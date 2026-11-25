// Inbound message handlers for Telegram.
//
// T4 scope: each handler extracts the gate inputs from a grammY Context,
// calls gateTelegramMessage, and on allow forwards a minimal placeholder
// notification through the MCP channel. Drops log at debug only.
//
// T7 added reply-context wrapping via prompt/build.ts (untrusted_metadata
// for reply bodies). T8 adds media descriptors: each media handler now
// builds a typed MediaDescriptor, renders it via renderMediaDescriptor,
// and passes the result through buildChannelContent so the prompt the
// agent sees has `<media kind="..." .../>` tags above the user text.
//
// Photo handler additionally downloads the photo after the allowlist gate
// passes (mirrors gateway.py:863-901 + server.ts:791-815). Voice handler
// optionally calls Groq Whisper via maybeTranscribeVoice — failure does
// not crash, the descriptor records transcription_status=failed/missing_key.
import type { Context } from 'grammy'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import {
  resolveGuestModeAllowedUserIds,
  resolveGuestModeEnabled,
  resolveOwnerChatIds,
  type AppConfig,
  type StatePaths,
} from '../config.js'
import type { GuestQueryRegistry } from './guest-queries.js'
import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import type { StatusManager } from '../status/status-manager.js'
import type { MultichatPolicy } from '../chats/policy-loader.js'
import type { MultichatRouter } from '../router/multichat-router.js'
import type { InboundMessage } from '../router/inbox-bridge.js'
import { deriveRouteKey } from '../router/route-key.js'
import type { ThreadStore } from '../state/thread-store.js'
import type { OpenQuestionStore } from '../state/open-question-store.js'
import { sendChannelNotification, type ChannelEvent } from '../channel/notify.js'
import { gateTelegramMessage, type GateInput } from './gate.js'
import { isAddressedToBot } from './addressing.js'
import {
  buildChannelContent,
  flattenRichMessage,
  type BotIdentity,
  type RichMessagePayload,
  type TelegramForwardOrigin,
  type TelegramReplyMessage,
} from '../prompt/build.js'
import {
  renderMediaDescriptor,
  type BotApiForDownload,
  type MediaDescriptor,
} from './media.js'
import {
  buildAnimationDescriptor,
  buildAudioDescriptor,
  buildDocumentDescriptorWithDownload,
  buildOwnMediaDescriptors,
  buildPhotoDescriptor,
  buildReplyMediaDescriptors,
  buildStickerDescriptor,
  buildVideoDescriptor,
  buildVideoNoteDescriptor,
  buildVoiceDescriptor,
  type MediaDownloadDeps,
  type VoiceTranscribeDeps,
} from './media-descriptors.js'
import {
  executeOobResult,
  handleOobCommand,
  parseOobCommand,
  type OobContext,
  type TmuxMirrorControl,
} from '../commands/oob.js'
import { interruptCurrentTurn, resolveTmuxKeysTarget } from '../commands/tmux-interrupt.js'
import {
  isPermissionApprover,
  parsePermissionTextReply,
  type PermissionRelayHooks,
} from '../channel/permissions.js'
import type { AskUserQuestionUi } from './ask-user-question.js'
import { AlbumBuffer, type Album } from './album-buffer.js'
import {
  compositeAlbumKey,
  dropAlbumDir,
  moveToAlbumDeadLetter,
  persistFragment,
  type PersistedAlbumMeta,
} from './album-persistence.js'
import type { InboundWatcher } from './watcher.js'

// A single buffered album item — one Telegram update that belongs to an
// album. We capture everything needed to emit a combined channel notification
// without re-parsing the original ctx (which is short-lived per update).
export interface AlbumEntry {
  /** Pre-rendered `<media .../>` descriptor strings for this item. */
  descriptors: string[]
  /** Local filesystem paths for downloaded media in this item (router path).
   *  Empty when no media in this item was downloaded inline (only `photo`
   *  triggers an immediate download today). */
  mediaPaths: string[]
  /** Trimmed caption text for this item ('' when no caption). */
  caption: string
  /** Per-item message_id — used to surface first message_id in meta. */
  messageId: number | undefined
  /** Reply context, if this item was a reply. First non-null wins on flush. */
  reply: TelegramReplyMessage | undefined
  /** Forward origin, if this item was forwarded from someone else. Telegram
   *  stamps it on EVERY fragment of a forwarded album, so first non-null wins
   *  on flush — same rule as `reply` (2026-11-10). */
  forward?: TelegramForwardOrigin | undefined
  /** FIX-D B1 (2026-05-27): whether `isAddressedToBot` returned true for
   *  THIS fragment at push time. Telegram only carries the caption/@mention
   *  on one fragment of an album — sibling fragments arrive bare. We must
   *  buffer them anyway and aggregate at flush: any fragment with
   *  `addressedAtPush=true` ⇒ the whole album is addressed. In DMs the
   *  flag is always true (private chat ⇒ addressed unconditionally).
   *  Optional for back-compat with disk-recovered entries written by
   *  pre-FIX-D versions; the album dispatch treats `undefined` as true
   *  (those builds dropped unaddressed fragments at the gate, so anything
   *  on disk was addressed at the time). */
  addressedAtPush?: boolean
  /** Forum-topic thread id of this fragment. First
   *  defined value wins on flush so the reply lands in the same topic. */
  threadId?: number
}

// Album-level dispatch deps. Subset of HandlerDeps used by sendAlbumNotification.
export interface AlbumDispatchDeps {
  server: Server
  config: AppConfig
  log: Logger
  bot: BotIdentity
  telegramApi: TelegramApi
  statusManager?: StatusManager
  // Multichat router + policy. When both present, album flushes are
  // dispatched as a single InboundMessage (captions merged, media_paths
  // concatenated). Otherwise the legacy MCP notify path runs.
  router?: MultichatRouter
  policy?: MultichatPolicy
  // Forum-topic memory: record the album's inbound topic
  // so a reply that omits thread_id still lands in the same topic.
  threadStore?: ThreadStore
}

export interface HandlerDeps {
  server: Server
  config: AppConfig
  statePaths: StatePaths
  telegramApi: TelegramApi
  log: Logger
  // BotIdentity is shared by reference from server.ts — its id/username are
  // populated by grammy's onStart callback before any update reaches us.
  bot: BotIdentity
  // Bot.api passthrough for photo download (getFile). Kept narrow so the
  // handler module never reaches into grammY internals.
  botApi: BotApiForDownload
  // Telegram bot token, used to build file-CDN URLs. Redacted in logs by
  // config.redactToken before any error escapes the process.
  botToken: string
  // Minimal env subset — currently only GROQ_API_KEY for voice transcription.
  env: { GROQ_API_KEY?: string }
  // Permission relay hooks — when present, the text handler intercepts
  // "yes <id>" / "no <id>" replies from approvers and emits verdicts.
  // Optional so older tests that don't exercise permissions still compile.
  permissionHooks?: PermissionRelayHooks
  // T11: status manager owns the "Печатает.../🔧 tool" transient. Optional
  // so older T4-T10 tests that pre-date T11 still compile against this
  // type — when absent we just skip status creation.
  statusManager?: StatusManager
  // T9: album buffer collects per-mgid items and fires a flush callback
  // after `config.album.flush_ms` of silence. Optional so older T4-T8
  // tests still compile — when absent, every media message goes through
  // the single-media path (no album merging).
  albumBuffer?: AlbumBuffer<AlbumEntry>
  // PR-A3 (2026-05-20): InboundWatcher fires an auto-reply «Агент занят»
  // when the owner sends plain text mid-tool. Optional so older tests
  // compile — when absent, the watcher branch is skipped and behaviour
  // matches the pre-A3 path. Insertion point in handleInboundText sits
  // AFTER OOB resolution and BEFORE gateAndNotify: OOB still wins, and
  // Claude still receives the channel notification regardless.
  watcher?: InboundWatcher
  // TmuxMirror control surface, used by /mirror OOB command. Optional —
  // when tmux_mirror.enabled=false at startup the mirror instance is
  // never created and the OOB handler replies «disabled in config».
  tmuxMirror?: TmuxMirrorControl
  // Multichat router. When present together with `policy`, all gated
  // inbound traffic is dispatched to the per-chat tmux session via
  // `router.dispatch(InboundMessage)` instead of the legacy
  // sendChannelNotification path. Absent in legacy single-chat
  // deployments — handlers fall back to the historical MCP notify path.
  router?: MultichatRouter
  // Multichat policy. Drives gate.ts group-chat allowlist, addressing
  // mention_allowlist, and per-chat behaviour. MUST be paired with
  // `router` to flip the dispatch path; passing one without the other
  // is a wiring bug at the server.ts level (Batch 5 enforces this).
  policy?: MultichatPolicy
  // PRX-1 TASK-2 (2026-05-27): AskUserQuestion Telegram UX. The text
  // handler consults `tryHandleOtherText` BEFORE the permission-reply
  // short-circuit so a follow-up «Другое» text answer never gets
  // mis-parsed as `yes <id>` / `no <id>`. Optional — when absent (old
  // wiring / tests that predate TASK-2), the consumption is skipped
  // and inbound text flows through the existing paths unchanged.
  askUserQuestionUi?: AskUserQuestionUi
  // Per-chat forum-topic memory (2026-06-09). When present, every gated inbound
  // records its message_thread_id so the reply / status surfaces default into
  // the topic the message came from instead of the supergroup's General.
  // Optional — omitted in tests / legacy wiring leaves threading unchanged.
  threadStore?: ThreadStore
  // Open-question reminder (2026-11-14). When present, ANY inbound text in a
  // chat disarms the pending reminder for it: the owner has spoken, so nudging
  // him about the question is now noise. Optional — omitted leaves inbound
  // handling unchanged.
  openQuestions?: OpenQuestionStore
  // Context HUD (wave 3B, status-pin). When present, maybeBumpMirror re-anchors
  // the pinned status card on every inbound owner message, sequenced BEFORE the
  // tmux-mirror bump. Optional — undefined when resolveHudEnabled(config)=false,
  // so the HUD flag OFF leaves handler behaviour identical (no bump leg).
  contextHud?: { bump(chatId: string): Promise<void> }
  // Session facts view (transcript_path + model) recorded from hook events,
  // consumed by /status for context usage. Optional — undefined when the HUD
  // flag is off; injected alongside contextHud from server.ts.
  sessionInfo?: { get(chatId?: string): { transcriptPath?: string; model?: string } }
  // Guest Mode: registry of pending one-shot guest queries.
  // handleGuestMessage registers allowlisted queries here; the `reply` tool
  // claims them when answering via answerGuestQuery. Optional so pre-guest
  // tests compile — when absent, guest updates are dropped.
  guestQueries?: GuestQueryRegistry
}

