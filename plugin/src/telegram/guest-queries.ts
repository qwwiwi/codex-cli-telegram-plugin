// Guest-query registry (Guest Mode, Bot API 10.0, 2026-07-04).
//
// A guest_message update carries a one-shot `guest_query_id`: the bot may
// answer it exactly once via answerGuestQuery, and only queries created by
// an ALLOWLISTED caller ever enter this registry (the handler gates before
// registering). The `reply` tool then authorizes a guest answer purely by
// registry membership — it deliberately does NOT consult the chat
// allowlist, because the originating chat is by definition one the bot is
// not a member of.
//
// Entry lifecycle (dual review 2026-07-04, Codex #1/#2 + Fable #1/#7):
//   pending  --claim-->  inflight  --confirm-->  answered (tombstone)
//                          |  ^
//                   release|  |claim refused ('consumed')
//                          v  |
//                        pending
//
// Fail-closed properties:
//   - unknown guest_query_id       → reject (never answered blind)
//   - inflight/answered id         → reject 'consumed' (kept as tombstone
//     until TTL so the error is clear, not cryptic)
//   - expired entry                → reject (Telegram queries go stale; we
//     mirror that with a conservative local TTL)
//   - duplicate register of a known id → NO-OP. Telegram redelivers
//     updates (poller restart, offset replay); re-registering must never
//     resurrect a consumed query into a second answer (Codex #1) nor
//     evict an innocent entry when the map is at cap (Fable #1).
//   - cap eviction never touches an INFLIGHT entry — evicting one would
//     turn a post-failure release() into a no-op and strand the retry
//     (Codex #2). Victim preference: oldest answered tombstone, then
//     oldest pending; if literally everything is inflight, registration
//     is refused (register returns false; caller logs and drops).
//
// In-memory only: a plugin restart drops pending queries. That is
// acceptable — the query would not survive the restart round-trip anyway,
// and persisting one-shot reply capabilities to disk would only widen the
// replay surface.

export type GuestQueryState = 'pending' | 'inflight' | 'answered'

export interface GuestQueryEntry {
  guestQueryId: string
  callerUserId: string
  callerChatId: string | undefined
  messageText: string
  createdAtMs: number
  state: GuestQueryState
}

export type GuestQueryClaim =
  | { kind: 'ok'; entry: GuestQueryEntry }
  | { kind: 'unknown' }
  | { kind: 'consumed' }
  | { kind: 'expired' }

// Telegram does not document the guest-query lifetime; callback queries
// live for a few minutes and inline results for about an hour. 15 minutes
// is long enough for a real Claude turn and short enough to bound replay.
export const GUEST_QUERY_TTL_MS = 15 * 60 * 1000

// How long an unanswered guest query may keep the owner's DM free of
// hook-driven bubbles. Deliberately much shorter than the replay TTL above:
// a real guest answer lands in seconds, so anything older means the agent
// never answered — and no bug is worth leaving the owner's own turns without
// a progress bubble for a quarter of an hour.
export const GUEST_PAINT_SUPPRESSION_MS = 2 * 60 * 1000

// Registry never grows unbounded even under a flood of allowlisted
// queries: sweep() prunes expired entries on register/pendingCount and the
// cap below evicts a non-inflight victim when a NEW id would exceed it.
const MAX_ENTRIES = 64

export class GuestQueryRegistry {
  private entries = new Map<string, GuestQueryEntry>()
  // When the last guest answer was confirmed, and not yet retired by endTurn().
  // See isTurnActive() for why an answered query must keep counting.
  private answeredTailAtMs: number | undefined

