import { carriesExpandableBlockquote } from '../channel/tools.js'
import { maskShownSecrets, splitMessage, splitMessageFrom } from '../format/chunk.js'
import { splitMessageLegacy } from '../format/chunk-legacy.js'
import { markdownToTelegramHtml } from '../format/html.js'
import { splitLongBlock, splitLongBlockLegacy } from '../format/paragraphs.js'
import { contentFitsRichLimits, needsRichMarkdown } from '../format/rich.js'
import { classifySendError } from '../safety/reliable-telegram-api.js'

export type PartStatus = 'sending' | 'sent' | 'fallback' | 'failed' | 'uncertain'

export async function deliverReplyPart<T>(
  previous: PartStatus | undefined,
  persist: (state: PartStatus | undefined) => void,
  send: () => Promise<T>,
  needsFallback?: (value: T) => boolean,
): Promise<{ state: Exclude<PartStatus, 'sending'>; value?: T }> {
  if (previous === 'sending') {
    persist('uncertain')
    return { state: 'uncertain' }
  }
  if (previous) return { state: previous }
  persist('sending')
  let value: T
  try {
    value = await send()
  } catch (error) {
    const { kind } = classifySendError(error, 30_000)
    if (kind === 'pre_send' || kind === 'rate_limited') {
      persist(undefined)
      throw error
    }
    const state = kind === 'ambiguous' ? 'uncertain' : 'failed'
    persist(state)
    return { state }
  }
  const state = needsFallback?.(value) ? 'fallback' : 'sent'
  persist(state)
  return { state, value }
}

/** The richMessages config block: Rich Messages on or off and the chats that always get HTML. */
export interface RichReplyConfig {
  enabled: boolean
  perChatOptOut: readonly string[]
}

/**
 * True when a reply goes out as one Rich Message (Markdown rendered by Telegram) instead of HTML parts: rich is on
 * for the chat, the reply carries no files, fits the rich limit, has no expandable quote and needs rich Markdown
 * (a table, math, a task list). Prose goes as HTML: in a Rich Message Telegram drops the empty line between paragraphs.
 */
export function sendsAsRich(text: string, chat: string, rich: RichReplyConfig, containsFiles = false): boolean {
  return rich.enabled && !containsFiles && !rich.perChatOptOut.includes(chat) && contentFitsRichLimits(text) &&
    !carriesExpandableBlockquote(text) && needsRichMarkdown(text)
}

/** The receipts of the pending reply's parts and the chunk plan its text parts were sent with. */
export interface ReplyReceipts {
  replyPart(id: number, key: string): PartStatus | undefined
  replyPlan(id: number): readonly string[] | undefined
  setReplyPlan(id: number, parts: readonly string[]): void
}

/**
 * The Telegram HTML text parts of a pending reply; `text` is the normalized reply. The first call saves the plan, so
 * a resumed delivery sends exactly the chunks its `text:N` receipts count, whatever the renderer does by then.
 * Receipts saved without a plan come from a bridge before paragraph grouping: they resume with its chunking.
 * `redact` masks secrets in the source text: the renderer escapes `&`, `<`, `>` and quotes, so an exact-match
 * redaction of the rendered parts would no longer find a value that holds one of them.
 */
export function plannedTextParts(receipts: ReplyReceipts, id: number, text: string,
  redact: (text: string) => string = text => text, onMasked?: (part: string) => void): string[] {
  const saved = receipts.replyPlan(id)
  if (saved) return [...saved]
  const legacy = receipts.replyPart(id, 'text:0') !== undefined
  const source = redact(text)
  const html = markdownToTelegramHtml(legacy ? splitLongBlockLegacy(source) : splitLongBlock(source))
  const parts = legacy ? legacyResumeParts(receipts, id, html) : maskShownSecrets(splitMessage(html), html, redact, onMasked)
  receipts.setReplyPlan(id, parts)
  return parts
}

/**
 * The plan of a reply whose receipts were saved without one: that bridge cut the HTML by its raw length. The parts
 * its receipts count keep the old cuts (they are never sent again); the rest of the text, from the last old cut on,
 * is split with today's chunker. Any receipt counts: a part in any saved state is never sent again.
 */
function legacyResumeParts(receipts: ReplyReceipts, id: number, html: string): string[] {
  const old = splitMessageLegacy(html)
  let done = 0
  while (done < old.chunks.length && receipts.replyPart(id, 'text:' + done) !== undefined) done += 1
  if (done >= old.chunks.length) return old.chunks
  return [...old.chunks.slice(0, done), ...splitMessageFrom(html, old.ends[done - 1] ?? 0)]
}
