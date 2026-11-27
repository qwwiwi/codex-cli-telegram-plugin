import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AccessRole, StoredRole } from './store.js'

export type AuditEvent =
  | 'access.change'
  | 'pairing.invite'
  | 'pairing.redeem'
  | 'pairing.confirm'
  | 'pairing.deny'
  | 'pairing.bad_code'
  | 'pairing.lockout'
  | 'chat.pending'
  | 'chat.approve'
  | 'chat.deny'
  | 'chat.remove'
  | 'chat.leave'
  | 'chat.migrate'

export interface AuditRecord {
  event: AuditEvent
  user_id: string
  role?: AccessRole
  previous_role?: StoredRole
  reason?: string
  by?: string
  /** A group ID for chat.* events. */
  chat_id?: string
  /** chat.approve: members or open. */
  mode?: string
}

/**
 * Appends one line to `<state>/audit/YYYY-MM.jsonl` (mode 0600). Never holds
 * message text or notes. Returns false when the line could not be written.
 */
export function appendAudit(stateDir: string, record: AuditRecord, now: number): boolean {
  const ts = new Date(now).toISOString()
  const folder = join(stateDir, 'audit')
  const file = join(folder, ts.slice(0, 7) + '.jsonl')
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify({ ts, ...record }) + '\n', { mode: 0o600 })
    // The mode above applies only on create; keep a file created by hand private too.
    chmodSync(file, 0o600)
    return true
  } catch {
    return false
  }
}
