// Slice S4: level 3 archive (spec §9, D8): month tar.gz + sha256, plain journal files removed only
// after a read-back, a late delivery becomes a new day revision.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type Day, DigestSchema, formatJournalRef, type JournalLine, JournalLineSchema, type Summarizer,
} from '../../../codex-brain/src/contract.js'
import { archiveMonth, readArchive } from '../../../codex-brain/src/digest/archive.js'
import { readDay } from '../../../codex-brain/src/digest/day.js'
import { sealDays } from '../../../codex-brain/src/digest/seal.js'
import { packTar, unpackTar } from '../../../codex-brain/src/digest/tar.js'
import { appendLine } from '../../../codex-brain/src/store/atomic.js'
import { ensureScope, type ScopePaths } from '../../../codex-brain/src/store/paths.js'
import { DATA_BEGIN, DATA_END } from '../../../codex-brain/src/summary/prompt.js'
import { FakeProposals, FakeReceipts, fixedClock, ownerPassOnly, stubSummarizer } from './fakes.js'

const TODAY = '2026-11-26'
const OLD_A = '2026-08-03'
const OLD_B = '2026-08-04'
const RECENT = '2026-11-20'
const MONTH = '2026-08'

let dir = ''
let paths: ScopePaths
let clock: ReturnType<typeof fixedClock>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brain-archive-'))
  paths = ensureScope(join(dir, 'brain'), 'local')
  clock = fixedClock(`${TODAY}T08:00:00Z`)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

function writeDay(day: Day, count: number, from = 1): void {
  for (let n = from; n < from + count; n++) {
    const base = { n, key: `chat:${day}:${n}`, origin: 'owner-direct', input_kind: 'text' } as const
    const lines: JournalLine[] = [
      { ...base, status: 'bound', ts_in: `${day}T10:00:00Z`, input: `Сообщение ${n} за ${day}, токен [REDACTED]` },
      { ...base, status: 'answered', reply: `Ответ ${n}` },
    ]
    for (const line of lines) appendLine(paths.journal(day), JSON.stringify(JournalLineSchema.parse(line)))
  }
}

/** One digest line per exchange the prompt carries. */
function model(calls: string[] = []): Summarizer {
  return async (prompt: string) => {
    calls.push(prompt)
    const data = JSON.parse(prompt.slice(prompt.indexOf(DATA_BEGIN) + DATA_BEGIN.length, prompt.indexOf(DATA_END))) as { ref: string }[]
    return JSON.stringify({ lines: data.map(e => ({ text: 'Разговор о делах владельца', ref: e.ref })), proposals: [] })
  }
}

const deps = (summarizer: Summarizer, extra: object = {}) => ({
  paths, receipts: new FakeReceipts(), proposals: new FakeProposals(), summarizer: ownerPassOnly(summarizer), clock, ...extra,
})
const signal = (): AbortSignal => new AbortController().signal

test('days past retention with a verified digest are archived; the archive reproduces the redacted entries byte for byte', async () => {
  writeDay(OLD_A, 3)
  writeDay(OLD_B, 2)
  writeDay(RECENT, 1)
  const plain: Record<string, Buffer> = { [OLD_A]: readFileSync(paths.journal(OLD_A)), [OLD_B]: readFileSync(paths.journal(OLD_B)) }

  const report = await sealDays(deps(model()), signal())
  expect(report.errors).toEqual([])
  expect(report.sealed).toEqual([OLD_A, OLD_B, RECENT])
  expect(report.archived).toEqual([MONTH])

  // Checksum file in sha256sum format, matching the archive bytes.
  const archiveBytes = readFileSync(paths.archive(MONTH))
  expect(readFileSync(paths.archiveChecksum(MONTH), 'utf8')).toBe(`${sha(archiveBytes)}  ${MONTH}.tar.gz\n`)
  expect(statSync(paths.archive(MONTH)).mode & 0o777).toBe(0o600)

  const entries = readArchive(paths, MONTH)
  expect(entries.map(e => e.name)).toEqual([`${OLD_A}.jsonl`, `${OLD_B}.jsonl`])
  for (const entry of entries) {
    const day = entry.name.slice(0, 10)
    expect(sha(entry.data)).toBe(sha(plain[day] ?? ''))
  }
  expect(existsSync(paths.journal(OLD_A))).toBe(false)
  expect(existsSync(paths.journal(OLD_B))).toBe(false)
  expect(existsSync(paths.journal(RECENT))).toBe(true)
  // The digests stay readable after the plain files are gone.
  expect(DigestSchema.parse(JSON.parse(readFileSync(paths.digestMeta(OLD_A), 'utf8'))).lines).toHaveLength(3)
  expect(readDay(paths, OLD_A).exchanges).toHaveLength(3)

  // A second run has nothing to do and calls no model.
  const calls: string[] = []
  expect(await sealDays(deps(model(calls)), signal())).toEqual({ sealed: [], archived: [], errors: [] })
  expect(calls).toEqual([])
})

