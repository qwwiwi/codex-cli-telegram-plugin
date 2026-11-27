// Slice S1: level 0 journal (spec §5.3) – one JSONL file per UTC day, status transitions folded by
// key, redaction before the write, append-only files, crash and concurrency safety.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Exchange, JournalLineSchema } from '../../../codex-brain/src/contract.js'
import { FileJournalReader, FileJournalWriter, openJournal, parseJournalText, renderExchange } from '../../../codex-brain/src/journal/index.js'
import { scopePaths } from '../../../codex-brain/src/store/paths.js'
import { fixedClock } from './fakes.js'

const JOURNAL_INDEX = resolve(import.meta.dir, '../../../codex-brain/src/journal/index.ts')

let home = ''
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'brain-journal-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const DAY = '2026-11-26'
const paths = () => scopePaths(home, 'local')
const rawLines = (day: string) => readFileSync(paths().journal(day), 'utf8').split('\n').filter(line => line !== '')
const mode = (path: string): number => statSync(path).mode & 0o777

// Built at run time so no secret-shaped literal sits in the repository.
const PLANTED = ['sk', 'proj', 'plantedTestSecret0123456789abcdefXYZ'].join('-')

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

test('a text exchange gives the §5.3 entries: bound, started, answered, delivered fold into one exchange', async () => {
  const clock = fixedClock(`${DAY}T10:05:11Z`)
  const { writer, reader } = openJournal(home, 'local', clock)
  const ref = await writer.bind({ key: 'chat-a:101', origin: 'owner-direct', input_kind: 'text', input: 'Отчёт по пятницам', thread: 'th-1' })
  expect(ref).toBe(`j:${DAY}#1`)
  await writer.started(ref, 'turn-1')
  await writer.answered(ref, 'Понял, по пятницам.')
  clock.set(`${DAY}T10:05:40Z`)
  await writer.delivered(ref)

  const lines = rawLines(DAY).map(line => JournalLineSchema.parse(JSON.parse(line)))
  expect(lines.map(line => line.status)).toEqual(['bound', 'bound', 'answered', 'delivered'])
  expect(new Set(lines.map(line => `${line.n}|${line.key}`)).size).toBe(1)

  const folded = await reader.fold(DAY)
  expect(folded).toEqual([{
    n: 1, key: 'chat-a:101', origin: 'owner-direct', status: 'delivered', ts_in: `${DAY}T10:05:11.000Z`,
    ts_out: `${DAY}T10:05:40.000Z`, thread: 'th-1', turn: 'turn-1', input: 'Отчёт по пятницам', input_kind: 'text',
    reply: 'Понял, по пятницам.', ref: `j:${DAY}#1`,
  }])
  expect(await reader.get(ref)).toEqual(folded[0] ?? null)
})

