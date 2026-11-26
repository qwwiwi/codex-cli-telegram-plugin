import { splitMessage } from '../format/chunk.js'
import { markdownToTelegramHtml } from '../format/html.js'
import { splitLongBlock, splitLongBlockLegacy } from '../format/paragraphs.js'
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
 */
export function plannedTextParts(receipts: ReplyReceipts, id: number, text: string): string[] {
  const saved = receipts.replyPlan(id)
  if (saved) return [...saved]
  const legacy = receipts.replyPart(id, 'text:0') !== undefined
  const parts = splitMessage(markdownToTelegramHtml(legacy ? splitLongBlockLegacy(text) : splitLongBlock(text)))
  receipts.setReplyPlan(id, parts)
  return parts
}
