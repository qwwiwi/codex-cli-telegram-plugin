// MCP tool surface for the Telegram channel.
//
// 7 tools: reply, react, download_attachment, edit_message, status, autonomy, pin.
// Status is currently a stub (returns not_implemented) — T11 will wire it.
//
// All tool args are validated through Zod schemas; we never reach into
// `req.params.arguments` with `as Record<string, unknown>` casts. If a
// schema rejects, we surface the Zod error as a tool error (isError: true)
// rather than throwing through the MCP layer.

import { Buffer } from 'buffer'
import { basename, extname, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { z } from 'zod'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import type { MultichatPolicy } from '../chats/policy-loader.js'
import type { StatusManager, StatusState } from '../status/status-manager.js'
import type { ThreadStore } from '../state/thread-store.js'
import type { OpenQuestionStore } from '../state/open-question-store.js'
import {
  AutonomyArgsSchema,
  DownloadAttachmentArgsSchema,
  EditMessageArgsSchema,
  ReactArgsSchema,
  PinArgsSchema,
  ReplyArgsSchema,
  StatusArgsSchema,
} from '../schemas.js'
import { resolveAskGuardMode } from '../config.js'
import {
  activeLeases,
  consumeLease,
  loadAutonomyState,
  renderAutonomyStatus,
  resolveQuestion,
  revokeLease,
  updateAutonomyState,
  type UpdateResult,
} from '../autonomy/store.js'
import { analyzeAskDetailed, askGuardAdvisoryHint, askGuardBlockMessage } from '../safety/ask-guard.js'
import { detectOpenQuestion } from '../safety/open-question.js'
import { assertAllowedChat } from '../telegram/gate.js'
import { analyzeFormat, formatHint } from '../format/format-check.js'
import {
  isTelegramHtmlParseError,
  markdownToTelegramHtml,
} from '../format/html.js'
import { splitMessage } from '../format/chunk.js'
import { buildRichMessagePayload, contentFitsRichLimits } from '../format/rich.js'
import type { RichLatch } from '../safety/rich-latch.js'
import { PHOTO_EXTENSIONS, assertSendableFile, isPhotoExtension } from '../security/paths.js'
import { validateTelegramHtml } from '../safety/html-validator.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'
import type { Outbox } from '../safety/outbox.js'
import type { GuestQueryRegistry } from '../telegram/guest-queries.js'

// Fallback retry_after (seconds) when a flood 429 carries none — used to
// schedule the outbox re-send far enough out that we don't hammer the ban.
const OUTBOX_FALLBACK_RETRY_S = 60

// ─────────────────────────────────────────────────────────────────────
// MCP request/response types we touch. We narrow rather than import deep
// SDK types because the SDK exports them only as generic Zod-inferred shapes
// and we want minimal coupling.
// ─────────────────────────────────────────────────────────────────────

export interface CallToolRequest {
  params: {
    name: string
    arguments?: unknown
  }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolContent {
  type: 'text'
  text: string
}

export interface CallToolResult {
  content: ToolContent[]
  isError?: boolean
}

// ─────────────────────────────────────────────────────────────────────
// Telegram API surface that tools consume. Defined as an interface so
// tests can stub without touching network.
// ─────────────────────────────────────────────────────────────────────

// Minimal shape we accept for an inline keyboard. Matches grammY's
// InlineKeyboard but kept structural so tests can stub without grammy.
export interface InlineKeyboardLike {
  inline_keyboard: { text: string; callback_data?: string }[][]
}

export interface SendMessageOpts {
  reply_to_message_id?: number
  parse_mode?: 'MarkdownV2' | 'HTML'
  reply_markup?: InlineKeyboardLike
  // Forum-topic thread id. When set, Telegram delivers the message into the
  // matching topic instead of the supergroup's General topic. Omitted in
  // private chats and the General topic (no thread).
  message_thread_id?: number
  // Deliver without a push notification. Set by progress surfaces whose
  // messages are indicators, not reports — the status bubble above all: it is
  // re-created on every turn (and once per turn-like gap), and each send buzzed
  // the owner's phone (repeated bubble respawns).
  // Edits never push, so only the initial send needs it.
  disable_notification?: boolean
  // Opt OUT of the reliable layer's outbound-activity stamp. Set by INTERNAL
  // status surfaces (context-HUD sends, status pins) whose messages must not
  // count as «the owner heard a real report» — otherwise a pin self-heal would
  // silently reset the silence window the outbound clock measures. Consumed and
  // STRIPPED by createReliableTelegramApi; never reaches the wire.
  skipOutboundStamp?: boolean
}

export interface EditOpts {
  parse_mode?: 'MarkdownV2' | 'HTML'
  // PRX-1 TASK-2 (2026-05-27): inline keyboard mutation on edit. Needed by
  // the AskUserQuestion relay to re-render the multi-select question card
  // when a toggle button is pressed (text changes — `[ ]` → `[x]` — AND
  // the keyboard itself updates). Optional and additive: existing callers
  // (commands/oob, channel/tools edit_message) pass no reply_markup and
  // Telegram leaves the existing keyboard untouched.
  reply_markup?: InlineKeyboardLike
}

export interface SendDocumentOpts {
  reply_to_message_id?: number
  caption?: string
  // Forum-topic thread id — see SendMessageOpts.message_thread_id.
  message_thread_id?: number
  // Staging uploads (guest attachments) land in the owner's DM only to mint a
  // reusable file_id — they are plumbing, not a message for the owner to read.
  disable_notification?: boolean
  // Overrides the name Telegram STORES for the file (grammY otherwise guesses
  // it from the path). Telegram keeps that name inside the document, so every
  // later re-send of the same file_id carries it — including a cached result
  // in a public guest answer. The guest path uses this to keep a workspace
  // basename (which can name a client) out of a foreign chat.
  filename?: string
}

// What an upload reports back. `file_id` is the handle Telegram assigns to the
// stored file; it is reusable in later calls (including inline/guest results),
// which is the only way a local file can ride along in answerGuestQuery.
export interface SendFileResult {
  message_id: number
  file_id?: string
}

// Options for the rich-message send. Threading only for M1; M3/M4 extend.
export interface SendRichMessageOpts {
  reply_to_message_id?: number
}

// Result of a rich send. Either Telegram accepted it (we got a message_id)
// or the layered wrapper decided to fall back to the HTML path. `fallback`
// is the signal the reply tool reads to decide whether to also run the HTML
// chunk path — exactly one of the two ships, so a message is never lost or
// duplicated.
export type SendRichMessageResult = { message_id: number } | { fallback: true }

export interface DownloadResult {
  path: string
  mime?: string
  size?: number
}

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note'

// An attachment riding along in the one-shot guest answer. Telegram takes an
// InlineQueryResult there, so the file must already live on its servers: we
// pass a `file_id` minted by a staging upload and the answer becomes a CACHED
// photo/document result whose caption carries the reply text.
export interface GuestFileAnswer {
  kind: 'photo' | 'document'
  fileId: string
  // Shown as the result title (required by Telegram for a document result);
  // the attachment's file name.
  title: string
}

// Options for the one-shot guest answer (Guest Mode, Bot API 10.0).
export interface AnswerGuestQueryOpts {
  parse_mode?: 'MarkdownV2' | 'HTML'
  // When set, the answer ships the file instead of a text article, with the
  // answer text as its caption (Telegram caps a caption at 1024 chars).
  file?: GuestFileAnswer
}

// Telegram's caption cap for a media message — the hard ceiling on the text
// that can accompany a guest attachment (a text-only guest answer has the
// usual 4096 message cap instead).
export const GUEST_CAPTION_LIMIT = 1024

// Telegram counts a caption's VISIBLE text: markup travels out-of-band as
// entities, so `<b>` and `&amp;` are not what the 1024 cap measures. Counting
// the rendered HTML instead would refuse perfectly legal captions whose tags
// happen to be long (Grimstroke review, 2026-11-10).
export function visibleTextLength(text: string, parseMode: string | undefined): number {
  if (parseMode !== 'HTML') return text.length
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // &amp; last: decoding it first would turn &amp;lt; into a bare tag.
    .replace(/&amp;/g, '&').length
}

// Extensions that may be echoed into a public guest answer. An ALLOWLIST, not
// a blocklist: the last suffix of a workspace path is not necessarily a file
// type — `brief.ClientSecret` or `dump.AcmeCorpInternal` would otherwise ship
// as `attachment.clientsecret` / `attachment.acmecorpinternal` and leak the
// very thing the neutral name exists to hide (Grimstroke round-2 review,
// 2026-11-10). Anything unrecognised becomes `.bin`, which every Telegram
// client treats as an opaque download.
const PUBLIC_SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...PHOTO_EXTENSIONS,
  // documents / text
  '.pdf', '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.html', '.log', '.rtf', '.svg', '.bmp', '.heic', '.tiff',
  // office
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // archives
  '.zip', '.gz', '.bz2', '.xz', '.tar', '.7z', '.rar',
  // media
  '.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.flac',
  '.mp4', '.mov', '.webm', '.mkv', '.avi',
])

