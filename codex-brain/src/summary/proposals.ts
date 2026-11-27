// Proposals from the summarizer (A2) and the daily reviewer (D14): candidate facts the owner
// accepts or rejects in `/memory pending`. They are never facts by themselves.

import { createHash } from 'node:crypto'

import {
  type BrainOrigin, type Clock, DESCRIPTION_MAX, type FactKind, type JournalRef, type ProposalStore, ProposalSchema, PROVENANCE_VERSION,
  type ReceiptStore,
} from '../contract.js'

export type ProposalKind = 'decision' | 'task' | 'preference'

export interface ProposalCandidate {
  kind: ProposalKind
  text: string
  ref: JournalRef
  origin?: BrainOrigin
}

export interface ProposalDeps {
  receipts: ReceiptStore
  proposals: ProposalStore
  clock: Clock
}

const FACT_KIND: Record<ProposalKind, FactKind> = { decision: 'decision', task: 'task', preference: 'user' }

export const isProposalKind = (kind: string): kind is ProposalKind => kind === 'decision' || kind === 'task' || kind === 'preference'

/** A one-line label of at most `max` characters, cut at a word end; the full text stays in the body. */
export function label(text: string, max = DESCRIPTION_MAX): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/**
 * Stores the candidates as proposals and returns how many were added. Skipped: a ref that already
 * has a receipt (the agent saved it in that turn), and a ref + kind that already has a proposal.
 * Ids are derived from the content, so a retried batch never duplicates a proposal.
 */
export async function addProposals(from: 'summarizer' | 'reviewer', candidates: readonly ProposalCandidate[], deps: ProposalDeps): Promise<number> {
  if (candidates.length === 0) return 0
  const existing = await deps.proposals.list()
  const taken = new Set(existing.map(p => `${p.source ?? ''}|${p.fact.kind}`))
  let added = 0
  for (const candidate of candidates) {
    const kind = FACT_KIND[candidate.kind]
    const key = `${candidate.ref}|${kind}`
    if (taken.has(key) || await deps.receipts.hasJournalRef(candidate.ref)) continue
    const id = `${from === 'summarizer' ? 's' : 'r'}-${createHash('sha256').update(`${from}|${key}|${candidate.text}`).digest('hex').slice(0, 24)}`
    await deps.proposals.add(ProposalSchema.parse({
      id,
      fact: { kind, description: label(candidate.text), body: candidate.text },
      source: candidate.ref,
      from,
      reason: 'model',
      provenance: PROVENANCE_VERSION,
      ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
      created: deps.clock.now().toISOString(),
    }))
    taken.add(key)
    added += 1
  }
  return added
}