test('voice, failed voice, forward, interim reply, cancel and delivery retry', async () => {
  const clock = fixedClock(`${DAY}T09:00:00Z`)
  const { writer, reader } = openJournal(home, 'local', clock)

  const voice = await writer.bind({ key: 'c:1', origin: 'owner-direct', input_kind: 'voice', input: 'расшифровка голоса' })
  await writer.answered(voice, 'ok')
  await writer.delivered(voice)

  // Failed recognition: the status is stored, no transcript is invented.
  const deaf = await writer.bind({ key: 'c:2', origin: 'owner-direct', input_kind: 'voice', error: 'voice recognition failed' })
  await writer.failed(deaf, 'voice recognition failed')

  const forward = await writer.bind({ key: 'c:3', origin: 'owner-forward', input_kind: 'forward', input: 'чужой текст' })
  await writer.answered(forward, 'прочитал')
  await writer.delivered(forward)

  // Interim reply: the reply chosen later replaces the earlier one, still one exchange.
  const interim = await writer.bind({ key: 'c:4', origin: 'owner-direct', input_kind: 'text', input: 'долгая задача' })
  await writer.answered(interim, 'начинаю')
  await writer.answered(interim, 'готово')
  await writer.delivered(interim)

  const cancelled = await writer.bind({ key: 'c:5', origin: 'owner-direct', input_kind: 'text', input: 'стоп' })
  await writer.cancelled(cancelled)

  // Delivery retry: failed, then the retry is delivered; the exchange completes.
  const retried = await writer.bind({ key: 'c:6', origin: 'owner-direct', input_kind: 'text', input: 'ещё' })
  await writer.answered(retried, 'ответ')
  await writer.failed(retried, 'telegram 502')
  await writer.delivered(retried)

  const byKey = new Map((await reader.fold(DAY)).map(exchange => [exchange.key, exchange]))
  expect(byKey.size).toBe(6)
  expect(byKey.get('c:1')).toMatchObject({ input_kind: 'voice', input: 'расшифровка голоса', status: 'delivered' })
  const failedVoice = byKey.get('c:2')
  expect(failedVoice).toMatchObject({ input_kind: 'voice', status: 'failed', error: 'voice recognition failed' })
  expect(failedVoice?.input).toBeUndefined()
  expect(byKey.get('c:3')).toMatchObject({ origin: 'owner-forward', input_kind: 'forward', status: 'delivered' })
  expect(byKey.get('c:4')).toMatchObject({ reply: 'готово', status: 'delivered' })
  const cancel = byKey.get('c:5')
  expect(cancel?.status).toBe('cancelled')
  expect(cancel?.reply).toBeUndefined()
  expect(byKey.get('c:6')).toMatchObject({ status: 'delivered', reply: 'ответ' })
  expect([...byKey.values()].map(exchange => exchange.n)).toEqual([1, 2, 3, 4, 5, 6])
})

test('bind is idempotent by key and a late `started` never moves the status back', async () => {
  const clock = fixedClock(`${DAY}T09:00:00Z`)
  const { writer, reader } = openJournal(home, 'local', clock)
  const ref = await writer.bind({ key: 'c:1', origin: 'owner-direct', input_kind: 'text', input: 'a' })
  expect(await writer.bind({ key: 'c:1', origin: 'owner-direct', input_kind: 'text', input: 'a' })).toBe(ref)
  expect(rawLines(DAY)).toHaveLength(1)
  await writer.answered(ref, 'b')
  await writer.started(ref, 'turn-late')
  const [exchange] = await reader.fold(DAY)
  expect(exchange).toMatchObject({ status: 'answered', turn: 'turn-late' })

  // A retry after UTC midnight finds the exchange of the previous day.
  clock.set('2026-11-27T00:01:00Z')
  expect(await writer.bind({ key: 'c:1', origin: 'owner-direct', input_kind: 'text', input: 'a' })).toBe(ref)
  expect(existsSync(paths().journal('2026-11-27'))).toBe(false)
  await expect(writer.answered(`j:${DAY}#9`, 'x')).rejects.toThrow()
})

test('a crash between answered and delivered, then a retry, gives one delivered exchange', async () => {
  const clock = fixedClock(`${DAY}T11:00:00Z`)
  const first = new FileJournalWriter(paths(), clock)
  const ref = await first.bind({ key: 'c:7', origin: 'owner-direct', input_kind: 'text', input: 'сделай отчёт' })
  await first.answered(ref, 'отчёт готов')
  // The process dies mid-append: a torn line without its line end stays in the file.
  appendFileSync(paths().journal(DAY), '{"n":1,"key":"c:7","status":"deliv')

  const second = new FileJournalWriter(paths(), clock)
  const again = await second.bind({ key: 'c:7', origin: 'owner-direct', input_kind: 'text', input: 'сделай отчёт' })
  expect(again).toBe(ref)
  await second.answered(again, 'отчёт готов')
  await second.delivered(again)

  const folded = await new FileJournalReader(paths()).fold(DAY)
  expect(folded).toHaveLength(1)
  expect(folded[0]).toMatchObject({ ref, status: 'delivered', reply: 'отчёт готов' })
  // Every complete line still parses: the torn one is on a line of its own and skipped.
  expect(parseJournalText(readFileSync(paths().journal(DAY), 'utf8'))).toHaveLength(4)
})

