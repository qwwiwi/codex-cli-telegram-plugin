// Prompt construction for inbound Telegram messages.
//
// Ports the BEHAVIOR of gateway.py:2765-2821 (reply-injection with untrusted
// metadata wrapping) into a typed, side-effect-free module. The critical rule
// is anti-spoof: a reply is labeled "agent's previous message" ONLY when
// reply.from.id === bot.id. Using reply.from.is_bot would let any user spoof
// agent output by replying to ANY bot — see gateway-inventory surprise #2.
//
// All composition produces a single string used as the `content` field of an
// MCP channel notification. Reply bodies are wrapped in
//   <untrusted_metadata type="telegram_reply">{json}</untrusted_metadata>
// so Claude reads them as data, never as instructions — same defense as
// gateway.py's "[Replied message (untrusted metadata, for context only):]"
// block, but with an explicit XML-style tag for cleaner parsing.

export type BotIdentity = { id: number; username: string }

// Telegram renders a Rich Message (Bot API 10.1) server-side from raw
// markdown, and a message sent that way carries NO `text`/`caption` at all —
// its body arrives as a structured block tree under `rich_message`. The shape
// is intentionally loose here: Telegram documents a growing set of block and
// inline node types, and this module only ever needs the text inside them.
export interface RichMessagePayload {
  blocks?: unknown
}

export interface TelegramReplyMessage {
  message_id: number
  from?: { id: number; is_bot: boolean; username?: string }
  text?: string
  caption?: string
  rich_message?: RichMessagePayload
  date: number
  // Pre-rendered `<media .../>` descriptor strings for the reply target's
  // attachment(s). METADATA ONLY — the reply author is not the allowlisted
  // caller, so a reply photo is never eager-downloaded and a reply voice is
  // never transcribed. adaptReply() populates this from the shared metadata
  // builders. Absent when the reply target carries no media.
  media?: string[]
}

export type UntrustedReplyContext =
  | {
      sender: 'agent_previous_message'
      bot_id: number
      message_id: number
      body: string
      truncated: boolean
      media?: string[]
    }
  | {
      sender: 'other_bot'
      bot_username?: string
      message_id: number
      body: string
      truncated: boolean
      media?: string[]
    }
  | {
      sender: 'human'
      user_id?: number
      username?: string
      message_id: number
      body: string
      truncated: boolean
      media?: string[]
    }

// grammY's ctx.message.forward_origin (Bot API 7.0 MessageOrigin). Present
// only on a forwarded message; the four variants differ in WHO the original
// author was and in how much of them Telegram is willing to disclose.
export type TelegramForwardOrigin =
  | {
      type: 'user'
      date: number
      sender_user?: {
        id: number
        is_bot: boolean
        first_name?: string
        last_name?: string
        username?: string
      }
    }
  | { type: 'hidden_user'; date: number; sender_user_name?: string }
  | {
      type: 'chat'
      date: number
      sender_chat?: { id: number; type: string; title?: string; username?: string }
      author_signature?: string
    }
  | {
      type: 'channel'
      date: number
      chat?: { id: number; type: string; title?: string; username?: string }
      message_id?: number
      author_signature?: string
    }

// Attribution of a forwarded message, as handed to the agent. UNTRUSTED: every
// string here is chosen by the original author (a display name can say anything,
// including a misleading name or instruction), so it ships inside the
// <untrusted_metadata> envelope and never as trusted prose.
// A type alias, not an interface, for the same reason UntrustedReplyContext is
// one: renderUntrustedMetadata takes Record<string, unknown>, and only an
// alias gets TypeScript's implicit index signature.
export type UntrustedForwardContext = {
  origin: 'user' | 'hidden_user' | 'chat' | 'channel'
  author: string
  author_user_id?: number
  author_username?: string
  author_signature?: string
  source_chat_id?: number
  source_message_id?: number
}

export const REPLY_BODY_MAX = 1200

