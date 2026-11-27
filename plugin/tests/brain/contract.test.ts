import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { z } from 'zod'
import {
  BrainConfigFileSchema, BrainStatusSchema, compareIndexLines, DESCRIPTION_MAX, DigestLineSchema, DigestSchema,
  estimateTokens, ExchangeSchema, FactKindSchema, FactSchema, formatIndexLine, formatJournalRef, HANDOFF_MAX_TOKENS,
  HandoffSchema, HOT_MAX_TOKENS, IndexLineSchema, JournalLineSchema, ManifestSchema, parseJournalRef,
  PermitSchema, PRIORITY_MAX_TOKENS, ProposalSchema, RECENT_TAIL_MAX_TOKENS, ReceiptSchema, SessionEntrySchema,
  SnapshotMetaSchema, SUMMARY_BATCH, SummarizerStateSchema, SummaryLineSchema, type BrainJobs, type BrainPort, type FactReader, type FactWriter, type HandoffBuilder,
  type IndexLine, type JournalReader, type JournalWriter, type PermitStore, type ProposalStore, type ReceiptStore,
  type SessionRegistry, type SnapshotBuilder, type Summarizer,
} from '../../../codex-brain/src/contract.js'
import { estimateTokens as storeEstimate } from '../../../codex-brain/src/store/estimate.js'
import {
  FakeBrainJobs, FakeBrainPort, FakeFacts, FakeHandoffBuilder, FakeJournal, FakePermits, FakeProposals, FakeReceipts, FakeSessions,
  FakeSnapshotBuilder, fixedClock, stubSummarizer,
} from './fakes.js'

// Parse, serialise to JSON and parse again: the value must survive unchanged.
function roundTrip<S extends z.ZodTypeAny>(schema: S, example: unknown): void {
  const first = schema.parse(example)
  expect(first).toEqual(example)
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first)
}

test('budget constants match the slice plan', () => {
  expect(HOT_MAX_TOKENS).toBe(2000)
  expect(PRIORITY_MAX_TOKENS).toBe(800)
  expect(HANDOFF_MAX_TOKENS).toBe(1000)
  expect(RECENT_TAIL_MAX_TOKENS).toBe(600)
  expect(SUMMARY_BATCH).toBe(10)
  expect(DESCRIPTION_MAX).toBe(120)
  expect(estimateTokens).toBe(storeEstimate)
})

// ---------------------------------------------------------------- spec examples

test('the §5.2 fact example round-trips', () => {
  roundTrip(FactSchema, {
    id: 'report-day-friday', kind: 'correction', description: 'Weekly report is due on Fridays', revision: 3,
    source: 'j:2026-11-26#17', created: '2026-11-20', updated: '2026-11-26',
    body: 'Weekly report is due on Fridays, not Mondays.\n**Why:** the owner reviews numbers on Friday evening.\n'
      + '**How to apply:** schedule report tasks for Friday 12:00 UTC.\n',
  })
  roundTrip(FactSchema, {
    id: 'owner-added', kind: 'user', description: 'Prefers short answers', revision: 1, source: 'tg-command',
    created: '2026-11-26', updated: '2026-11-26', body: 'Short answers.\n',
  })
})

test('A1 task facts carry a status; other kinds may not', () => {
  roundTrip(FactSchema, {
    id: 'ship-digest', kind: 'task', description: 'Ship the daily digest', revision: 1, source: 'j:2026-11-26#3',
    created: '2026-11-26', updated: '2026-11-26', status: 'open', owner_message_id: '42', body: 'Ship it.\n',
  })
  const base = { id: 'x', description: 'd', revision: 1, source: 'tg-command', created: '2026-11-26', updated: '2026-11-26', body: '' }
  expect(FactSchema.safeParse({ ...base, kind: 'task' }).success).toBe(false)
  expect(FactSchema.safeParse({ ...base, kind: 'user', status: 'open' }).success).toBe(false)
  expect(FactKindSchema.options).toEqual(['user', 'correction', 'decision', 'project', 'reference', 'pinned', 'task'])
})

test('fact validation rejects unsafe ids, long or multi-line descriptions and bad sources', () => {
  const ok = { id: 'a-1', kind: 'user', description: 'd', revision: 1, source: 'tg-command', created: '2026-11-26', updated: '2026-11-26', body: '' }
  expect(FactSchema.safeParse(ok).success).toBe(true)
  for (const bad of [{ id: '../x' }, { id: 'A' }, { id: '' }, { description: 'x'.repeat(DESCRIPTION_MAX + 1) },
    { description: 'two\nlines' }, { description: '' }, { source: 'j:2026-11-26' }, { revision: 0 }, { created: '26.11.2026' }]) {
    expect(FactSchema.safeParse({ ...ok, ...bad }).success).toBe(false)
  }
})