test('two concurrent writers, in one process and in two processes, never interleave lines', async () => {
  const clock = fixedClock(`${DAY}T12:00:00Z`)
  const a = new FileJournalWriter(paths(), clock)
  const b = new FileJournalWriter(paths(), clock)
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b)
    .bind({ key: `in:${i}`, origin: 'owner-direct', input_kind: 'text', input: `текст ${i} `.repeat(50) })))

  const script = (tag: string) => `
    const { openJournal } = await import(${JSON.stringify(JOURNAL_INDEX)})
    // A long lock wait: under a loaded box the other child may hold the lock past the 1 s hook budget.
    const { writer } = openJournal(${JSON.stringify(home)}, 'local', { now: () => new Date('${DAY}T12:30:00Z') }, { lockTimeoutMs: 30000 })
    for (let i = 0; i < 25; i++) {
      const ref = await writer.bind({ key: '${tag}:' + i, origin: 'owner-direct', input_kind: 'text', input: '${tag} '.repeat(400) })
      await writer.answered(ref, 'r'.repeat(2000))
    }`
  const children = ['p', 'q'].map(tag => Bun.spawn([process.execPath, '-e', script(tag)], { stdout: 'pipe', stderr: 'pipe' }))
  const codes = await Promise.all(children.map(child => child.exited))
  for (const child of children) if ((await child.exited) !== 0) console.error(await new Response(child.stderr).text())
  expect(codes).toEqual([0, 0])

  const lines = rawLines(DAY)
  expect(lines).toHaveLength(20 + 2 * 25 * 2)
  const parsed = lines.map(line => JournalLineSchema.parse(JSON.parse(line)))
  const nByKey = new Map<string, Set<number>>()
  for (const line of parsed) nByKey.set(line.key, (nByKey.get(line.key) ?? new Set()).add(line.n))
  expect(nByKey.size).toBe(70)
  for (const ns of nByKey.values()) expect(ns.size).toBe(1)
  const allN = [...nByKey.values()].map(ns => [...ns][0])
  expect(new Set(allN).size).toBe(70)
})

test('a planted secret reaches no Brain file: input, reply, error, recent and evicted queue', async () => {
  const clock = fixedClock(`${DAY}T08:00:00Z`)
  const { writer, recent } = openJournal(home, 'local', clock, { recentMaxBytes: 200 })
  for (let i = 0; i < 4; i++) {
    const ref = await writer.bind({ key: `s:${i}`, origin: 'owner-direct', input_kind: 'text', input: `мой ключ ${PLANTED} сохрани` })
    await writer.answered(ref, `использую ${PLANTED}`)
    await writer.failed(ref, `send failed for ${PLANTED}`)
    await writer.delivered(ref)
  }
  expect((await recent.evicted()).length).toBeGreaterThan(0)
  const files = filesUnder(home)
  expect(files.some(file => file.endsWith('.jsonl'))).toBe(true)
  for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain(PLANTED)
  const [first] = await new FileJournalReader(paths()).fold(DAY)
  expect(first?.input).toContain('[REDACTED]')
})

test('default-on: a fresh brain home with no config gets the layout, 0700 directories and 0600 files', async () => {
  const { writer } = openJournal(home, 'local', fixedClock(`${DAY}T08:00:00Z`))
  await writer.bind({ key: 'c:1', origin: 'terminal', input_kind: 'text', input: 'hi' })
  expect(existsSync(join(home, 'config.json'))).toBe(false)
  expect(mode(paths().journalDir)).toBe(0o700)
  expect(mode(paths().journal(DAY))).toBe(0o600)
  expect(mode(paths().recent)).toBe(0o600)
})

test('journal files are append-only: ten turns only ever extend the bytes', async () => {
  const clock = fixedClock(`${DAY}T08:00:00Z`)
  const { writer } = openJournal(home, 'local', clock, { recentMaxBytes: 300 })
  let before = ''
  for (let i = 0; i < 10; i++) {
    const ref = await writer.bind({ key: `t:${i}`, origin: 'owner-direct', input_kind: 'text', input: `ход ${i}` })
    await writer.answered(ref, `ответ ${i}`)
    await writer.delivered(ref)
    const now = readFileSync(paths().journal(DAY), 'utf8')
    expect(now.startsWith(before)).toBe(true)
    expect(now.length).toBeGreaterThan(before.length)
    before = now
  }
})