// Coerce grammY's reply_to_message Message shape into the narrower
// TelegramReplyMessage that prompt/build.ts consumes. Only the fields the
// classifier uses are forwarded — full Message type carries dozens of
// service-message fields that the prompt builder ignores by design.
export function adaptReply(
  reply: NonNullable<Context['message']>['reply_to_message'] | undefined,
): TelegramReplyMessage | undefined {
  if (!reply) return undefined
  const out: TelegramReplyMessage = {
    message_id: reply.message_id,
    date: reply.date,
  }
  if (reply.from) {
    out.from = {
      id: reply.from.id,
      is_bot: reply.from.is_bot,
      ...(reply.from.username !== undefined ? { username: reply.from.username } : {}),
    }
  }
  if (reply.text !== undefined) out.text = reply.text
  if (reply.caption !== undefined) out.caption = reply.caption
  const rich = extractRichMessage(reply)
  if (rich !== undefined) out.rich_message = rich
  // Reply-target media — METADATA ONLY. The reply author is NOT the
  // allowlisted caller, so we never download a reply photo nor transcribe a
  // reply voice; we only surface file_id + <media> descriptors so the agent
  // can decide whether to fetch via download_attachment. This one fix point
  // covers every reply path (DM, router, guest, album — all funnel through
  // adaptReply → buildReplyContext).
  const replyMedia = buildReplyMediaDescriptors(reply).map(renderMediaDescriptor)
  if (replyMedia.length > 0) out.media = replyMedia
  return out
}

/**
 * True when a descriptor already holds the bytes on disk, i.e. it came off the
 * eager download path. Only `photo` and `document` ever do; keeping the test in
 * one place stops the two `media_paths` builders from drifting apart — the
 * document case was missed exactly that way (2026-11-17).
 */
