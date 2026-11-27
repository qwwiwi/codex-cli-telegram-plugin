// Receipts (spec §7.2): `state/receipts/<turn_id>.json` lists the fact writes done in one turn.
// Every fact write records one (see `FactStore.writer`), so the bridge can show "saved" notices
// and `auditFactWrites` can flag writes whose turn id the bridge never issued.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type JournalRef, type Receipt, ReceiptSchema, type ReceiptStore, type ReceiptWrite, ReceiptWriteSchema, type Scope } from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, withLock } from '../store/lock.js'
import { ensureScope, type ScopePaths, scopePaths } from '../store/paths.js'

export function readReceipt(path: string): Receipt | null {
  if (!existsSync(path)) return null
  try {
    const parsed = ReceiptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Appends one write to the turn's receipt. The caller holds the scope lock; the fact writer calls
 * this inside its own critical section, so the receipt and the fact change under one lock.
 */
export function appendReceiptLocked(paths: ScopePaths, turnId: string, journalRef: JournalRef | undefined, write: ReceiptWrite): Receipt {
  if (turnId.length === 0) throw new Error('a receipt needs a turn id')
  const path = paths.receipt(turnId)
  const existing = readReceipt(path)
  if (existing === null && existsSync(path)) throw new Error(`receipt of turn ${turnId} is unreadable; refusing to overwrite it`)
  const receipt: Receipt = existing ?? { turn_id: turnId, writes: [] }
  if (receipt.journal_ref === undefined && journalRef !== undefined) receipt.journal_ref = journalRef
  receipt.writes.push(ReceiptWriteSchema.parse(write))
  writeFileAtomic(path, `${JSON.stringify(ReceiptSchema.parse(receipt))}\n`)
  return receipt
}

export class FileReceiptStore implements ReceiptStore {
  private readonly paths: ScopePaths

  constructor(private readonly brainHome: string, private readonly scope: Scope, private readonly lock: LockOptions = {}) {
    this.paths = scopePaths(brainHome, scope)
  }

  async add(turnId: string, journalRef: JournalRef | undefined, write: ReceiptWrite): Promise<Receipt> {
    const paths = ensureScope(this.brainHome, this.scope)
    return withLock(paths.lockDir, async () => appendReceiptLocked(paths, turnId, journalRef, write), this.lock)
  }

  async get(turnId: string): Promise<Receipt | null> {
    return readReceipt(this.paths.receipt(turnId))
  }

  /** Every readable receipt, sorted by turn id; unreadable files are skipped. */
  async all(): Promise<Receipt[]> {
    if (!existsSync(this.paths.receiptsDir)) return []
    const receipts: Receipt[] = []
    for (const name of readdirSync(this.paths.receiptsDir).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const receipt = readReceipt(join(this.paths.receiptsDir, name))
      if (receipt !== null) receipts.push(receipt)
    }
    return receipts.sort((a, b) => (a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0))
  }

  async hasJournalRef(ref: JournalRef): Promise<boolean> {
    return (await this.all()).some(receipt => receipt.journal_ref === ref)
  }
}