// The name a guest attachment is uploaded (and therefore re-sent) under.
// Deliberately content-free: a workspace basename can carry a client name or
// an internal project code, and the guest answer is public. The real name is
// not lost — it goes into the owner's staging copy and the tool result, both
// private. A known extension is kept so the recipient's client can open it;
// an unknown one is dropped rather than echoed (see PUBLIC_SAFE_EXTENSIONS).
export function neutralAttachmentName(canonicalPath: string): string {
  const ext = extname(canonicalPath).toLowerCase()
  return `attachment${PUBLIC_SAFE_EXTENSIONS.has(ext) ? ext : '.bin'}`
}

// Every failed answerGuestQuery is AMBIGUOUS, whether it was the first call
// or the plain-text retry: Telegram may have accepted the answer and only the
// acknowledgement got lost. release() re-arms the claim so a deliberate retry
// is possible, but the caller must know that a retry can double-post into a
// public chat — and, with an attachment, leave a SECOND staged copy in the
// owner's DM. So the result says "unknown", never "failed" (Grimstroke
// rounds 2 and 3, 2026-11-10 — round 2 fixed only the first call).
function ambiguousGuestFailure(err: unknown, hadAttachment: boolean): string {
  return (
    `${err instanceof Error ? err.message : String(err)} — delivery outcome UNKNOWN; ` +
    'the answer may already be in the foreign chat, so retry only if you can live with a ' +
    'possible duplicate' +
    (hadAttachment
      ? ' (the staged copy is already in the owner DM; a retry adds another)'
      : '')
  )
}

// A staging upload that THROWS is a DIFFERENT uncertainty from a failed answer,
// and collapsing the two misinforms in both directions (Grimstroke round 4,
// 2026-11-10):
//   - the staging outcome is unknown — Telegram may have stored the file and
//     lost only the acknowledgement, so the owner-DM copy is POSSIBLE, not a
//     fact we may assert;
//   - the public answer is NOT unknown — answerGuestQuery is never reached from
//     this branch, so the foreign chat is untouched with certainty.
// Hence the retry advice differs too: retrying is safe for the foreign chat and
// risks only a duplicate in the owner's own DM.
function ambiguousStagingFailure(err: unknown): string {
  return (
    `${err instanceof Error ? err.message : String(err)} — the staging upload into the owner ` +
    'DM failed and its outcome is UNKNOWN: Telegram may have stored the file even though the ' +
    'acknowledgement was lost, so a copy MAY already be in the owner DM. The guest answer was ' +
    'NOT sent — nothing reached the foreign chat, so a retry is safe there, but it may leave ' +
    'another owner-DM copy'
  )
}

// The ONE deleteMessage failure whose outcome is not in doubt: Telegram says
// the message is not there, so the owner's DM no longer holds the copy —
// whoever removed it. Every other failure (timeout, 5xx, throttle) leaves the
// true state unknown, because the delete may have landed and only its
// acknowledgement been lost; those must be reported as unconfirmed, never as
// "the copy is still there" (Grimstroke round 1, 2026-11-11).
//
// Only Telegram can hand down this verdict, and only as a 400 about THIS call.
// It is therefore read ONLY from grammY's structured payload — `error_code`
// together with `description` — never from free text. A message string carries
// no provenance: a proxy echoing the complete upstream body, or a 502 whose
// text quotes the API verbatim, reads identically to the real thing and would
// be misreported as "the copy is gone" (Grimstroke rounds 2–3, 2026-11-11).
// If some wrapper ever strips the structured fields, a genuine 400 degrades to
// 'unconfirmed' — a false negative, which is the safe direction: it overstates
// what is unknown instead of promising a cleanup that may not have happened.
// Both safe-telegram-api and rate-limited-telegram-api rethrow the original
// error, so the fields survive today.
//
// Description verified against live Telegram: a second deleteMessage on an
// already-deleted DM message answers exactly
// `Bad Request: message to delete not found` (2026-11-11).
const DELETE_TARGET_ABSENT = 'bad request: message to delete not found'

function isMessageAlreadyGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const api = err as { error_code?: unknown; description?: unknown }
  if (api.error_code !== 400 || typeof api.description !== 'string') return false
  return api.description.trim().toLowerCase() === DELETE_TARGET_ABSENT
}

// A staging upload is a real network round trip, and it may sit behind the
// heavy-upload throttle (90s) before it even starts. claim() proves a query is
// answerable NOW; this is the headroom that makes it likely to still be
// answerable once the upload AND the answer have landed. Below it we refuse
// up front rather than leave a staged copy in the owner's DM for an answer
// Telegram will reject (Grimstroke round-2 review, 2026-11-10).
export const GUEST_STAGING_MIN_TTL_MS = 120_000

// Which DM the guest attachment is staged into. The staging message carries
// the file AND its real name, so that chat must provably be the OWNER's.
// resolveOwnerChatIds() falls back to `allowed_user_ids` when `owner_chat_ids`
// is unset — acceptable for an owner HUD, NOT for this: with several
// allowlisted users the first one is merely *an* allowlisted user, who would
// then receive a workspace file and its real name (Grimstroke round-2
// review). The fallback is therefore honoured only when it is unambiguous.
//
// TRUST ASSUMPTION, stated explicitly (Grimstroke round 3): a sole allowlisted
// user is an operator CONVENTION, not a proof of ownership — single-user
// channels are configured by and for their owner. Deployments where that does
// not hold must set `owner_chat_ids`. RETENTION: the staging message is
// permanent in that DM and is minted for FAILED attempts too, so whoever owns
// that chat sees every file this path touches. On a CONFIRMED delivery the
// copy is swept again right after the answer (owner request, 2026-11-10); it
// is kept for failed or ambiguous attempts, and may also survive a delivery
// whose cleanup could not be confirmed.
export function resolveGuestStagingChatId(
  config: AppConfig,
): { ok: true; chatId: string } | { ok: false; reason: string } {
  const explicit = (config.owner_chat_ids ?? []).filter((n) => Number.isInteger(n) && n > 0)
  const owner = explicit[0]
  if (owner !== undefined) return { ok: true, chatId: String(owner) }
  const allowed = config.allowed_user_ids
  const sole = allowed.length === 1 ? allowed[0] : undefined
  if (sole !== undefined) return { ok: true, chatId: String(sole) }
  if (allowed.length === 0) {
    return {
      ok: false,
      reason:
        'cannot attach a file to a guest answer: no owner DM chat configured to stage the ' +
        'upload — set owner_chat_ids',
    }
  }
  return {
    ok: false,
    reason:
      `cannot attach a file to a guest answer: ${allowed.length} users are allowlisted and ` +
      'none is marked as the owner, so there is no provable owner DM to stage the upload into ' +
      '(it would carry the file and its real name) — set owner_chat_ids explicitly',
  }
}