test('the §5.3 journal entry round-trips and folds into an Exchange', () => {
  roundTrip(JournalLineSchema, {
    n: 17, key: 'c1:100', origin: 'owner-direct', status: 'delivered', ts_in: '2026-11-26T10:05:11Z',
    ts_out: '2026-11-26T10:05:40Z', thread: 't1', turn: 'u1', input: 'redacted owner text', input_kind: 'text',
    reply: 'redacted final reply',
  })
  roundTrip(JournalLineSchema, { n: 18, key: 'c1:101', origin: 'owner-direct', status: 'failed', input_kind: 'voice', error: 'voice not recognised' })
  expect(JournalLineSchema.safeParse({ n: 1, key: 'k', origin: 'stranger', status: 'bound', input_kind: 'text' }).success).toBe(false)
  roundTrip(ExchangeSchema, {
    ref: 'j:2026-11-26#17', n: 17, key: 'c1:100', origin: 'owner-direct', status: 'delivered', input_kind: 'text',
    ts_in: '2026-11-26T10:05:11Z', input: 'text', reply: 'reply',
  })
})

test('journal refs format and parse strictly', () => {
  expect(formatJournalRef('2026-11-26', 17)).toBe('j:2026-11-26#17')
  expect(parseJournalRef('j:2026-11-26#17')).toEqual({ day: '2026-11-26', n: 17 })
  for (const bad of ['j:2026-11-26', 'j:2026-11-26#0', 'j:26-11-2026#1', 'x:2026-11-26#1', 'j:2026-11-26#1 ']) {
    expect(parseJournalRef(bad)).toBeNull()
  }
  expect(() => formatJournalRef('2026-11-26', 0)).toThrow()
})

test('index lines format as "- <id> · <kind> · <description>" and sort by kind, then id', () => {
  const line: IndexLine = { id: 'report-day-friday', kind: 'correction', description: 'Weekly report is due on Fridays' }
  roundTrip(IndexLineSchema, line)
  expect(formatIndexLine(line)).toBe('- report-day-friday · correction · Weekly report is due on Fridays')
  const lines: IndexLine[] = [
    { id: 'b', kind: 'user', description: '1' }, { id: 'a', kind: 'user', description: '2' },
    { id: 'z', kind: 'correction', description: '3' },
  ]
  expect([...lines].sort(compareIndexLines).map(l => l.id)).toEqual(['z', 'a', 'b'])
})

test('the §7.2 permit, receipts, proposals and sessions round-trip', () => {
  roundTrip(PermitSchema, {
    scope: 'local', session_id: 's1', turn_id: 'u1', origin: 'owner-direct', journal_ref: 'j:2026-11-26#17',
    expires: '2026-11-26T11:05:11Z', cue: true,
  })
  roundTrip(ReceiptSchema, {
    turn_id: 'u1', journal_ref: 'j:2026-11-26#17',
    writes: [{ id: 'report-day-friday', kind: 'correction', description: 'Weekly report is due on Fridays', revision: 3, action: 'put', at: '2026-11-26T10:05:30Z' }],
  })
  roundTrip(ProposalSchema, {
    id: 'p-1', fact: { kind: 'decision', description: 'Use Friday reports', body: 'Text.\n' }, source: 'j:2026-11-26#17',
    from: 'remember', reason: 'not-owner-direct', origin: 'owner-forward', created: '2026-11-26T10:05:30Z',
  })
  roundTrip(SessionEntrySchema, { session_id: 's1', scope: 'local', role: 'owner', registered: '2026-11-26T10:00:00Z' })
  roundTrip(ManifestSchema, { version: 1, facts: { 'report-day-friday': { revision: 3, sha256: 'a'.repeat(64) } } })
})

test('A2/A3 summary lines, digest, handoff, config and status round-trip', () => {
  roundTrip(SummaryLineSchema, { kind: 'decision', text: 'Reports move to Friday', ref: 'j:2026-11-26#17' })
  roundTrip(DigestLineSchema, { text: 'Report day moved to Friday', ref: 'j:2026-11-26#17' })
  roundTrip(DigestSchema, {
    day: '2026-11-26', revision: 1, provenance: 2, input_hash: 'b'.repeat(64), covered_to: 'j:2026-11-26#17',
    lines: [{ text: 'Report day moved to Friday', ref: 'j:2026-11-26#17' }],
  })
  roundTrip(BrainConfigFileSchema, { enabled: false, summarizer: { model: 'gpt-6.1-terra', effort: 'high' }, resume_reemit: true })
  roundTrip(BrainConfigFileSchema, {})
  roundTrip(HandoffSchema, {
    session_id: 's1', trigger: 'auto', written: '2026-11-26T10:06:00Z', journal_to: 'j:2026-11-26#17',
    in_flight: { ref: 'j:2026-11-26#17', origin: 'owner-direct', quote: 'Make the report' },
    plan: [{ step: 'collect', status: 'completed' }, { step: 'write', status: 'inProgress' }, { step: 'send', status: 'pending' }],
    open_questions: ['Which week?'], decisions: [{ id: 'report-day-friday', kind: 'correction', description: 'Weekly report is due on Fridays' }],
    tasks: [{ id: 'ship-digest', description: 'Ship the daily digest', next: 'write tests' }], next_step: 'write the report',
    tail: [{ ref: 'j:2026-11-26#16', origin: 'owner-direct', line: 'earlier ask' }, { ref: 'j:2026-11-26#15', origin: 'owner-forward' }],
  })
  roundTrip(BrainStatusSchema, {
    enabled: true, scope: 'local', facts: 3, pending: 1, priority_tokens: 120, priority_over_budget: false,
    last_digest: '2026-11-25', journal_bytes: 2048, hooks: 'managed', precompact: 'not-installed', degraded: false,
    last_handoff_delivery: null, integrity: [], summarizer: { model: 'gpt-6.1-terra', effort: 'high', fallback: false },
    warnings: [],
  })
})

