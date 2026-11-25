import { object } from './rpc.js'

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