export interface TelegramApi {
  sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<{ message_id: number }>
  // Telegram Bot API 10.1 Rich Messages: ship RAW markdown that Telegram
  // renders server-side (tables/math/headings/task-lists/<details>/footnotes,
  // up to 32768 bytes). The result is either a message_id (sent) or
  // { fallback: true } (caller must use the HTML path instead). Implemented
  // via grammY's raw escape hatch; redaction runs in the safe wrapper BEFORE
  // the raw send — never call this from outside the layered chain.
  sendRichMessage(
    chatId: string,
    rawMarkdown: string,
    opts: SendRichMessageOpts,
  ): Promise<SendRichMessageResult>
  editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void>
  setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void>
  sendChatAction(chatId: string, action: ChatAction): Promise<void>
  sendDocument(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult>
  sendPhoto(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult>
  downloadFile(fileId: string, destDir: string): Promise<DownloadResult>
  deleteMessage(chatId: string, messageId: number): Promise<void>
  // Guest Mode: answer a guest @-mention exactly once. Telegram's contract
  // takes an InlineQueryResult; we emit either a text article or — when
  // `opts.file` is set — a cached photo/document captioned with `text`.
  answerGuestQuery(guestQueryId: string, text: string, opts: AnswerGuestQueryOpts): Promise<void>
}

// Pin/unpin carry NO user text, so they do not belong behind the safe
// (redact + HTML-validate) or rate-limited text chain — the same split the
// Context HUD adapter makes in server.ts, which talks to bot.api directly.
export interface PinApi {
  pinChatMessage(
    chatId: string,
    messageId: number,
    opts: { disable_notification?: boolean },
  ): Promise<void>
  unpinChatMessage(chatId: string, messageId: number): Promise<void>
}

// grammY ^1.21.0 has no typed `sendRichMessage` on its RawApi (the method is
// newer than the bundled types). We reach it through the raw escape hatch
// `bot.api.raw`, narrowed to a typed function rather than `any`: the body is
// the RichMessageBody buildRichMessagePayload produces, and the response is
// the small shape we read message_id from (defensively — Telegram nests it
// under `result`, grammY usually unwraps to the top level).
interface RawSendRichResponse {
  message_id?: number
  result?: { message_id?: number }
}
type RawSendRichMessageFn = (
  body: Record<string, unknown>,
) => Promise<RawSendRichResponse>

// Thin wrapper around grammY bot.api. Keeps the rest of the system free of
// grammy-specific quirks (reply_parameters vs reply_to_message_id, etc).
export function createTelegramApi(bot: Bot, token: string): TelegramApi {
  return {
    async sendMessage(chatId, text, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.parse_mode !== undefined) {
        other.parse_mode = opts.parse_mode
      }
      if (opts.reply_markup !== undefined) {
        other.reply_markup = opts.reply_markup
      }
      if (opts.message_thread_id !== undefined) {
        other.message_thread_id = opts.message_thread_id
      }
      if (opts.disable_notification !== undefined) {
        other.disable_notification = opts.disable_notification
      }
      const sent = await bot.api.sendMessage(chatId, text, other)
      return { message_id: sent.message_id }
    },
    async sendRichMessage(chatId, rawMarkdown, opts) {
      // Build the raw-api body (chat_id + markdown + reply_parameters) and
      // dispatch through grammY's untyped raw escape hatch. The safe wrapper
      // already redacted `rawMarkdown`; this layer only transports it.
      const body = buildRichMessagePayload(rawMarkdown, {
        chat_id: chatId,
        ...(opts.reply_to_message_id !== undefined
          ? { reply_to_message_id: opts.reply_to_message_id }
          : {}),
      })
      // `bot.api.raw` is typed to known methods only; cast through unknown to
      // a typed function for the (still-untyped-in-grammY) sendRichMessage.
      const rawApi = bot.api.raw as unknown as Record<string, unknown>
      const sendRich = rawApi.sendRichMessage as RawSendRichMessageFn
      const res = await sendRich(body as unknown as Record<string, unknown>)
      // Parse message_id defensively: top-level (grammY-unwrapped) first,
      // then nested under `result` (raw Bot API envelope).
      const messageId = res.message_id ?? res.result?.message_id
      if (typeof messageId !== 'number') {
        throw new Error('sendRichMessage returned no message_id')
      }
      return { message_id: messageId }
    },
    async editMessageText(chatId, messageId, text, opts) {
      const other: Record<string, unknown> = {}
      if (opts.parse_mode !== undefined) other.parse_mode = opts.parse_mode
      if (opts.reply_markup !== undefined) other.reply_markup = opts.reply_markup
      await bot.api.editMessageText(chatId, messageId, text, other)
    },
    async setMessageReaction(chatId, messageId, emoji) {
      await bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ])
    },
    async sendChatAction(chatId, action) {
      await bot.api.sendChatAction(chatId, action)
    },
    async sendDocument(chatId, filePath, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.caption !== undefined) other.caption = opts.caption
      if (opts.message_thread_id !== undefined) other.message_thread_id = opts.message_thread_id
      if (opts.disable_notification !== undefined) {
        other.disable_notification = opts.disable_notification
      }
      const sent = await bot.api.sendDocument(
        chatId,
        new InputFile(filePath, opts.filename),
        other,
      )
      return {
        message_id: sent.message_id,
        ...(sent.document?.file_id !== undefined ? { file_id: sent.document.file_id } : {}),
      }
    },
    async sendPhoto(chatId, filePath, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.caption !== undefined) other.caption = opts.caption
      if (opts.message_thread_id !== undefined) other.message_thread_id = opts.message_thread_id
      if (opts.disable_notification !== undefined) {
        other.disable_notification = opts.disable_notification
      }
      const sent = await bot.api.sendPhoto(chatId, new InputFile(filePath, opts.filename), other)
      // Telegram returns every rendered size, ascending — the LAST entry is
      // the largest, which is the one worth re-sending.
      const largest = sent.photo?.[sent.photo.length - 1]?.file_id
      return {
        message_id: sent.message_id,
        ...(largest !== undefined ? { file_id: largest } : {}),
      }
    },
    async deleteMessage(chatId, messageId) {
      await bot.api.deleteMessage(chatId, messageId)
    },
    async downloadFile(fileId, destDir) {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop() ?? 'bin' : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(destDir, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(destDir, { recursive: true })
      writeFileSync(path, buf)
      return { path, size: buf.length }
    },
    async answerGuestQuery(guestQueryId, text, opts) {
      // answerGuestQuery takes an InlineQueryResult; a text answer is an
      // article with InputTextMessageContent. `id` is scoped to the query
      // (one result per answer), so a constant is fine.
      const parseMode = opts.parse_mode !== undefined ? { parse_mode: opts.parse_mode } : {}
      if (opts.file !== undefined) {
        // With an attachment the answer becomes a CACHED media result: the
        // file already lives on Telegram's servers (file_id from the staging
        // upload) and `text` rides along as its caption.
        const caption = text.length > 0 ? { caption: text, ...parseMode } : {}
        await bot.api.answerGuestQuery(
          guestQueryId,
          opts.file.kind === 'photo'
            ? { type: 'photo', id: 'answer', photo_file_id: opts.file.fileId, ...caption }
            : {
                type: 'document',
                id: 'answer',
                title: opts.file.title,
                document_file_id: opts.file.fileId,
                ...caption,
              },
        )
        return
      }
      await bot.api.answerGuestQuery(guestQueryId, {
        type: 'article',
        id: 'answer',
        title: 'Ответ',
        input_message_content: {
          message_text: text,
          ...parseMode,
        },
      })
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tool definitions. Order is stable — Claude Code surfaces tools in
// listing order, and tests pin the order to catch accidental swaps.
// ─────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. In a forum supergroup ALWAYS reply in the same topic the message came from: pass thread_id from the inbound <channel> block\'s message_thread_id (the tool also defaults to the last inbound topic of that chat, so you never accidentally answer in General). Optionally pass reply_to (message_id) to quote, and files (absolute paths) to attach images or documents. GUEST MODE: when the inbound <channel> meta carries guest_query_id (guest="1"), pass that guest_query_id here too — the answer is delivered into the foreign chat via answerGuestQuery. Guest answers are ONE-SHOT (exactly one reply, no reply_to, single message ≤4096 chars — be concise). A guest answer may carry AT MOST ONE file in `files`: the text then ships as the caption of that file, so keep it ≤1024 chars, and the file arrives under a neutral public name — `attachment.<ext>` for a known file type, `attachment.bin` otherwise. The upload is staged through the owner DM to mint a file_id and that staging copy is deleted once the answer is delivered; it is kept when the answer failed or its outcome is unknown. The tool result states which happened — including the case where the delete itself could not be confirmed, i.e. the copy may still be in the owner DM — and it reports that alongside any truncation notice, never instead of it.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        guest_query_id: {
          type: 'string',
          description:
            'Guest Mode only: the guest_query_id from the inbound <channel> meta. When set, the reply goes through answerGuestQuery (one-shot) instead of sendMessage. At most ONE entry in `files` is allowed on this path, and the text becomes its caption (≤1024 chars).',
        },
        thread_id: {
          type: 'string',
          description:
            'Forum-topic thread id. Use message_thread_id from the inbound <channel> block so the reply lands in the same topic. Omit only for private chats or the General topic.',
        },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2', 'html', 'rich'],
          default: 'html',
          description:
            "Rendering mode. Default: 'html' — markdown (**bold**, *italic*, `code`, ```fenced```, [text](url), tables, # headings) is auto-converted to Telegram's HTML subset and auto-chunked at 4000 chars. Plain `<`, `>`, `&` in regular text are safe — they get auto-escaped before sending. On parse error the chunk re-sends as plain text so the reply still ships. Use 'text' only to bypass markdown conversion entirely (e.g. sending pre-built Telegram entity strings verbatim). 'markdownv2' passes raw — caller escapes per Telegram rules. 'rich' opts into Telegram Rich Messages (raw markdown rendered server-side: tables/math/task-lists, up to 32KB in one DM message) and transparently falls back to the 'html' path if unavailable.",
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Pass chat_id from the SAME inbound <channel> block so the tool can verify the file came from an allowlisted chat. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat_id from inbound meta' },
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['chat_id', 'file_id'],
    },
  },
  {
    name: 'edit_message',
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description:
            "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'status',
    description:
      'Update or cancel the transient status line for an in-flight reply. Pass chat_id from the inbound <channel> meta. state controls the label: typing→"Печатает...", thinking→"Думает...", tool→"🔧 <tool_name>", stopped/error→short reason. Call this when you switch from thinking to running a tool, or when work is interrupted. The status message auto-deletes when the final reply ships.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        state: {
          type: 'string',
          enum: ['typing', 'thinking', 'tool', 'stopped', 'error'],
        },
        tool_name: {
          type: 'string',
          description: 'Required when state="tool". Renders as 🔧 <tool_name>.',
        },
        reason: {
          type: 'string',
          description: 'Optional short context for stopped/error states.',
        },
      },
      required: ['chat_id', 'state'],
    },
  },
  {
    name: 'autonomy',
    description:
      'Inspect and resolve the durable autonomy registry for a chat — the owner-granted mandates (leases) that survive context compaction, plus open questions to the owner. Pass chat_id from the inbound <channel> meta. action="status" returns active leases (id, scope, time left) and open questions (id, summary, age, default action, sticky flag). action="consume" marks a lease consumed (pass lease_id). action="revoke" withdraws a lease\'s authority (pass lease_id, optional reason) — self-revoke only shrinks authority. action="resolve_question" sets a question answered/bypassed (pass question_id and resolution). This tool CANNOT grant a lease — grants come from the owner via the /lease command.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        action: {
          type: 'string',
          enum: ['status', 'consume', 'revoke', 'resolve_question'],
        },
        lease_id: {
          type: 'string',
          description: 'Required when action="consume" or action="revoke". The lease id (e.g. L-20260710-a1b2c3d4).',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason for action="revoke" (stored as revokeReason).',
        },
        question_id: {
          type: 'string',
          description: 'Required when action="resolve_question". The question id (e.g. Q-20260710-a1b2).',
        },
        resolution: {
          type: 'string',
          enum: ['answered', 'bypassed'],
          description: 'Required when action="resolve_question". How the question was resolved.',
        },
      },
      required: ['chat_id', 'action'],
    },
  },
  {
    name: 'pin',
    description:
      "Pin or unpin one of the bot's OWN messages in a chat. Use it to keep a live dashboard at the top of the chat: send the message with reply, pin it once with action=\"pin\", then keep the SAME message_id updated with edit_message — an edited pinned message updates in place forever (no 48h limit) and edits raise no notification. action=\"unpin\" removes it. Pass chat_id from the inbound <channel> meta. Pinning is silent (no push).",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat_id from inbound meta' },
        message_id: { type: 'string', description: 'A message the bot itself sent' },
        action: { type: 'string', enum: ['pin', 'unpin'] },
      },
      required: ['chat_id', 'message_id', 'action'],
    },
  },
]

