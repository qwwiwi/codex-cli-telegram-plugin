// What a parallel (side) Codex turn put in the Telegram chat through its tools.
// A side turn that worked only through tools (a reaction, a component, an interim reply) may finish
// with an empty final text: that is a finished turn, not a lost answer.

import { object } from './rpc.js'

type ToolResult = { success: boolean; contentItems: ReadonlyArray<{ type: 'inputText'; text: string }> }

// Telegram actions and component tools whose success means the owner sees something in the chat.
const delivering = new Set(['reply', 'edit', 'pin', 'unpin', 'react', 'send_component', 'update_component'])
const turnLimit = 500

export const sideNoAnswer = 'Параллельный поток не вернул ответ. Отправь сообщение ещё раз.'
export const sideStopped = 'Параллельная задача остановлена.'

function delivered(result: ToolResult): boolean {
  let body: Record<string, unknown>
  try { body = object(JSON.parse(result.contentItems[0]?.text ?? '')) } catch { return false }
  // An ambiguous component send may already be on screen: never claim that nothing arrived.
  if (body.delivery === 'unknown') return true
  const name = typeof body.action === 'string' ? body.action : body.tool
  if (typeof name !== 'string' || !delivering.has(name)) return false
  // A reply whose text went out before a later attachment failed still put a confirmed message in the chat.
  const confirmed = Array.isArray(body.message_ids) && body.message_ids.some(id => typeof id === 'number')
  return result.success || confirmed
}

const turnKey = (thread: string, turn: string): string => JSON.stringify([thread, turn])

/**
 * Counts chat deliveries per Codex turn (thread and turn ID), so a receipt that arrives after its turn ended is
 * never counted for the next turn on the same reused side thread.
 */
export class SideDeliveries {
  private readonly counts = new Map<string, number>()

  /** One finished tool call; `key` is the native call key [threadId, turnId, callId]. */
  record(key: string, result: ToolResult): void {
    let parts: unknown
    try { parts = JSON.parse(key) } catch { return }
    if (!Array.isArray(parts) || typeof parts[0] !== 'string' || typeof parts[1] !== 'string' || !delivered(result)) return
    const turn = turnKey(parts[0], parts[1])
    const count = (this.counts.get(turn) ?? 0) + 1
    this.counts.delete(turn)
    this.counts.set(turn, count)
    if (this.counts.size > turnLimit) this.counts.delete(this.counts.keys().next().value!)
  }

  count(thread: string, turn: string | undefined): number {
    return turn === undefined ? 0 : this.counts.get(turnKey(thread, turn)) ?? 0
  }
}

/**
 * The chat notice for a side turn that ended without final text; undefined means stay silent.
 * A completed turn that delivered something through its tools has said what it had to say.
 */
export function sideEndNotice(status: 'completed' | 'interrupted' | 'failed', deliveredCount: number): string | undefined {
  if (status === 'interrupted') return sideStopped
  if (status === 'completed' && deliveredCount > 0) return undefined
  return sideNoAnswer
}
