// M5 architecture pass: consistency of lookup, archive, digest publish, fact commit and snapshot
// boundary (docs/design/brain/provenance-consistency.md §2).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  type BrainConfig, DEFAULT_SUMMARIZER, EvictedLineSchema, type FactInput, formatJournalRef, type JournalLine,
  JournalLineSchema, ManifestSchema, type Summarizer,
} from '../../../codex-brain/src/contract.js'
import { archiveMonth, readArchive } from '../../../codex-brain/src/digest/archive.js'
import { readDay } from '../../../codex-brain/src/digest/day.js'
import { sealDays } from '../../../codex-brain/src/digest/seal.js'
import { packTar } from '../../../codex-brain/src/digest/tar.js'
import { FactStore } from '../../../codex-brain/src/facts/store.js'
import { FileJournalReader, foldDay } from '../../../codex-brain/src/journal/fold.js'
import { FileProposalStore } from '../../../codex-brain/src/permit/proposals.js'
import { createSnapshotBuilder } from '../../../codex-brain/src/snapshot/builder.js'
import { appendLine } from '../../../codex-brain/src/store/atomic.js'
import { withLock } from '../../../codex-brain/src/store/lock.js'
import { ensureScope, type ScopePaths } from '../../../codex-brain/src/store/paths.js'
import { readDigestMeta } from '../../../codex-brain/src/summary/reader.js'
import { readEvictedQueue, runRollingSummary } from '../../../codex-brain/src/summary/rolling.js'
import { FakeFacts, FakeJournal, FakeProposals, FakeReceipts, FakeRecent, FakeSessions, FakeSummaries, fixedClock, stubSummarizer } from './fakes.js'

const TODAY = '2026-11-26'
const YESTERDAY = '2026-11-25'
const OLD = '2026-08-03'
const MONTH = '2026-08'
const SCOPE = 'local'

let dir = ''
let home = ''
let paths: ScopePaths
let clock: ReturnType<typeof fixedClock>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brain-consistency-'))
  home = join(dir, 'brain')
  paths = ensureScope(home, SCOPE)
  clock = fixedClock(`${TODAY}T08:00:00Z`)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const line = (day: string, n: number, extra: Partial<JournalLine>): JournalLine =>
  JournalLineSchema.parse({ n, key: `chat:${day}:${n}`, origin: 'owner-direct', input_kind: 'text', status: 'bound', ...extra })
const append = (day: string, value: JournalLine): void => appendLine(paths.journal(day), JSON.stringify(value))
const signal = (): AbortSignal => new AbortController().signal

// ---------------------------------------------------------------- journal lookup

test('a lookup that overlaps an archive replacement still finds the exchange', async () => {
  append(OLD, line(OLD, 1, { ts_in: `${OLD}T10:00:00Z`, input: 'Перенеси отчёт' }))
  let swaps = 0
  const reader = new FileJournalReader(paths, {
    // The archiver finishes between the reader's archive read and its plain-file read.
    afterArchiveRead: () => {
      if (swaps++ > 0) return
      mkdirSync(dirname(paths.archive(MONTH)), { recursive: true })
      writeFileSync(paths.archive(MONTH), gzipSync(packTar([{ name: `${OLD}.jsonl`, data: readFileSync(paths.journal(OLD)) }])))
      rmSync(paths.journal(OLD))
    },
  })
  const found = await reader.get(formatJournalRef(OLD, 1))
  expect(swaps).toBeGreaterThan(0)
  expect(found?.input).toBe('Перенеси отчёт')
})