export function listTools(): ToolDefinition[] {
  // Return a shallow copy so callers cannot mutate our canonical list.
  return TOOL_DEFINITIONS.map(t => ({ ...t }))
}

// ─────────────────────────────────────────────────────────────────────
// Tool dispatch
// ─────────────────────────────────────────────────────────────────────

export interface ToolDeps {
  config: AppConfig
  statePaths: StatePaths
  telegramApi: TelegramApi
  log: Logger
  statusManager: StatusManager
  // H4 fix (2026-05-23): when multichat is enabled, the policy is the
  // authoritative outbound allowlist. Omitted in legacy DM-only mode.
  policy?: MultichatPolicy
  // Per-chat forum-topic memory (2026-06-09). When present, a reply without an
  // explicit thread_id defaults into the last inbound topic of the chat so it
  // never lands in General. Omitted in tests / legacy wiring → no default.
  threadStore?: ThreadStore
  // Open-question reminder (2026-11-14). When present, a reply that leaves the
  // owner on the critical path («жду го», «скажешь go — отправлю») is recorded
  // here and a question-free reply clears it, so the sweep can nudge him if the
  // answer never comes. Optional → omitted in tests / legacy wiring means the
  // feature simply records nothing.
  openQuestions?: OpenQuestionStore
  // M1 rich messages (2026-06-14): session-scoped capability latch shared
  // with the safe-telegram-api wrapper. The reply handler reads
  // `sendDisabled` to skip rich attempts cheaply once a capability error has
  // latched it off. Optional so existing test fixtures that omit it keep the
  // legacy HTML-only behaviour (rich is then never attempted).
  richLatch?: RichLatch
  // Persistent outbox (2026-07-07). When a reply hits a LONG flood ban (the
  // rate-limited api fail-fast throws the 429), the undelivered reply is
  // enqueued here and a background flusher re-sends it once the ban lifts —
  // so the owner always gets the answer without pinging. Feature-flag-safe:
  // omitted (undefined) → today's "not delivered" behaviour, no enqueue.
  outbox?: Outbox
  // Guest Mode: pending one-shot guest queries. Authorization for a guest
  // reply is registry membership — only allowlisted callers' queries are
  // ever registered (handleGuestMessage gates first), so the tool trusts an
  // entry it finds here. Absent when guest_mode.enabled=false.
  guestQueries?: GuestQueryRegistry
  // Pin surface (2026-11-10). Optional: legacy wiring and test fixtures omit
  // it, and the `pin` tool then reports unavailability instead of throwing.
  pinApi?: PinApi
}

// DM detection: a Telegram DM chat.id equals the user's id and is positive.
// Groups/supergroups/channels are negative. M1 ships rich messages to DMs
// only (groups are M4). Non-numeric / NaN ids fail closed (not a DM).
export function isDmChat(chatId: string): boolean {
  const n = Number(chatId)
  return Number.isFinite(n) && n > 0
}

// Collapsible sections (2026-11-10). Telegram's `<blockquote expandable>` is
// HTML-subset-only: the rich path ships RAW markdown and the server renders no
// HTML, so the tag reached the chat as literal text. A body carrying it must
// take the HTML path, where markdownToTelegramHtml preserves the tag and the
// pre-send validator allows the `expandable` attribute.
export function carriesExpandableBlockquote(text: string): boolean {
  return /<blockquote\b[^>]*\bexpandable\b/i.test(text)
}

