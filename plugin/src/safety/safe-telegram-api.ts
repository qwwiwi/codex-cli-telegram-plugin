// Safety wrapper around TelegramApi: the outbound masking choke point.
//
// Every text the bridge sends is rendered to the text Telegram will show
// (format/visible.ts render: HTML, MarkdownV2 or plain), masked there
// (mask: every registered value and pattern rule, the formatting carried
// beside the text) and passed down as text + entities with parse_mode
// removed. The string we mask is, character for character, the string the
// reader sees, so markup can no longer hide, split or re-join a value.
//
// Routes: sendMessage, editMessageText, editRichMessage (a text edit),
// answerGuestQuery (article text or file caption, file title), photo and
// document captions, the widget caption. Rich sends are off: without a
// latch sendRichMessage reports `{ fallback }` and callers take the text
// path. The raw adapter masks once more right before HTTP (its wire guard),
// so a value registered while a send waits in the rate limiter is masked
// too.
//
// The wrapper returns a fresh TelegramApi-shaped object whose every method
// is a thin function. Callers swap the raw instance for this one and need
// no code changes downstream.

import { basename } from 'node:path'

import type { Logger } from '../log.js'
import type {
  AnswerGuestQueryOpts,
  ChatAction,
  DownloadResult,
  EditOpts,
  EditResult,
  InlineKeyboardLike,
  SendDocumentOpts,
  SendFileResult,
  SendMessageOpts,
  SendRichMessageOpts,
  SendRichMessageResult,
  SendWidgetParams,
  SentMessage,
  SentText,
  TelegramApi,
} from '../channel/tools.js'
import { escapeHtml, escapeHtmlAttr, isTelegramHtmlParseError, markdownToTelegramHtml } from '../format/html.js'
import { CAPTION_LIMIT, maskPiece, maskString, MESSAGE_HARD_LIMIT, render, visibleToHtml, type Entity,
  type SourceFormat, type VisibleText } from '../format/visible.js'
import { redactSecrets } from './redact.js'
import { richErrorClass } from '../format/rich.js'
import type { RichLatch } from './rich-latch.js'
import { MaskedOverflowError, WidgetPreSendError } from './pre-send-error.js'

/**
 * Walk an inline keyboard and redact every button's `text` and `url`
 * fields in place on a freshly cloned object. The structural type
 * `InlineKeyboardLike` only declares `{ text, callback_data? }` cells,
 * but Telegram's wire format also accepts `url` (and several other
 * button kinds). We treat each cell as an open record so an unknown
 * field — say `web_app.url` or `login_url.url` — survives untouched.
 *
 * We don't run HTML validation on button text or url: buttons don't
 * render markup. We only redact secrets.
 */
function redactReplyMarkup(
  markup: InlineKeyboardLike,
  extraSecrets: ReadonlyArray<string> | undefined,
): InlineKeyboardLike {
  // FIX-T1 F4 (PRX-1 Phase 5, 2026-05-27): non-inline markups (ForceReply,
  // ReplyKeyboardMarkup, ReplyKeyboardRemove) carry no inline_keyboard
  // field — only `force_reply`, `selective`, `input_field_placeholder`,
  // or `keyboard`/`remove_keyboard` flags. The previous implementation
  // discarded everything but inline_keyboard, silently breaking the
  // AskUserQuestion «Other» force_reply prompt. Pass these through
  // verbatim (no string fields to redact) by typeof-probing the field.
  const maybeInline = (markup as { inline_keyboard?: unknown }).inline_keyboard
  if (!Array.isArray(maybeInline)) {
    // ForceReply / ReplyKeyboardRemove / ReplyKeyboardMarkup. None of
    // their primitive fields carry caller text that needs redaction
    // (input_field_placeholder is bot-author controlled), so a shallow
    // clone keeps grammY's shape intact.
    return { ...(markup as object) } as unknown as InlineKeyboardLike
  }
  // Defensive: the array may be missing, malformed, or contain unknown
  // cells. We copy row by row, cell by cell, redacting only string-typed
  // `text` and `url` fields.
  const rows = maybeInline
  const safeRows: { text: string; callback_data?: string }[][] = rows.map((row) => {
    if (!Array.isArray(row)) return []
    return row.map((cell) => {
      // Treat the cell as an open record so we can read/write `url` and
      // other fields without leaking `any`. Unknown keys are preserved.
      const c = cell as Record<string, unknown>
      const next: Record<string, unknown> = { ...c }
      if (typeof c.text === 'string') {
        next.text = maskString(c.text, extraSecrets)
      }
      if (typeof c.url === 'string') {
        next.url = maskString(c.url, extraSecrets)
      }
      // Cast back to the structural cell type — the unknown extra keys
      // ride along because TS doesn't widen object literal property sets
      // through Record-cast. This is intentional: we forward whatever
      // shape grammY sent us with only text/url sanitised.
      return next as { text: string; callback_data?: string }
    })
  })
  return { inline_keyboard: safeRows }
}

