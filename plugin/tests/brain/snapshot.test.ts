import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type BrainConfig, DEFAULT_SUMMARIZER, type Digest, estimateTokens, type Exchange, type FactInput, HOT_MAX_TOKENS,
  type FactReader, RECENT_TAIL_MAX_TOKENS, renderRecentTail, type SessionRole, SnapshotMetaSchema, type SnapshotBuilder,
} from '../../../codex-brain/src/contract.js'
import { MEMORY_RULE, createSnapshotBuilder } from '../../../codex-brain/src/snapshot/index.js'
import { appendLine } from '../../../codex-brain/src/store/atomic.js'
import { scopePaths } from '../../../codex-brain/src/store/paths.js'
import { FakeFacts, FakeJournal, FakeRecent, FakeSessions, FakeSummaries, fixedClock } from './fakes.js'

const SCOPE = 'b-0123456789abcdef'
const SID = 'thread-owner'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brain-snapshot-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

interface Rig {
  builder: SnapshotBuilder
  facts: FakeFacts
  sessions: FakeSessions
  summaries: FakeSummaries
  recent: FakeRecent
  clock: ReturnType<typeof fixedClock>
  config: BrainConfig
}

function rig(options: { role?: SessionRole; scope?: string; summaries?: FakeSummaries; recent?: FakeRecent } = {}): Rig {
  const clock = fixedClock('2026-11-26T10:00:00Z')
  const facts = new FakeFacts(clock)
  const sessions = new FakeSessions()
  const summaries = options.summaries ?? new FakeSummaries()
  const recent = options.recent ?? new FakeRecent()
  const config: BrainConfig = { enabled: true, summarizer: { ...DEFAULT_SUMMARIZER }, resume_reemit: false, problems: [] }
  void sessions.register({ session_id: SID, scope: options.scope ?? SCOPE, role: options.role ?? 'owner', registered: clock.now().toISOString() })
  const builder = createSnapshotBuilder({ brainHome: dir, scope: SCOPE, facts, recent, summaries, sessions, clock, config: () => config })
  return { builder, facts, sessions, summaries, recent, clock, config }
}

async function put(facts: FakeFacts, input: FactInput): Promise<void> {
  const result = await facts.put(input)
  if (!result.ok) throw new Error(result.message)
}

const fact = (id: string, kind: FactInput['kind'], description: string): FactInput =>
  kind === 'task' ? { id, kind, description, source: 'tg-command', status: 'open', body: '' } : { id, kind, description, source: 'tg-command', body: '' }

async function seedPriority(facts: FakeFacts): Promise<string[]> {
  await put(facts, fact('pin-a', 'pinned', 'Always answer in Russian'))
  await put(facts, fact('pin-b', 'pinned', 'Never deploy on Fridays'))
  await put(facts, fact('pin-c', 'pinned', 'Reports go to the shared folder'))
  await put(facts, fact('task-a', 'task', 'Prepare the weekly report'))
  await put(facts, fact('task-b', 'task', 'Call the accountant back'))
  return ['pin-a', 'pin-b', 'pin-c', 'task-a', 'task-b']
}

async function seedIndex(facts: FakeFacts, count: number): Promise<void> {
  const kinds = ['user', 'correction', 'decision', 'project', 'reference'] as const
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length] ?? 'user'
    await put(facts, fact(`fact-${String(i).padStart(3, '0')}`, kind, `Stored ${kind} fact number ${i} about a recurring detail of the work`))
  }
}

async function startup(builder: SnapshotBuilder, source: 'startup' | 'clear' | 'compact' = 'startup'): Promise<string> {
  const boundary = await builder.beginBoundary(SID, source)
  return builder.build({ sessionId: SID, source, boundary })
}

const positions = (text: string, ids: string[]): number[] => ids.map(id => text.indexOf(`- ${id} · `))

// ---------------------------------------------------------------- static head (cache rule 2)

test('the first line of HOT is static and the rule and priority header carry no date or digit run', async () => {
  const { builder, facts } = rig()
  await seedPriority(facts)
  const hot = await startup(builder)
  const firstLine = hot.split('\n')[0] ?? ''
  expect(firstLine).toBe(MEMORY_RULE.split('\n')[0] ?? 'missing')
  expect(hot.startsWith(MEMORY_RULE)).toBe(true)
  const head = hot.slice(0, hot.indexOf('- pin-a · '))
  expect(head.length).toBeGreaterThan(MEMORY_RULE.length)
  expect(head).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  expect(head).not.toMatch(/\d{2,}/)
})