function toolError(name: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${name} failed: ${message}` }],
    isError: true,
  }
}

function zodErrorMessage(err: z.ZodError): string {
  return err.errors.map(e => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')
}

export async function callTool(req: CallToolRequest, deps: ToolDeps): Promise<CallToolResult> {
  const { telegramApi, log, config, statePaths, statusManager } = deps
  const name = req.params.name
  const rawArgs: unknown = req.params.arguments ?? {}

  try {
    switch (name) {
      case 'reply': {
        const parsed = ReplyArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data

        // Guest Mode path. Authorization = registry membership (only
        // allowlisted callers' queries get registered), NOT the chat
        // allowlist — the originating chat is one the bot is not a member
        // of, so assertAllowedChat would always (correctly) refuse it.
        if (args.guest_query_id !== undefined) {
          if (deps.guestQueries === undefined) {
            return toolError(name, 'guest replies unavailable — guest_mode is not enabled in config')
          }
          const guestFiles = args.files ?? []
          if (guestFiles.length > 1) {
            return toolError(
              name,
              'a guest answer is one-shot: it carries at most ONE file — send the rest to the owner DM instead',
            )
          }
          if (args.reply_to !== undefined) {
            return toolError(name, 'guest replies do not support reply_to — the answer always lands in-place')
          }
          // thread_id is meaningless here (answerGuestQuery has no topic
          // routing) and silently ignoring it would read as "answered in the
          // topic" in the transcript. Refuse like the other unsupported args.
          if (args.thread_id !== undefined) {
            return toolError(name, 'guest replies do not support thread_id — answerGuestQuery has no topic routing')
          }

          // Render BEFORE claiming: a renderer throw after claim() would
          // strand the one-shot entry inflight until TTL. Hard-cap at ONE
          // Telegram message: there is no second answerGuestQuery, so
          // chunking cannot apply — ship chunk[0] and flag the truncation in
          // the tool result so the agent knows. 'rich' degrades to the HTML
          // rendering here: answerGuestQuery has no rich_message payload, and
          // raw markdown in a public foreign chat reads worse than our
          // rendered HTML subset.
          const guestFormat = args.format === 'rich' ? 'html' : args.format
          const body = guestFormat === 'html' ? markdownToTelegramHtml(args.text) : args.text

          const chunks = splitMessage(body)
          const single = chunks[0]
          if (single === undefined) {
            return toolError(name, 'guest reply rendered to an empty message — nothing to send')
          }
          const truncated = chunks.length > 1
          // Plain-text fallback body: the PRE-render text — a parse failure
          // means our markup was bad, and raw <b> tag soup in a public
          // foreign chat reads worse than unrendered markdown.
          const plainBody = splitMessage(args.text)[0] ?? single
          const guestParseMode: AnswerGuestQueryOpts['parse_mode'] | undefined =
            guestFormat === 'html' ? 'HTML' : guestFormat === 'markdownv2' ? 'MarkdownV2' : undefined

          // ── Attachment (2026-11-10) ──────────────────────────────────
          // answerGuestQuery takes an InlineQueryResult, so a file can ride
          // along — but only by file_id (there is no multipart upload on this
          // method). We therefore STAGE the file into the owner's DM, which
          // mints a reusable file_id, and answer with a cached media result.
          //
          // Everything that can be judged from the ARGUMENTS alone is checked
          // here, before the registry is touched: text length, workspace gate,
          // staging target. The upload itself happens after claim() — see the
          // ordering note there.
          const guestFilePath = guestFiles[0]
          let guestCanonical: string | undefined
          let stagingChatId: string | undefined
          if (guestFilePath !== undefined) {
            // The cap applies to what Telegram actually receives:
            //   · valid HTML  → it counts the VISIBLE text (markup travels as
            //     entities, so long tags are free);
            //   · invalid HTML → the safety wrapper escapes the whole body and
            //     ships it WITHOUT parse_mode, and escaping INFLATES it (a
            //     reviewed case went 859 raw chars → 2992 escaped), so the cap
            //     must be measured on that string instead;
            //   · a parse-error retry → the raw markdown fallback.
            // Known blind spot: redaction also rewrites the text, but it needs
            // the channel's secret list, which this layer does not have. A
            // redacted caption that trips the cap fails the send — it does not
            // leak (Grimstroke round-2 review, 2026-11-10). DECIDED in round 3:
            // not escalated to a hard "never stage an oversize caption"
            // guarantee. That would mean duplicating the secret list into this
            // layer (or moving caption policy into the safety wrapper) to buy
            // availability in a case that requires a secret-shaped string in a
            // near-1024-char public answer. Cost beats the benefit; the failure
            // mode is a refused send plus a staged copy, both visible.
            const htmlCheck = guestParseMode === 'HTML' ? validateTelegramHtml(single) : undefined
            const shippedLen =
              htmlCheck?.downgraded === true
                ? htmlCheck.text.length
                : visibleTextLength(single, guestParseMode)
            const captionLen = Math.max(shippedLen, plainBody.length)
            if (captionLen > GUEST_CAPTION_LIMIT) {
              return toolError(
                name,
                `a guest answer with a file puts the text in the file's CAPTION, which Telegram caps at ` +
                  `${GUEST_CAPTION_LIMIT} chars (this answer needs ${captionLen}, counting the ` +
                  `plain-text fallback) — shorten the text`,
              )
            }
            try {
              guestCanonical = assertSendableFile({ filePath: guestFilePath, config })
            } catch (err) {
              return toolError(name, err instanceof Error ? err.message : String(err))
            }
            const staging = resolveGuestStagingChatId(config)
            if (!staging.ok) {
              return toolError(name, staging.reason)
            }
            stagingChatId = staging.chatId
          }

          const claim = deps.guestQueries.claim(args.guest_query_id)
          if (claim.kind !== 'ok') {
            return toolError(
              name,
              `guest query ${claim.kind} — guest answers are one-shot and expire after 15 minutes`,
            )
          }
          // Cheap LLM-mixup guard: with two pending guest queries in
          // different foreign chats, a swapped (chat_id, guest_query_id) pair
          // would deliver chat A's answer into chat B — both public. The
          // registry knows the true origin; refuse loud.
          if (claim.entry.callerChatId !== undefined && claim.entry.callerChatId !== args.chat_id) {
            deps.guestQueries.release(args.guest_query_id)
            return toolError(
              name,
              `guest query ${args.guest_query_id} originated in chat ${claim.entry.callerChatId}, not ${args.chat_id} — pass the chat_id from the SAME inbound <channel> meta`,
            )
          }

          // Stage the upload only now that the query has passed every check we
          // can make locally — which is NOT a proof that Telegram will accept
          // the answer, only that nothing we know of rules it out. claim() is a
          // local reservation, not the Telegram one-shot: a release() re-arms
          // it. Uploading before it (as this code first did) pushed a copy of
          // the file into the owner's DM for queries that were unknown, expired
          // or mis-routed — a side effect for an answer that could never be
          // sent (Grimstroke review, 2026-11-10).
          //
          // The staging message records what was staged TOWARD a public
          // foreign chat — an attempt, not a delivery. It must therefore
          // outlive every path that has NOT delivered: there it is both the
          // retry's file_id and the only private record of what was staged.
          // Only once the answer is CONFIRMED delivered has the copy done its
          // job, and it is swept (owner request, 2026-11-10) — see the cleanup
          // after confirm(), which is the sole place allowed to delete it.
          let guestFile: GuestFileAnswer | undefined
          let stagedMessageId: number | undefined
          if (guestCanonical !== undefined && stagingChatId !== undefined) {
            // claim() proved the query answerable AT THIS INSTANT; the upload
            // that follows is slow and leaves a copy in the owner's DM. Refuse
            // while we still can, rather than stage a file for an answer that
            // will expire mid-flight.
            const ttlLeftMs = deps.guestQueries.remainingMs(args.guest_query_id) ?? 0
            if (ttlLeftMs < GUEST_STAGING_MIN_TTL_MS) {
              deps.guestQueries.release(args.guest_query_id)
              return toolError(
                name,
                `guest query expires in ${Math.round(ttlLeftMs / 1000)}s — too little headroom ` +
                  `to stage a file upload (needs ${GUEST_STAGING_MIN_TTL_MS / 1000}s); answer ` +
                  'with text only and send the file to the owner DM instead',
              )
            }
            const isPhoto = isPhotoExtension(guestCanonical)
            // Public name: content-free, so a workspace basename cannot leak
            // into the foreign chat. The owner's copy keeps the real one.
            const publicName = neutralAttachmentName(guestCanonical)
            let staged: SendFileResult
            try {
              const stageOpts: SendDocumentOpts = {
                disable_notification: true,
                // "attempt": this copy is minted BEFORE the answer is sent, so
                // it records what was staged, not what was delivered. The
                // tool result is the only place that knows the outcome.
                caption:
                  `guest answer attempt → chat ${args.chat_id}: ${basename(guestCanonical)} ` +
                  '(staged for upload; delivery not confirmed here)',
                filename: publicName,
              }
              staged = isPhoto
                ? await telegramApi.sendPhoto(stagingChatId, guestCanonical, stageOpts)
                : await telegramApi.sendDocument(stagingChatId, guestCanonical, stageOpts)
            } catch (err) {
              deps.guestQueries.release(args.guest_query_id)
              return toolError(name, ambiguousStagingFailure(err))
            }
            if (staged.file_id === undefined) {
              // Mirror case: the upload SUCCEEDED (no throw), so the staged
              // message normally does exist — but without a file_id there is
              // nothing to attach, and the public answer never happened.
              deps.guestQueries.release(args.guest_query_id)
              return toolError(
                name,
                'staging upload returned no file_id — cannot attach the file to a guest answer; ' +
                  'the upload itself succeeded, so a staged copy normally exists in the owner DM, ' +
                  'but the guest answer was NOT sent (nothing reached the foreign chat)',
              )
            }
            guestFile = {
              kind: isPhoto ? 'photo' : 'document',
              fileId: staged.file_id,
              title: publicName,
            }
            stagedMessageId = staged.message_id
          }

          // The upload itself can outlast the headroom checked above (a 50MB
          // file behind a throttle). Report the real state instead of burning
          // the answer on a query we already know is stale.
          if (guestFile !== undefined) {
            const ttlAfterUpload = deps.guestQueries.remainingMs(args.guest_query_id) ?? 0
            if (ttlAfterUpload <= 0) {
              deps.guestQueries.release(args.guest_query_id)
              return toolError(
                name,
                'the guest query expired while the file was uploading — the answer was NOT sent; ' +
                  'the staged copy is in the owner DM',
              )
            }
          }

          const guestOpts: AnswerGuestQueryOpts = {
            ...(guestParseMode !== undefined ? { parse_mode: guestParseMode } : {}),
            ...(guestFile !== undefined ? { file: guestFile } : {}),
          }

          try {
            await telegramApi.answerGuestQuery(args.guest_query_id, single, guestOpts)
          } catch (err) {
            // Entity-parse failures are format-agnostic: Telegram raises the
            // same «can't parse entities» family for HTML and MarkdownV2
            // bodies — and a chunked MarkdownV2 body can be INVALID by
            // construction (splitMessage balances only HTML tags), so without
            // this retry a long markdownv2 guest reply would burn the query's
            // TTL on identical failures. A failed call does not consume the
            // query on Telegram's side.
            if (guestOpts.parse_mode !== undefined && isTelegramHtmlParseError(err)) {
              log.warn('guest answer entity parse failed, retrying as plain text', {
                format: args.format,
                error: err instanceof Error ? err.message : String(err),
              })
              try {
                // Drop the markup, KEEP the attachment — the file is the
                // point of the answer; losing it to a bad tag is not an option.
                await telegramApi.answerGuestQuery(args.guest_query_id, plainBody, {
                  ...(guestFile !== undefined ? { file: guestFile } : {}),
                })
              } catch (err2) {
                deps.guestQueries.release(args.guest_query_id)
                return toolError(name, ambiguousGuestFailure(err2, guestFile !== undefined))
              }
            } else {
              deps.guestQueries.release(args.guest_query_id)
              return toolError(name, ambiguousGuestFailure(err, guestFile !== undefined))
            }
          }

          // Send succeeded — freeze the entry as answered so a repeat reply
          // reads 'consumed' and cap-eviction may reclaim the slot.
          deps.guestQueries.confirm(args.guest_query_id)

          // The staging copy existed only to mint the file_id above. The
          // answer is out, so sweep it — the owner asked not to keep a stray
          // document in their DM for every guest file they requested.
          //
          // Deliberately AFTER confirm() and never before the answer: the
          // delete must not be able to cost us the file_id we answer with.
          // A failure here is cosmetic — the answer is already public — so it
          // must not turn a delivered answer into a tool error; it only
          // changes what we report about the owner's DM.
          // Three states, not two: a failed delete does NOT prove the copy
          // survived (the call may have landed and only its acknowledgement
          // been lost), so 'unconfirmed' must not be reported as "still
          // there" — the same false-certainty trap as the answer path above.
          // 'unattempted' is a fourth state, not a flavour of success: a
          // malformed upload response with no message_id leaves nothing to
          // delete, and the copy sits in the DM untouched. Mapping that to
          // 'swept' would promise a cleanup that never ran.
          let staging: 'swept' | 'unconfirmed' | 'unattempted' | undefined
          if (guestFile !== undefined) {
            if (stagedMessageId === undefined || stagingChatId === undefined) {
              staging = 'unattempted'
              log.warn('guest staging copy cannot be cleaned up — no message id', {
                chat_id: stagingChatId ?? '(unknown)',
              })
            } else {
              try {
                await telegramApi.deleteMessage(stagingChatId, stagedMessageId)
                staging = 'swept'
              } catch (err) {
                staging = isMessageAlreadyGone(err) ? 'swept' : 'unconfirmed'
                log.warn('guest staging copy cleanup failed', {
                  chat_id: stagingChatId,
                  message_id: stagedMessageId,
                  outcome: staging === 'swept' ? 'already absent' : 'unknown',
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          }

          // Truncation and the attachment/cleanup status are INDEPENDENT facts
          // about the same send, so they are composed, never nested: a
          // truncated answer that also left a copy in the owner DM must report
          // BOTH. Nesting them once hid the cleanup outcome behind the
          // truncation notice (Grimstroke round 2, 2026-11-11).
          const notes: string[] = []
          if (truncated) {
            notes.push('TRUNCATED to one message — guest replies are one-shot; keep them short')
          }
          if (guestFile !== undefined && guestCanonical !== undefined) {
            notes.push(
              `${basename(guestCanonical)} attached as ${guestFile.title}; ` +
                (staging === 'unconfirmed'
                  ? 'cleanup of the staging copy was not confirmed — it may still be in the owner DM'
                  : staging === 'unattempted'
                    ? 'cleanup of the staging copy was not attempted — it may still be in the ' +
                      'owner DM'
                    : 'the staging copy was removed from the owner DM'),
            )
          }

          return {
            content: [{
              type: 'text',
              text:
                notes.length > 0
                  ? `guest answer sent (${notes.join(' | ')})`
                  : 'guest answer sent',
            }],
          }
        }

        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }

        // ── Ask-guard (autonomy M3, ported from upstream) ────────────────
        // Enforces owner-granted autonomy mandates on the OWNER-egress
        // `reply`-tool path. When an ACTIVE lease exists for this chat AND the
        // outgoing body is a self-gating permission-ask («жду го / дай добро»),
        // intercept:
        //   * block mode  → refuse the send (isError, nothing shipped). NO
        //                   resend-valve — an identical re-send is analyzed
        //                   the same way and blocked again (analyzeAsk is
        //                   pure/stateless).
        //   * advisory    → the reply still ships; a hint is appended to the
        //                   tool result (computed here, attached near the
        //                   result below) nudging act-with-veto.
        // SCOPE (honest coverage): this guards ONLY the `reply` tool.
        // `edit_message` is UNGUARDED BY DESIGN (interim progress edits are not
        // owner-egress go-questions); the AskUserQuestion relay is a different
        // tool (the legitimate escape). Fail-open on ANY error — a guard fault
        // must never gate a real reply.
        let askGuardHint = ''
        try {
          const askGuardMode = resolveAskGuardMode(config, log)
          if (askGuardMode !== 'off') {
            const autonomyState = loadAutonomyState(statePaths, args.chat_id, log)
            const leases = activeLeases(autonomyState, Date.now())
            if (leases.length > 0) {
              const analysis = analyzeAskDetailed(args.text, { hasActiveLease: true })
              // A hard-gate marker that survives ONLY inside a fenced/quoted
              // zone still exempts (fail-safe) but is a distinct audit class.
              if (analysis.exemptReason === 'hard_gate_protected_only') {
                log.info('ask_guard exempt — hard-gate marker only in a protected zone', {
                  code: 'hard_gate_protected_only',
                  chat_id: args.chat_id,
                  lease_id: leases[0]!.id,
                })
              }
              const finding = analysis.findings[0]
              if (finding !== undefined) {
                const lease = leases[0]! // soonest-expiry first
                if (askGuardMode === 'block') {
                  log.info('ask_guard blocked a self-gating permission-ask (mandate active)', {
                    code: 'ask_guard_block',
                    chat_id: args.chat_id,
                    lease_id: lease.id,
                    pattern: finding.code,
                  })
                  // List ALL active lease scopes so the model can self-check its
                  // intended action; never claim authorization.
                  const scopes = leases.map((l) => l.scope)
                  return {
                    content: [{ type: 'text', text: askGuardBlockMessage(lease.id, scopes) }],
                    isError: true,
                  }
                }
                // advisory — message still ships; attach the hint below.
                log.info('ask_guard advisory on a self-gating permission-ask (mandate active)', {
                  code: 'ask_guard_advisory',
                  chat_id: args.chat_id,
                  lease_id: lease.id,
                  pattern: finding.code,
                })
                askGuardHint = askGuardAdvisoryHint(lease.id)
              }
            }
          }
        } catch (err) {
          // Fail-open: a guard fault must never block a real reply. The log
          // call itself is wrapped so a THROWING logger can never abort
          // delivery from the catch path.
          try {
            log.warn('ask_guard evaluation failed — failing open (reply sent unguarded)', {
              code: 'ask_guard_error',
              chat_id: args.chat_id,
              error: err instanceof Error ? err.message : String(err),
            })
          } catch {
            /* a logger fault must not gate a real reply */
          }
        }

        const files = args.files ?? []

        // Resolve every attachment through the workspace gate up front, so a
        // file rejection never leaves a half-sent reply (text already shipped,
        // attachment then refused). Canonical paths come back from the gate
        // and we use those for sendDocument/sendPhoto below.
        const canonicalFiles: string[] = []
        for (const f of files) {
          try {
            canonicalFiles.push(assertSendableFile({ filePath: f, config }))
          } catch (err) {
            return toolError(name, err instanceof Error ? err.message : String(err))
          }
        }

        const replyToId = args.reply_to !== undefined ? Number(args.reply_to) : undefined

        // Forum-topic threading. Explicit thread_id wins; otherwise default to
        // the last inbound topic remembered for this chat so a reply lands in
        // the topic the message came from, never the supergroup's General.
        // A non-positive / unparsable value resolves to undefined (General).
        const explicitThread =
          args.thread_id !== undefined ? Number(args.thread_id) : undefined
        const resolvedThread =
          explicitThread !== undefined && Number.isFinite(explicitThread) && explicitThread > 0
            ? explicitThread
            : deps.threadStore?.get(args.chat_id)
        const threadId =
          resolvedThread !== undefined && resolvedThread > 0 ? resolvedThread : undefined

        const sentIds: number[] = []

        // Outbox re-send payload (2026-07-07), computed BEFORE any send so the
        // flood-catch below can queue the exact undelivered reply. Rendered
        // per-format so the delayed re-send displays like the live send would
        // have. It is a SINGLE message (no chunk-split): a flood ban rejects
        // the FIRST send, so the whole reply is undelivered; a reply long
        // enough to exceed Telegram's 4096 cap on re-send is the rare
        // exception (it would fail non-flood in the flusher and drop after
        // maxAttempts) — acceptable versus the common case of losing the reply.
        const outboxText =
          args.format === 'html' || args.format === 'rich'
            ? markdownToTelegramHtml(args.text)
            : args.text
        const outboxOpts: SendMessageOpts = {}
        if (args.format === 'html' || args.format === 'rich') outboxOpts.parse_mode = 'HTML'
        else if (args.format === 'markdownv2') outboxOpts.parse_mode = 'MarkdownV2'
        if (replyToId !== undefined) outboxOpts.reply_to_message_id = replyToId
        if (threadId !== undefined) outboxOpts.message_thread_id = threadId

        // Wrap the whole send below so a LONG flood-ban 429 (fail-fast throw
        // from the rate-limited api) is caught HERE, with `sentIds` in scope.
        // ANTI-DUPLICATE INVARIANT: we enqueue for the flusher ONLY when
        // `sentIds.length === 0` — i.e. NOTHING shipped in-turn — so the reply
        // is delivered by exactly one actor (the flusher), never twice. A
        // partial send (some chunk out, then a fresh ban) falls through to the
        // outer catch's legacy "not delivered" message rather than re-queuing
        // the already-sent prefix.
        try {

        // ── M1 Rich Messages (Bot API 10.1) ─────────────────────────────
        // Attempt a single RAW-markdown rich send when ALL conditions hold.
        // On success we push the id and SKIP the HTML/text+chunk path. On a
        // transparent `{ fallback: true }` we fall through to the existing
        // HTML path UNCHANGED — exactly one path ships, so the reply is
        // never lost or duplicated. A `transient` error re-throws from the
        // safe wrapper (caught by the outer try) so we never silently
        // swallow then resend.
        const richLatch = deps.richLatch
        const richEligible =
          config.richMessages.enabled &&
          args.format !== 'text' &&
          args.format !== 'markdownv2' &&
          richLatch !== undefined &&
          !richLatch.sendDisabled &&
          !config.richMessages.perChatOptOut.includes(args.chat_id) &&
          files.length === 0 &&
          contentFitsRichLimits(args.text) &&
          isDmChat(args.chat_id) &&
          !carriesExpandableBlockquote(args.text)

        let richSent = false
        if (richEligible) {
          const richOpts: SendRichMessageOpts = {}
          if (replyToId !== undefined) richOpts.reply_to_message_id = replyToId
          const res = await telegramApi.sendRichMessage(args.chat_id, args.text, richOpts)
          if ('message_id' in res) {
            sentIds.push(res.message_id)
            richSent = true
          }
          // else res.fallback === true → fall through to the HTML path below.
        }

        if (richSent) {
          // Rich shipped the whole body — nothing else to send for text.
          // (Attachments are impossible here: richEligible required
          // files.length === 0.)
        } else if (args.format === 'html' || args.format === 'rich') {
          // HTML path (also the transparent fallback for 'rich'): when rich
          // was skipped (disabled / non-DM / oversize / opted-out / has
          // files) or fell back, render markdown → validated Telegram HTML.
          // Convert markdown → Telegram HTML, then chunk at 4000 chars so we
          // never exceed Telegram's 4096 sendMessage cap. reply_to applies
          // only to the first chunk so a long answer doesn't quote-spam the
          // user's original message N times.
          const rendered = markdownToTelegramHtml(args.text)
          const chunks = splitMessage(rendered)
          for (let i = 0; i < chunks.length; i++) {
            const chunkOpts: SendMessageOpts = { parse_mode: 'HTML' }
            if (i === 0 && replyToId !== undefined) chunkOpts.reply_to_message_id = replyToId
            if (threadId !== undefined) chunkOpts.message_thread_id = threadId
            const chunk = chunks[i] as string
            try {
              const out = await telegramApi.sendMessage(args.chat_id, chunk, chunkOpts)
              sentIds.push(out.message_id)
            } catch (err) {
              if (isTelegramHtmlParseError(err)) {
                // Telegram rejected our HTML. Retry the SAME chunk as plain
                // text so the user still sees the answer body — better a
                // missing <b> than a missing reply. Mirror gateway.py:500-510.
                log.warn('telegram HTML parse failed, retrying as plain text', {
                  chunk_index: i,
                  error: err instanceof Error ? err.message : String(err),
                })
                const plainOpts: SendMessageOpts = {}
                if (i === 0 && replyToId !== undefined) plainOpts.reply_to_message_id = replyToId
                if (threadId !== undefined) plainOpts.message_thread_id = threadId
                const out = await telegramApi.sendMessage(args.chat_id, chunk, plainOpts)
                sentIds.push(out.message_id)
              } else {
                throw err
              }
            }
          }
        } else {
          // text / markdownv2 — also chunk at 4000 chars so a 9000-char reply
          // does not trip Telegram's 4096 sendMessage cap. reply_to threads
          // only the first chunk so a long answer doesn't quote-spam.
          // chunk.ts' tag-balancing is HTML-specific; for text/markdownv2 we
          // still rely on the same paragraph/line/hard-cut preference order
          // (the tag-balance path is a no-op when no <pre>/<code> tags).
          const chunks = splitMessage(args.text)
          for (let i = 0; i < chunks.length; i++) {
            const chunkOpts: SendMessageOpts = {}
            if (i === 0 && replyToId !== undefined) chunkOpts.reply_to_message_id = replyToId
            if (threadId !== undefined) chunkOpts.message_thread_id = threadId
            if (args.format === 'markdownv2') chunkOpts.parse_mode = 'MarkdownV2'
            const chunk = chunks[i] as string
            const sent = await telegramApi.sendMessage(args.chat_id, chunk, chunkOpts)
            sentIds.push(sent.message_id)
          }
        }

        // Attachments. We send the canonical (realpath-resolved) path so a
        // symlink or relative path inside the workspace becomes the absolute
        // file ultimately handed to grammY's InputFile.
        for (const canonical of canonicalFiles) {
          const opts: SendDocumentOpts = {}
          if (args.reply_to !== undefined) opts.reply_to_message_id = Number(args.reply_to)
          if (threadId !== undefined) opts.message_thread_id = threadId
          const out = isPhotoExtension(canonical)
            ? await telegramApi.sendPhoto(args.chat_id, canonical, opts)
            : await telegramApi.sendDocument(args.chat_id, canonical, opts)
          sentIds.push(out.message_id)
        }

        // Real answer shipped — clear the transient status. complete() is
        // idempotent (no-op when no status is active), so this is safe even
        // when the agent never opened a status.
        try {
          await statusManager.complete(args.chat_id)
        } catch (err) {
          log.warn('status complete after reply failed (ignored)', {
            chat_id: args.chat_id,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        // Observe-only TOV/format check: compute cheap rule-code metrics on the
        // OUTGOING body and surface them back to the agent as a hint. NEVER
        // blocking, NEVER rewriting prose, and NEVER logging the message text —
        // only rule codes + counts. Purely advisory feedback so the model
        // self-corrects on the NEXT message.
        //
        // Guarded: the message already SHIPPED — a checker throw here would
        // surface as a tool error and could push the agent into a duplicate
        // resend. Any failure degrades to "no findings".
        let hint = ''
        try {
          const formatFindings = analyzeFormat(args.text)
          if (formatFindings.length > 0) {
            log.info('reply format check', {
              chat_id: args.chat_id,
              codes: formatFindings.map((f) => `${f.code}=${f.count}`).join(','),
            })
          }
          hint = formatHint(formatFindings)
        } catch (err) {
          log.debug('reply format check failed (ignored)', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        // Open-question reminder: remember that this reply left the owner on
        // the critical path, so the sweep can nudge him if he never answers —
        // and CLEAR a previous record when this reply asks nothing, otherwise
        // he gets reminded about a question he already answered.
        //
        // Guarded like the format check above: the message already SHIPPED, so
        // any fault here degrades to "no reminder", never to a tool error that
        // could push the agent into a duplicate resend.
        try {
          const oq = detectOpenQuestion(args.text)
          const firstId = sentIds[0]
          if (oq !== undefined && firstId !== undefined) {
            deps.openQuestions?.set({
              chatId: args.chat_id,
              // The FIRST part of a chunked reply — the reminder quote-replies
              // to where the question started.
              messageId: firstId,
              ...(threadId !== undefined ? { threadId } : {}),
              askedAtMs: Date.now(),
              code: oq.code,
              snippet: oq.snippet,
              remindersSent: 0,
            })
          } else {
            deps.openQuestions?.clear(args.chat_id)
          }
        } catch (err) {
          log.debug('open-question record failed (ignored)', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        // Assemble the tool result: base «sent …» line, plus the ask-guard
        // advisory hint when a mandate is active and the body self-gated, plus
        // the observe-only format hint. Each is optional and independent.
        const resultParts = [result]
        if (askGuardHint) resultParts.push(askGuardHint)
        if (hint) resultParts.push(hint)
        return { content: [{ type: 'text', text: resultParts.join('\n') }] }
        } catch (err) {
          // LONG flood ban with NOTHING delivered → persist the reply and let
          // the background flusher deliver it once the ban lifts. This does
          // NOT retry in-turn (no double-send) and does NOT sleep (no frozen
          // turn / extended ban): enqueue, then tell the agent to end the turn.
          const cls = classifyEditError(err)
          if (cls.kind === 'flood' && deps.outbox !== undefined && sentIds.length === 0) {
            const retryAfter = cls.retryAfterSec ?? OUTBOX_FALLBACK_RETRY_S
            try {
              deps.outbox.enqueue(args.chat_id, outboxText, outboxOpts, retryAfter)
            } catch (e) {
              log.warn('outbox enqueue failed (ignored)', {
                chat_id: args.chat_id,
                error: e instanceof Error ? e.message : String(e),
              })
            }
            return toolError(
              name,
              'Telegram flood ban (429). Your reply was NOT sent right now, but it has been ' +
                'QUEUED and will be delivered automatically once Telegram lifts the ban. ' +
                'Do NOT retry this send and do NOT run `sleep`/wait — just end your turn; ' +
                'the background flusher delivers the queued reply on its own.',
            )
          }
          // No outbox, a partial send, or a non-flood error → hand off to the
          // outer catch (legacy "not delivered" for flood; generic otherwise).
          throw err
        }
      }

      case 'react': {
        const parsed = ReactArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        await telegramApi.setMessageReaction(args.chat_id, Number(args.message_id), args.emoji)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'download_attachment': {
        const parsed = DownloadAttachmentArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const out = await telegramApi.downloadFile(args.file_id, statePaths.inbox)
        return { content: [{ type: 'text', text: out.path }] }
      }

      case 'edit_message': {
        const parsed = EditMessageArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const opts: EditOpts = {}
        if (args.format === 'markdownv2') opts.parse_mode = 'MarkdownV2'
        await telegramApi.editMessageText(args.chat_id, Number(args.message_id), args.text, opts)
        return { content: [{ type: 'text', text: `edited (id: ${args.message_id})` }] }
      }

      case 'status': {
        const parsed = StatusArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        // No active status → silently no-op. The agent may try to set a
        // status before /start has fired (e.g. webhook-driven flow) — we
        // don't want to error out the tool call. Same logic as gateway.py
        // which just no-ops when status_msg_id is None.
        const active = statusManager.isActive(args.chat_id)
        if (!active) {
          return { content: [{ type: 'text', text: 'status no-op (no active session)' }] }
        }

        // stopped/error → cancel (edits to terminal label, stops timers).
        if (args.state === 'stopped' || args.state === 'error') {
          const reason = args.reason ?? args.state
          await statusManager.cancel(args.chat_id, reason)
          return { content: [{ type: 'text', text: 'status canceled' }] }
        }

        // tool requires tool_name — surface a clear Zod-style error rather
        // than silently rendering an empty 🔧 tag.
        if (args.state === 'tool' && (args.tool_name === undefined || args.tool_name.length === 0)) {
          return toolError(name, 'state="tool" requires tool_name')
        }

        // Build a fresh handle synthetically — update() validates message_id
        // against the live entry, so we have to read it back from the
        // manager. We expose this by re-invoking start without an active
        // session if the agent passes typing/thinking and there is none.
        // Since we checked isActive above, the entry exists; reach into the
        // manager via a thin helper. Cleaner: add a public update-by-chat
        // method. We do that here:
        const state: StatusState =
          args.state === 'tool'
            ? { kind: 'tool', toolName: args.tool_name! }
            : args.state === 'typing'
              ? { kind: 'typing' }
              : { kind: 'thinking' }
        await statusManager.updateByChatId(args.chat_id, state)
        return { content: [{ type: 'text', text: 'status updated' }] }
      }

      case 'autonomy': {
        const parsed = AutonomyArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }

        const now = Date.now()

        if (args.action === 'status') {
          // Read-only — no serialization needed.
          const state = loadAutonomyState(statePaths, args.chat_id, log)
          return { content: [{ type: 'text', text: renderAutonomyStatus(state, now) }] }
        }

        // Honest refusal when a FRESH writer lock is held by another process —
        // shared by all three mutating actions.
        const writerConflict = (): CallToolResult =>
          toolError(
            name,
            'autonomy registry is write-locked by another live writer process — mutation refused (writer_conflict), retry later',
          )

        // A file from a NEWER schema (version > 1) is read-only — refuse the
        // mutation rather than downgrade + clobber it.
        const versionUnsupported = (): CallToolResult =>
          toolError(
            name,
            'autonomy registry was written by a newer plugin version — it is read-only, mutation refused (version_unsupported); upgrade the plugin',
          )

        if (args.action === 'consume') {
          // lease_id presence is enforced by the schema's superRefine. The
          // mutation routes through updateAutonomyState — the serialized
          // read-modify-write — so two concurrent consumes can never both
          // succeed.
          const leaseId = args.lease_id as string
          const upd = await updateAutonomyState(
            statePaths,
            args.chat_id,
            (state) => {
              const r = consumeLease(state, leaseId, now)
              return { state: r.state, result: r.outcome }
            },
            log,
            now,
          )
          if (upd.kind === 'writer_conflict') return writerConflict()
          if (upd.kind === 'version_unsupported') return versionUnsupported()
          switch (upd.result) {
            case 'not_found':
              return toolError(name, `lease not found: ${leaseId}`)
            case 'already_consumed':
              return toolError(name, `lease already consumed: ${leaseId}`)
            case 'revoked':
              // Terminal revoked state: withdrawn authority can never be consumed.
              return toolError(name, `lease revoked: ${leaseId} — the mandate's authority was withdrawn, it cannot be consumed`)
            case 'expired':
              // Honest refusal: the mandate's window has passed — do not report
              // success on a dead mandate.
              return toolError(name, `lease expired: ${leaseId} — the mandate window has passed, it cannot be consumed`)
            case 'ok':
              return { content: [{ type: 'text', text: `lease consumed: ${leaseId}` }] }
          }
        }

        if (args.action === 'revoke') {
          // Self-revoke: the agent may WITHDRAW its own authority
          // (revokedBy='agent') — shrinking is safe; granting is not.
          const leaseId = args.lease_id as string
          const upd = await updateAutonomyState(
            statePaths,
            args.chat_id,
            (state) => {
              const r = revokeLease(state, leaseId, now, 'agent', args.reason)
              return { state: r.state, result: r.outcome }
            },
            log,
            now,
          )
          if (upd.kind === 'writer_conflict') return writerConflict()
          if (upd.kind === 'version_unsupported') return versionUnsupported()
          switch (upd.result) {
            case 'not_found':
              return toolError(name, `lease not found: ${leaseId}`)
            case 'already_consumed':
              return toolError(name, `lease already consumed: ${leaseId} — a used mandate cannot be revoked`)
            case 'already_revoked':
              return toolError(name, `lease already revoked: ${leaseId}`)
            case 'expired':
              return toolError(name, `lease expired: ${leaseId} — an expired mandate has no authority left, nothing to revoke`)
            case 'ok':
              return { content: [{ type: 'text', text: `lease revoked: ${leaseId}` }] }
          }
        }

        // action === 'resolve_question' (question_id + resolution enforced by schema).
        const questionId = args.question_id as string
        const resolution = args.resolution as 'answered' | 'bypassed'
        const upd: UpdateResult<ReturnType<typeof resolveQuestion>['outcome']> = await updateAutonomyState(
          statePaths,
          args.chat_id,
          (state) => {
            const r = resolveQuestion(state, questionId, resolution, now)
            return { state: r.state, result: r.outcome }
          },
          log,
          now,
        )
        if (upd.kind === 'writer_conflict') return writerConflict()
        if (upd.kind === 'version_unsupported') return versionUnsupported()
        switch (upd.result) {
          case 'not_found':
            return toolError(name, `question not found: ${questionId}`)
          case 'sticky_forbidden':
            // Store-enforced invariant: security questions can never be
            // bypassed — only an owner answer resolves them.
            return toolError(name, `question ${questionId} is sticky (security) — bypass is forbidden, it requires the owner's answer`)
          case 'already_resolved':
            return toolError(name, `question already resolved: ${questionId}`)
          case 'ok':
            return { content: [{ type: 'text', text: `question ${questionId} resolved: ${resolution}` }] }
        }
      }

      case 'pin': {
        const parsed = PinArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const pinApi = deps.pinApi
        if (pinApi === undefined) {
          return toolError(name, 'pin is not available in this wiring')
        }
        const messageId = Number(args.message_id)
        if (args.action === 'unpin') {
          await pinApi.unpinChatMessage(args.chat_id, messageId)
          return { content: [{ type: 'text', text: `unpinned (id: ${messageId})` }] }
        }
        // Silent on purpose: a dashboard re-pin must not ping the owner's device.
        await pinApi.pinChatMessage(args.chat_id, messageId, { disable_notification: true })
        return { content: [{ type: 'text', text: `pinned (id: ${messageId})` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('tool call failed', { tool: name, error: msg })
    // Flood ban (429): the rate-limited API already exhausted its bounded
    // retries before throwing. Surface explicit guidance instead of the raw
    // "retry_after: N" — otherwise the agent has been observed to invent a
    // blocking `sleep` to "ride out" the cooldown, which freezes the whole
    // turn (no new messages processed) and, because every send extends the
    // ban, only makes it worse. Tell the agent to stop and end the turn.
    if (classifyEditError(err).kind === 'flood') {
      return toolError(
        name,
        'Telegram flood ban (429). The message was NOT delivered. ' +
          'Do NOT retry this send and do NOT run `sleep`/wait to ride out the cooldown — ' +
          'a blocking wait freezes your whole session and blocks new messages, and every ' +
          'retry only extends the ban. Stop now and end your turn without further sends; ' +
          'the channel paces automatically and recovers on its own once Telegram lifts the ban.',
      )
    }
    return toolError(name, msg)
  }
}
