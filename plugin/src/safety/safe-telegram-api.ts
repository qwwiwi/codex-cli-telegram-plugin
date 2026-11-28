// Safety wrapper around TelegramApi.
//
// Every outbound TEXT method (sendMessage, editMessageText) runs through:
//   1. redactSecrets(text, extraSecrets) — strips tokens, IPs, secret paths,
//      and any caller-supplied substrings before the body leaves the process.
//   2. validateTelegramHtml(text) — only when parse_mode === 'HTML'. If the
//      body is invalid Telegram HTML, we downgrade by removing parse_mode
//      and shipping the body as plain text. Telegram will accept it.
//
// Methods that don't accept user text (sendDocument, sendPhoto, downloadFile,
// setMessageReaction, deleteMessage, sendChatAction) are forwarded verbatim.
// Captions on document/photo sends DO contain user text — Phase A1 keeps the
// scope tight to text-only methods; PR-A2 can extend to captions if needed
// (most callers route formatted text through sendMessage with attachment
// resolution done as a separate call).
//
// The wrapper returns a fresh TelegramApi-shaped object whose every method
// is a thin function. Callers swap the raw instance for this one and need
// no code changes downstream.

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
  TelegramApi,
} from '../channel/tools.js'
import { htmlToPlainText, TELEGRAM_MAX_MESSAGE, telegramTextLength } from '../format/chunk.js'
import { escapeHtml, escapeHtmlAttr } from '../format/html.js'
import { redactSecrets } from './redact.js'
import { validateTelegramHtml } from './html-validator.js'
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
        next.text = redactSecrets(c.text, extraSecrets)
      }
      if (typeof c.url === 'string') {
        next.url = redactSecrets(c.url, extraSecrets)
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

/**
 * Wrap the raw TelegramApi so every text-sending call is funneled through
 * redaction + HTML validation. Logger receives a `warn` on HTML downgrade
 * — only the reason is logged, never the body (which may still contain
 * pre-redaction secrets if the agent was sloppy about logging upstream).
 *
 * @param raw           The underlying TelegramApi (typically createTelegramApi()).
 * @param log           Channel logger.
 * @param extraSecrets  Optional list of exact-substring secrets to mask
 *                      (e.g. webhook token, Groq key). Passed through to
 *                      redactSecrets on every send.
 * @param richLatch     Optional M1 rich-message capability latch. When the
 *                      rich send fails with a `capability` error we flip
 *                      `sendDisabled` so subsequent rich attempts short-
 *                      circuit to fallback without hitting Telegram. When
 *                      omitted, sendRichMessage always reports `{ fallback }`
 *                      (the layered chain then uses the HTML path) so a
 *                      mis-wired build degrades safely instead of crashing.
 */
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

// The length Telegram checks against its message limit: what it shows for HTML, the raw text otherwise.
function shownLength(text: string, parseMode: 'MarkdownV2' | 'HTML' | undefined): number {
  return parseMode === 'HTML' ? telegramTextLength(text) : text.length
}

export function createSafeTelegramApi(
  raw: TelegramApi,
  log: Logger,
  extraSecrets?: ReadonlyArray<string>,
  richLatch?: RichLatch,
): TelegramApi {
  const sanitize = (
    text: string,
    parseMode: 'MarkdownV2' | 'HTML' | undefined,
  ): { text: string; parseMode: 'MarkdownV2' | 'HTML' | undefined } => {
    // Redact first — secrets must be stripped regardless of parse mode. HTML text
    // carries a secret in its escaped form (`&` as `&amp;`), so those forms are
    // masked too; callers still redact the source before rendering.
    // The escaped forms are derived per send: a secret registered after this wrapper was built is masked too.
    const redacted = redactSecrets(text, parseMode === 'HTML' && extraSecrets !== undefined
      ? htmlSecretForms(extraSecrets) : extraSecrets)
    if (parseMode !== 'HTML') {
      return { text: redacted, parseMode }
    }
    const validated = validateTelegramHtml(redacted)
    // Markup can separate a token from the prefix that marks it (`Bearer <b>…</b>`): the text Telegram shows
    // joins them. When that visible text still holds a secret, send it masked as plain text.
    const visible = validated.downgraded ? '' : htmlToPlainText(validated.text)
    if (!validated.downgraded && redactSecrets(visible, extraSecrets) !== visible) {
      log.warn('telegram html downgrade', { reason: 'secret in visible text' })
      return { text: redactSecrets(visible, extraSecrets), parseMode: undefined }
    }
    if (validated.downgraded) {
      // Telegram-bound payload is unknown to the operator, so log only the
      // classification (reason). The original text is intentionally NOT in
      // ctx — even after redaction it may carry sensitive context the
      // caller didn't whitelist.
      log.warn('telegram html downgrade', { reason: validated.reason ?? 'unknown' })
      // Decoding entities could reassemble a secret written as numeric entities.
      return { text: redactSecrets(validated.text, extraSecrets), parseMode: undefined }
    }
    return { text: validated.text, parseMode }
  }

  return {
    // The redaction choke point for every outgoing text: the result carries the payload actually sent.
    async sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<SentMessage> {
      const { text: safeText, parseMode } = sanitize(text, opts.parse_mode)
      // Masking can grow a message (`[REDACTED]` is longer than a short value) past the limit Telegram counts on
      // what it shows. Refuse before the request so the caller splits the text instead of losing it to a 400.
      if (shownLength(safeText, parseMode) > TELEGRAM_MAX_MESSAGE &&
          shownLength(text, opts.parse_mode) <= TELEGRAM_MAX_MESSAGE) {
        throw new MaskedOverflowError('the masked message is longer than Telegram allows; nothing was sent')
      }
      // Rebuild opts without mutating caller's object.
      const safeOpts: SendMessageOpts = { ...opts }
      if (parseMode === undefined) {
        delete safeOpts.parse_mode
      } else {
        safeOpts.parse_mode = parseMode
      }
      if (safeOpts.reply_markup) {
        safeOpts.reply_markup = redactReplyMarkup(safeOpts.reply_markup, extraSecrets)
      }
      const result = await raw.sendMessage(chatId, safeText, safeOpts)
      return { ...result, sent: { text: safeText, format: parseMode ?? 'plain' } }
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
      return raw.sendWidget(chatId, { ...params, caption: redactSecrets(params.caption, extraSecrets) })
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

    // A Rich Message edit is redacted like a rich send and reports the Markdown it sent.
    async editRichMessage(chatId: string, messageId: number, rawMarkdown: string): Promise<EditResult> {
      if (raw.editRichMessage === undefined) throw new Error('editRichMessage is not available on this transport')
      const redacted = redactSecrets(rawMarkdown, extraSecrets)
      await raw.editRichMessage(chatId, messageId, redacted)
      return { sent: { text: redacted, format: 'rich' } }
    },

    async editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void> {
      const { text: safeText, parseMode } = sanitize(text, opts.parse_mode)
      const safeOpts: EditOpts = { ...opts }
      if (parseMode === undefined) {
        delete safeOpts.parse_mode
      } else {
        safeOpts.parse_mode = parseMode
      }
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
      return raw.editMessageText(chatId, messageId, safeText, safeOpts)
    },

    // ─── Pass-through methods ────────────────────────────────────────
    // These accept no user-controlled HTML text. Captions could carry user
    // text but Phase A1 keeps the scope tight; see header comment.

    async setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
      return raw.setMessageReaction(chatId, messageId, emoji)
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      return raw.sendChatAction(chatId, action)
    },

    async sendDocument(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult> {
      // Caption is plain text on Telegram unless parse_mode is set on the
      // raw call (we don't expose that here). Redact it defensively in case
      // the caller threaded user text into the caption.
      const safeOpts: SendDocumentOpts = { ...opts }
      if (typeof safeOpts.caption === 'string') {
        safeOpts.caption = redactSecrets(safeOpts.caption, extraSecrets)
      }
      return raw.sendDocument(chatId, filePath, safeOpts)
    },

    async sendPhoto(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<SendFileResult> {
      const safeOpts: SendDocumentOpts = { ...opts }
      if (typeof safeOpts.caption === 'string') {
        safeOpts.caption = redactSecrets(safeOpts.caption, extraSecrets)
      }
      return raw.sendPhoto(chatId, filePath, safeOpts)
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
      // Guest answers land in a PUBLIC foreign chat — redaction here is the
      // last line of defence, exactly like sendMessage. HTML downgrade
      // follows the same rule: invalid Telegram HTML ships as plain text.
      const { text: safeText, parseMode } = sanitize(text, opts.parse_mode)
      const safeOpts: AnswerGuestQueryOpts = { ...opts }
      // An attachment's title is its FILE NAME and lands in the same public
      // chat as the caption — redact it on the same last line of defence.
      if (safeOpts.file !== undefined) {
        safeOpts.file = {
          ...safeOpts.file,
          title: redactSecrets(safeOpts.file.title, extraSecrets),
        }
      }
      if (parseMode === undefined) {
        delete safeOpts.parse_mode
      } else {
        safeOpts.parse_mode = parseMode
      }
      return raw.answerGuestQuery(guestQueryId, safeText, safeOpts)
    },
  }
}