// ---------------------------------------------------------------- stable prefix (cache rules 1, 3, 7)

test('ten ordinary turns with one new fact keep the stored HOT hash and bytes', async () => {
  const { builder, facts, clock } = rig()
  await seedPriority(facts)
  await seedIndex(facts, 12)
  const journal = new FakeJournal(clock)
  const boundary = await builder.beginBoundary(SID, 'startup')
  const first = await builder.build({ sessionId: SID, source: 'startup', boundary })
  const paths = scopePaths(dir, SCOPE)
  const storedHash = sha(readFileSync(paths.snapshotText(SID), 'utf8'))
  expect(storedHash).toBe(sha(first))

  const hashes: string[] = []
  for (let turn = 1; turn <= 10; turn++) {
    clock.set(`2026-11-26T10:${String(turn).padStart(2, '0')}:00Z`)
    const ref = await journal.bind({ key: `k:${turn}`, origin: 'owner-direct', input_kind: 'text', input: `turn ${turn}` })
    if (turn === 5) await put(facts, fact('fresh-decision', 'decision', 'Use the new invoice template'))
    expect(await builder.delta(SID)).toBe('')
    const again = await builder.build({ sessionId: SID, source: 'startup', boundary })
    await journal.answered(ref, `reply ${turn}`)
    await journal.delivered(ref)
    hashes.push(sha(again))
    expect(sha(readFileSync(paths.snapshotText(SID), 'utf8'))).toBe(storedHash)
  }
  expect(new Set(hashes)).toEqual(new Set([sha(first)]))
  expect(first).not.toContain('fresh-decision')

  // The next boundary picks the fact up.
  const next = await startup(builder, 'clear')
  expect(next).toContain('- fresh-decision · decision · Use the new invoice template')
})

test('the same state gives the same bytes regardless of write order', async () => {
  const a = rig()
  await seedIndex(a.facts, 8)
  await seedPriority(a.facts)
  const textA = await startup(a.builder)
  rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), 'brain-snapshot-'))
  const b = rig()
  await seedPriority(b.facts)
  await seedIndex(b.facts, 8)
  expect(await startup(b.builder)).toBe(textA)
})

// ---------------------------------------------------------------- budget (D3)

test('300 facts fit 2000 tokens with per-kind count lines and the full-index pointer', async () => {
  const { builder, facts } = rig()
  await seedIndex(facts, 300)
  const hot = await startup(builder)
  expect(estimateTokens(hot)).toBeLessThanOrEqual(HOT_MAX_TOKENS)
  for (const kind of ['correction', 'decision', 'project', 'reference', 'user']) expect(hot).toContain(`- ${kind}: 60 facts`)
  expect(hot).toContain('full index: brain list')
  expect(hot.match(/^- fact-\d{3} · /gm)?.length ?? 0).toBeGreaterThan(0)
})

test('a small index is printed whole, without the count lines', async () => {
  const { builder, facts } = rig()
  await seedIndex(facts, 5)
  const hot = await startup(builder)
  expect(hot.match(/^- fact-\d{3} · /gm)?.length).toBe(5)
  expect(hot).not.toContain('full index: brain list')
})

// ---------------------------------------------------------------- priority layer (A1)