test('a checksum read error during archive replacement retries the lookup', async () => {
  append(OLD, line(OLD, 1, { input: 'Перенеси отчёт' }))
  await archiveMonth(paths, MONTH, [OLD], { lockTimeoutMs: 1000 })
  const archive = paths.archive(MONTH)
  const replacement = `${archive}.replacement`
  writeFileSync(replacement, readFileSync(archive))
  let checksumReads = 0
  const reader = new FileJournalReader({
    ...paths,
    archiveChecksum: month => {
      if (checksumReads++ > 0) return paths.archiveChecksum(month)
      renameSync(replacement, archive)
      // Inject EISDIR on the first checksum read, after the reader has opened the old archive.
      return dirname(paths.archiveChecksum(month))
    },
  })
  expect((await reader.get(formatJournalRef(OLD, 1)))?.input).toBe('Перенеси отчёт')
  expect(checksumReads).toBe(2)
})

test('a checksum read error for a stable archive is propagated immediately', async () => {
  append(OLD, line(OLD, 1, { input: 'Перенеси отчёт' }))
  await archiveMonth(paths, MONTH, [OLD], { lockTimeoutMs: 1000 })
  let checksumReads = 0
  const reader = new FileJournalReader({
    ...paths,
    archiveChecksum: month => {
      checksumReads++
      return dirname(paths.archiveChecksum(month))
    },
  })
  await expect(reader.get(formatJournalRef(OLD, 1))).rejects.toThrow(/EISDIR/)
  expect(checksumReads).toBe(1)
})

test('a ref the journal does not return is never marked summarized: it stays queued, then is skipped with a reason', async () => {
  const journal = new FakeJournal(clock)
  const missing = formatJournalRef(TODAY, 99)
  appendLine(paths.evicted, JSON.stringify(EvictedLineSchema.parse({ ref: missing, status: 'pending', at: clock.now().toISOString() })))
  const model = stubSummarizer([])
  const run = () => runRollingSummary({ paths, journal, receipts: new FakeReceipts(), proposals: new FakeProposals(), summarizer: model, clock }, signal(), true)
  const first = await run()
  expect(first.summarized).toBe(0)
  expect(readEvictedQueue(paths.evicted)).toEqual([missing])
  await run()
  await run()
  const statuses = readFileSync(paths.evicted, 'utf8').split('\n').filter(Boolean).map(raw => EvictedLineSchema.parse(JSON.parse(raw)))
  expect(statuses.some(s => s.status === 'summarized')).toBe(false)
  expect(statuses.at(-1)).toMatchObject({ ref: missing, status: 'skipped' })
  expect(readEvictedQueue(paths.evicted)).toEqual([])
  expect(model.calls.length).toBe(0)
})

// ---------------------------------------------------------------- archive and digest

test('A → B → A: the final A is not deduplicated against an earlier revision, the archived fold equals the journal', async () => {
  const a = line(OLD, 1, { ts_in: `${OLD}T10:00:00Z`, input: 'Первое' })
  const b = line(OLD, 1, { status: 'failed', error: 'timeout' })
  for (const revision of [a, b, a]) {
    append(OLD, revision)
    await archiveMonth(paths, MONTH, [OLD], { lockTimeoutMs: 1000 })
  }
  // Journal order is a, b, a: the last line wins, so the exchange is `bound` again.
  expect(foldDay(paths, OLD).map(e => e.status)).toEqual(['bound'])
  expect(readArchive(paths, MONTH).length).toBe(3)
  expect(existsSync(paths.journal(OLD))).toBe(false)
})