test('the archive is a standard tar.gz', async () => {
  writeDay(OLD_A, 1)
  await sealDays(deps(model()), signal())
  const tar = Bun.which('tar')
  if (tar === null) return
  const listed = spawnSync(tar, ['-tzf', paths.archive(MONTH)], { encoding: 'utf8' })
  expect(listed.status).toBe(0)
  expect(listed.stdout.trim().split('\n')).toEqual([`${OLD_A}.jsonl`])
})

test('a day without a verified digest is not archived', async () => {
  writeDay(OLD_A, 2)
  const report = await sealDays(deps(stubSummarizer([new Error('model down')])), signal())
  expect(report.archived).toEqual([])
  expect(report.errors).toHaveLength(1)
  expect(existsSync(paths.journal(OLD_A))).toBe(true)
  expect(existsSync(paths.archive(MONTH))).toBe(false)
})

test('plain files are removed only after the read-back: a corrupted archive keeps them', async () => {
  writeDay(OLD_A, 2)
  const before = readFileSync(paths.journal(OLD_A))
  const report = await sealDays(deps(model(), {
    archiveHooks: { beforeVerify: (path: string) => { writeFileSync(path, Buffer.from('not a gzip stream')) } },
  }), signal())
  expect(report.archived).toEqual([])
  expect(report.errors.join(' ')).toContain(MONTH)
  expect(readFileSync(paths.journal(OLD_A))).toEqual(before)
  expect(existsSync(paths.archiveChecksum(MONTH))).toBe(false)
})

test('a late delivery for an archived day creates a new day revision in the archive and in the digest', async () => {
  writeDay(OLD_A, 2)
  await sealDays(deps(model()), signal())
  const original = readArchive(paths, MONTH)
  expect(existsSync(paths.journal(OLD_A))).toBe(false)

  // The retry completes exchange 2 after the day was archived.
  const late: JournalLine = { n: 2, key: `chat:${OLD_A}:2`, origin: 'owner-direct', input_kind: 'text', status: 'delivered', ts_out: `${TODAY}T07:00:00Z` }
  appendLine(paths.journal(OLD_A), JSON.stringify(late))
  const lateBytes = readFileSync(paths.journal(OLD_A))

  // The day folds the archived revision and the late line together.
  const day = readDay(paths, OLD_A)
  expect(day.exchanges.map(e => [e.ref, e.status, e.input])).toEqual([
    [formatJournalRef(OLD_A, 1), 'answered', `Сообщение 1 за ${OLD_A}, токен [REDACTED]`],
    [formatJournalRef(OLD_A, 2), 'delivered', `Сообщение 2 за ${OLD_A}, токен [REDACTED]`],
  ])

  const report = await sealDays(deps(model()), signal())
  expect(report.sealed).toEqual([OLD_A])
  expect(report.archived).toEqual([MONTH])
  expect(DigestSchema.parse(JSON.parse(readFileSync(paths.digestMeta(OLD_A), 'utf8'))).revision).toBe(2)

  const entries = readArchive(paths, MONTH)
  expect(entries.map(e => e.name)).toEqual([`${OLD_A}.jsonl`, `${OLD_A}.r2.jsonl`])
  expect(sha(entries[0]?.data ?? new Uint8Array())).toBe(sha(original[0]?.data ?? new Uint8Array()))
  expect(sha(entries[1]?.data ?? new Uint8Array())).toBe(sha(lateBytes))
  expect(existsSync(paths.journal(OLD_A))).toBe(false)
})

test('a month archive whose checksum does not match is reported and left alone, with its days kept plain', async () => {
  writeDay(OLD_A, 1)
  await sealDays(deps(model()), signal())
  writeFileSync(paths.archiveChecksum(MONTH), `${'0'.repeat(64)}  ${MONTH}.tar.gz\n`)
  writeFileSync(paths.archive(MONTH), Buffer.from('corrupted'))
  writeDay(OLD_B, 1)
  const report = await sealDays(deps(model()), signal())
  // Earlier revisions of a day of that month cannot be read, so its days are neither sealed nor archived.
  expect(report.sealed).toEqual([])
  expect(report.archived).toEqual([])
  expect(readFileSync(paths.archive(MONTH), 'utf8')).toBe('corrupted')
  expect(report.errors.join(' ')).toContain(MONTH)
  expect(existsSync(paths.journal(OLD_B))).toBe(true)
})

