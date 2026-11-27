// The agent-side write path (`brain remember | pin | task | done | forget`, spec §7.2, K12).
// A write is done only with owner rights (`decideWriteRight`); the fact's `source` is the permit's
// journal ref and the receipt goes to the permit's turn. Without owner rights a new or changed
// fact becomes a proposal in `pending/`, and a close or removal is refused. Secrets and invalid
// input are rejected before the gate, so they reach neither a fact nor a proposal.

import { randomBytes } from 'node:crypto'

import {
  type Clock, type Fact, type FactId, FactInputSchema, type FactWriteError, type FactWriteResult, type Proposal,
  type ProposalReason, type TaskStatus,
} from '../contract.js'
import { findSecretText } from '../facts/secrets.js'
import type { FactStore } from '../facts/store.js'
import { decideWriteRight, type WriteRight } from './gate.js'
import type { FilePermitStore } from './permits.js'
import type { FileProposalStore } from './proposals.js'

export interface GateContext {
  clock: Clock
  facts: FactStore
  permits: FilePermitStore
  proposals: FileProposalStore
  /** The key the caller presents (`--permit`, `BRAIN_PERMIT`); an owner-direct permit needs it. */
  permitKey?: string
}

/** A fact as the agent states it; the source comes from the permit. */
export interface RememberFact {
  id: FactId
  kind: Fact['kind']
  description: string
  body: string
  status?: TaskStatus
  owner_message_id?: string
}

export interface RememberRequest {
  input: RememberFact
  expectedRevision?: number
}

export type GateOutcome =
  | { outcome: 'fact'; fact: Fact; turn_id: string }
  | { outcome: 'proposal'; proposal: Proposal }
  | { outcome: 'removed'; id: FactId; revision: number; turn_id: string }
  | { outcome: 'refused'; reason: ProposalReason }
  | { outcome: 'error'; error: FactWriteError; message: string; current?: number }

async function right(ctx: GateContext): Promise<WriteRight> {
  return decideWriteRight(await ctx.permits.all(), ctx.facts.scope, ctx.clock.now(), ctx.permitKey)
}

function fromWrite(result: FactWriteResult, turnId: string): GateOutcome {
  if (result.ok) return { outcome: 'fact', fact: result.fact, turn_id: turnId }
  const error: GateOutcome = { outcome: 'error', error: result.error, message: result.message }
  return result.current === undefined ? error : { ...error, current: result.current }
}

function proposalId(now: Date): string {
  return `r-${now.getTime().toString(36)}-${randomBytes(6).toString('hex')}`
}

export async function remember(ctx: GateContext, request: RememberRequest): Promise<GateOutcome> {
  const { input } = request
  // Validate with a placeholder source: the real one is known only after the gate.
  const parsed = FactInputSchema.safeParse({ ...input, source: 'tg-command' })
  if (!parsed.success) return { outcome: 'error', error: 'invalid', message: parsed.error.issues.map(i => `${i.path.join('.') || 'fact'}: ${i.message}`).join('; ') }
  const secret = findSecretText([input.id, input.description, input.body, input.owner_message_id ?? ''])
  if (secret !== null) return { outcome: 'error', error: 'secret', message: `the text contains a secret (${secret}); it is not stored` }

  const decision = await right(ctx)
  if (decision.ok) {
    const { permit } = decision
    const writer = ctx.facts.writer({ turnId: permit.turn_id, journalRef: permit.journal_ref })
    return fromWrite(await writer.put({ ...parsed.data, source: permit.journal_ref }, request.expectedRevision), permit.turn_id)
  }

  const now = ctx.clock.now()
  const proposal: Proposal = {
    id: proposalId(now),
    fact: { id: input.id, kind: input.kind, description: input.description, body: input.body },
    from: 'remember',
    reason: decision.reason,
    created: now.toISOString(),
  }
  if (decision.permit !== undefined) {
    proposal.source = decision.permit.journal_ref
    proposal.origin = decision.permit.origin
  }
  await ctx.proposals.add(proposal)
  return { outcome: 'proposal', proposal }
}

export async function closeTask(ctx: GateContext, request: { id: FactId; status?: Exclude<TaskStatus, 'open'>; expectedRevision?: number }): Promise<GateOutcome> {
  const decision = await right(ctx)
  if (!decision.ok) return { outcome: 'refused', reason: decision.reason }
  const writer = ctx.facts.writer({ turnId: decision.permit.turn_id, journalRef: decision.permit.journal_ref })
  return fromWrite(await writer.done(request.id, request.status ?? 'done', request.expectedRevision), decision.permit.turn_id)
}

export async function forgetFact(ctx: GateContext, request: { id: FactId; expectedRevision: number }): Promise<GateOutcome> {
  const decision = await right(ctx)
  if (!decision.ok) return { outcome: 'refused', reason: decision.reason }
  const writer = ctx.facts.writer({ turnId: decision.permit.turn_id, journalRef: decision.permit.journal_ref })
  const result = await writer.remove(request.id, request.expectedRevision)
  if (result.ok) return { outcome: 'removed', id: result.id, revision: result.revision, turn_id: decision.permit.turn_id }
  const error: GateOutcome = { outcome: 'error', error: result.error, message: result.message }
  return result.current === undefined ? error : { ...error, current: result.current }
}
