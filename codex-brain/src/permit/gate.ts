// Who may write a fact from a shell tool (spec §7.2, slice plan K12). A tool process does not
// learn its turn id, so the CLI grants owner rights only when exactly one unexpired permit exists
// in the scope and its origin is trusted (`owner-direct`, or `terminal`); everything else turns a
// write into a proposal (or refuses a removal). An owner-direct permit is also bound to its caller:
// the bridge hands a random key only to the model of that turn and stores its sha256 in the permit,
// so a process outside the turn that cannot present the key gets no owner rights ('no-permit').

import { createHash, timingSafeEqual } from 'node:crypto'

import { type Permit, type ProposalReason, type Scope, TRUSTED_ORIGINS } from '../contract.js'

export type WriteRight =
  | { ok: true; permit: Permit }
  | { ok: false; reason: Extract<ProposalReason, 'not-owner-direct' | 'no-permit' | 'expired-permit' | 'several-permits'>; permit?: Permit }

/** sha256 (hex) of a permit key, as stored in `Permit.key_hash`. */
export function permitKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function keyMatches(permit: Permit, key: string | undefined): boolean {
  if (key === undefined || key === '' || permit.key_hash === undefined) return false
  const expected = Buffer.from(permit.key_hash, 'hex')
  const actual = Buffer.from(permitKeyHash(key), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function decideWriteRight(permits: readonly Permit[], scope: Scope, now: Date, key?: string): WriteRight {
  const mine = permits.filter(permit => permit.scope === scope)
  const live = mine.filter(permit => Date.parse(permit.expires) > now.getTime())
  if (live.length > 1) return { ok: false, reason: 'several-permits' }
  const only = live[0]
  if (only === undefined) return { ok: false, reason: mine.length > 0 ? 'expired-permit' : 'no-permit' }
  if (!TRUSTED_ORIGINS.includes(only.origin)) return { ok: false, reason: 'not-owner-direct', permit: only }
  // The caller did not prove it is the turn's model: it gets neither rights nor the permit's provenance.
  if (only.origin === 'owner-direct' && !keyMatches(only, key)) return { ok: false, reason: 'no-permit' }
  return { ok: true, permit: only }
}