test('two overlapping archive runs of one month never lose a day', async () => {
  writeDay(OLD_A, 1)
  writeDay(OLD_B, 1)
  const bytesA = readFileSync(paths.journal(OLD_A))
  const bytesB = readFileSync(paths.journal(OLD_B))
  // Run B started from the empty archive; run A archives OLD_A and removes its plain file meanwhile.
  const outer = archiveMonth(paths, MONTH, [OLD_B], {
    lockTimeoutMs: 1000,
    hooks: { beforeVerify: async () => { await archiveMonth(paths, MONTH, [OLD_A], { lockTimeoutMs: 1000 }) } },
  })
  await expect(outer).rejects.toThrow(MONTH)
  const names = readArchive(paths, MONTH).map(e => e.name)
  expect(names).toContain(`${OLD_A}.jsonl`)
  // OLD_B was not archived by the failed run, so its plain file stays; nothing is lost.
  expect(existsSync(paths.journal(OLD_B))).toBe(true)
  expect(readFileSync(paths.journal(OLD_B))).toEqual(bytesB)
  expect(sha(readArchive(paths, MONTH).find(e => e.name === `${OLD_A}.jsonl`)?.data ?? '')).toBe(sha(bytesA))
  // The next run adds it.
  await archiveMonth(paths, MONTH, [OLD_B], { lockTimeoutMs: 1000 })
  expect(readArchive(paths, MONTH).map(e => e.name)).toEqual([`${OLD_A}.jsonl`, `${OLD_B}.jsonl`])
  expect(existsSync(paths.journal(OLD_B))).toBe(false)
})

test('tar round trip keeps names and bytes', () => {
  const files = [{ name: 'a.jsonl', data: Buffer.from('{"x":1}\n') }, { name: 'b.jsonl', data: Buffer.alloc(1025, 7) }]
  const back = unpackTar(packTar(files))
  expect(back.map(f => f.name)).toEqual(['a.jsonl', 'b.jsonl'])
  expect(back.map(f => sha(f.data))).toEqual(files.map(f => sha(f.data)))
})

// ---------------------------------------------------------------- review fixes: coverage and checksum

test('a delivery appended while the digest model runs keeps its plain file and is sealed by the next run', async () => {
  writeDay(OLD_A, 2)
  const base = model()
  const racing: Summarizer = async (prompt, schema, abort) => {
    const late: JournalLine = { n: 2, key: `chat:${OLD_A}:2`, origin: 'owner-direct', input_kind: 'text', status: 'delivered', ts_out: `${TODAY}T07:00:00Z` }
    appendLine(paths.journal(OLD_A), JSON.stringify(late))
    return base(prompt, schema, abort)
  }
  await sealDays(deps(racing), signal())
  expect(existsSync(paths.journal(OLD_A))).toBe(true)
  const second = await sealDays(deps(model()), signal())
  expect(second.sealed).toEqual([OLD_A])
  const digest = DigestSchema.parse(JSON.parse(readFileSync(paths.digestMeta(OLD_A), 'utf8')))
  expect(digest.input_hash).toBe(readDay(paths, OLD_A).inputHash)
  expect(existsSync(paths.journal(OLD_A))).toBe(false)
})

test('a retry after a crash between the archive rename and the checksum write restores the checksum before unlinking', async () => {
  writeDay(OLD_A, 2)
  const bytes = readFileSync(paths.journal(OLD_A))
  await sealDays(deps(model()), signal())
  // The crash: archive renamed in place, checksum not yet written, plain file not yet removed.
  rmSync(paths.archiveChecksum(MONTH))
  writeFileSync(paths.journal(OLD_A), bytes)
  await archiveMonth(paths, MONTH, [OLD_A], { lockTimeoutMs: 1000 })
  expect(existsSync(paths.journal(OLD_A))).toBe(false)
  expect(readFileSync(paths.archiveChecksum(MONTH), 'utf8')).toBe(`${sha(readFileSync(paths.archive(MONTH)))}  ${MONTH}.tar.gz\n`)
})