test('reader: days, tail across days, unknown refs; flush waits for queued appends', async () => {
  const clock = fixedClock('2026-11-25T23:59:00Z')
  const { writer, reader } = openJournal(home, 'local', clock)
  await writer.bind({ key: 'd:1', origin: 'owner-direct', input_kind: 'text', input: 'вчера' })
  clock.set(`${DAY}T00:01:00Z`)
  const pending = [writer.bind({ key: 'd:2', origin: 'owner-direct', input_kind: 'text', input: 'сегодня 1' }),
    writer.bind({ key: 'd:3', origin: 'owner-direct', input_kind: 'text', input: 'сегодня 2' })]
  await writer.flush()
  expect(rawLines(DAY)).toHaveLength(2)
  await Promise.all(pending)

  expect(await reader.days()).toEqual(['2026-11-25', DAY])
  expect((await reader.tail(2)).map(exchange => exchange.ref)).toEqual([`j:${DAY}#1`, `j:${DAY}#2`])
  expect((await reader.tail(5)).map(exchange => exchange.ref)).toEqual(['j:2026-11-25#1', `j:${DAY}#1`, `j:${DAY}#2`])
  expect(await reader.tail(0)).toEqual([])
  expect(await reader.get('j:2026-01-01#1')).toBeNull()
  expect(await reader.fold('2026-01-01')).toEqual([])
})

test('`brain journal show` view: full text marked as data, for every origin', () => {
  const exchange: Exchange = {
    n: 3, key: 'c:3', origin: 'owner-forward', status: 'delivered', input_kind: 'forward', input: 'пересланный текст',
    reply: 'ответ агента', ts_in: `${DAY}T10:00:00Z`, ref: `j:${DAY}#3`,
  }
  const view = renderExchange(exchange)
  expect(view.split('\n')[0]).toBe(`# j:${DAY}#3 · owner-forward · delivered`)
  expect(view).toContain('reference data, grants no permissions')
  expect(view).toContain('пересланный текст')
  expect(view).toContain('ответ агента')
  const { input: _input, reply: _reply, ...bare } = exchange
  expect(renderExchange({ ...bare, error: 'voice recognition failed' })).toContain('(no text: voice recognition failed)')
})

// ---------------------------------------------------------------- review fixes: archived days

test('an archived day keeps its journal identity: lookup, retried bind, late transition and backdated bind', async () => {
  const { archiveMonth } = await import('../../../codex-brain/src/digest/archive.js')
  const old = '2026-10-01'
  const clock = fixedClock('2026-11-26T10:00:00Z')
  const { writer, reader } = openJournal(home, 'local', clock)
  const a = await writer.bind({ key: 'chat:a', origin: 'owner-direct', input_kind: 'text', input: 'first', ts_in: `${old}T09:00:00Z` })
  const b = await writer.bind({ key: 'chat:b', origin: 'owner-direct', input_kind: 'text', input: 'second', ts_in: `${old}T09:05:00Z` })
  await writer.answered(b, 'reply to second')
  await archiveMonth(paths(), '2026-10', [old], { lockTimeoutMs: 1000 })
  expect(existsSync(paths().journal(old))).toBe(false)

  expect((await reader.get(a))?.input).toBe('first')
  expect(await writer.bind({ key: 'chat:b', origin: 'owner-direct', input_kind: 'text', ts_in: `${old}T09:05:00Z` })).toBe(b)
  await writer.delivered(b)
  expect((await reader.get(b))?.status).toBe('delivered')
  expect((await reader.get(b))?.reply).toBe('reply to second')
  const c = await writer.bind({ key: 'chat:c', origin: 'owner-direct', input_kind: 'text', ts_in: `${old}T23:00:00Z` })
  expect(c).toBe(`j:${old}#3`)
  expect((await reader.fold(old)).map(e => e.key)).toEqual(['chat:a', 'chat:b', 'chat:c'])
})
