import { createHash } from 'node:crypto'
import { classifySendError } from '../safety/reliable-telegram-api.js'
import type { ControlState } from './control-state.js'
import { object } from './rpc.js'

export async function deliverGoalFiles(
  state: ControlState, thread: string, paths: readonly string[], send: (path: string) => Promise<unknown>,
): Promise<{ failed: number; uncertain: number }> {
  let failed = 0
  let uncertain = 0
  for (const path of paths) {
    const key = createHash('sha256').update(path).digest('hex')
    const previous = state.goalFileDelivery(key)
    if (previous === 'sent') continue
    if (previous === 'failed') { failed++; continue }
    if (previous === 'sending' || previous === 'uncertain') { uncertain++; continue }
    state.setGoalFileDelivery(thread, key, 'sending')
    try {
      await send(path)
    } catch (error) {
      const { kind } = classifySendError(error, 30_000)
      if (kind === 'pre_send' || kind === 'rate_limited') {
        state.setGoalFileDelivery(thread, key)
        throw error
      }
      if (kind === 'ambiguous') uncertain++
      else failed++
      state.setGoalFileDelivery(thread, key, kind === 'ambiguous' ? 'uncertain' : 'failed')
      continue
    }
    state.setGoalFileDelivery(thread, key, 'sent')
  }
  return { failed, uncertain }
}

export function shouldRecoverGoal(status: unknown, pending: boolean | undefined, hasMandate: boolean): boolean {
  // Recognize pending goals created before the bridge tracked delivery separately from mandates.
  return (status === 'active' || status === 'complete') && (pending ?? (status === 'active' || hasMandate))
}

export function savedGoalAnswer(turns: unknown[]): string {
  const turn = turns.map(object).findLast(item => item.status === 'completed')
  return savedTurnAnswer(turn) ?? ''
}

export function savedTurnAnswer(value: unknown): string | undefined {
  const turn = object(value)
  if (turn.status !== 'completed') return undefined
  const messages = Array.isArray(turn?.items) ? turn.items.map(object)
    .filter(item => item.type === 'agentMessage' && item.delivery !== 'async' && typeof item.text === 'string') : []
  const answer = messages.findLast(item => item.phase === 'final_answer') ??
    messages.findLast(item => item.phase !== 'commentary')
  return typeof answer?.text === 'string' ? answer.text : undefined
}
