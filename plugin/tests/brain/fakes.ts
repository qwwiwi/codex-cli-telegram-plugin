// In-memory fakes of the Brain contract interfaces, for slice tests that must not depend on the
// real stores of other slices (S3-S6 until S1/S2 merge). They follow the contract semantics
// (revisions, fold by key, priority order, permit expiry, one-shot handoff) but keep everything
// in memory and never touch the file system.

import { REFERENCE_OUTPUT_SCHEMA } from '../../../codex-brain/src/summary/prompt.js'
import {
  type BindInput, type BrainJobs, type BrainOrigin, type BrainPort, type SealRunResult, type SessionRole,
  type SummaryRunResult, type BrainStatus, BrainStatusSchema, type Clock,
  compareIndexLines, type CompactionEvent, type Day, type Exchange, ExchangeSchema, type Fact, type FactId,
  type FactInput, FactInputSchema, type FactKind, type FactReader, type FactRemoveResult, FactSchema,
  type FactWriter, type FactWriteResult, formatIndexLine, formatJournalRef, type Handoff, type HandoffBuilder,
  type HandoffRequest, HandoffSchema, type IndexLine, type IntegrityIssue, type JournalLine, JournalLineSchema,
  type JournalReader, type JournalRef, type JournalWriter, type JsonSchemaObject, type Manifest,
  type MemoryReply, type MemoryRequest, parseJournalRef, type Permit, PermitSchema, type PermitStore,
  type PlanUpdate, type Proposal, ProposalSchema, type ProposalStore, type Receipt, type ReceiptStore,
  type ReceiptWrite, ReceiptWriteSchema, type SessionEntry, SessionEntrySchema, type SessionRegistry,
  type SnapshotBuilder, type SnapshotRequest, type Summarizer, type TaskStatus, type TurnNotice, type TurnOutcome,
  type TurnStartInput, type TurnTicket, type BoundaryId, type Digest, DigestSchema, type OpenBoundary,
  OpenBoundarySchema, PERSONAL_MEMORY_ROLES, type RecentReader, type Scope, SESSION_INTENT_TTL_MS, type SessionIntent,
  SessionIntentSchema, type SessionSource, type SummaryLine, SummaryLineSchema, type SummaryReader,
} from '../../../codex-brain/src/contract.js'
import { findSecretKinds } from '../../src/safety/redact.js'

/** A clock that returns `iso` until `set` moves it. */
export function fixedClock(iso: string): Clock & { set(next: string): void } {
  let now = new Date(iso)
  return { now: () => new Date(now), set: next => { now = new Date(next) } }
}

const day = (clock: Clock): Day => clock.now().toISOString().slice(0, 10)

// ---------------------------------------------------------------- facts

export class FakeFacts implements FactReader, FactWriter {
  readonly facts = new Map<FactId, Fact>()
  constructor(private readonly clock: Clock) {}

  async get(id: FactId): Promise<Fact | null> {
    return this.facts.get(id) ?? null
  }

  // Closed tasks (done / dropped) are not active, so they leave the index.
  async list(kind?: FactKind): Promise<IndexLine[]> {
    return [...this.facts.values()]
      .filter(f => (kind === undefined || f.kind === kind) && (f.kind !== 'task' || f.status === 'open'))
      .map(f => ({ id: f.id, kind: f.kind, description: f.description }))
      .sort(compareIndexLines)
  }

  async priority(): Promise<Fact[]> {
    const byId = (a: Fact, b: Fact) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const all = [...this.facts.values()]
    return [
      ...all.filter(f => f.kind === 'pinned').sort(byId),
      ...all.filter(f => f.kind === 'task' && f.status === 'open').sort(byId),
    ]
  }

  async indexText(): Promise<string> {
    return (await this.list()).map(line => `${formatIndexLine(line)}\n`).join('')
  }

  async manifest(): Promise<Manifest> {
    const facts: Manifest['facts'] = {}
    for (const fact of this.facts.values()) facts[fact.id] = { revision: fact.revision, sha256: '0'.repeat(64) }
    return { version: 1, facts }
  }