test('the handoff never quotes forwarded or agent text, only its ref', () => {
  const base = {
    session_id: 's1', trigger: 'manual', written: '2026-11-26T10:06:00Z', in_flight: null, plan: [], open_questions: [],
    decisions: [], tasks: [], next_step: null, tail: [],
  }
  expect(HandoffSchema.safeParse(base).success).toBe(true)
  expect(HandoffSchema.safeParse({ ...base, in_flight: { ref: 'j:2026-11-26#1', origin: 'owner-forward', quote: 'injected' } }).success).toBe(false)
  expect(HandoffSchema.safeParse({ ...base, in_flight: { ref: 'j:2026-11-26#1', origin: 'owner-forward' } }).success).toBe(true)
  expect(HandoffSchema.safeParse({ ...base, tail: [{ ref: 'j:2026-11-26#1', origin: 'agent', line: 'quoted' }] }).success).toBe(false)
})

// ---------------------------------------------------------------- fakes honour the interfaces

test('the in-memory fakes implement every contract interface', async () => {
  const clock = fixedClock('2026-11-26T10:00:00Z')
  const facts: FactReader & FactWriter = new FakeFacts(clock)
  const journal: JournalReader & JournalWriter = new FakeJournal(clock)
  const permits: PermitStore = new FakePermits()
  const receipts: ReceiptStore = new FakeReceipts()
  const proposals: ProposalStore = new FakeProposals()
  const sessions: SessionRegistry = new FakeSessions()
  const snapshot: SnapshotBuilder = new FakeSnapshotBuilder(facts)
  const handoff: HandoffBuilder = new FakeHandoffBuilder(clock)
  const summarizer: Summarizer = stubSummarizer(['{"lines":[]}'])
  const port: BrainPort = new FakeBrainPort()
  expect([facts, journal, permits, receipts, proposals, sessions, snapshot, handoff, summarizer, port].every(Boolean)).toBe(true)
})

test('FakeFacts: revisions, conflicts, priority order and done', async () => {
  const facts = new FakeFacts(fixedClock('2026-11-26T10:00:00Z'))
  const put = await facts.put({ id: 'a', kind: 'user', description: 'A', body: '', source: 'tg-command' })
  expect(put.ok && put.fact.revision).toBe(1)
  const again = await facts.put({ id: 'a', kind: 'user', description: 'A2', body: '', source: 'tg-command' }, 1)
  expect(again.ok && again.fact.revision).toBe(2)
  const stale = await facts.put({ id: 'a', kind: 'user', description: 'A3', body: '', source: 'tg-command' }, 1)
  expect(stale).toEqual({ ok: false, error: 'conflict', current: 2, message: 'fact a is at revision 2, not 1' })
  expect((await facts.list()).map(l => l.description)).toEqual(['A2'])

  await facts.put({ id: 't2', kind: 'task', description: 'T2', body: '', source: 'tg-command', status: 'open' })
  await facts.put({ id: 'p1', kind: 'pinned', description: 'P1', body: '', source: 'tg-command' })
  await facts.put({ id: 't1', kind: 'task', description: 'T1', body: '', source: 'tg-command', status: 'open' })
  expect((await facts.priority()).map(f => f.id)).toEqual(['p1', 't1', 't2'])
  const done = await facts.done('t1')
  expect(done.ok && done.fact.status).toBe('done')
  expect((await facts.priority()).map(f => f.id)).toEqual(['p1', 't2'])
  expect((await facts.remove('a', 1)).ok).toBe(false)
  expect((await facts.remove('a', 2)).ok).toBe(true)
  expect(await facts.get('a')).toBeNull()
})