test('A1: pinned facts and open tasks survive an index past the budget, in fixed order, for startup, compact and resume with reemit', async () => {
  const { builder, facts, config } = rig()
  const ids = await seedPriority(facts)
  await seedIndex(facts, 300)
  config.resume_reemit = true
  for (const source of ['startup', 'compact'] as const) {
    const boundary = await builder.beginBoundary(SID, source)
    const hot = await builder.build({ sessionId: SID, source, boundary })
    const at = positions(hot, ids)
    expect(at.every(p => p > 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(at.every(p => p < hot.indexOf('full index: brain list'))).toBe(true)
    expect(estimateTokens(hot)).toBeLessThanOrEqual(HOT_MAX_TOKENS)
    const resumed = await builder.build({ sessionId: SID, source: 'resume', boundary })
    expect(resumed).toBe(hot)
  }
})

test('A1: closing a task changes only the next snapshot', async () => {
  const { builder, facts } = rig()
  await seedPriority(facts)
  const boundary = await builder.beginBoundary(SID, 'startup')
  const before = await builder.build({ sessionId: SID, source: 'startup', boundary })
  expect(before).toContain('- task-a · task · ')
  const closed = await facts.done('task-a')
  expect(closed.ok).toBe(true)
  expect(await builder.build({ sessionId: SID, source: 'startup', boundary })).toBe(before)
  const next = await startup(builder, 'compact')
  expect(next).not.toContain('task-a')
  expect(next).toContain('- task-b · task · ')
})

test('A1: a priority block over its cap gets one warning line and nothing is dropped', async () => {
  const { builder, facts } = rig()
  for (let i = 0; i < 40; i++) await put(facts, fact(`pin-${String(i).padStart(2, '0')}`, 'pinned', `Standing rule number ${i} that the owner wants kept in every session`))
  const hot = await startup(builder)
  for (let i = 0; i < 40; i++) expect(hot).toContain(`- pin-${String(i).padStart(2, '0')} · pinned · `)
  expect(hot.match(/^warning: /gm)?.length).toBe(1)
})

test('A1: a priority block within its cap carries no warning', async () => {
  const { builder, facts } = rig()
  await seedPriority(facts)
  expect(await startup(builder)).not.toContain('warning: ')
})

// ---------------------------------------------------------------- digest and summary blocks

test('the digests of today and yesterday sit below the index, with their coverage ref; older ones do not', async () => {
  const digest = (day: string, text: string): Digest => ({
    day, revision: 1, provenance: 2, input_hash: 'a'.repeat(64), covered_to: `j:${day}#9`, lines: [{ text, ref: `j:${day}#3` }],
  })
  const summaries = new FakeSummaries(
    [{ kind: 'decision', text: 'Switched invoices to the new template', ref: 'j:2026-11-26#2' }],
    [digest('2026-11-23', 'Old day'), digest('2026-11-25', 'Yesterday work'), digest('2026-11-26', 'Today work')],
  )
  const { builder, facts } = rig({ summaries })
  await seedPriority(facts)
  await seedIndex(facts, 3)
  const hot = await startup(builder)
  expect(hot).not.toContain('Old day')
  const yesterday = hot.indexOf('- Yesterday work · j:2026-11-25#3')
  const today = hot.indexOf('- Today work · j:2026-11-26#3')
  expect(yesterday).toBeGreaterThan(hot.indexOf('- fact-002 · '))
  expect(today).toBeGreaterThan(yesterday)
  expect(hot).toContain('j:2026-11-25#9')
  expect(hot.indexOf('- decision · Switched invoices to the new template · j:2026-11-26#2')).toBeGreaterThan(today)
})

test('blocks below the index are trimmed from the bottom when the budget runs out', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ text: `Digest line ${i} ${'detail '.repeat(30).trim()}`, ref: `j:2026-11-26#${i + 1}` }))
  const summaries = new FakeSummaries([], [{ day: '2026-11-26', revision: 1, provenance: 2, input_hash: 'b'.repeat(64), covered_to: 'j:2026-11-26#10', lines }])
  const { builder, facts } = rig({ summaries })
  await seedIndex(facts, 40)
  const hot = await startup(builder)
  expect(estimateTokens(hot)).toBeLessThanOrEqual(HOT_MAX_TOKENS)
  expect(hot).toContain('- Digest line 0 ')
  expect(hot).not.toContain('- Digest line 9 ')
  expect(hot).not.toContain('full index: brain list')
})

// ---------------------------------------------------------------- boundary identity and gates

test('the same boundary twice returns the same bytes; a new boundary rebuilds and is stored', async () => {
  const { builder, facts } = rig()
  await seedIndex(facts, 3)
  const boundary = await builder.beginBoundary(SID, 'startup')
  expect((await builder.openBoundary(SID))?.boundary).toBe(boundary)
  const one = await builder.build({ sessionId: SID, source: 'startup', boundary })
  const two = await builder.build({ sessionId: SID, source: 'startup', boundary })
  expect(two).toBe(one)
  await put(facts, fact('late', 'user', 'Owner prefers short answers'))
  const next = await builder.beginBoundary(SID, 'clear')
  expect(next).not.toBe(boundary)
  const three = await builder.build({ sessionId: SID, source: 'clear', boundary: next })
  expect(three).toContain('- late · user · ')
  const paths = scopePaths(dir, SCOPE)
  expect(readFileSync(paths.snapshotText(SID), 'utf8')).toBe(three)
  const meta = SnapshotMetaSchema.parse(JSON.parse(readFileSync(paths.snapshotMeta(SID), 'utf8')))
  expect(meta.boundary).toBe(next)
  expect(meta.sha256).toBe(sha(three))
  expect(meta.facts.late).toBe(1)
  expect(statSync(paths.snapshotText(SID)).mode & 0o777).toBe(0o600)
  expect(statSync(paths.snapshotMeta(SID)).mode & 0o777).toBe(0o600)
})