  async integrity(): Promise<IntegrityIssue[]> {
    return []
  }

  async put(input: FactInput, expectedRevision?: number): Promise<FactWriteResult> {
    const parsed = FactInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'invalid', message: parsed.error.issues.map(i => i.message).join('; ') }
    if (findSecretKinds(`${input.description}\n${input.body}`).length > 0) {
      return { ok: false, error: 'secret', message: 'the fact contains a secret' }
    }
    const existing = this.facts.get(input.id)
    if (expectedRevision === undefined && existing) {
      return { ok: false, error: 'conflict', current: existing.revision, message: `fact ${input.id} exists at revision ${existing.revision}; pass it as the expected revision to update` }
    }
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
      if (!existing) return { ok: false, error: 'not-found', message: `fact ${input.id} does not exist` }
      return { ok: false, error: 'conflict', current: existing.revision, message: `fact ${input.id} is at revision ${existing.revision}, not ${expectedRevision}` }
    }
    const today = day(this.clock)
    const fact = FactSchema.parse({
      ...parsed.data,
      revision: (existing?.revision ?? 0) + 1,
      created: existing?.created ?? today,
      updated: today,
    })
    this.facts.set(fact.id, fact)
    return { ok: true, fact }
  }

  async remove(id: FactId, expectedRevision: number): Promise<FactRemoveResult> {
    const existing = this.facts.get(id)
    if (!existing) return { ok: false, error: 'not-found', message: `fact ${id} does not exist` }
    if (existing.revision !== expectedRevision) {
      return { ok: false, error: 'conflict', current: existing.revision, message: `fact ${id} is at revision ${existing.revision}, not ${expectedRevision}` }
    }
    this.facts.delete(id)
    return { ok: true, id, revision: existing.revision }
  }

  async done(id: FactId, status: Exclude<TaskStatus, 'open'> = 'done', expectedRevision?: number): Promise<FactWriteResult> {
    const existing = this.facts.get(id)
    if (!existing) return { ok: false, error: 'not-found', message: `fact ${id} does not exist` }
    if (existing.kind !== 'task') return { ok: false, error: 'invalid', message: `fact ${id} is not a task` }
    const { revision: _revision, created: _created, updated: _updated, ...input } = existing
    return this.put({ ...input, status }, expectedRevision ?? existing.revision)
  }
}

// ---------------------------------------------------------------- journal

export class FakeJournal implements JournalWriter, JournalReader {
  /** Raw lines per day, as the JSONL file would hold them. */
  readonly lines = new Map<Day, JournalLine[]>()
  flushes = 0
  constructor(private readonly clock: Clock) {}

  private find(ref: JournalRef): { day: Day; first: JournalLine } {
    const parsed = parseJournalRef(ref)
    const first = parsed ? this.lines.get(parsed.day)?.find(line => line.n === parsed.n) : undefined
    if (!parsed || !first) throw new Error(`unknown journal ref ${ref}`)
    return { day: parsed.day, first }
  }

  private append(dayKey: Day, line: JournalLine): void {
    const list = this.lines.get(dayKey) ?? []
    list.push(JournalLineSchema.parse(line))
    this.lines.set(dayKey, list)
  }

  async bind(input: BindInput): Promise<JournalRef> {
    for (const [d, list] of this.lines) {
      const hit = list.find(line => line.key === input.key)
      if (hit) return formatJournalRef(d, hit.n)
    }
    const tsIn = input.ts_in ?? this.clock.now().toISOString()
    const d = tsIn.slice(0, 10)
    const n = new Set((this.lines.get(d) ?? []).map(line => line.n)).size + 1
    const line: JournalLine = { n, key: input.key, origin: input.origin, status: 'bound', input_kind: input.input_kind, ts_in: tsIn }
    if (input.input !== undefined) line.input = input.input
    if (input.error !== undefined) line.error = input.error
    if (input.thread !== undefined) line.thread = input.thread
    if (input.turn !== undefined) line.turn = input.turn
    this.append(d, line)
    return formatJournalRef(d, n)
  }