// Match identifier-style kind names — keeps the rendered tag safe to scan
// with a simple regex on the consumer side.
const KIND_RE = /^[a-z_][a-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Depth ceiling for the block walk. The tree comes from an untrusted update,
// and unbounded recursion threw RangeError out of buildChannelContent — which
// made the poller dead-letter the ENTIRE update, losing the owner's own text
// along with the quote. Real Telegram markdown nests a handful of levels; 64
// is far above that and far below the stack limit.
const RICH_MAX_DEPTH = 64

// Node keys that describe presentation, not content. A generic fallback walk
// would otherwise splice 'center'/'bash' into the quoted body.
const RICH_META_KEYS = new Set([
  'type',
  'align',
  'valign',
  'language',
  'mime_type',
  'file_id',
  'emoji',
])

/**
 * Flatten an inline node (`paragraph.text`) into plain text. Inline spans are
 * concatenated WITHOUT a separator because Telegram keeps the surrounding
 * spaces inside the strings: `['E) ', {type:'bold', text:'Rich Message'}]`.
 */
function flattenInline(node: unknown, depth: number): string {
  if (depth > RICH_MAX_DEPTH) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(n => flattenInline(n, depth + 1)).join('')
  if (isRecord(node)) return flattenInline(node.text, depth + 1)
  return ''
}

/**
 * Flatten one block node. Blocks are separated by newlines; table rows join
 * their cells with ' | ' so a quoted table stays readable as one line each.
 * A node whose type this module has never seen falls back to its own string
 * fields — Telegram keeps adding block types (code, quote, heading …) and a
 * quote must never be silently emptied by an unseen one.
 */
function flattenBlock(node: unknown, depth: number): string {
  if (depth > RICH_MAX_DEPTH) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return node
      .map(n => flattenBlock(n, depth + 1))
      .filter(part => part.length > 0)
      .join('\n')
  }
  if (!isRecord(node)) return ''
  if (Array.isArray(node.cells)) {
    return node.cells
      .map(row =>
        Array.isArray(row)
          ? row.map(cell => flattenInline(cell, depth + 1)).join(' | ')
          : flattenInline(row, depth + 1),
      )
      .filter(row => row.length > 0)
      .join('\n')
  }
  if (node.blocks !== undefined) return flattenBlock(node.blocks, depth + 1)
  if (node.items !== undefined) return flattenBlock(node.items, depth + 1)
  if (node.text !== undefined) return flattenInline(node.text, depth + 1)
  return flattenUnknownNode(node, depth)
}

/**
 * Last resort for an unrecognised block: collect the text out of its own
 * content-bearing fields (e.g. `code` on a code block), skipping presentation
 * metadata. Keeps future Telegram block types readable instead of empty.
 */
function flattenUnknownNode(node: Record<string, unknown>, depth: number): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (RICH_META_KEYS.has(key)) continue
    const part = flattenBlock(value, depth + 1)
    if (part.length > 0) parts.push(part)
  }
  return parts.join('\n')
}

/**
 * Plain-text body of a Rich Message, or '' when it holds no readable text.
 * Without this every quote of an agent answer in a DM was dropped: the reply
 * classifier only looked at `text`/`caption`, both absent on rich messages.
 */
export function flattenRichMessage(rich: RichMessagePayload | undefined): string {
  if (rich === undefined) return ''
  return flattenBlock(rich.blocks, 0).trim()
}

// Classify a reply message into an UntrustedReplyContext. Returns null when
// the reply has no usable body or no `from` (system messages are ignored —
// the agent already has the surrounding message, the reply adds no signal).
export function buildReplyContext(
  reply: TelegramReplyMessage,
  bot: BotIdentity,
): UntrustedReplyContext | null {
  // Reply body fallback chain mirrors gateway.py:2769 (text || caption), with
  // rich messages last: they carry no text/caption, so before this the whole
  // quote was dropped whenever the agent's own DM answer was quoted.
  const raw = reply.text ?? reply.caption ?? flattenRichMessage(reply.rich_message)
  // Strip null bytes before measuring length, matching gateway.py:2812
  // ordering. \x00 escape keeps the source file ASCII-clean.
  const stripped = raw.replace(/\x00/g, '')
  const media = reply.media && reply.media.length > 0 ? reply.media : undefined
  // Drop the reply context only when it carries NOTHING — no usable body AND
  // no media descriptor. A reply to a caption-less photo/voice has an empty
  // body but real media, and must still surface (the pre-fix early-return
  // dropped these entirely, so a reply to a bare photo produced no metadata
  // block at all).
  if (stripped.length === 0 && media === undefined) return null

  const truncated = stripped.length > REPLY_BODY_MAX
  const body = truncated ? stripped.slice(0, REPLY_BODY_MAX) : stripped

  // No `from` field — Telegram system messages (channel posts forwarded into
  // a group, anonymous admin actions). We can't classify the sender, so we
  // drop the reply context entirely rather than guess.
  if (!reply.from) return null

  // Anti-spoof: id comparison, not is_bot. reply.from.is_bot=true alone would
  // let a user reply to ANY bot and have the agent treat that message as its
  // own previous output. See gateway.py:2786-2793.
  //
  // Defence: bot.id===0 is the "identity not yet initialised" sentinel from
  // server.ts. We MUST NOT treat a reply.from.id===0 as the agent's previous
  // message (no Telegram user has id 0) and we MUST NOT classify any other
  // bot reply confidently in that pre-init window — server.ts now awaits
  // bot.init() before starting the poller/webhook, so this branch is a
  // belt-and-braces guard for tests and any future call site.
  if (bot.id === 0) return null
  if (reply.from.id === bot.id) {
    return {
      sender: 'agent_previous_message',
      bot_id: bot.id,
      message_id: reply.message_id,
      body,
      truncated,
      ...(media !== undefined ? { media } : {}),
    }
  }

  if (reply.from.is_bot === true) {
    const ctx: UntrustedReplyContext = {
      sender: 'other_bot',
      message_id: reply.message_id,
      body,
      truncated,
      ...(media !== undefined ? { media } : {}),
    }
    if (reply.from.username !== undefined) ctx.bot_username = reply.from.username
    return ctx
  }

  const human: UntrustedReplyContext = {
    sender: 'human',
    message_id: reply.message_id,
    body,
    truncated,
    ...(media !== undefined ? { media } : {}),
  }
  if (reply.from.id !== undefined) human.user_id = reply.from.id
  if (reply.from.username !== undefined) human.username = reply.from.username
  return human
}