test('resume without reemit, fork, unregistered, non-personal and foreign-scope sessions get nothing', async () => {
  const { builder, facts } = rig()
  await seedPriority(facts)
  const boundary = await builder.beginBoundary(SID, 'startup')
  expect(await builder.build({ sessionId: SID, source: 'startup', boundary })).not.toBe('')
  expect(await builder.build({ sessionId: SID, source: 'resume', boundary })).toBe('')
  expect(await builder.build({ sessionId: SID, source: 'fork', boundary })).toBe('')
  expect(await builder.build({ sessionId: 'unknown-thread', source: 'startup', boundary })).toBe('')

  for (const [role, scope] of [['guest', SCOPE], ['side', SCOPE], ['owner', 'b-ffffffffffffffff']] as const) {
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'brain-snapshot-'))
    const other = rig({ role, scope })
    await seedPriority(other.facts)
    expect(await startup(other.builder)).toBe('')
    expect(await other.builder.delta(SID)).toBe('')
  }
})

test('resume with reemit and no stored snapshot gives nothing', async () => {
  const { builder, config } = rig()
  config.resume_reemit = true
  const boundary = await builder.beginBoundary(SID, 'startup')
  expect(await builder.build({ sessionId: SID, source: 'resume', boundary })).toBe('')
})

test('Brain disabled: every builder output is empty', async () => {
  const recent = new FakeRecent([{ n: 1, key: 'k', origin: 'owner-direct', status: 'delivered', input_kind: 'text', input: 'hi', reply: 'hello', ref: 'j:2026-11-26#1' }])
  const { builder, facts, config } = rig({ recent })
  await seedPriority(facts)
  config.enabled = false
  expect(await startup(builder)).toBe('')
  expect(await builder.recentTail()).toBe('')
  expect(await builder.delta(SID)).toBe('')
})

// ---------------------------------------------------------------- recent tail

test('recentTail renders the recent exchanges within the tail budget', async () => {
  const held: Exchange[] = Array.from({ length: 40 }, (_, i) => ({
    n: i + 1, key: `k${i}`, origin: i % 3 === 0 ? 'owner-forward' : 'owner-direct', status: 'delivered', input_kind: 'text',
    input: `Message ${i} ${'text '.repeat(20)}`, reply: `Reply ${i}`, ref: `j:2026-11-26#${i + 1}`,
  }))
  const recent = new FakeRecent(held)
  const { builder } = rig({ recent })
  const tail = await builder.recentTail()
  expect(tail).toBe(renderRecentTail(held, RECENT_TAIL_MAX_TOKENS))
  expect(tail).not.toBe('')
})

// ---------------------------------------------------------------- out-of-band owner edits (D9)

test('an out-of-band owner edit gives exactly one delta line, once; a new boundary absorbs earlier edits', async () => {
  const { builder, facts } = rig()
  await seedIndex(facts, 3)
  const hot = await startup(builder)
  const paths = scopePaths(dir, SCOPE)
  appendLine(paths.delta, JSON.stringify({ seq: 1, id: 'fact-001', action: 'changed', revision: 2, at: '2026-11-26T10:05:00Z' }))
  const line = await builder.delta(SID)
  expect(line).toBe('memory update: fact fact-001 changed by the owner, read it before use\n')
  expect(await builder.delta(SID)).toBe('')
  expect(await builder.build({ sessionId: SID, source: 'startup', boundary: (await builder.openBoundary(SID))?.boundary ?? 'x' })).toBe(hot)

  appendLine(paths.delta, JSON.stringify({ seq: 2, id: 'fact-002', action: 'removed', at: '2026-11-26T10:06:00Z' }))
  appendLine(paths.delta, '{"torn line')
  expect(await builder.delta(SID)).toBe('memory update: fact fact-002 removed by the owner, read it before use\n')

  appendLine(paths.delta, JSON.stringify({ seq: 3, id: 'fact-000', action: 'changed', revision: 2, at: '2026-11-26T10:07:00Z' }))
  await startup(builder, 'clear')
  expect(await builder.delta(SID)).toBe('')
})