  private transition(ref: JournalRef, status: JournalLine['status'], extra: Partial<JournalLine> = {}): void {
    const { day: d, first } = this.find(ref)
    this.append(d, { n: first.n, key: first.key, origin: first.origin, input_kind: first.input_kind, status, ...extra })
  }

  async started(ref: JournalRef, turn: string): Promise<void> {
    this.transition(ref, 'bound', { turn })
  }

  async answered(ref: JournalRef, reply: string): Promise<void> {
    this.transition(ref, 'answered', { reply })
  }

  async delivered(ref: JournalRef): Promise<void> {
    this.transition(ref, 'delivered', { ts_out: this.clock.now().toISOString() })
  }

  async failed(ref: JournalRef, error?: string): Promise<void> {
    this.transition(ref, 'failed', error === undefined ? {} : { error })
  }

  async cancelled(ref: JournalRef): Promise<void> {
    this.transition(ref, 'cancelled')
  }

  async flush(): Promise<void> {
    this.flushes += 1
  }

  async fold(d: Day): Promise<Exchange[]> {
    const byKey = new Map<string, Exchange>()
    for (const line of this.lines.get(d) ?? []) {
      const previous = byKey.get(line.key)
      byKey.set(line.key, ExchangeSchema.parse({ ...previous, ...line, ref: formatJournalRef(d, line.n) }))
    }
    return [...byKey.values()].sort((a, b) => a.n - b.n)
  }

  async tail(n: number): Promise<Exchange[]> {
    const all: Exchange[] = []
    for (const d of await this.days()) all.push(...await this.fold(d))
    return n <= 0 ? [] : all.slice(-n)
  }

  async get(ref: JournalRef): Promise<Exchange | null> {
    const parsed = parseJournalRef(ref)
    if (!parsed) return null
    return (await this.fold(parsed.day)).find(exchange => exchange.n === parsed.n) ?? null
  }

  async days(): Promise<Day[]> {
    return [...this.lines.keys()].sort()
  }
}

// ---------------------------------------------------------------- permits, receipts, proposals, sessions

export class FakePermits implements PermitStore {
  readonly permits = new Map<string, Permit>()
  async put(permit: Permit): Promise<void> {
    this.permits.set(permit.turn_id, PermitSchema.parse(permit))
  }
  async get(turnId: string): Promise<Permit | null> {
    return this.permits.get(turnId) ?? null
  }
  async live(now: Date): Promise<Permit[]> {
    return [...this.permits.values()]
      .filter(permit => Date.parse(permit.expires) > now.getTime())
      .sort((a, b) => (a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0))
  }
  async remove(turnId: string): Promise<void> {
    this.permits.delete(turnId)
  }
}

export class FakeReceipts implements ReceiptStore {
  readonly receipts = new Map<string, Receipt>()
  async add(turnId: string, journalRef: JournalRef | undefined, write: ReceiptWrite): Promise<Receipt> {
    const existing = this.receipts.get(turnId)
    const receipt: Receipt = existing ?? { turn_id: turnId, writes: [] }
    if (!existing && journalRef !== undefined) receipt.journal_ref = journalRef
    receipt.writes.push(ReceiptWriteSchema.parse(write))
    this.receipts.set(turnId, receipt)
    return receipt
  }
  async get(turnId: string): Promise<Receipt | null> {
    return this.receipts.get(turnId) ?? null
  }
  async hasJournalRef(ref: JournalRef): Promise<boolean> {
    return [...this.receipts.values()].some(receipt => receipt.journal_ref === ref)
  }
}