// Classify a forwarded message's origin into an UntrustedForwardContext.
// Returns null when the variant carries no usable attribution — a context that
// only says "forwarded" without naming anyone adds no signal.
//
// Why this exists: forward_origin was listed in MESSAGE_ENVELOPE_KEYS and
// dropped, so a forwarded voice note reached the agent indistinguishable from
// the owner's own words — and got acted on as the owner's instruction
// (2026-11-10).
export function buildForwardContext(
  origin: TelegramForwardOrigin,
): UntrustedForwardContext | null {
  switch (origin.type) {
    case 'user': {
      const user = origin.sender_user
      if (!user) return null
      const name = [user.first_name, user.last_name]
        .filter(part => part !== undefined && part.length > 0)
        .join(' ')
      const author = name.length > 0 ? name : (user.username ?? '')
      if (author.length === 0) return null
      const ctx: UntrustedForwardContext = { origin: 'user', author }
      ctx.author_user_id = user.id
      if (user.username !== undefined) ctx.author_username = user.username
      return ctx
    }
    case 'hidden_user': {
      const author = origin.sender_user_name ?? ''
      if (author.length === 0) return null
      return { origin: 'hidden_user', author }
    }
    case 'chat': {
      const chat = origin.sender_chat
      if (!chat) return null
      const author = chat.title ?? chat.username ?? ''
      if (author.length === 0) return null
      const ctx: UntrustedForwardContext = { origin: 'chat', author }
      ctx.source_chat_id = chat.id
      if (chat.username !== undefined) ctx.author_username = chat.username
      if (origin.author_signature !== undefined) ctx.author_signature = origin.author_signature
      return ctx
    }
    case 'channel': {
      const chat = origin.chat
      if (!chat) return null
      const author = chat.title ?? chat.username ?? ''
      if (author.length === 0) return null
      const ctx: UntrustedForwardContext = { origin: 'channel', author }
      ctx.source_chat_id = chat.id
      if (chat.username !== undefined) ctx.author_username = chat.username
      if (origin.message_id !== undefined) ctx.source_message_id = origin.message_id
      if (origin.author_signature !== undefined) ctx.author_signature = origin.author_signature
      return ctx
    }
    default:
      return null
  }
}

// Wrap an arbitrary payload in a tagged metadata block. JSON inside is NOT
// HTML-escaped — Claude reads the block as a string-tagged region (similar
// to gateway.py's `[Replied message (untrusted metadata, for context only):]`
// prefix), not as HTML to render. The tag itself uses XML-style attributes
// so it's recognizable even when surrounded by free-form text.
export function renderUntrustedMetadata(
  kind: string,
  payload: Record<string, unknown>,
): string {
  if (!KIND_RE.test(kind)) {
    throw new Error(`renderUntrustedMetadata: invalid kind "${kind}"`)
  }
  const json = JSON.stringify(payload)
  return `<untrusted_metadata type="${kind}">\n${json}\n</untrusted_metadata>`
}

export interface PromptInput {
  // Primary user text (text, caption, or empty for media-only messages).
  text: string
  bot: BotIdentity
  // grammY's ctx.message.reply_to_message, when present.
  reply?: TelegramReplyMessage
  // grammY's ctx.message.forward_origin — present only when the caller
  // forwarded someone else's message instead of writing it themselves.
  forward?: TelegramForwardOrigin
  // Pre-rendered media descriptors from T8 (e.g. `<media type="photo" .../>`).
  // T7 just concatenates them above the text — T8 owns the rendering logic.
  mediaDescriptors?: string[]
}

// Compose the final channel content string. Order:
//   1. media descriptors (joined by \n) — context about attachments
//   2. primary text — what the user actually typed
//   3. <untrusted_metadata> reply block — quoted message, sender-classified
//
// No legacy "Replied message: ..." plain prefix. Gateway.py used a labeled
// JSON block (gateway.py:2817-2819); we tighten that to a proper tag so the
// boundary between trusted user text and untrusted quoted text is explicit.
export function buildChannelContent(input: PromptInput): string {
  const parts: string[] = []

  if (input.mediaDescriptors && input.mediaDescriptors.length > 0) {
    parts.push(input.mediaDescriptors.join('\n'))
  }

  if (input.text.length > 0) {
    parts.push(input.text)
  }

  if (input.reply) {
    const ctx = buildReplyContext(input.reply, input.bot)
    if (ctx !== null) {
      parts.push(renderUntrustedMetadata('telegram_reply', ctx))
    }
  }

  // Forward attribution goes LAST: it describes the message as a whole, so it
  // reads as a footnote on everything above rather than part of the quote.
  if (input.forward) {
    const ctx = buildForwardContext(input.forward)
    if (ctx !== null) {
      parts.push(renderUntrustedMetadata('telegram_forward', ctx))
    }
  }

  return parts.join('\n')
}