test('a pinned fact that fails the integrity check (not in the index) stays out of HOT', async () => {
  const clock = fixedClock('2026-11-26T10:00:00Z')
  const facts = new FakeFacts(clock)
  await seedPriority(facts)
  // The real store drops a fact file that does not match the manifest from `list()`.
  const tampered: FactReader = {
    get: id => facts.get(id),
    list: async kind => (await facts.list(kind)).filter(line => line.id !== 'pin-b'),
    priority: () => facts.priority(),
    indexText: () => facts.indexText(),
    manifest: () => facts.manifest(),
    integrity: async () => [{ file: 'facts/pin-b.md', problem: 'hash-mismatch' }],
  }
  const sessions = new FakeSessions()
  await sessions.register({ session_id: SID, scope: SCOPE, role: 'owner', registered: clock.now().toISOString() })
  const builder = createSnapshotBuilder({ brainHome: dir, scope: SCOPE, facts: tampered, recent: new FakeRecent(), summaries: new FakeSummaries(), sessions, clock })
  const hot = await startup(builder)
  expect(hot).toContain('- pin-a · pinned · ')
  expect(hot).not.toContain('pin-b')
})

// ---------------------------------------------------------------- review fixes: publication race

/** FactReader whose first `priority()` call waits until `release()`; `entered` resolves when it starts waiting. */
function gatedFacts(facts: FakeFacts): { reader: FactReader; entered: Promise<void>; release: () => void } {
  let release = (): void => undefined
  let signal = (): void => undefined
  const entered = new Promise<void>(resolve => { signal = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let first = true
  const reader: FactReader = {
    get: id => facts.get(id),
    list: kind => facts.list(kind),
    priority: async () => {
      if (first) {
        first = false
        signal()
        await gate
      }
      return facts.priority()
    },
    indexText: () => facts.indexText(),
    manifest: () => facts.manifest(),
    integrity: () => facts.integrity(),
  }
  return { reader, entered, release }
}

function gatedRig(): Rig & { entered: Promise<void>; release: () => void } {
  const base = rig()
  const gated = gatedFacts(base.facts)
  const builder = createSnapshotBuilder({ brainHome: dir, scope: SCOPE, facts: gated.reader, recent: base.recent, summaries: base.summaries, sessions: base.sessions, clock: base.clock, config: () => base.config })
  return { ...base, builder, entered: gated.entered, release: gated.release }
}

test('a slow compact build does not overwrite the snapshot of a newer clear boundary', async () => {
  const r = gatedRig()
  await seedIndex(r.facts, 2)
  const compact = await r.builder.beginBoundary(SID, 'compact')
  const slow = r.builder.build({ sessionId: SID, source: 'compact', boundary: compact })
  await r.entered
  await put(r.facts, fact('late', 'user', 'Added before the clear'))
  const clear = await r.builder.beginBoundary(SID, 'clear')
  const fresh = await r.builder.build({ sessionId: SID, source: 'clear', boundary: clear })
  r.release()
  await slow
  const meta = SnapshotMetaSchema.parse(JSON.parse(readFileSync(scopePaths(dir, SCOPE).snapshotMeta(SID), 'utf8')))
  expect(meta.boundary).toBe(clear)
  expect(await r.builder.build({ sessionId: SID, source: 'clear', boundary: clear })).toBe(fresh)
})

test('an owner edit logged while HOT renders is still delivered as a delta', async () => {
  const r = gatedRig()
  await seedIndex(r.facts, 2)
  const boundary = await r.builder.beginBoundary(SID, 'startup')
  const building = r.builder.build({ sessionId: SID, source: 'startup', boundary })
  await r.entered
  appendLine(scopePaths(dir, SCOPE).delta, JSON.stringify({ seq: 1, id: 'fact-001', action: 'changed', revision: 2, at: '2026-11-26T10:05:00Z' }))
  r.release()
  await building
  expect(await r.builder.delta(SID)).toBe('memory update: fact fact-001 changed by the owner, read it before use\n')
})

// ---------------------------------------------------------------- review fixes: open-task overflow

test('60 open tasks: HOT stays within its budget, shows what fits and points to the rest with a count', async () => {
  const { builder, facts } = rig()
  await put(facts, fact('pin-a', 'pinned', 'Always answer in Russian'))
  for (let i = 0; i < 60; i++) await put(facts, fact(`task-${String(i).padStart(2, '0')}`, 'task', `Open task number ${i} with a description long enough to matter for the budget`))
  const hot = await startup(builder)
  expect(estimateTokens(hot)).toBeLessThanOrEqual(HOT_MAX_TOKENS)
  expect(hot).toContain('- pin-a · pinned · ')
  const shown = hot.match(/^- task-\d\d · task · /gm)?.length ?? 0
  expect(shown).toBeGreaterThan(0)
  expect(shown).toBeLessThan(60)
  expect(hot).toContain(`- ${60 - shown} more open tasks: brain list --kind task`)
})
