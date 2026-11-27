// Receipt audit (spec §7.2 integrity, S0 review): permits and receipts are plain files the agent
// could forge with shell access, so the only trustworthy record of which turns exist is the one
// the bridge keeps itself. Every fact write carries a receipt with its turn id (`FactStore.writer`);
// this check compares receipts and the manifest against the bridge's own record and reports:
// - `unknown-turn`: a receipt write whose turn the bridge did not issue with owner rights: a
//   made-up turn id, or a real turn whose permit origin was rewritten (e.g. `agent` → `owner-direct`);
// - `no-receipt`: a fact revision in the manifest that no receipt accounts for (manifest edited
//   around the API, or a crash inside a write).
// `isOwnerTurn` must come from the bridge's memory, never from permit files: it answers true only
// for turns the bridge itself started with a trusted origin (`TRUSTED_ORIGINS`) and for the turn
// ids it uses for its own `/memory` edits. The CLI's `doctor` cannot know them and passes
// `() => true`, so it reports only `no-receipt`.
// A receipt write that carries `sha256` covers only that content: a fact rewritten at the same
// revision together with its manifest hash is `no-receipt`. Older receipts without a hash cover
// the revision alone.

import type { FactId, ReceiptWrite } from '../contract.js'
import type { FactStore } from '../facts/store.js'
import type { FileReceiptStore } from './receipts.js'

export type WriteAuditIssue =
  | { problem: 'unknown-turn'; id: FactId; revision: number; action: ReceiptWrite['action']; turn_id: string }
  | { problem: 'no-receipt'; id: FactId; revision: number }

export async function auditFactWrites(facts: FactStore, receipts: FileReceiptStore, isOwnerTurn: (turnId: string) => boolean): Promise<WriteAuditIssue[]> {
  const issues: WriteAuditIssue[] = []
  const covered = new Set<string>()
  const hashes = new Map<string, Set<string>>()
  for (const receipt of await receipts.all()) {
    const issued = isOwnerTurn(receipt.turn_id)
    for (const write of receipt.writes) {
      if (write.action !== 'remove') {
        const key = `${write.id}#${write.revision}`
        if (write.sha256 === undefined) covered.add(key)
        else hashes.set(key, (hashes.get(key) ?? new Set<string>()).add(write.sha256))
      }
      if (!issued) issues.push({ problem: 'unknown-turn', id: write.id, revision: write.revision, action: write.action, turn_id: receipt.turn_id })
    }
  }
  const manifest = await facts.manifest()
  for (const id of Object.keys(manifest.facts).sort()) {
    const entry = manifest.facts[id]
    const key = `${id}#${entry?.revision ?? 0}`
    if (entry !== undefined && !covered.has(key) && !(hashes.get(key)?.has(entry.sha256) ?? false)) issues.push({ problem: 'no-receipt', id, revision: entry.revision })
  }
  return issues
}
