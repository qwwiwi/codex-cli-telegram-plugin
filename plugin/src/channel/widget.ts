// Limits and pre-flight checks for Telegram Bot API widgets (sendWidget).
// Every rule is checked BEFORE the HTTP call, so the model gets a precise
// refusal with the measured size instead of an opaque Bot API 400.
//
// Limits (https://core.telegram.org/bots/widgets):
//   html     <= 32768 bytes UTF-8 AND <= 4096 bytes after zlib level 9, no NUL
//   caption  <= 1024 characters
// Widgets work only in a private chat with the bot.
// Ported from the Claude Code version of the plugin (channel/widget.ts).

import { deflateSync } from 'node:zlib'

export const WIDGET_HTML_MAX_BYTES = 32768
export const WIDGET_HTML_MAX_ZLIB_BYTES = 4096
export const WIDGET_CAPTION_MAX_CHARS = 1024

// A human-readable refusal, or undefined when the html is sendable. The zlib
// pass runs only on html that already fits the raw cap.
export function checkWidgetHtml(html: string): string | undefined {
  if (html.includes('\u0000')) return 'html contains a NUL character'
  const raw = Buffer.byteLength(html, 'utf8')
  if (raw > WIDGET_HTML_MAX_BYTES) return `html is ${raw} bytes, over the ${WIDGET_HTML_MAX_BYTES}-byte limit`
  const zipped = deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length
  if (zipped > WIDGET_HTML_MAX_ZLIB_BYTES) {
    return `html is ${zipped} bytes after zlib level 9, over the ${WIDGET_HTML_MAX_ZLIB_BYTES}-byte limit`
  }
  return undefined
}

// A private chat id is positive; groups and channels are negative. Non-numeric ids fail closed.
export function checkWidgetChat(chatId: string): string | undefined {
  const id = Number(chatId)
  if (Number.isFinite(id) && id > 0) return undefined
  return `chat ${chatId} is not a private chat; Telegram shows widgets only in a private chat with the bot`
}

// Counted in UTF-16 code units, the stricter reading of the limit.
export function checkWidgetCaption(caption: string): string | undefined {
  if (caption.length > WIDGET_CAPTION_MAX_CHARS) {
    return `caption is ${caption.length} characters, over the ${WIDGET_CAPTION_MAX_CHARS}-character limit`
  }
  return undefined
}

// The one place that knows every size rule of the final payload: the component
// tool calls it early, the raw API layer again on what actually goes out.
export function checkWidgetPayload(payload: { html: string; caption: string }): string | undefined {
  return checkWidgetHtml(payload.html) ?? checkWidgetCaption(payload.caption)
}