function hasLocalPath(
  media: MediaDescriptor,
): media is MediaDescriptor & { localPath: string } {
  return (
    (media.kind === 'photo' || media.kind === 'document') &&
    typeof media.localPath === 'string'
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Pull `forward_origin` (Bot API 7.0 MessageOrigin) off an inbound message and
 * narrow it to the shape prompt/build.ts consumes.
 *
 * Why the unknown-cast + per-variant guard rather than a type assertion: the
 * field is attacker-shaped (any stranger's display name), Telegram keeps adding
 * origin variants, and an unrecognised shape must degrade to "no attribution"
 * instead of throwing and dead-lettering the owner's whole message.
 *
 * Until 2026-11-10 this was never read at all — forward_origin sat in
 * MESSAGE_ENVELOPE_KEYS and a forwarded voice note reached the agent
 * indistinguishable from the owner's own words.
 */
export function adaptForward(message: unknown): TelegramForwardOrigin | undefined {
  if (!isPlainObject(message)) return undefined
  const raw = message.forward_origin
  if (!isPlainObject(raw)) return undefined
  const date = typeof raw.date === 'number' ? raw.date : 0

  switch (raw.type) {
    case 'user': {
      if (!isPlainObject(raw.sender_user)) return undefined
      const u = raw.sender_user
      if (typeof u.id !== 'number') return undefined
      return {
        type: 'user',
        date,
        sender_user: {
          id: u.id,
          is_bot: u.is_bot === true,
          ...(optString(u.first_name) !== undefined ? { first_name: optString(u.first_name)! } : {}),
          ...(optString(u.last_name) !== undefined ? { last_name: optString(u.last_name)! } : {}),
          ...(optString(u.username) !== undefined ? { username: optString(u.username)! } : {}),
        },
      }
    }
    case 'hidden_user': {
      const name = optString(raw.sender_user_name)
      if (name === undefined) return undefined
      return { type: 'hidden_user', date, sender_user_name: name }
    }
    case 'chat': {
      if (!isPlainObject(raw.sender_chat)) return undefined
      const c = raw.sender_chat
      if (typeof c.id !== 'number') return undefined
      return {
        type: 'chat',
        date,
        sender_chat: {
          id: c.id,
          type: optString(c.type) ?? 'unknown',
          ...(optString(c.title) !== undefined ? { title: optString(c.title)! } : {}),
          ...(optString(c.username) !== undefined ? { username: optString(c.username)! } : {}),
        },
        ...(optString(raw.author_signature) !== undefined
          ? { author_signature: optString(raw.author_signature)! }
          : {}),
      }
    }
    case 'channel': {
      if (!isPlainObject(raw.chat)) return undefined
      const c = raw.chat
      if (typeof c.id !== 'number') return undefined
      return {
        type: 'channel',
        date,
        chat: {
          id: c.id,
          type: optString(c.type) ?? 'unknown',
          ...(optString(c.title) !== undefined ? { title: optString(c.title)! } : {}),
          ...(optString(c.username) !== undefined ? { username: optString(c.username)! } : {}),
        },
        ...(typeof raw.message_id === 'number' ? { message_id: raw.message_id } : {}),
        ...(optString(raw.author_signature) !== undefined
          ? { author_signature: optString(raw.author_signature)! }
          : {}),
      }
    }
    default:
      return undefined
  }
}

/**
 * Pull `rich_message` off a message (quoted or inbound). Bot API 10.1 Rich
 * Messages carry their body as a block tree instead of `text`, and grammY
 * 1.43's Message type does not declare the field yet — hence the unknown-cast
 * + shape guard rather than a type assertion. Returns undefined for any other
 * message shape.
 */
function extractRichMessage(message: unknown): RichMessagePayload | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const raw = (message as Record<string, unknown>).rich_message
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const blocks = (raw as Record<string, unknown>).blocks
  return blocks === undefined ? {} : { blocks }
}

// PR-A3 — auto-reply gate. The InboundWatcher must never fire for
// senders/chats that aren't on the allowlist: a future group-chat use of
// the bot would otherwise leak bot activity to non-allowed senders. We
// mirror the OOB short-circuit's allowlist check (allowed_user_ids AND
// allowed_chat_ids — defence in depth even when the gate lets the message
// through). DM-only is NOT required here; auto-reply makes sense in any
// allowlisted chat. Returns true when the watcher is permitted to fire.
function watcherAllowed(
  ctx: Context,
  config: AppConfig,
  policy?: MultichatPolicy,
): boolean {
  const senderNum = ctx.from?.id
  const chatNum = ctx.chat?.id
  if (senderNum === undefined || chatNum === undefined) return false
  // Multichat: defer to policy.allowlist for both user and chat. Symmetric
  // with the gate's group branch — a sender allowed by policy in a
  // policy-listed chat may trigger the auto-reply even in a group.
  if (policy) {
    const userOk =
      policy.allowlist.users.includes(String(senderNum)) ||
      policy.allowlist.users.includes('*')
    const chatOk = policy.allowlist.chats.includes(String(chatNum))
    return userOk && chatOk
  }
  if (!config.allowed_user_ids.includes(senderNum)) return false
  // allowed_chat_ids may be a mix of strings and numbers — coerce both
  // sides to string for comparison, same as the OOB block does.
  const allowedChatSet = new Set(config.allowed_chat_ids.map((v) => String(v)))
  if (!allowedChatSet.has(String(chatNum))) return false
  return true
}

// Bug #3 (TASK-4, 2026-05-27) — addressed-only side effects.
//
// `watcherAllowed` checks who the sender/chat are, but in groups any
// allowed sender's message would trigger auto-reply and tmux-mirror
// bump even when the bot was not addressed. That leaks bot activity
// (typing bubble, status edits, mirror re-anchor) on every normal
// group message — the owner and other speakers would see the bot
// "react" to traffic that wasn't directed at it.
//
// Composite gate: allowlist-pass (chat/sender) AND addressing-pass
// (DM, or group with @mention / reply-to-bot). DMs pass addressing
// unconditionally because `isAddressedToBot` returns true for private
// chat regardless of mention_allowlist. We reuse the existing
// `isAddressedToBot` helper so addressing semantics stay in one place
// (DM vs group rules, mention_allowlist for groups) and side-effect
// triggers can never disagree with the reaction gate.
function isSideEffectAllowed(
  ctx: Context,
  config: AppConfig,
  policy?: MultichatPolicy,
): boolean {
  if (!watcherAllowed(ctx, config, policy)) return false
  // Addressing gate. mention_allowlist defends groups; DM passes through.
  return isAddressedToBot(ctx, policy?.mention_allowlist)
}

// Fire-and-forget watcher trigger. Encapsulates the allowlist gate +
// `void`/`.catch` boilerplate so every inbound handler (text + media) can
// invoke the watcher with one call. Optional `deps.watcher` makes this a
// no-op when the watcher isn't configured — older tests stay compatible.
//
// Bug #3 (TASK-4): use `isSideEffectAllowed` (allowlist AND addressing)
// so a non-addressed group message never triggers «Агент занят».
function maybeTriggerWatcher(ctx: Context, deps: HandlerDeps): void {
  if (!deps.watcher) return
  if (!isSideEffectAllowed(ctx, deps.config, deps.policy)) return
  const chatNum = ctx.chat?.id
  const msgId = ctx.message?.message_id
  if (chatNum === undefined || msgId === undefined) return
  void deps.watcher
    .maybeAutoReply({ chatId: String(chatNum), messageId: msgId })
    .catch((err) => {
      deps.log.warn('watcher auto-reply error (ignored)', {
        chat_id: String(chatNum),
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

// Fire-and-forget mirror bump. Triggered by an inbound message from an
// allowed sender so the rolling tmux-mirror message is re-anchored at
// the bottom of the chat (owner asked for this 2026-05-20: the mirror
// was scrolling up out of view as the conversation progressed). Reuses
// the same allowlist gate as the watcher so a non-allowed message never
// disturbs the mirror. `bump` is optional on TmuxMirrorControl, so when
// the wired mirror predates this method we silently skip.
//
// Bug #3 (TASK-4): use `isSideEffectAllowed` so a non-addressed group
// message never re-anchors the mirror.
function maybeBumpMirror(ctx: Context, deps: HandlerDeps): void {
  const hasMirror = deps.tmuxMirror?.bump !== undefined
  const hasHud = deps.contextHud !== undefined
  // Nothing to re-anchor. With the HUD flag OFF (`contextHud` undefined) this
  // collapses to the original `if (!deps.tmuxMirror?.bump) return` — identical
  // behaviour to before the HUD port.
  if (!hasMirror && !hasHud) return
  if (!isSideEffectAllowed(ctx, deps.config, deps.policy)) return
  const chatNum = ctx.chat?.id
  if (chatNum === undefined) return
  const chatId = String(chatNum)
  // Sequence matters (status-pin wave, 2026-07-04): the pinned status card
  // re-anchors FIRST, the tmux mirror second, so the chat bottom always reads
  // «status card above, mirror below». Each leg is best-effort — a HUD failure
  // must never rob the mirror of its bump, and vice versa. The HUD leg is
  // guarded on `hasHud`, so the flag-off path (contextHud undefined) runs only
  // the original mirror bump.
  void (async () => {
    if (hasHud) {
      try {
        await deps.contextHud!.bump(chatId)
      } catch (err) {
        deps.log.warn('context hud bump error (ignored)', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (hasMirror) {
      try {
        await deps.tmuxMirror!.bump!()
      } catch (err) {
        deps.log.warn('tmux mirror bump error (ignored)', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })()
}

// FIX-D M1 (2026-05-27): chat-type detection from a stringified Telegram
// chat id. Telegram uses negative ids for groups, supergroups, and
// channels; positive ids are user/bot DMs. We rely on this convention so
// the album-dispatch path can enforce the policy+router XOR check even
// when it only has `ids.chatId` to work with (the original ctx is gone
// by flush time). Defensively coerced — non-numeric ids return false.
function isGroupChatId(chatId: string): boolean {
  if (chatId === '') return false
  return chatId.startsWith('-')
}

// FIX-D M1 (2026-05-27): defence-in-depth wiring check.
//
// The server boots with `policy` and `router` together (or both absent).
// A wiring bug that supplies only one half would otherwise let group
// traffic past gate.ts (because the policy unlocks the group branch)
// and into `sendChannelNotification` (because no router exists), which
// leaks chat-specific traffic into the master legacy session.
//
// Returns true when the current dispatch is in the BAD half of the XOR
// AND the chat is non-private (DMs are unaffected — they use the legacy
// notify path even in multichat builds).
function isPolicyRouterMisconfig(
  hasPolicy: boolean,
  hasRouter: boolean,
  isGroup: boolean,
): boolean {
  if (!isGroup) return false
  // XOR: exactly one of policy/router is set.
  return (hasPolicy && !hasRouter) || (!hasPolicy && hasRouter)
}

// Variant A (2026-06-11): whether a NON-group chat (a private DM) should be
// routed to its own per-chat tmux session instead of falling through to the
// legacy master notify. True only when `multichat.route_private` is enabled
// AND the chat has its own entry in `policy.chats`. With the flag off or no
// policy entry, the DM still lands in the main session.
function shouldRoutePrivate(
  config: AppConfig,
  policy: MultichatPolicy | undefined,
  chatId: string,
  threadId: number | undefined,
): boolean {
  // Optional-chain `multichat`: the schema always defaults it to an object,
  // but hand-built test configs may omit the block entirely.
  if (policy === undefined || !config.multichat?.route_private) return false
  const routeKey = deriveRouteKey(
    chatId,
    threadId !== undefined ? String(threadId) : undefined,
    policy,
  )
  return Object.prototype.hasOwnProperty.call(policy.chats, routeKey)
}

// Extract the four fields the gate cares about from a grammY Context. Kept
// separate so unit tests for gate.ts don't need a real Context shape.
function gateInputFromContext(ctx: Context): GateInput {
  const chatType = ctx.chat?.type
  const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined
  const senderId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined
  const isBot = ctx.from?.is_bot
  return {
    // grammY's chat.type is a wider union (incl. 'channel') — we narrow here.
    chatType: chatType as GateInput['chatType'],
    chatId,
    senderId,
    isBot,
  }
}

// Forum-topic thread id of the inbound message, or undefined. Telegram sets
// `message_thread_id` on messages that belong to a forum topic AND flags them
// with `is_topic_message: true`; the General topic and plain (non-topic) reply
// chains carry no usable thread. We require `is_topic_message` so a regular
// reply inside a non-forum group is never mistaken for a topic id (sending to
// a bogus thread id would make Telegram reject the message).
function threadIdOf(ctx: Context): number | undefined {
  const msg = ctx.message
  if (!msg || msg.is_topic_message !== true) return undefined
  const id = msg.message_thread_id
  return typeof id === 'number' && id > 0 ? id : undefined
}

// Shared metadata layout. Identifier-style keys only — notify.normalizeMeta
// will silently drop hyphens, but we never emit them in the first place.
function buildMeta(
  decision: { kind: 'allow'; senderId: string; chatId: string },
  ctx: Context,
): Record<string, string> {
  const meta: Record<string, string> = {
    source: 'telegram',
    chat_id: decision.chatId,
    user_id: decision.senderId,
    ts: new Date().toISOString(),
  }
  if (ctx.message?.message_id !== undefined) {
    meta.message_id = String(ctx.message.message_id)
  }
  const threadId = threadIdOf(ctx)
  if (threadId !== undefined) {
    meta.message_thread_id = String(threadId)
  }
  return meta
}

// Common gate+notify body. Each per-kind handler computes its primary text
// and (in T8+) a list of MediaDescriptors via buildMedia. We render the
// descriptors and feed them to buildChannelContent so the agent sees
// `<media .../>` tags above the user's text and reply block.
async function gateAndNotify(
  ctx: Context,
  deps: HandlerDeps,
  buildText: () => string,
  buildMedia: (() => Promise<MediaDescriptor[]>) | undefined,
  kind: string,
): Promise<void> {
  const input = gateInputFromContext(ctx)
  // Multichat-aware gate: policy unlocks group/supergroup paths. Without
  // policy the legacy "DM-only or drop" behaviour is preserved by gate.ts.
  const decision = gateTelegramMessage(input, deps.config, deps.policy)
  if (decision.kind === 'drop') {
    deps.log.debug('inbound dropped', {
      reason: decision.reason,
      chat_type: input.chatType,
      kind,
      // sender_id / chat_id only at debug — operator can opt in via LOG_LEVEL.
      sender_id: input.senderId,
      chat_id: input.chatId,
    })
    return
  }

  // Group/supergroup addressing gate: only senders in `mention_allowlist`
  // (typically just the owner) may summon the bot via @-mention or
  // reply-to-bot. Silent drop — no reaction, no notify, no router dispatch.
  // DM passes through unchanged because isAddressedToBot returns true for
  // private chats regardless of the allowlist parameter.
  if (input.chatType !== 'private') {
    // Legacy open-group mode has no policy -> pass undefined so ANY
    // sender's @mention / reply-to-bot addresses the bot. Multichat mode
    // still restricts via policy.mention_allowlist.
    const addressed = isAddressedToBot(ctx, deps.policy?.mention_allowlist)
    if (!addressed) {
      deps.log.debug('handlers.not_addressed', {
        chat_id: decision.chatId,
        user_id: decision.senderId,
        kind,
      })
      return
    }
  }

  // FIX-D M1 (2026-05-27) — policy/router XOR defence-in-depth.
  //
  // The server is supposed to wire `policy` and `router` together. A
  // wiring bug that supplies only `policy` would otherwise let group
  // traffic past the gate (policy unlocks the group branch) and into
  // `sendChannelNotification` (no router → fall through to legacy),
  // which leaks chat-specific traffic into the master legacy session.
  // The symmetric case (`router` without `policy`) is benign in
  // practice — gate.ts keeps the legacy DM-only behaviour — but we
  // still flag it as a wiring error so the operator notices.
  //
  // DM dispatch is unaffected: legacy notify of DMs is intentional in
  // single-chat builds.
  const hasPolicy = deps.policy !== undefined
  const hasRouter = deps.router !== undefined
  const isGroup = input.chatType === 'group' || input.chatType === 'supergroup'
  if (isPolicyRouterMisconfig(hasPolicy, hasRouter, isGroup)) {
    deps.log.error('handlers.policy_router_misconfig — dropping group dispatch', {
      chat_id: decision.chatId,
      user_id: decision.senderId,
      kind,
      has_policy: hasPolicy,
      has_router: hasRouter,
      chat_type: input.chatType,
      hint: 'policy and router MUST be wired together; configure both or neither',
    })
    return
  }

  // Remember the inbound forum topic for this chat so the reply / status
  // surfaces default into the same topic. A General-topic or private message
  // clears any stale thread. Record it before any outbound traffic.
  const inboundThreadId = threadIdOf(ctx)
  deps.threadStore?.record(decision.chatId, inboundThreadId)

  // Media build runs ONLY after the gate allows the message — never download
  // or transcribe for un-allowlisted senders. Mirrors gateway.py: download
  // path is guarded by allowlist check at 2117+ (auto_transcribe_group_voice
  // is invoked from already-allowlisted handlers).
  const descriptors = buildMedia ? await buildMedia() : []
  const renderedMedia = descriptors.map(renderMediaDescriptor)

  // Router path: route GROUP/supergroup chats to their per-chat tmux
  // session via the file-based inbox. Private DMs fall through to the
  // legacy sendChannelNotification path below by default so they land in
  // the master session — the owner's main Telegram
  // channel lives there (explicit requirement 2026-05-28). Variant A
  // (2026-06-11) opts a deployment INTO routing private DMs too, via
  // `multichat.route_private` + a per-chat policy entry (see
  // shouldRoutePrivate): then the DM gets its own session, uniform with
  // every other routed chat. For groups the router always takes full
  // ownership — no fallback — so the master session never sees traffic
  // belonging to a different chat.
  if (
    deps.router &&
    deps.policy &&
    (isGroup || shouldRoutePrivate(deps.config, deps.policy, decision.chatId, inboundThreadId))
  ) {
    // Open a status before dispatch — symmetric with the legacy path so
    // the user sees "Печатает..." within a tick. Streaming is per-chat
    // gated inside StatusManager.start via shouldStreamForChat(policy,
    // chatId) — chats with `streaming: 'off'` (or chats absent from
    // policy) get a sentinel handle and no Telegram traffic.
    if (deps.statusManager && deps.config.status.enabled) {
      try {
        await deps.statusManager.start(
          decision.chatId,
          ctx.message?.message_id,
          undefined,
          inboundThreadId,
        )
      } catch (err) {
        deps.log.warn('status start failed (continuing without status)', {
          chat_id: decision.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Extract media local paths from descriptors. `photo` and `document`
    // carry localPath (downloaded inline on the eager path); the rest are
    // pure metadata — the tmux session can call `download_attachment` if it
    // wants the bytes. This list, not the <media> attribute, is what
    // multichat-entrypoint.sh renders as the explicit "read these files"
    // bullets — a no-MCP panel leans on it. We filter to defined strings so
    // the DTO never holds `undefined` entries.
    const mediaPaths = descriptors
      .map((m) => (hasLocalPath(m) ? m.localPath : undefined))
      .filter((p): p is string => p !== undefined)

    // Reply-context payload: serialise via the same buildChannelContent
    // helper so the tmux side sees the identical `<reply>` block format
    // the master session would have received. Cheap defence against
    // schema drift between the two paths.
    const replyContext = ctx.message?.reply_to_message
      ? buildChannelContent({
          text: '',
          bot: deps.bot,
          reply: adaptReply(ctx.message.reply_to_message)!,
        })
      : undefined

    // Quote target (2026-11-11, owner's rule): when the trigger quote-replies
    // SOMEONE ELSE and tags the bot, the answer must thread to that original
    // question — not to the message that merely tagged us. A reply to the bot
    // itself carries no target, so the router falls back to the trigger id.
    const repliedMsg = ctx.message?.reply_to_message
    const replyToOriginalId =
      repliedMsg !== undefined && repliedMsg.from?.id !== deps.bot.id
        ? String(repliedMsg.message_id)
        : undefined

    // Forward attribution, same serialisation trick — the per-chat session
    // must learn that the sender is quoting someone else, not speaking.
    const routerForward = adaptForward(ctx.message)
    const forwardContext =
      routerForward !== undefined
        ? buildChannelContent({ text: '', bot: deps.bot, forward: routerForward })
        : undefined

    const inboundMsg: InboundMessage = {
      text: buildText(),
      chat_id: decision.chatId,
      user_id: decision.senderId,
      // Display name first: the handle already travels in `username` below,
      // and preferring it here made the two fields identical for everyone who
      // has one — the per-chat session could then only ever address people by
      // @handle, never by the name they chose.
      user:
        ctx.from?.first_name !== undefined
          ? ctx.from.first_name
          : ctx.from?.username !== undefined
            ? ctx.from.username
            : 'unknown',
      // Raw @-handle with no fallback — `user` above cannot say whether its
      // value is a handle or a first_name, and the child session needs the
      // real one to address the participant.
      ...(ctx.from?.username !== undefined ? { username: ctx.from.username } : {}),
      timestamp: new Date().toISOString(),
      ...(replyContext !== undefined ? { reply_context: replyContext } : {}),
      ...(forwardContext !== undefined ? { forward_context: forwardContext } : {}),
      ...(mediaPaths.length > 0 ? { media_paths: mediaPaths } : {}),
      // Carry the rendered <media …/> descriptors (voice transcript lives
      // here). Without this the router path dropped them and the per-chat
      // session received an empty body — the DM/legacy path below folds the
      // same strings into buildChannelContent (2026-07-20 voice fix).
      ...(renderedMedia.length > 0 ? { media_descriptors: renderedMedia } : {}),
      ...(ctx.message?.message_id !== undefined
        ? { message_id: String(ctx.message.message_id) }
        : {}),
      ...(replyToOriginalId !== undefined
        ? { reply_to_message_id: replyToOriginalId }
        : {}),
      ...(inboundThreadId !== undefined
        ? { message_thread_id: String(inboundThreadId) }
        : {}),
    }

    deps.log.info('inbound dispatched to router', { kind, chat_id: decision.chatId })
    try {
      await deps.router.dispatch(inboundMsg)
    } catch (err) {
      // Router errors are logged and swallowed inside dispatch() for the
      // pool/spawn/inbox-write branches, but a top-level throw is still
      // possible (e.g. policy mutation mid-flight). Surface as throw so
      // the poller dead-letters the update — symmetric with the legacy
      // sendChannelNotification path.
      throw new Error(
        `router dispatch failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }

  // Legacy path: MCP-notify the master Claude session. Kept for the
  // single-chat (DM-only) wiring; will be removed once all deployments
  // run multichat.
  const forwardOrigin = adaptForward(ctx.message)
  const content = buildChannelContent({
    text: buildText(),
    bot: deps.bot,
    ...(ctx.message?.reply_to_message
      ? { reply: adaptReply(ctx.message.reply_to_message)! }
      : {}),
    ...(renderedMedia.length > 0 ? { mediaDescriptors: renderedMedia } : {}),
    ...(forwardOrigin !== undefined ? { forward: forwardOrigin } : {}),
  })

  const event: ChannelEvent = {
    content,
    meta: buildMeta(decision, ctx),
  }

  // Open a status before notifying the channel — this way the user sees
  // "Печатает..." within a tick of sending their message, not after the
  // first tool call completes. Errors here are best-effort: a failed
  // sendMessage must not block delivery of the actual channel event.
  if (deps.statusManager && deps.config.status.enabled) {
    const replyTo = ctx.message?.message_id
    try {
      await deps.statusManager.start(decision.chatId, replyTo, undefined, inboundThreadId)
    } catch (err) {
      deps.log.warn('status start failed (continuing without status)', {
        chat_id: decision.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  deps.log.info('inbound delivered', { kind, chat_id: decision.chatId })
  const delivered = await sendChannelNotification(deps.server, event, deps.log)
  if (!delivered) {
    // Throw so the poller dead-letters this update AND advances offset (it
    // does that on every handler throw). We never want infinite redelivery
    // for a notify-transport failure — the channel may be torn down.
    throw new Error('channel notify failed — message dead-lettered')
  }
}

// ─────────────────────────────────────────────────────────────────────
// Guest Mode (Bot API 10.0) — handle a one-shot guest @-mention from a
// chat the bot is NOT a member of.
//
// Deliberately does NOT reuse gateAndNotify: the gate there reasons
// about chats the bot belongs to (DM allowlist / multichat policy),
// while a guest message arrives from an arbitrary foreign chat. The
// only authentication primitive that makes sense is the CALLER user id
// — fail-closed against resolveGuestModeAllowedUserIds. Everything
// about the drop path is silent (no reaction, no answerGuestQuery
// spent) so strangers mentioning the bot learn nothing.
//
// No status bubble and no router dispatch: the bot cannot sendMessage
// into the foreign chat (not a member), and guest interactions are
// one-shot by contract — they always flow to the master session via
// the MCP notify path with `guest_query_id` in meta. The reply tool
// closes the loop through answerGuestQuery.
//
// A guest's OWN media takes the same eager path as a DM attachment:
// photos and documents are downloaded, voice is transcribed. Only the
// kinds that stay metadata-only (video, sticker, …) can still drop as
// empty when they arrive without a caption.
// ─────────────────────────────────────────────────────────────────────

export async function handleGuestMessage(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (!resolveGuestModeEnabled(deps.config)) return

  const msg = ctx.update?.guest_message
  if (!msg) return

  // Caller identity: Bot API docs describe guest_bot_caller_user on the
  // outbound SentGuestMessage; on the inbound update the mentioning user
  // is `from`. We accept either (caller wins) and fail closed when both
  // are absent.
  const caller = msg.guest_bot_caller_user ?? msg.from
  if (caller === undefined) {
    deps.log.debug('guest_message dropped', { reason: 'missing_caller' })
    return
  }
  const allowed = new Set(
    resolveGuestModeAllowedUserIds(deps.config).map((n) => String(n)),
  )
  if (!allowed.has(String(caller.id))) {
    deps.log.info('guest_message dropped', {
      reason: 'caller_not_allowed',
      caller_id: caller.id,
      chat_id: msg.chat?.id,
    })
    return
  }

  const guestQueryId = msg.guest_query_id
  if (guestQueryId === undefined || guestQueryId === '') {
    deps.log.warn('guest_message without guest_query_id — dropped', {
      chat_id: msg.chat?.id,
    })
    return
  }

  const text = (msg.text ?? msg.caption ?? '').trim()

  // Wiring check sits AFTER the caller gate on purpose: a stranger must
  // never learn anything from a misconfigured deployment either. It still
  // precedes register(), so an unwired build drops loudly instead of
  // registering into the void.
  if (deps.guestQueries === undefined) {
    deps.log.error('guest_message dropped — guest_mode.enabled but no GuestQueryRegistry wired', {
      hint: 'server.ts must construct GuestQueryRegistry when guest_mode.enabled',
    })
    return
  }

  // The guest CALLER is allowlisted (gated above), so the guest's OWN media
  // is handled exactly like a DM attachment: photo eager-downloaded to the
  // inbox, voice transcribed, everything else surfaced as a descriptor. This
  // is the SAME shared builder the DM per-kind handlers use. Computed BEFORE
  // the drop gate so a media-only mention is never dropped for empty text.
  const descriptors = await buildOwnMediaDescriptors(msg, {
    photo: mediaDownloadDeps(deps),
    document: mediaDownloadDeps(deps),
    voice: voiceTranscribeDeps(deps),
  })
  const renderedMedia = descriptors.map(renderMediaDescriptor)

  // Drop only when the mention carries NOTHING — no text/caption AND no
  // media. A media-only @-mention (e.g. a photo with no caption) is a
  // legitimate request and must survive (the pre-fix gate dropped it before
  // media was ever looked at).
  if (text === '' && renderedMedia.length === 0) {
    deps.log.info('guest_message dropped', { reason: 'empty_text', chat_id: msg.chat?.id })
    return
  }

  const chatIdStr = msg.chat?.id !== undefined ? String(msg.chat.id) : undefined
  const admitted = deps.guestQueries.register({
    guestQueryId,
    callerUserId: String(caller.id),
    ...(chatIdStr !== undefined ? { callerChatId: chatIdStr } : {}),
    messageText: text,
  })
  if (!admitted) {
    // Registry at cap with every entry inflight — pathological (needs 64
    // concurrent unanswered claims). Dropping is safer than evicting an
    // inflight entry and stranding its post-failure retry.
    deps.log.warn('guest_message dropped — registry at capacity, all entries inflight', {
      caller_id: caller.id,
      chat_id: chatIdStr,
    })
    return
  }

  const guestForward = adaptForward(msg)
  const content = buildChannelContent({
    text,
    bot: deps.bot,
    ...(renderedMedia.length > 0 ? { mediaDescriptors: renderedMedia } : {}),
    ...(msg.reply_to_message ? { reply: adaptReply(msg.reply_to_message)! } : {}),
    ...(guestForward !== undefined ? { forward: guestForward } : {}),
  })

  const meta: Record<string, string> = {
    source: 'telegram',
    guest: '1',
    guest_query_id: guestQueryId,
    user_id: String(caller.id),
    ts: new Date().toISOString(),
  }
  if (chatIdStr !== undefined) meta.chat_id = chatIdStr
  if (msg.message_id !== undefined) meta.message_id = String(msg.message_id)

  deps.log.info('guest inbound delivered', {
    caller_id: caller.id,
    chat_id: chatIdStr,
    pending: deps.guestQueries.pendingCount(),
  })
  const delivered = await sendChannelNotification(deps.server, { content, meta }, deps.log)
  if (!delivered) {
    throw new Error('channel notify failed — guest message dead-lettered')
  }
}

// ─────────────────────────────────────────────────────────────────────
// Album path — buffer media-group items and emit ONE combined channel
// notification after `config.album.flush_ms` of silence. Mirrors
// gateway.py:3154-3234 (_buffer_media_group + _flush_media_group).
// ─────────────────────────────────────────────────────────────────────

// Try to route this update into the album buffer. Returns true if the
// item was buffered (caller MUST NOT continue with single-media path).
// Returns false when the message has no media_group_id or no buffer
// configured — caller proceeds with the existing gateAndNotify flow.
//
// Bug #1 (TASK-4): the buffer key is `${chatId}:${media_group_id}`, not
// the raw mgid. Telegram can re-use mgids across chats, so two chats
// sending an album within the same time window would otherwise merge —
// captions/media from chat B would dispatch under chat A's identity.
//
// Bug #2 (TASK-4): every fragment is persisted to disk BEFORE the buffer
// receives it. The poller advances its offset cursor as soon as the
// handler returns, so without this any of (a) plugin crash before the
// flush timer fires, (b) router/MCP failure inside the flush callback,
// (c) shutdown drain that fails — would silently lose fragments. The
// on-disk dir is the source of truth: the flush callback walks it,
// dispatches once, and only then drops the dir. On flush failure the
// dir is moved into `<state>/albums/dead-letter/`.
async function tryRouteToAlbumBuffer(
  ctx: Context,
  deps: HandlerDeps,
  buildDescriptors: () => Promise<MediaDescriptor[]>,
  kind: string,
): Promise<boolean> {
  const mgid = ctx.message?.media_group_id
  if (!mgid) return false
  if (!deps.albumBuffer) return false

  // Gate FIRST — never download/transcribe for non-allowlisted senders,
  // and never start an album buffer entry for a dropped sender either
  // (otherwise allowlisted noise could be merged into a denied bucket).
  const input = gateInputFromContext(ctx)
  const decision = gateTelegramMessage(input, deps.config, deps.policy)
  if (decision.kind === 'drop') {
    deps.log.debug('inbound dropped', {
      reason: decision.reason,
      chat_type: input.chatType,
      kind,
      sender_id: input.senderId,
      chat_id: input.chatId,
    })
    return true // we *handled* it (by dropping) — do NOT fall through
  }

  // FIX-D M1 (2026-05-27) — policy/router XOR defence-in-depth, mirrors
  // the same check in gateAndNotify. A group album buffered without a
  // router wired alongside policy would otherwise fall through to the
  // legacy notify path at flush time, leaking traffic into the master
  // session. Drop the whole album silently (no buffer entry, no
  // persistence) so even one bad fragment never enters the pipeline.
  const hasPolicy = deps.policy !== undefined
  const hasRouter = deps.router !== undefined
  const isGroup = input.chatType === 'group' || input.chatType === 'supergroup'
  if (isPolicyRouterMisconfig(hasPolicy, hasRouter, isGroup)) {
    deps.log.error('handlers.album.policy_router_misconfig — dropping group album', {
      chat_id: decision.chatId,
      user_id: decision.senderId,
      kind,
      has_policy: hasPolicy,
      has_router: hasRouter,
      chat_type: input.chatType,
      media_group_id: mgid,
      hint: 'policy and router MUST be wired together; configure both or neither',
    })
    return true
  }

  // FIX-D B1 (2026-05-27) — album aggregate addressing.
  //
  // Pre-FIX-D: a group fragment that wasn't itself addressed was dropped
  // here. That broke real albums: Telegram puts the caption/@mention on
  // ONE fragment (typically the first), and the rest arrive bare. The
  // captioned fragment would pass; siblings dropped silently → the agent
  // saw a one-photo "album" while the user thought they had sent 5.
  //
  // Post-FIX-D: buffer ALL allowlisted-sender fragments and record
  // per-fragment `addressedAtPush`. At flush time the dispatcher
  // aggregates with `.some(...)` — any addressed fragment ⇒ whole album
  // dispatches; zero addressed fragments ⇒ silent drop of the whole
  // album (legitimate group post, NOT an error → no dead-letter).
  //
  // DMs always evaluate to `true` (isAddressedToBot returns true for
  // private chat regardless of mention_allowlist), so private albums
  // behave exactly as before.
  const addressedAtPush = isAddressedToBot(ctx, deps.policy?.mention_allowlist)

  const descriptors = await buildDescriptors()
  const rendered = descriptors.map(renderMediaDescriptor)
  const caption = inboundCaption(ctx).trim()
  const reply = ctx.message?.reply_to_message
    ? adaptReply(ctx.message.reply_to_message)
    : undefined
  const mediaPaths = descriptors
    .map((m) => (hasLocalPath(m) ? m.localPath : undefined))
    .filter((p): p is string => p !== undefined)
  const pushThreadId = threadIdOf(ctx)
  const entry: AlbumEntry = {
    descriptors: rendered,
    mediaPaths,
    caption,
    messageId: ctx.message?.message_id,
    reply,
    forward: adaptForward(ctx.message),
    addressedAtPush,
    ...(pushThreadId !== undefined ? { threadId: pushThreadId } : {}),
  }

  // Open the status transient on first inbound — gateway.py does this
  // on EVERY message but for albums one "Печатает..." per album is more
  // honest about what's happening. We attempt on every push; status
  // manager dedups via isActive check internally (best-effort).
  //
  // FIX-D B1: gate on addressedAtPush. Unaddressed group fragments must
  // stay silent (no "Печатает..." in the chat). If ALL fragments turn
  // out unaddressed the album will be dropped at flush — flashing a
  // typing bubble for it would leak bot activity into a chat that did
  // not summon us.
  if (deps.statusManager && deps.config.status.enabled && addressedAtPush) {
    try {
      await deps.statusManager.start(
        decision.chatId,
        ctx.message?.message_id,
        undefined,
        pushThreadId,
      )
    } catch (err) {
      deps.log.warn('status start failed (continuing without status)', {
        chat_id: decision.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const dispatchDeps: AlbumDispatchDeps = {
    server: deps.server,
    config: deps.config,
    log: deps.log,
    bot: deps.bot,
    telegramApi: deps.telegramApi,
    ...(deps.statusManager !== undefined ? { statusManager: deps.statusManager } : {}),
    ...(deps.router !== undefined ? { router: deps.router } : {}),
    ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
    ...(deps.threadStore !== undefined ? { threadStore: deps.threadStore } : {}),
  }
  const chatIdAtPush = decision.chatId
  const senderIdAtPush = decision.senderId
  // Capture sender's display name at push time — by the time the album
  // flushes the ctx is long gone, and the router DTO requires a `user`.
  // Name before handle, same reasoning as the single-message path above.
  const userAtPush =
    ctx.from?.first_name !== undefined
      ? ctx.from.first_name
      : ctx.from?.username !== undefined
        ? ctx.from.username
        : 'unknown'
  // Raw @-handle (no fallback) — surfaced into the child prompt so the
  // session cites the real username instead of guessing. Undefined when none.
  const usernameAtPush = ctx.from?.username

  // Composite buffer key — see Bug #1 above. The same string is the
  // on-disk dir name for persistence.
  const bufferKey = compositeAlbumKey(chatIdAtPush, mgid)

  // Bug #2 — durability. Persist the fragment to disk BEFORE the
  // poller's offset advances past this update. If anything below this
  // line fails (timer cancellation, crash, flush failure), the
  // on-disk fragment is replayed by `recoverPendingAlbums` at the
  // next startup. Failure to persist degrades to "in-memory only,
  // same as pre-fix behaviour" — we still buffer + log the warning
  // so operators see persistence regressions, but we do not refuse
  // delivery: losing the fragment from disk is strictly worse than
  // losing it from memory (the user still wants their photo to
  // arrive when things are green).
  const meta: PersistedAlbumMeta = {
    chatId: chatIdAtPush,
    senderId: senderIdAtPush,
    user: userAtPush,
    ...(usernameAtPush !== undefined ? { username: usernameAtPush } : {}),
    mediaGroupId: mgid,
    kind,
    firstAt: Date.now(),
  }
  if (deps.statePaths?.root) {
    try {
      await persistFragment(deps.statePaths.root, bufferKey, meta, entry)
    } catch (err) {
      deps.log.warn('album persist failed (continuing in-memory only)', {
        kind,
        media_group_id: mgid,
        chat_id: chatIdAtPush,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  deps.albumBuffer.push(bufferKey, entry, (album) => {
    // Flush callback — dispatch once, then either drop the on-disk dir
    // (success) or move it to dead-letter (failure inside dispatch).
    // We fire-and-forget here because the buffer's timer is sync; the
    // actual delivery / cleanup races the next inbound but cannot
    // double-fire (the buffer entry is already deleted by the time
    // this callback runs).
    void (async () => {
      // `flushOk` is true for either real dispatch OR intentional
      // silent-drop (FIX-D B1: unaddressed group album, FIX-D M1:
      // wiring misconfig). Both are non-errors → drop the on-disk
      // dir. Only a thrown exception escalates to dead-letter.
      let flushOk = true
      try {
        await sendAlbumNotification(
          album,
          {
            chatId: chatIdAtPush,
            senderId: senderIdAtPush,
            user: userAtPush,
            ...(usernameAtPush !== undefined ? { username: usernameAtPush } : {}),
            mediaGroupId: mgid,
            kind,
          },
          dispatchDeps,
        )
      } catch (err) {
        flushOk = false
        deps.log.warn('album dispatch failed — moving to dead-letter', {
          kind,
          media_group_id: mgid,
          chat_id: chatIdAtPush,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (!deps.statePaths?.root) return
      if (flushOk) {
        await dropAlbumDir(deps.statePaths.root, bufferKey).catch((rmErr: unknown) => {
          deps.log.warn('album cleanup failed (dir lingers; harmless)', {
            key: bufferKey,
            error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          })
        })
      } else {
        await moveToAlbumDeadLetter(
          deps.statePaths.root,
          bufferKey,
          'sendAlbumNotification threw during flush',
        ).catch((dlErr: unknown) => {
          deps.log.warn('album dead-letter move failed', {
            key: bufferKey,
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          })
        })
      }
    })()
  })
  deps.log.debug('album buffered', {
    kind,
    media_group_id: mgid,
    chat_id: decision.chatId,
    buffer_key: bufferKey,
  })
  return true
}

/** Outcome of {@link sendAlbumNotification}. The flush wrapper uses it
 *  to decide disk cleanup: `dispatched=true` ⇒ delivery succeeded, drop
 *  the dir. `dispatched=false` with `silentDrop` set ⇒ intentional drop
 *  (e.g. unaddressed group album, wiring misconfig), drop the dir
 *  without dead-lettering. A throw ⇒ delivery failed, dead-letter. */
export interface AlbumDispatchOutcome {
  dispatched: boolean
  /** Reason string when `dispatched=false`. Helps observability and
   *  lets tests assert the specific silent-drop branch that fired. */
  silentDrop?: string
}

// Build one combined channel notification from a flushed Album. Captions
// are merged with blank-line separators (matches gateway.py:3184-3193);
// media descriptors are concatenated in insertion order; meta carries
// album_size and media_group_id so the agent can recognise this as a
// single album rather than a deluge of photos.
export async function sendAlbumNotification(
  album: Album<AlbumEntry>,
  ids: {
    chatId: string
    senderId: string
    user: string
    // Raw @-handle of the sender when they have one — see InboundMessage.
    username?: string
    mediaGroupId: string
    kind: string
  },
  deps: AlbumDispatchDeps,
): Promise<AlbumDispatchOutcome> {
  const isGroup = isGroupChatId(ids.chatId)

  // FIX-D M1 (2026-05-27) — policy/router XOR defence-in-depth at the
  // dispatch site. If we somehow buffered a group album despite the
  // wiring being broken (e.g. recovery from a previous bad-build run),
  // silently drop instead of falling into legacy notify. The dir is
  // dropped by the flush wrapper because this is not a delivery
  // failure, just a wiring refusal.
  const hasPolicy = deps.policy !== undefined
  const hasRouter = deps.router !== undefined
  if (isPolicyRouterMisconfig(hasPolicy, hasRouter, isGroup)) {
    deps.log.error('album.policy_router_misconfig — dropping group album', {
      kind: ids.kind,
      chat_id: ids.chatId,
      media_group_id: ids.mediaGroupId,
      album_size: album.messages.length,
      has_policy: hasPolicy,
      has_router: hasRouter,
      hint: 'policy and router MUST be wired together; configure both or neither',
    })
    return { dispatched: false, silentDrop: 'policy_router_misconfig' }
  }

  // FIX-D B1 (2026-05-27) — aggregate addressing.
  //
  // Telegram puts the @mention/caption on exactly one fragment of an
  // album. Pre-FIX-D we filtered per-fragment at the gate, which dropped
  // every sibling and broke real albums. Now we buffer every allowlisted
  // fragment with a per-fragment `addressedAtPush` flag and aggregate
  // here: if ANY fragment was addressed at push time, the whole album
  // dispatches. If NONE were addressed (group post the user did not
  // direct at the bot), the album drops silently — legitimate content,
  // not an error, so no dead-letter.
  //
  // Back-compat with disk-recovered entries: `addressedAtPush` may be
  // undefined on entries written by pre-FIX-D builds. We treat undefined
  // as true (those builds only persisted addressed fragments at the gate).
  const aggregateAddressed = album.messages.some(
    (m) => m.addressedAtPush === undefined || m.addressedAtPush === true,
  )
  if (!aggregateAddressed) {
    deps.log.debug('album.not_addressed_aggregate — dropping silently', {
      kind: ids.kind,
      chat_id: ids.chatId,
      media_group_id: ids.mediaGroupId,
      album_size: album.messages.length,
    })
    return { dispatched: false, silentDrop: 'aggregate_not_addressed' }
  }

  // Merge captions: non-empty in order, joined by blank line. This matches
  // gateway.py's `"\n\n".join(captions)`. When every caption is empty the
  // merged text is empty — buildChannelContent skips it correctly.
  const captions = album.messages.map((m) => m.caption).filter((c) => c.length > 0)
  const mergedText = captions.join('\n\n')

  // Concatenate all media descriptors in insertion order.
  const combinedDescriptors: string[] = []
  for (const m of album.messages) {
    for (const d of m.descriptors) combinedDescriptors.push(d)
  }

  // First non-null reply wins. Albums rarely contain replies, but if the
  // user replied with the first photo of the album we forward that context.
  const reply = album.messages.find((m) => m.reply !== undefined)?.reply

  // Same first-wins rule for forward attribution: Telegram stamps
  // forward_origin on every fragment of a forwarded album.
  const albumForward = album.messages.find((m) => m.forward !== undefined)?.forward

  // First defined forum-topic thread wins — so the album
  // reply lands in the same topic. Record it as the chat's default thread too,
  // matching gateAndNotify's single-message behaviour.
  const albumThreadId = album.messages.find((m) => m.threadId !== undefined)?.threadId
  deps.threadStore?.record(ids.chatId, albumThreadId)

  // Router path: GROUP albums go to the per-chat session (merged caption
  // + every downloaded media path). Private-DM albums fall through to the
  // legacy notify path below by default, landing in the master
  // session — symmetric with the single-message branch
  // in gateAndNotify, including the variant-A `route_private` opt-in.
  // Reuse the `isGroup` local set above (isGroupChatId(ids.chatId)) — it
  // is the only group signal here since the original Context/chatType is
  // gone by album flush time. Channel-type posts never reach this path
  // (gate.ts drops chatType==='channel' before buffering), so the
  // negative-id check cannot misclassify a channel as a group here.
  if (
    deps.router &&
    deps.policy &&
    (isGroup || shouldRoutePrivate(deps.config, deps.policy, ids.chatId, albumThreadId))
  ) {
    const combinedMediaPaths: string[] = []
    for (const m of album.messages) {
      for (const p of m.mediaPaths) combinedMediaPaths.push(p)
    }
    const replyContext = reply
      ? buildChannelContent({ text: '', bot: deps.bot, reply })
      : undefined
    const forwardContext = albumForward
      ? buildChannelContent({ text: '', bot: deps.bot, forward: albumForward })
      : undefined
    // First available message_id in the album — Telegram attaches the
    // @mention to one fragment; any fragment's id anchors the quote-reply.
    const albumMessageId = album.messages.find(
      (m) => m.messageId !== undefined,
    )?.messageId
    // Quote target (2026-11-11): when the album replies to SOMEONE ELSE, the
    // answer must thread to that quoted question, not to the album that merely
    // tagged us. Mirrors `replyToOriginalId` on the single-message router path;
    // a reply to the bot itself carries no target, so the router falls back to
    // the album's own message_id.
    const albumReplyToOriginalId =
      reply !== undefined && reply.from?.id !== deps.bot.id
        ? String(reply.message_id)
        : undefined
    const inboundMsg: InboundMessage = {
      text: mergedText,
      chat_id: ids.chatId,
      user_id: ids.senderId,
      user: ids.user,
      ...(ids.username !== undefined ? { username: ids.username } : {}),
      timestamp: new Date().toISOString(),
      ...(replyContext !== undefined ? { reply_context: replyContext } : {}),
      ...(forwardContext !== undefined ? { forward_context: forwardContext } : {}),
      ...(combinedMediaPaths.length > 0 ? { media_paths: combinedMediaPaths } : {}),
      // Carry the rendered <media …/> descriptors too (2026-09-09). Only
      // photos and documents have a `localPath`, so `media_paths` alone
      // leaves an album of voice/video with nothing at all — a per-topic
      // session then gets an empty prompt and the agent reports "no files
      // arrived". Mirrors the same field on the single-message router path.
      ...(combinedDescriptors.length > 0
        ? { media_descriptors: combinedDescriptors }
        : {}),
      ...(albumMessageId !== undefined ? { message_id: String(albumMessageId) } : {}),
      ...(albumReplyToOriginalId !== undefined
        ? { reply_to_message_id: albumReplyToOriginalId }
        : {}),
      ...(albumThreadId !== undefined ? { message_thread_id: String(albumThreadId) } : {}),
    }
    deps.log.info('album dispatched to router', {
      kind: ids.kind,
      chat_id: ids.chatId,
      media_group_id: ids.mediaGroupId,
      album_size: album.messages.length,
    })
    // Bug #2 (TASK-4): throw on router failure so the caller's
    // flush-callback can move the on-disk album dir into dead-letter
    // instead of silently logging "content lost".
    await deps.router.dispatch(inboundMsg)
    return { dispatched: true }
  }

  const content = buildChannelContent({
    text: mergedText,
    bot: deps.bot,
    ...(reply ? { reply } : {}),
    ...(combinedDescriptors.length > 0 ? { mediaDescriptors: combinedDescriptors } : {}),
    ...(albumForward ? { forward: albumForward } : {}),
  })

  const firstMessageId = album.messages[0]?.messageId
  const meta: Record<string, string> = {
    source: 'telegram',
    chat_id: ids.chatId,
    user_id: ids.senderId,
    ts: new Date().toISOString(),
    album_size: String(album.messages.length),
    media_group_id: ids.mediaGroupId,
  }
  if (firstMessageId !== undefined) {
    meta.message_id = String(firstMessageId)
  }
  if (albumThreadId !== undefined) {
    meta.message_thread_id = String(albumThreadId)
  }

  const event: ChannelEvent = { content, meta }
  deps.log.info('album delivered', {
    kind: ids.kind,
    chat_id: ids.chatId,
    media_group_id: ids.mediaGroupId,
    album_size: album.messages.length,
  })
  const delivered = await sendChannelNotification(deps.server, event, deps.log)
  if (!delivered) {
    // Bug #2 (TASK-4): throw so the caller dead-letters the on-disk
    // album dir. Pre-fix this logged "content lost"; now persistence
    // gives us a recovery path.
    throw new Error(
      `album notify failed — channel transport refused delivery (mgid=${ids.mediaGroupId})`,
    )
  }
  return { dispatched: true }
}

// ─────────────────────────────────────────────────────────────────────
// Text handler — no media descriptors.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundText(ctx: Context, deps: HandlerDeps): Promise<void> {
  // capRichBody: `text` can be a rich block tree the middleware flattened,
  // which is bounded by neither Telegram's 4096-char limit nor the middleware.
  const text = capRichBody(ctx.message?.text ?? '', ctx.message)

  // Open-question reminder: the owner has written something in this chat, so
  // whatever question was pending here is no longer worth a nudge. Done FIRST,
  // before any of the verdict / «Другое» branches below — each of them can
  // `return` early, and a skipped clear means reminding him about a question he
  // just answered. Fail-open: a store fault must not touch inbound handling.
  const inboundChatId = ctx.chat?.id
  if (inboundChatId !== undefined) {
    try {
      deps.openQuestions?.clear(String(inboundChatId))
    } catch (err) {
      deps.log.debug('open-question clear on inbound failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // fix/eyes-on-read (2026-05-28): the 👀 read receipt is NO LONGER set
  // here. Setting it at bot-receive time made 👀 mean "the bot saw the
  // update", not "the agent read it" — if a turn was busy, the message queued
  // while the eyes already showed, so the signal lied. The reaction now
  // fires deterministically from the Stop hook (scripts/read-receipt-hook.ts
  // → POST /hooks/react) once the message has actually entered and been read
  // in a session turn. This covers every message type (text, voice, photo,
  // document) and both the DM and per-chat multichat sessions uniformly,
  // because all of them run the same Stop hook against their transcript.

  // FIX-T1 F3 (PRX-1 Phase 5, 2026-05-27): permission verdicts ALWAYS take
  // priority over the AskUserQuestion «Other» text consumer. Previously the
  // Other-text path ran first and would swallow a perfectly-formed
  // `yes <id>` / `no <id>` reply — the permission relay timed out and the
  // owner's intent was lost. SECURITY gate: live permission verdict
  // wins so the approve/deny channel cannot be hijacked by a parallel
  // AskUserQuestion prompt.
  //
  // DM-only guard: permission verdicts MUST come from a private chat. In a
  // group/supergroup/channel we fall through to the normal channel forward
  // so the agent still sees the text — we never emit a verdict from a
  // non-DM context.
  if (deps.permissionHooks && ctx.from?.id !== undefined && ctx.chat?.type === 'private') {
    const decision = parsePermissionTextReply(text)
    if (decision && isPermissionApprover(ctx.from.id, deps.config)) {
      if (deps.permissionHooks.isPending(decision.requestId)) {
        deps.permissionHooks.consumePending(decision.requestId)
        await deps.permissionHooks.emitVerdict(decision)
        const chatNum = ctx.chat?.id
        const msgId = ctx.message?.message_id
        if (chatNum !== undefined && msgId !== undefined) {
          const emoji = decision.behavior === 'allow' ? '✅' : '❌'
          try {
            await deps.telegramApi.setMessageReaction(String(chatNum), msgId, emoji)
          } catch (err) {
            deps.log.debug('permission text reply reaction failed', {
              chat_id: String(chatNum),
              message_id: msgId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        deps.log.info('permission text verdict', {
          request_id: decision.requestId,
          behavior: decision.behavior,
        })
        return
      }
      deps.log.warn('permission text reply with unknown request_id', {
        request_id: decision.requestId,
      })
      // fall through — text might genuinely be "yes abcde fix it" if the user
      // ever starts a sentence that way. Channel sees the message.
    }
  }

  // PRX-1 TASK-2 (2026-05-27): AskUserQuestion «Other» text-reply
  // consumption. Runs AFTER the permission-reply gate so a live `yes <id>`
  // / `no <id>` verdict is never swallowed (FIX-T1 F3). The UI itself
  // enforces:
  //   - approver allowlist (only the owner may answer)
  //   - reply_to_message_id matches the awaiting prompt (FIX-T1 F4 — narrow
  //     hijack surface; only an explicit reply to «Введи ответ» consumes
  //     the awaiting slot, freeform text falls through to channel forward)
  if (
    deps.askUserQuestionUi
    && ctx.from?.id !== undefined
    && ctx.chat?.id !== undefined
  ) {
    const replyToId = ctx.message?.reply_to_message?.message_id
    const consumed = await deps.askUserQuestionUi.tryHandleOtherText({
      chatId: String(ctx.chat.id),
      fromUserId: ctx.from.id,
      text,
      ...(replyToId !== undefined ? { replyToMessageId: replyToId } : {}),
    })
    if (consumed) return
  }
  // OOB short-circuit: when the sender is allowed AND the chat is a DM AND
  // the text parses as a known /command, handle it inline and DO NOT fall
  // through to the normal channel notification. Mirrors gateway.py:3037-3133
  // (_is_oob_command + _handle_oob_command running on the producer thread
  // before the consumer ever sees the update).
  const parsed = parseOobCommand(text, deps.bot.username)
  if (parsed) {
    const chatType = ctx.chat?.type
    const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined
    const senderId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined
    const senderNum = ctx.from?.id
    const chatNum = ctx.chat?.id
    const allowedSender =
      senderNum !== undefined
      && deps.config.allowed_user_ids.includes(senderNum)
    // Defence-in-depth: even DM from allowed user must come from a chat in
    // allowed_chat_ids. The allowlists can drift (chat list tighter than user
    // list); without this check an OOB command could run from an unverified
    // chat slot. Coerce config ids to string for comparison since the gate
    // does the same elsewhere.
    const allowedChatSet = new Set(deps.config.allowed_chat_ids.map((v) => String(v)))
    const allowedChat = chatNum !== undefined && allowedChatSet.has(String(chatNum))
    if (chatType === 'private' && chatId && senderId && allowedSender && allowedChat) {
      // /keys + /cc target the SAME pane as the cooperative /stop interrupt.
      const tmuxKeysTarget = resolveTmuxKeysTarget(deps.config.tmux_mirror.pane_target)
      const oobCtx: OobContext = {
        chatId,
        senderId,
        config: deps.config,
        telegramApi: deps.telegramApi,
        log: deps.log,
        botId: deps.bot.id,
        stateDir: deps.statePaths.root,
        // Real /stop interrupt: Escape to the agent's own tmux pane.
        interruptTurn: () => interruptCurrentTurn(deps.config.tmux_mirror.pane_target, deps.log),
        ...(tmuxKeysTarget ? { tmuxKeys: { target: tmuxKeysTarget } } : {}),
        // `/new` presses /clear on the owner's single global pane — scope it to
        // the owner DM exactly like the `newq:confirm` button does.
        ownerChatIds: resolveOwnerChatIds(deps.config),
        // Idempotency key source for `/lease` — a replayed command grants ONE
        // lease instead of minting a second one.
        ...(ctx.message?.message_id !== undefined ? { messageId: ctx.message.message_id } : {}),
        ...(deps.statusManager
          ? {
              statusManager: {
                isActive: (id: string) => deps.statusManager!.isActive(id),
                cancel: (id: string, reason: string) => deps.statusManager!.cancel(id, reason),
              },
            }
          : {}),
        ...(deps.tmuxMirror ? { tmuxMirror: deps.tmuxMirror } : {}),
      }
      const result = await handleOobCommand(parsed, oobCtx)
      await executeOobResult(result, oobCtx, deps.server)
      return
    }
  }

  // PR-A3 watcher hook (after OOB resolution, before gate/notify): if Claude
  // is mid-tool for this chat, auto-reply «Агент занят». Gated on the
  // allowlist — only allowed senders in allowed chats can trigger it.
  // Fire-and-forget — channel-notification latency must NOT depend on the
  // auto-reply round-trip. Auto-reply does NOT replace the channel notification
  // — gateAndNotify still runs below so Claude sees the message normally.
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)

  await gateAndNotify(ctx, deps, () => text, undefined, 'text')
}

// ─────────────────────────────────────────────────────────────────────
// Eager media-descriptor deps, derived from HandlerDeps. The per-kind
// handlers below are thin wrappers over the shared builders in
// media-descriptors.ts — the builders are the single source of truth for
// descriptor shape, reused by the guest path (own media) and the reply
// path (metadata only).
// ─────────────────────────────────────────────────────────────────────

// Download deps for ANY inbound file kind — photo and document both land in
// the inbox through it (the type keeps its original name upstream).
function mediaDownloadDeps(deps: HandlerDeps): MediaDownloadDeps {
  return { botApi: deps.botApi, botToken: deps.botToken, inboxDir: deps.statePaths.inbox }
}

function voiceTranscribeDeps(deps: HandlerDeps): VoiceTranscribeDeps {
  return {
    config: deps.config,
    env: deps.env,
    downloadFile: (fileId: string) =>
      deps.telegramApi.downloadFile(fileId, deps.statePaths.inbox),
    log: deps.log,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Photo — picks largest size, downloads to inbox after the gate allows.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundPhoto(ctx: Context, deps: HandlerDeps): Promise<void> {
  // PR-A3: same watcher hook as text. Media handlers must surface
  // «Агент занят» too — otherwise a busy-session photo/voice silently waits.
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildPhoto = (): Promise<MediaDescriptor[]> =>
    buildPhotoDescriptor(ctx.message?.photo, mediaDownloadDeps(deps))
  if (await tryRouteToAlbumBuffer(ctx, deps, buildPhoto, 'photo')) return
  await gateAndNotify(ctx, deps, () => inboundCaption(ctx), buildPhoto, 'photo')
}

// ─────────────────────────────────────────────────────────────────────
// Document — downloaded to the inbox, like a photo.
//
// It used to be metadata-only, on the assumption that the agent fetches it
// itself via the download_attachment MCP tool. That holds in a DM session;
// a multichat/topic panel runs a BARE claude with no MCP tools, so there the
// agent was left holding a file_id it could never open (2026-11-17).
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundDocument(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  // A GIF arrives as `animation` AND `document` at once, and both handlers are
  // registered. The animation handler owns it — otherwise the download would
  // run twice. Same dedupe as in buildOwnMediaDescriptors.
  const doc = ctx.message?.animation ? undefined : ctx.message?.document
  const buildDoc = (): Promise<MediaDescriptor[]> =>
    buildDocumentDescriptorWithDownload(doc, mediaDownloadDeps(deps))
  if (await tryRouteToAlbumBuffer(ctx, deps, buildDoc, 'document')) return
  await gateAndNotify(ctx, deps, () => inboundCaption(ctx), buildDoc, 'document')
}

// ─────────────────────────────────────────────────────────────────────
// Voice — calls Groq Whisper if GROQ_API_KEY is set. Transcript folds into
// the descriptor; failure does not crash.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVoice(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => inboundCaption(ctx),
    () => buildVoiceDescriptor(ctx.message?.voice, voiceTranscribeDeps(deps)),
    'voice',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Audio — metadata only (title/performer for songs).
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundAudio(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildAudio = async (): Promise<MediaDescriptor[]> =>
    buildAudioDescriptor(ctx.message?.audio)
  if (await tryRouteToAlbumBuffer(ctx, deps, buildAudio, 'audio')) return
  await gateAndNotify(ctx, deps, () => inboundCaption(ctx), buildAudio, 'audio')
}

// ─────────────────────────────────────────────────────────────────────
// Video — metadata only.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVideo(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildVideo = async (): Promise<MediaDescriptor[]> =>
    buildVideoDescriptor(ctx.message?.video)
  if (await tryRouteToAlbumBuffer(ctx, deps, buildVideo, 'video')) return
  await gateAndNotify(ctx, deps, () => inboundCaption(ctx), buildVideo, 'video')
}

// ─────────────────────────────────────────────────────────────────────
// Animation (GIF / silent looping MP4) — metadata only. Telegram sets the
// `document` field on the same message for backward compatibility, so the
// server MUST register this handler BEFORE `message:document` (otherwise
// the document handler swallows the GIF and it never gets an animation
// descriptor). Mirrors handleInboundVideo — an animation is a soundless
// short video from the API's point of view.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundAnimation(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildAnimation = async (): Promise<MediaDescriptor[]> =>
    buildAnimationDescriptor(ctx.message?.animation)
  if (await tryRouteToAlbumBuffer(ctx, deps, buildAnimation, 'animation')) return
  await gateAndNotify(ctx, deps, () => inboundCaption(ctx), buildAnimation, 'animation')
}

// ─────────────────────────────────────────────────────────────────────
// Video note — round selfie videos. Always square, no name/mime in the
// Telegram object (only length+duration+thumb).
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVideoNote(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    // Telegram gives a video note no caption field, but the rich fallback
    // costs nothing and keeps every media handler symmetric — a caption shape
    // we have not seen must never be swallowed again.
    () => inboundCaption(ctx),
    () => Promise.resolve(buildVideoNoteDescriptor(ctx.message?.video_note)),
    'video_note',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sticker — emoji + optional set name.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundSticker(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => inboundCaption(ctx),
    () => Promise.resolve(buildStickerDescriptor(ctx.message?.sticker)),
    'sticker',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Rich Message inbound.
//
// A message Telegram rendered as a Rich Message (Bot API 10.1) carries NO
// `text` and NO `caption` — the body is a block tree under `rich_message`.
// Forwarding such a message therefore matched NONE of the per-type
// subscriptions (`message:text` needs `text`), so it fell off the end of the
// middleware chain: the 👀 receipt fired, then the forward was lost without
// an error or dead-letter entry.
//
// The quote path already knew how to read the tree (buildReplyContext →
// flattenRichMessage); this reuses that flattener for the inbound body.
// ─────────────────────────────────────────────────────────────────────

/** True when a message's body lives in `rich_message` (no text/caption). */
export function hasRichBody(message: unknown): boolean {
  return extractRichMessage(message) !== undefined
}

// Shown instead of an empty body. A rich payload we cannot flatten must still
// wake the agent — it can ask the sender to resend as plain text. Silence was
// the whole defect, so an ugly placeholder beats a lost message.
const RICH_UNREADABLE =
  '[Telegram rich_message без читаемого текста — попроси отправителя переслать текстом]'

/**
 * Ceiling for a flattened inbound rich body. Plain `text` is bounded by
 * Telegram's own ~4096-char message limit; a `rich_message` block tree is not
 * (the flattener's RICH_MAX_DEPTH guard already treats it as attacker-shaped),
 * and the quote path has capped its own flattened body at REPLY_BODY_MAX since
 * day one. 32000 is Telegram's documented rich-message payload size, so a
 * legitimate message always passes through whole.
 */
export const INBOUND_RICH_MAX = 32_000

const RICH_TRUNCATED_MARK = '\n…[обрезано: rich_message длиннее лимита]'

/**
 * Flattened body of a message's `rich_message`, capped at INBOUND_RICH_MAX.
 * Returns '' when the message carries no rich payload or no readable text —
 * callers decide whether that means "fall back to caption" or "placeholder".
 */
export function richBodyOf(message: unknown): string {
  return capRichBody(flattenRichMessage(extractRichMessage(message)), message)
}

/**
 * INBOUND_RICH_MAX applied to a body that may have come out of
 * `rich_message` — including one the ported upstream middleware
 * (src/telegram/rich-inbound.ts) already flattened into `text`/`caption`.
 * That middleware runs before every filter and caps nothing, and a typed
 * handler ends the chain, so `handleInboundRich` — which used to be the only
 * holder of this ceiling — never runs for such a message. Without this the
 * ceiling added in PR #22 would be reachable only for payloads the upstream
 * flattener could not read at all.
 *
 * Plain Telegram text is bounded at ~4096 chars by the API itself, so a
 * message with no `rich_message` is passed through untouched.
 */
function capRichBody(body: string, message: unknown): string {
  if (!hasRichBody(message) || body.length <= INBOUND_RICH_MAX) return body
  return body.slice(0, INBOUND_RICH_MAX) + RICH_TRUNCATED_MARK
}

/**
 * Caption text for a media message. Falls back to the rich body because a
 * typed handler (`message:photo` …) matches and ENDS the middleware chain
 * before the rich catch-all runs — without this fallback a rich-formatted
 * caption would be swallowed into '', the same silent loss one level deeper.
 */
function inboundCaption(ctx: Context): string {
  const caption = ctx.message?.caption
  if (caption !== undefined && caption.length > 0) return capRichBody(caption, ctx.message)
  return richBodyOf(ctx.message)
}

export async function handleInboundRich(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => {
      const body = richBodyOf(ctx.message)
      return body.length > 0 ? body : RICH_UNREADABLE
    },
    undefined,
    'rich',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Catch-all for message types no handler claims.
//
// `rich_message` was lost because the inbound router was a closed list of
// eight types with no else-branch — a shape Telegram added later could only
// disappear. This branch makes the next such shape loud: anything carrying
// sender content is delivered with a flag, and pure service updates (someone
// joined, title changed, …) are logged for the operator and go no further —
// forwarding those would spam the agent on every group event.
// ─────────────────────────────────────────────────────────────────────

// Envelope fields present on every message — not content, never a reason to
// forward.
const MESSAGE_ENVELOPE_KEYS = new Set([
  'message_id',
  'message_thread_id',
  'date',
  'edit_date',
  'chat',
  'from',
  'sender_chat',
  'sender_boost_count',
  'sender_business_bot',
  'business_connection_id',
  'is_topic_message',
  'is_automatic_forward',
  'is_from_offline',
  'reply_to_message',
  'external_reply',
  'quote',
  'reply_to_story',
  'via_bot',
  'has_protected_content',
  'media_group_id',
  'author_signature',
  'effect_id',
  'link_preview_options',
  'reply_markup',
  'show_caption_above_media',
  'has_media_spoiler',
  'entities',
  'caption_entities',
  'forward_origin',
  'forward_from',
  'forward_from_chat',
  'forward_from_message_id',
  'forward_signature',
  'forward_sender_name',
  'forward_date',
  'paid_star_count',
])

// Service-message fields: chat events, not something a human sent us.
const SERVICE_MESSAGE_KEYS = new Set([
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message',
  'successful_payment',
  'refunded_payment',
  'users_shared',
  'chat_shared',
  'connected_website',
  'write_access_allowed',
  'passport_data',
  'proximity_alert_triggered',
  // NOTE: `web_app_data` deliberately does NOT belong here — it is a payload a
  // human submitted through a Web App, not a chat event, so it must reach the
  // agent like any other sender content.
  'boost_added',
  'chat_background_set',
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'giveaway_created',
  'giveaway',
  'giveaway_winners',
  'giveaway_completed',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
])

/** Content-bearing field names on a message we have no handler for. */
export function unhandledContentKeys(message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return []
  return Object.keys(message as Record<string, unknown>).filter(
    key => !MESSAGE_ENVELOPE_KEYS.has(key) && !SERVICE_MESSAGE_KEYS.has(key),
  )
}

export async function handleInboundUnsupported(
  ctx: Context,
  deps: HandlerDeps,
): Promise<void> {
  const keys = unhandledContentKeys(ctx.message)
  deps.log.warn('handlers.unhandled_message', {
    chat_id: ctx.chat?.id,
    message_id: ctx.message?.message_id,
    content_keys: keys,
    delivered: keys.length > 0,
  })
  // Pure service update — logged above, nothing to forward.
  if (keys.length === 0) return

  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () =>
      `[Telegram: сообщение типа «${keys.join(', ')}», которое канал не умеет разбирать — ` +
      `попроси отправителя переслать текстом]`,
    undefined,
    'unsupported',
  )
}
