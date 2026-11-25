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