/** Each secret as written and in the escaped forms it takes in rendered Telegram HTML. */
function htmlSecretForms(secrets: ReadonlyArray<string>): string[] {
  return [...new Set(secrets.flatMap(secret => [secret, escapeHtml(secret), escapeHtmlAttr(secret),
    // The Markdown renderer escapes only the three characters Telegram requires.
    secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')]))]
}

/**
 * The redaction the safe wrapper applies to one outbound text: every pattern rule plus the exact secrets, in their
 * escaped HTML forms too when the text is HTML.
 */
export function redactOutboundText(text: string, parseMode: 'MarkdownV2' | 'HTML' | undefined,
  secrets: ReadonlyArray<string>): string {
  return redactSecrets(text, parseMode === 'HTML' ? htmlSecretForms(secrets) : secrets)
}

/**
 * The masked text Telegram will show for `text` sent with `parseMode`, its formatting as entities. Masking can
 * grow a message (`[REDACTED]` is longer than a short value) past the limit Telegram counts on what it shows:
 * that is refused before the request, so the caller splits the text instead of losing it to a 400.
 */
function shownMasked(text: string, parseMode: SourceFormat, secrets: ReadonlyArray<string> | undefined,
  limit: number = MESSAGE_HARD_LIMIT, entities?: Entity[], before?: string): VisibleText {
  // A caller that planned the shown text itself (a reply piece) passes its entities and no parse_mode, and the
  // shown text already sent ahead of the piece: the two are masked as one text (see maskPiece).
  const shown = entities !== undefined && parseMode === undefined ? { text, entities } : render(text, parseMode)
  const visible = maskPiece(shown, secrets, before)
  if (visible.text.length > limit && shown.text.length <= limit) {
    throw new MaskedOverflowError('the masked message is longer than Telegram allows; nothing was sent')
  }
  return visible
}

// What a send reports it sent, for render records: Telegram HTML of the masked shown text when it has formatting
// or came from markup, the text itself when it was plain all along. Never sent anywhere.
function sentRecord(visible: VisibleText, formatted: boolean): SentText {
  return formatted || visible.entities.length > 0
    ? { text: visibleToHtml(visible), format: 'HTML' } : { text: visible.text, format: 'plain' }
}

// The refusal of explicit entities: the 400 «can't parse entities» family, an ENTITY_* error code, or a description
// about an entity's bounds, offset or length.
const ENTITY_REFUSAL_RE = /\bENTITY_[A-Z_]+\b|\bentit(?:y|ies)\b[^.]*\b(?:bounds|offset|length|invalid)\b/i

function errorTexts(error: object): string[] {
  const texts: string[] = []
  if ('description' in error && typeof error.description === 'string') texts.push(error.description)
  if ('message' in error && typeof error.message === 'string') texts.push(error.message)
  return texts
}

/**
 * Telegram's definite refusal of a request's entities (a 400 that names them): the same text goes once more
 * without them. A pure function of the error; nothing else counts.
 */
export function isEntityRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('error_code' in error) || error.error_code !== 400) return false
  return isTelegramHtmlParseError(error) || errorTexts(error).some(text => ENTITY_REFUSAL_RE.test(text))
}

/**
 * Send `visible` through `attempt` with its entities; when Telegram refuses them, once more as the same text
 * without them. Every text route shares it, so a refusal never turns into a different text (markup, a source).
 */
async function withEntityRetry<T>(visible: VisibleText, log: Logger, route: string,
  attempt: (entities: Entity[]) => Promise<T>): Promise<{ value: T; shown: VisibleText }> {
  try {
    return { value: await attempt(visible.entities), shown: visible }
  } catch (error) {
    if (visible.entities.length === 0 || !isEntityRejection(error)) throw error
    log.warn(`telegram refused the entities, ${route} the same text without formatting`)
    return { value: await attempt([]), shown: { text: visible.text, entities: [] } }
  }
}

/**
 * Wrap the raw TelegramApi so every text-sending call goes out as masked shown text plus entities.
 *
 * @param raw           The underlying TelegramApi (typically createTelegramApi()).
 * @param log           Channel logger.
 * @param extraSecrets  Optional list of exact-substring secrets to mask
 *                      (e.g. webhook token, Groq key). A live list: values
 *                      appended later are masked on the next send.
 * @param richLatch     Optional M1 rich-message capability latch. The bridge
 *                      passes none: rich messages are markup Telegram renders,
 *                      with no text + entities form, so sendRichMessage then
 *                      always reports `{ fallback }` and the caller sends text.
 */
export function createSafeTelegramApi(
  raw: TelegramApi,
  log: Logger,
  extraSecrets?: ReadonlyArray<string>,
  richLatch?: RichLatch,
): TelegramApi {
  // A caption has no parse_mode on this interface: it is plain text, masked and sent with caption entities.
  // The upload's name is shown too (the document's title in the chat): the explicit one, or the one grammY takes
  // from the path, is masked like text.
  const safeCaption = (filePath: string, opts: SendDocumentOpts): SendDocumentOpts => {
    const filename = maskString(opts.filename ?? basename(filePath), extraSecrets)
    if (typeof opts.caption !== 'string') return { ...opts, filename }
    const caption = shownMasked(opts.caption, undefined, extraSecrets, CAPTION_LIMIT)
    return { ...opts, filename, caption: caption.text, caption_entities: caption.entities }
  }

  return {
    // The redaction choke point for every outgoing text: the source is rendered to the text Telegram shows,
    // masked there, and sent as text + entities without a parse_mode. The result carries what was sent.
    async sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<SentMessage> {
      const visible = shownMasked(text, opts.parse_mode, extraSecrets, MESSAGE_HARD_LIMIT, opts.entities,
        opts.sentBefore)
      const { parse_mode: parseMode, ...rest } = opts
      const safeOpts: SendMessageOpts = { ...rest, entities: visible.entities }
      if (safeOpts.reply_markup) {
        safeOpts.reply_markup = redactReplyMarkup(safeOpts.reply_markup, extraSecrets)
      }
      const { value, shown } = await withEntityRetry(visible, log, 'sending',
        entities => raw.sendMessage(chatId, visible.text, { ...safeOpts, entities }))
      // A retry without the entities sent plain text, whatever markup the source had.
      return { ...value, sent: sentRecord(shown, shown === visible && parseMode !== undefined) }
    },

    // Widget html is CODE, not prose: redaction must never silently rewrite it
    // (a masked value inside a <script> is broken JavaScript). If the redactor
    // would change the html, the call fails closed with the offset, never the
    // value. The caption is plain fallback text and is redacted like a message.
    async sendWidget(chatId: string, params: SendWidgetParams): Promise<{ message_id: number }> {
      const redacted = redactSecrets(params.html, extraSecrets)
      if (redacted !== params.html) {
        let offset = 0
        while (offset < params.html.length && params.html[offset] === redacted[offset]) offset += 1
        throw new WidgetPreSendError(`widget html looks like it contains a secret at offset ${offset}; nothing was sent`)
      }
      const caption = shownMasked(params.caption, undefined, extraSecrets, CAPTION_LIMIT).text
      return raw.sendWidget(chatId, { ...params, caption })
    },

    async sendRichMessage(
      chatId: string,
      rawMarkdown: string,
      opts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      // Latch already tripped (or no latch wired) → don't even attempt the
      // send; report fallback so the caller uses the validated HTML path.
      // Checked before redaction: a latched-off session would otherwise pay
      // a full redaction pass on up-to-32KB text for every skipped call.
      if (richLatch === undefined || richLatch.sendDisabled) {
        return { fallback: true }
      }

      // Redact BEFORE the raw call — secrets must be stripped from the raw
      // markdown before it leaves the process, exactly like the sendMessage
      // path. We do NOT run validateTelegramHtml here: the body is markdown,
      // not HTML, and the validator would corrupt it. Telegram's server-side
      // parser is the safety net — a bad body comes back as a 400 we
      // classify and fall back from.
      const redacted = redactSecrets(rawMarkdown, extraSecrets)

      try {
        const result = await raw.sendRichMessage(chatId, redacted, opts)
        // Like sendMessage: a sent Rich Message carries the Markdown that actually went out.
        return 'message_id' in result ? { ...result, sent: { text: redacted, format: 'rich' } } : result
      } catch (err) {
        const cls = richErrorClass(err)
        if (cls === 'capability') {
          // Telegram / this build can't do rich messages. Latch OFF for the
          // session so we pay this failed call at most once, then fall back.
          richLatch.sendDisabled = true
          log.warn('rich message capability error — latching off, falling back to HTML', {
            error: err instanceof Error ? err.message : String(err),
          })
          return { fallback: true }
        }
        if (cls === 'parser' || cls === 'oversize') {
          // One-off body problem; the HTML path validates + chunks, so fall
          // back without latching (other messages may be fine).
          log.warn('rich message rejected — falling back to HTML', {
            class: cls,
            error: err instanceof Error ? err.message : String(err),
          })
          return { fallback: true }
        }
        // transient (network / 5xx / 429) — surface it. We must NOT fall back
        // here: the rate-limit wrapper owns 429 retries, and swallowing a
        // transient then sending via HTML risks a duplicate if the rich send
        // actually landed. Re-throw so the reply tool's outer try reports it.
        throw err
      }
    },

    // A Rich Message edit becomes a text + entities edit: its Markdown is rendered the way a reply is
    // (Markdown → Telegram HTML → shown text), masked, and sent as text. If Telegram refuses to turn a rich
    // message into text, its error reaches the caller. A refusal of the entities edits to the same text without
    // them, as every text route does.
    async editRichMessage(chatId: string, messageId: number, rawMarkdown: string): Promise<EditResult> {
      const visible = shownMasked(markdownToTelegramHtml(rawMarkdown), 'HTML', extraSecrets)
      const { shown } = await withEntityRetry(visible, log, 'editing to',
        entities => raw.editMessageText(chatId, messageId, visible.text, { entities }))
      return { sent: sentRecord(shown, shown === visible) }
    },

    async editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void> {
      const visible = shownMasked(text, opts.parse_mode, extraSecrets, MESSAGE_HARD_LIMIT, opts.entities)
      const { parse_mode: _parseMode, ...rest } = opts
      const safeOpts: EditOpts = { ...rest, entities: visible.entities }
      // PRX-1 TASK-2 (2026-05-27): edit-time reply_markup mutation needs
      // the same secret-redaction treatment as the send path. Without
      // this an inline keyboard re-render (multi-select toggle, etc.)
      // could ship raw button text/url straight to Telegram.
      //
      // FIX-T1 F2 (Phase 5, 2026-05-27): be explicit about the copy.
      // The spread `{ ...opts }` already brings `reply_markup` across at
      // runtime, but tying redaction to `opts.reply_markup` (the caller's
      // canonical source) instead of `safeOpts.reply_markup` makes the
      // intent obvious and prevents a future drift where someone strips
      // the spread or narrows the EditOpts type — the keyboard would
      // silently stop propagating without this assignment.
      if (opts?.reply_markup !== undefined) {
        safeOpts.reply_markup = redactReplyMarkup(opts.reply_markup, extraSecrets)
      }
      await withEntityRetry(visible, log, 'editing to',
        entities => raw.editMessageText(chatId, messageId, visible.text, { ...safeOpts, entities }))
    },

    // ─── Pass-through methods (no user text) and captions ───────────

    async setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
      return raw.setMessageReaction(chatId, messageId, emoji)
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      return raw.sendChatAction(chatId, action)
    },

    async sendDocument(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult> {
      return raw.sendDocument(chatId, filePath, safeCaption(filePath, opts))
    },

    async sendPhoto(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult> {
      return raw.sendPhoto(chatId, filePath, safeCaption(filePath, opts))
    },

    async downloadFile(fileId: string, destDir: string): Promise<DownloadResult> {
      return raw.downloadFile(fileId, destDir)
    },

    async deleteMessage(chatId: string, messageId: number): Promise<void> {
      return raw.deleteMessage(chatId, messageId)
    },

    async answerGuestQuery(
      guestQueryId: string,
      text: string,
      opts: AnswerGuestQueryOpts,
    ): Promise<void> {
      // Guest answers land in a PUBLIC foreign chat — masking here is the
      // last line of defence, exactly like sendMessage. With a file the text
      // is the file's caption, so the caption limit applies.
      const visible = shownMasked(text, opts.parse_mode, extraSecrets,
        opts.file === undefined ? MESSAGE_HARD_LIMIT : CAPTION_LIMIT)
      const { parse_mode: _parseMode, ...rest } = opts
      const safeOpts: AnswerGuestQueryOpts = { ...rest, entities: visible.entities }
      // An attachment's title is its FILE NAME and lands in the same public
      // chat as the caption — mask it on the same last line of defence.
      if (safeOpts.file !== undefined) {
        safeOpts.file = {
          ...safeOpts.file,
          title: maskString(safeOpts.file.title, extraSecrets),
        }
      }
      // A refusal of the entities answers with the same text without them, never with another body: a failed
      // call does not consume the query.
      await withEntityRetry(visible, log, 'answering with',
        entities => raw.answerGuestQuery(guestQueryId, visible.text, { ...safeOpts, entities }))
    },
  }
}