export class FakeProposals implements ProposalStore {
  readonly proposals = new Map<string, Proposal>()
  async add(proposal: Proposal): Promise<void> {
    this.proposals.set(proposal.id, ProposalSchema.parse(proposal))
  }
  async list(): Promise<Proposal[]> {
    return [...this.proposals.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  async get(id: string): Promise<Proposal | null> {
    return this.proposals.get(id) ?? null
  }
  async remove(id: string): Promise<void> {
    this.proposals.delete(id)
  }
}

export class FakeSessions implements SessionRegistry {
  readonly sessions = new Map<string, SessionEntry>()
  readonly intents = new Map<string, SessionIntent>()
  private minted = 0

  async register(entry: SessionEntry): Promise<void> {
    this.sessions.set(entry.session_id, SessionEntrySchema.parse(entry))
  }
  async resolve(sessionId: string): Promise<SessionEntry | null> {
    return this.sessions.get(sessionId) ?? null
  }
  async intend(intent: { scope: Scope; role: SessionIntent['role'] }, now: Date): Promise<SessionIntent> {
    this.minted += 1
    const value = SessionIntentSchema.parse({
      id: `i${this.minted}`, scope: intent.scope, role: intent.role, created: now.toISOString(),
      expires: new Date(now.getTime() + SESSION_INTENT_TTL_MS).toISOString(),
    })
    this.intents.set(value.id, value)
    return value
  }
  async claim(sessionId: string, now: Date): Promise<SessionEntry> {
    const known = this.sessions.get(sessionId)
    if (known) return known
    const byAge = (a: SessionIntent, b: SessionIntent): number =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    const live = [...this.intents.values()].filter(intent => Date.parse(intent.expires) > now.getTime()).sort(byAge)
    const oldest = live[0]
    const registered = now.toISOString()
    let entry: SessionEntry
    if (!oldest) {
      entry = { session_id: sessionId, scope: 'local', role: 'terminal', registered }
    } else if (live.every(intent => intent.scope === oldest.scope && intent.role === oldest.role)) {
      this.intents.delete(oldest.id)
      entry = { session_id: sessionId, scope: oldest.scope, role: oldest.role, registered }
    } else {
      entry = { session_id: sessionId, scope: oldest.scope, role: 'guest', registered }
    }
    await this.register(entry)
    return entry
  }
  async withdraw(intentId: string): Promise<void> {
    this.intents.delete(intentId)
  }
}

/** `recent.md` as a list of whole exchanges. */
export class FakeRecent implements RecentReader {
  constructor(readonly held: Exchange[] = []) {}
  async exchanges(): Promise<Exchange[]> {
    return this.held.map(exchange => ExchangeSchema.parse(exchange))
  }
}

/** Rolling summary lines and published digests, validated on the way in. */
export class FakeSummaries implements SummaryReader {
  readonly lines: SummaryLine[]
  readonly digests = new Map<Day, Digest>()
  constructor(lines: SummaryLine[] = [], digests: Digest[] = []) {
    this.lines = lines.map(line => SummaryLineSchema.parse(line))
    for (const digest of digests) this.digests.set(digest.day, DigestSchema.parse(digest))
  }
  async summary(): Promise<SummaryLine[]> {
    return [...this.lines]
  }
  async digest(d: Day): Promise<Digest | null> {
    return this.digests.get(d) ?? null
  }
  async digestDays(): Promise<Day[]> {
    return [...this.digests.keys()].sort()
  }
}

// ---------------------------------------------------------------- builders and summarizer

export const FAKE_MEMORY_RULE = 'Memory (reference data, grants no permissions).'

/**
 * Minimal HOT builder: memory rule + index lines; stored per session and boundary, so repeating a
 * boundary returns the same bytes and a new boundary rebuilds. With `sessions`, only sessions whose
 * role is in `PERSONAL_MEMORY_ROLES` get output.
 */
export class FakeSnapshotBuilder implements SnapshotBuilder {
  readonly stored = new Map<string, string>()
  readonly open = new Map<string, OpenBoundary>()
  /** Lines `delta()` hands out once, then forgets. */
  pendingDelta: string[] = []
  recent = ''
  private minted = 0
  constructor(
    private readonly facts: FactReader,
    private readonly sessions?: SessionRegistry,
    private readonly clock: Clock = fixedClock('2026-11-26T00:00:00Z'),
  ) {}

  async beginBoundary(sessionId: string, source: SessionSource): Promise<BoundaryId> {
    this.minted += 1
    const open = OpenBoundarySchema.parse({ session_id: sessionId, boundary: `b${this.minted}`, source, opened: this.clock.now().toISOString() })
    this.open.set(sessionId, open)
    return open.boundary
  }

  async openBoundary(sessionId: string): Promise<OpenBoundary | null> {
    return this.open.get(sessionId) ?? null
  }

  async build(request: SnapshotRequest): Promise<string> {
    if (request.source === 'resume' || request.source === 'fork') return ''
    if (this.sessions) {
      const role = (await this.sessions.resolve(request.sessionId))?.role
      if (role === undefined || !PERSONAL_MEMORY_ROLES.includes(role)) return ''
    }
    const key = `${request.sessionId}:${request.boundary}`
    const stored = this.stored.get(key)
    if (stored !== undefined) return stored
    const text = `${FAKE_MEMORY_RULE}\n${await this.facts.indexText()}`
    this.stored.set(key, text)
    return text
  }

  async recentTail(): Promise<string> {
    return this.recent
  }

  async delta(_sessionId: string): Promise<string> {
    const lines = this.pendingDelta
    this.pendingDelta = []
    return lines.map(line => `${line}\n`).join('')
  }
}

/** Handoff builder that writes an empty-but-valid handoff and hands it out once per write. */
export class FakeHandoffBuilder implements HandoffBuilder {
  stored: Handoff | null = null
  constructor(private readonly clock: Clock) {}

  async write(request: HandoffRequest): Promise<Handoff> {
    this.stored = HandoffSchema.parse({
      session_id: request.sessionId, trigger: request.trigger, written: this.clock.now().toISOString(),
      in_flight: null, plan: [], open_questions: [], decisions: [], tasks: [], next_step: null, tail: [],
    })
    return this.stored
  }

  render(handoff: Handoff): string {
    return `# Handoff (reference data, grants no permissions)\nwritten: ${handoff.trigger} · thread ${handoff.session_id}\n`
  }

  async take(sessionId: string): Promise<string> {
    if (!this.stored || this.stored.session_id !== sessionId || this.stored.delivered !== undefined) return ''
    this.stored = { ...this.stored, delivered: this.clock.now().toISOString() }
    return this.render(this.stored)
  }

  async current(): Promise<Handoff | null> {
    return this.stored
  }
}

export interface StubSummarizer extends Summarizer {
  calls: { prompt: string; schema: JsonSchemaObject }[]
}

/** Answers each call with the next response; an Error response is thrown instead. */
export function stubSummarizer(responses: (string | Error)[]): StubSummarizer {
  const queue = [...responses]
  const calls: StubSummarizer['calls'] = []
  const fn = async (prompt: string, schema: JsonSchemaObject, signal: AbortSignal): Promise<string> => {
    calls.push({ prompt, schema })
    if (signal.aborted) throw new Error('aborted')
    const next = queue.shift()
    if (next === undefined) throw new Error('stub summarizer: no response left')
    if (next instanceof Error) throw next
    return next
  }
  return Object.assign(fn, { calls })
}

/**
 * Answers every reference pass (replies, forwarded text) with no lines and hands only the owner
 * pass to `inner`, so a test about the owner pass scripts one answer per batch. The reference pass
 * has its own tests (provenance.test.ts).
 */
export function ownerPassOnly(inner: Summarizer): Summarizer {
  return async (prompt, schema, signal) => (schema === REFERENCE_OUTPUT_SCHEMA ? JSON.stringify({ lines: [] }) : inner(prompt, schema, signal))
}

/** Background jobs that report preset results and count their runs. */
export class FakeBrainJobs implements BrainJobs {
  summaryRuns: boolean[] = []
  sealRuns = 0
  nextSummary: SummaryRunResult = { summarized: 0, proposals: 0, queued: 0 }
  nextSeal: SealRunResult = { sealed: [], archived: [] }

  async summarize(_signal: AbortSignal, force: boolean): Promise<SummaryRunResult> {
    this.summaryRuns.push(force)
    return this.nextSummary
  }

  async sealDays(_signal: AbortSignal): Promise<SealRunResult> {
    this.sealRuns += 1
    return this.nextSeal
  }
}

// ---------------------------------------------------------------- bridge port

export type PortCall =
  | { method: 'sessionStarting'; role: SessionIntent['role'] }
  | { method: 'sessionStarted'; sessionId: string; role: SessionRole; intent?: string }
  | { method: 'turnStarting'; input: TurnStartInput }
  | { method: 'turnStarted'; ticket: TurnTicket; turnId: string }
  | { method: 'turnAnswered'; ticket: TurnTicket; reply: string }
  | { method: 'turnDelivered'; ticket: TurnTicket; outcome: TurnOutcome }
  | { method: 'planUpdated'; update: PlanUpdate }
  | { method: 'openQuestions'; sessionId: string; questions: string[] }
  | { method: 'compactionSeen'; event: CompactionEvent }
  | { method: 'firstTurnContext'; sessionId: string }
  | { method: 'memoryCommand'; request: MemoryRequest }

export const FAKE_STATUS: BrainStatus = BrainStatusSchema.parse({
  enabled: true, scope: 'local', facts: 0, pending: 0, priority_tokens: 0, priority_over_budget: false,
  last_digest: null, journal_bytes: 0, hooks: 'managed', precompact: 'installed', degraded: false,
  last_handoff_delivery: null, integrity: [], summarizer: { model: 'gpt-6.1-terra', effort: 'high', fallback: false },
  warnings: [],
})

/** Records every call; tickets get refs `j:<clock day>#<n>` in call order. */
export class FakeBrainPort implements BrainPort {
  readonly calls: PortCall[] = []
  /** Receipts to report on the next `turnDelivered`. */
  nextSaved: ReceiptWrite[] = []
  context = ''
  statusValue: BrainStatus = FAKE_STATUS
  private n = 0
  private intents = 0
  constructor(private readonly clock: Clock = fixedClock('2026-11-26T00:00:00Z'), private readonly enabled = true) {}

  async sessionStarting(role: SessionIntent['role']): Promise<string | null> {
    this.calls.push({ method: 'sessionStarting', role })
    if (!this.enabled) return null
    this.intents += 1
    return `i${this.intents}`
  }

  async sessionStarted(sessionId: string, role: SessionRole, intent?: string): Promise<void> {
    this.calls.push(intent === undefined ? { method: 'sessionStarted', sessionId, role } : { method: 'sessionStarted', sessionId, role, intent })
  }

  async turnStarting(input: TurnStartInput): Promise<TurnTicket | null> {
    this.calls.push({ method: 'turnStarting', input })
    if (!this.enabled) return null
    this.n += 1
    const origin: BrainOrigin = input.origin
    return { sessionId: input.sessionId, key: input.key, ref: formatJournalRef(day(this.clock), this.n), origin }
  }
  async turnStarted(ticket: TurnTicket, turnId: string): Promise<void> {
    this.calls.push({ method: 'turnStarted', ticket, turnId })
  }
  async turnAnswered(ticket: TurnTicket, reply: string): Promise<void> {
    this.calls.push({ method: 'turnAnswered', ticket, reply })
  }
  async turnDelivered(ticket: TurnTicket, outcome: TurnOutcome): Promise<TurnNotice> {
    this.calls.push({ method: 'turnDelivered', ticket, outcome })
    const saved = this.nextSaved
    this.nextSaved = []
    return { saved, unavailable: false }
  }
  async planUpdated(update: PlanUpdate): Promise<void> {
    this.calls.push({ method: 'planUpdated', update })
  }
  async openQuestions(sessionId: string, questions: string[]): Promise<void> {
    this.calls.push({ method: 'openQuestions', sessionId, questions })
  }
  async compactionSeen(event: CompactionEvent): Promise<void> {
    this.calls.push({ method: 'compactionSeen', event })
  }
  async firstTurnContext(sessionId: string): Promise<string> {
    this.calls.push({ method: 'firstTurnContext', sessionId })
    return this.context
  }
  async status(): Promise<BrainStatus> {
    return this.statusValue
  }
  async memoryCommand(request: MemoryRequest): Promise<MemoryReply> {
    this.calls.push({ method: 'memoryCommand', request })
    if (!request.ownerPrivateChat) return { text: 'Память доступна только владельцу в личном чате.', buttons: [] }
    return { text: `memory: ${request.args}`, buttons: [] }
  }
}
