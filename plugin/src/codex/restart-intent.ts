// Planned-restart intent and agent-loop breaker (docs/design/self-update-spec.md, S6).
// Every planned restart (exit 75) is written to <state>/restart-intent.json before the exit.
// A restart tied to an owner message is honoured once: its message ID must be greater than the
// last honoured one. Restarts without a new owner message (the agent's restart marker, an
// automatic retry) chain while they are at most 300 s apart; the third in a chain is refused.
// Reads fail open (a corrupt file is empty); a write error is reported by the caller.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { CHAIN_GAP_MS } from './boot-ledger.js'

/** Planned restarts without a new owner message allowed in one chain; the next one is refused. */
export const UNATTENDED_RESTART_CHAIN = 2

const IntentSchema = z.object({
  kind: z.enum(['restart', 'update', 'rollback', 'codex', 'agent']),
  at: z.number(),
  invocation: z.string(),
  ownerMessageId: z.number().int().optional(),
  fromCommit: z.string(),
  toCommit: z.string().optional(),
})
const FileSchema = z.object({
  v: z.literal(1),
  last: IntentSchema.optional(),
  lastOwnerMessageId: z.number().int().optional(),
  // `at` of the planned restarts since the last owner-message restart.
  unattended: z.array(z.number()).default([]),
})
export type RestartIntent = z.infer<typeof IntentSchema>
type IntentFile = z.infer<typeof FileSchema>
export type RestartAdmission = { ok: true } | { ok: false; reason: 'stale' | 'loop' }

export class RestartIntents {
  private readonly path: string

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.path = join(stateDir, 'restart-intent.json')
  }

  /**
   * Decides whether a planned restart may go ahead and, when it may, records the intent.
   * Throws only when the intent cannot be written: the caller must not restart then.
   */
  admit(intent: Omit<RestartIntent, 'at'>): RestartAdmission {
    const state = this.read()
    const now = this.now()
    const record: RestartIntent = { ...intent, at: now }
    if (intent.ownerMessageId !== undefined) {
      if (state.lastOwnerMessageId !== undefined && intent.ownerMessageId <= state.lastOwnerMessageId) {
        return { ok: false, reason: 'stale' }
      }
      this.write({ v: 1, last: record, lastOwnerMessageId: intent.ownerMessageId, unattended: [] })
      return { ok: true }
    }
    let chain: number[] = []
    for (const at of state.unattended) {
      const previous = chain.at(-1)
      // A backwards clock keeps the chain, as in the boot ledger.
      chain = previous === undefined || at - previous <= CHAIN_GAP_MS ? [...chain, at] : [at]
    }
    const last = chain.at(-1)
    if (last !== undefined && now - last > CHAIN_GAP_MS) chain = []
    if (chain.length >= UNATTENDED_RESTART_CHAIN) return { ok: false, reason: 'loop' }
    this.write({ ...state, v: 1, last: record, unattended: [...chain, now].slice(-10) })
    return { ok: true }
  }

  private read(): IntentFile {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (parsed.success) return parsed.data
    } catch { /* missing or corrupt: empty */ }
    return { v: 1, unattended: [] }
  }

  private write(state: IntentFile): void {
    const temp = this.path + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 })
    renameSync(temp, this.path)
  }
}

/** The owner-facing reason a planned restart was refused. */
export function refusedRestartText(reason: 'stale' | 'loop'): string {
  return reason === 'stale'
    ? 'Это сообщение уже вызывало перезапуск, второй раз не перезапускаюсь.'
    : 'Отменил перезапуск: за последние 5 минут мост уже перезапускался дважды без новой команды от тебя. ' +
      'Похоже на зацикливание. Если перезапуск действительно нужен, отправь /restart.'
}