test('a changed day publishes neither its stale digest nor its reviewer proposals', async () => {
  append(YESTERDAY, line(YESTERDAY, 1, { ts_in: `${YESTERDAY}T10:00:00Z`, input: 'Вопрос про склад' }))
  const ref = formatJournalRef(YESTERDAY, 1)
  const answer = JSON.stringify({
    lines: [{ text: 'Обсудили работу склада', ref }],
    proposals: [{ kind: 'task', text: 'Согласовать часы работы', ref }],
  })
  const proposals = new FileProposalStore(home, SCOPE)
  const deps = { paths, receipts: new FakeReceipts(), proposals, clock }
  let appended = false
  const model: Summarizer = async () => {
    if (!appended) append(YESTERDAY, line(YESTERDAY, 1, { status: 'answered', reply: 'Склад открыт.' }))
    appended = true
    return answer
  }
  const report = await sealDays({ ...deps, summarizer: model }, signal())
  expect(report.sealed).toEqual([])
  expect(report.errors[0]).toContain('the journal day changed')
  expect(readDigestMeta(paths, YESTERDAY)).toBeNull()
  expect(existsSync(paths.digest(YESTERDAY))).toBe(false)
  expect(await proposals.list()).toEqual([])
  // The next run digests the day as it is now.
  const next = await sealDays({ ...deps, summarizer: async () => answer }, signal())
  expect(next.sealed).toEqual([YESTERDAY])
  expect(readDigestMeta(paths, YESTERDAY)?.input_hash).toBe(readDay(paths, YESTERDAY).inputHash)
  expect(await proposals.list()).toMatchObject([{ from: 'reviewer', source: ref, fact: { kind: 'task', body: 'Согласовать часы работы' } }])
})

// ---------------------------------------------------------------- facts and receipts

const TURN = { turnId: 'turn-1', journalRef: 'j:2026-11-26#3' }
const fact: FactInput = { id: 'report-day', kind: 'correction', description: 'Weekly report is due on Fridays', body: 'Fridays.\n', source: 'j:2026-11-26#3' }

test('an unreadable receipt refuses the write before anything is committed', async () => {
  const store = new FactStore(home, SCOPE, { clock })
  mkdirSync(paths.receiptsDir, { recursive: true })
  writeFileSync(paths.receipt('turn-1'), '{ broken')
  await expect(store.writer(TURN).put(fact)).rejects.toThrow(/receipt/)
  expect(existsSync(paths.fact('report-day'))).toBe(false)
  expect(readdirSync(paths.stateDir).filter(name => name.startsWith('fact-commit'))).toEqual([])
  if (existsSync(paths.manifest)) expect(ManifestSchema.parse(JSON.parse(readFileSync(paths.manifest, 'utf8'))).facts).toEqual({})
  // The store still reads, and another turn still writes.
  expect(await store.get('report-day')).toBeNull()
  expect((await store.writer({ turnId: 'turn-2' }).put(fact)).ok).toBe(true)
})

test('an unreadable commit intent is kept for repair, not deleted', async () => {
  const store = new FactStore(home, SCOPE, { clock })
  expect((await store.writer(TURN).put(fact)).ok).toBe(true)
  writeFileSync(join(paths.stateDir, 'fact-commit.json'), '{ half an intent')
  expect((await store.get('report-day'))?.id).toBe('report-day')
  const kept = readdirSync(paths.stateDir).filter(name => name.startsWith('fact-commit.unreadable'))
  expect(kept.length).toBe(1)
  expect(readFileSync(join(paths.stateDir, kept[0] ?? ''), 'utf8')).toBe('{ half an intent')
  expect(existsSync(join(paths.stateDir, 'fact-commit.json'))).toBe(false)
})

// ---------------------------------------------------------------- snapshot boundary

test('beginBoundary publishes the open boundary under the scope lock', async () => {
  const sessions = new FakeSessions()
  await sessions.register({ session_id: 's1', scope: SCOPE, role: 'owner', registered: clock.now().toISOString() })
  const config: BrainConfig = { enabled: true, summarizer: { ...DEFAULT_SUMMARIZER }, resume_reemit: false, problems: [] }
  const builder = createSnapshotBuilder({ brainHome: home, scope: SCOPE, facts: new FakeFacts(clock), recent: new FakeRecent(), summaries: new FakeSummaries(), sessions, clock, config: () => config })
  let pending: Promise<string> = Promise.resolve('')
  await withLock(paths.lockDir, async () => {
    pending = builder.beginBoundary('s1', 'clear')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(existsSync(paths.boundary('s1'))).toBe(false)
  })
  const boundary = await pending
  expect((await builder.openBoundary('s1'))?.boundary).toBe(boundary)
})
