import { carriesExpandableBlockquote } from '../channel/tools.js'
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