test('FakeJournal: transitions fold by key, a retried bind returns the same exchange', async () => {
  const journal = new FakeJournal(fixedClock('2026-11-26T10:00:00Z'))
  const ref = await journal.bind({ key: 'c:1', origin: 'owner-direct', input: 'hi', input_kind: 'text', turn: 'u1' })
  expect(ref).toBe('j:2026-11-26#1')
  await journal.answered(ref, 'hello')
  await journal.failed(ref, 'telegram down')
  expect(await journal.bind({ key: 'c:1', origin: 'owner-direct', input: 'hi', input_kind: 'text' })).toBe(ref)
  await journal.answered(ref, 'hello')
  await journal.delivered(ref)
  const folded = await journal.fold('2026-11-26')
  expect(folded.length).toBe(1)
  expect(folded[0]?.status).toBe('delivered')
  expect(folded[0]?.reply).toBe('hello')
  expect((await journal.tail(5)).map(e => e.ref)).toEqual([ref])
  expect((await journal.get(ref))?.turn).toBe('u1')
})

test('FakePermits, FakeReceipts, FakeSessions and the stub summarizer behave like the stores', async () => {
  const permits = new FakePermits()
  await permits.put({ scope: 'local', session_id: 's', turn_id: 'u1', origin: 'owner-direct', journal_ref: 'j:2026-11-26#1', expires: '2026-11-26T11:00:00Z', cue: false })
  await permits.put({ scope: 'local', session_id: 's', turn_id: 'u0', origin: 'agent', journal_ref: 'j:2026-11-26#2', expires: '2026-11-26T09:00:00Z', cue: false })
  expect((await permits.live(new Date('2026-11-26T10:00:00Z'))).map(p => p.turn_id)).toEqual(['u1'])

  const receipts = new FakeReceipts()
  await receipts.add('u1', 'j:2026-11-26#1', { id: 'a', kind: 'user', description: 'A', revision: 1, action: 'put', at: '2026-11-26T10:00:00Z' })
  expect(await receipts.hasJournalRef('j:2026-11-26#1')).toBe(true)
  expect((await receipts.get('u1'))?.writes.length).toBe(1)

  const sessions = new FakeSessions()
  await sessions.register({ session_id: 's', scope: 'local', role: 'owner', registered: '2026-11-26T10:00:00Z' })
  expect((await sessions.resolve('s'))?.role).toBe('owner')
  expect(await sessions.resolve('other')).toBeNull()

  const summarizer = stubSummarizer(['first', new Error('model down')])
  const signal = new AbortController().signal
  expect(await summarizer('p', {}, signal)).toBe('first')
  await expect(summarizer('p', {}, signal)).rejects.toThrow('model down')
  expect(summarizer.calls.length).toBe(2)
})

// ---------------------------------------------------------------- review follow-ups

test('snapshot meta records fact revisions at the boundary, so the handoff can list changed facts', () => {
  roundTrip(SnapshotMetaSchema, {
    session_id: 's1', source: 'startup', boundary: 'b-1', sha256: 'c'.repeat(64), provenance: 2, delta_seen: 0,
    facts: { 'report-day-friday': 3, 'ship-digest': 1 },
  })
})

test('the summarizer state carries the fallback warning S6 shows in /memory', () => {
  roundTrip(SummarizerStateSchema, {
    configured: { model: 'gpt-6.1-terra', effort: 'high' }, used: { model: 'gpt-main', effort: 'low' },
    fallback: true, warning: 'gpt-6.1-terra is not in model/list', checked: '2026-11-26T10:00:00Z',
  })
})

test('the journal records the turn id once the turn has started', async () => {
  const journal = new FakeJournal(fixedClock('2026-11-26T10:00:00Z'))
  const ref = await journal.bind({ key: 'c:9', origin: 'owner-direct', input: 'go', input_kind: 'text' })
  await journal.started(ref, 'turn-9')
  const exchange = await journal.get(ref)
  expect(exchange?.turn).toBe('turn-9')
  expect(exchange?.status).toBe('bound')
})

test('the port registers a session before its first turn, and background jobs have an interface', async () => {
  const port = new FakeBrainPort()
  await port.sessionStarted('s1', 'owner')
  expect(port.calls).toEqual([{ method: 'sessionStarted', sessionId: 's1', role: 'owner' }])
  const jobs: BrainJobs = new FakeBrainJobs()
  const signal = new AbortController().signal
  expect(await jobs.summarize(signal, false)).toEqual({ summarized: 0, proposals: 0, queued: 0 })
  expect(await jobs.sealDays(signal)).toEqual({ sealed: [], archived: [] })
})

// ---------------------------------------------------------------- packaging

test('the contract bundles standalone, as the managed hooks bundle will import it', async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, '../../../codex-brain/src/contract.ts')], target: 'bun' })
  expect(built.logs.map(String)).toEqual([])
  expect(built.success).toBe(true)
})