  constructor(
    private readonly ttlMs: number = GUEST_QUERY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Register a fresh guest query. Returns false when the entry could not
   * be admitted (cap reached and every resident entry is inflight) — the
   * caller must drop the update instead of assuming it is answerable.
   * A duplicate id (Telegram redelivery) is a successful NO-OP: the
   * existing entry, whatever its state, stays authoritative.
   */
  register(input: {
    guestQueryId: string
    callerUserId: string
    callerChatId?: string
    messageText: string
  }): boolean {
    this.sweep()
    const existing = this.entries.get(input.guestQueryId)
    if (existing !== undefined) return true

    if (this.entries.size >= MAX_ENTRIES && !this.evictOne()) {
      return false
    }
    this.entries.set(input.guestQueryId, {
      guestQueryId: input.guestQueryId,
      callerUserId: input.callerUserId,
      callerChatId: input.callerChatId,
      messageText: input.messageText,
      createdAtMs: this.now(),
      state: 'pending',
    })
    return true
  }

  // One-shot claim: pending → inflight atomically with the check, so two
  // concurrent reply calls cannot both pass. Inflight/answered entries
  // stay in the map as tombstones until TTL so the second caller gets
  // 'consumed' instead of the less-actionable 'unknown'. No sweep() here —
  // the TTL check below must SEE the stale entry to report the actionable
  // 'expired' (sweeping first would collapse it into 'unknown').
  claim(guestQueryId: string): GuestQueryClaim {
    const entry = this.entries.get(guestQueryId)
    if (entry === undefined) return { kind: 'unknown' }
    if (entry.state !== 'pending') return { kind: 'consumed' }
    if (this.now() - entry.createdAtMs > this.ttlMs) {
      this.entries.delete(guestQueryId)
      return { kind: 'expired' }
    }
    entry.state = 'inflight'
    return { kind: 'ok', entry }
  }

  /**
   * How much local TTL the entry has left, or undefined when there is no
   * such entry (unknown id, or already swept). Floors at 0 instead of going
   * negative so a caller can compare it against a headroom budget directly.
   *
   * Why this exists (Grimstroke round-2 review, 2026-11-10): claim() proves a
   * query is answerable AT THAT MOMENT. A caller that then does slow work
   * with a side effect — the guest path stages a file upload into the owner's
   * DM — needs to know whether the query can still be answered once that work
   * finishes, otherwise it leaves the side effect behind for an answer
   * Telegram will refuse. NOTE: this is OUR conservative TTL; Telegram's real
   * guest-query lifetime is undocumented and may be shorter.
   */
  remainingMs(guestQueryId: string): number | undefined {
    const entry = this.entries.get(guestQueryId)
    if (entry === undefined) return undefined
    return Math.max(0, entry.createdAtMs + this.ttlMs - this.now())
  }

  // Mark an inflight entry as definitively answered (send succeeded).
  // The tombstone stays until TTL so a repeat reply reads 'consumed'.
  confirm(guestQueryId: string): void {
    const entry = this.entries.get(guestQueryId)
    if (entry !== undefined && entry.state === 'inflight') {
      entry.state = 'answered'
      this.answeredTailAtMs = this.now()
    }
  }

  // Un-consume after a failed Telegram send so the agent may retry.
  // Only inflight→pending: an 'answered' entry must never re-open.
  // No-op for unknown ids (entry may have been swept meanwhile).
  release(guestQueryId: string): void {
    const entry = this.entries.get(guestQueryId)
    if (entry !== undefined && entry.state === 'inflight') entry.state = 'pending'
  }

  /**
   * True while at least one query is still awaiting its answer — `pending`
   * (handed to the agent, reply not called yet) or `inflight` (reply in
   * progress). Answered tombstones and expired entries do NOT count.
   *
   * Half of the webhook's guest-bubble gate (2026-10-17): a guest turn has no
   * chat of its own to paint in. It is NOT by itself "a guest turn is running"
   * — registration happens when the Telegram update arrives, which can be
   * mid-turn — so the webhook pairs it with "no live bubble for the chat".
   *
   * @param maxAgeMs optional ceiling on entry age. The registry TTL is tuned
   *   for replay safety (15 min); a caller that degrades UX while the signal
   *   is true passes a shorter window so an abandoned query (agent never
   *   called reply) stops counting well before the entry expires.
   */
  hasUnanswered(maxAgeMs?: number): boolean {
    this.sweep()
    const now = this.now()
    for (const e of this.entries.values()) {
      if (e.state !== 'pending' && e.state !== 'inflight') continue
      if (maxAgeMs !== undefined && now - e.createdAtMs > maxAgeMs) continue
      return true
    }
    return false
  }

  /**
   * True while a guest turn is still RUNNING — the webhook's half of the
   * bubble gate. Wider than hasUnanswered() on purpose.
   *
   * PostToolUse and reasoning hooks can paint a status bubble after
   * `answerGuestQuery` has marked the query answered. Keep the signal alive
   * until the Stop hook calls endTurn().
   *
   * @param maxAgeMs ceiling on both halves, so a turn whose Stop never arrives
   *   stops suppressing instead of muting the owner's DM indefinitely.
   */
  isTurnActive(maxAgeMs?: number): boolean {
    if (this.hasUnanswered(maxAgeMs)) return true
    if (this.answeredTailAtMs === undefined) return false
    if (maxAgeMs !== undefined && this.now() - this.answeredTailAtMs > maxAgeMs) return false
    return true
  }

  /**
   * Retire the post-answer tail: the turn that produced the guest answer has
   * ended. Unanswered entries are deliberately untouched — an ordinary owner
   * turn ending must not disarm a guest query still waiting for its reply.
   */
  endTurn(): void {
    this.answeredTailAtMs = undefined
  }

  pendingCount(): number {
    this.sweep()
    let n = 0
    for (const e of this.entries.values()) if (e.state === 'pending') n++
    return n
  }

  // Pick and delete a cap-eviction victim: oldest answered tombstone
  // first (its one answer is already delivered — nothing to strand),
  // then oldest pending (stale-most by Map insertion order, which is
  // reliable here because register() never re-inserts existing keys).
  // Inflight entries are untouchable. Returns false when nothing could
  // be evicted.
  private evictOne(): boolean {
    for (const wanted of ['answered', 'pending'] as const) {
      for (const [id, entry] of this.entries) {
        if (entry.state === wanted) {
          this.entries.delete(id)
          return true
        }
      }
    }
    return false
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) this.entries.delete(id)
    }
  }
}
