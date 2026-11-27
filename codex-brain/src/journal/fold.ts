// Level 0 reader (spec §5.3): `journal/<day>.jsonl` holds one line per status transition; the
// reader folds lines by `key` (the last value of each field wins) into one exchange per key.
//
// A line that does not parse (a torn append after a crash, a hand edit) is skipped: the store's
// `appendLine` puts it on a line of its own, so the lines around it stay intact.
//
// A day past retention lives in `archive/<month>.tar.gz` (digest/archive.ts), possibly followed by
// a new plain file for a late append. `readDayLines` reads both, so lookup, folding and `n`
// allocation keep one identity per exchange after archiving. Archiving removes the plain file
// under the scope lock the writer appends under, so a reader under that lock never sees a gap.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

import {
  type Day, DaySchema, type Exchange, ExchangeSchema, formatJournalRef, type JournalLine, JournalLineSchema,
  type JournalReader, type JournalRef, parseJournalRef,
} from '../contract.js'
import { dayEntries, monthOf, readArchive } from '../digest/archive.js'
import type { ScopePaths } from '../store/paths.js'

/** The valid journal lines of `text`, in file order; unparsable lines are skipped. */
export function parseJournalText(text: string): JournalLine[] {
  const lines: JournalLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = JournalLineSchema.safeParse(value)
    if (parsed.success) lines.push(parsed.data)
  }
  return lines
}

/** Folds the lines of one day by key, in `n` order. The ref comes from the first line of a key. */
export function foldLines(day: Day, lines: readonly JournalLine[]): Exchange[] {
  const byKey = new Map<string, Exchange>()
  for (const line of lines) {
    const previous = byKey.get(line.key)
    const ref = previous?.ref ?? formatJournalRef(day, line.n)
    const n = previous?.n ?? line.n
    byKey.set(line.key, ExchangeSchema.parse({ ...previous, ...line, n, ref }))
  }
  return [...byKey.values()].sort((a, b) => a.n - b.n)
}

/** Journal order: day, then exchange number. */
export function compareRefs(a: JournalRef, b: JournalRef): number {
  const left = parseJournalRef(a)
  const right = parseJournalRef(b)
  if (left === null || right === null) throw new Error(`invalid journal ref ${left === null ? a : b}`)
  if (left.day !== right.day) return left.day < right.day ? -1 : 1
  return left.n - right.n
}

/**
 * Raw lines of one day: every archived revision of the day, then the plain file; [] when the day
 * has neither. Throws `ArchiveError` when the day's month archive cannot be read: the identity of
 * that day's exchanges is unknown, so nothing may be bound or appended against a partial view.
 */
export function readDayLines(paths: ScopePaths, day: Day, hooks: JournalReadHooks = {}): JournalLine[] {
  const lines: JournalLine[] = []
  if (existsSync(paths.archive(monthOf(day)))) {
    const decoder = new TextDecoder()
    for (const entry of dayEntries(readArchive(paths, monthOf(day)), day)) lines.push(...parseJournalText(decoder.decode(entry.data)))
  }
  hooks.afterArchiveRead?.()
  const file = paths.journal(day)
  if (existsSync(file)) lines.push(...parseJournalText(readFileSync(file, 'utf8')))
  return lines
}

export interface JournalReadHooks {
  /** Test seam: runs between the archive read and the plain-file read of one day. */
  afterArchiveRead?: () => void
}

/** Reads of one day a lockless reader retries when the month archive changed under it. */
export const STABLE_READ_ATTEMPTS = 5

// Identity of the month archive file: archiving renames a new file over it, so it changes.
function archiveIdentity(paths: ScopePaths, day: Day): string {
  const stat = statSync(paths.archive(monthOf(day)), { throwIfNoEntry: false })
  return stat === undefined ? 'none' : `${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

/**
 * `readDayLines` for a reader that does not hold the scope lock. Archiving swaps the month archive
 * and unlinks the plain file under the lock; a read that straddles the swap could see neither copy
 * of a day. The read is repeated until the archive was the same file before and after it, so the
 * result is one consistent view. Read errors propagate if the archive is unchanged. Throws when
 * the archive never settles: a partial day is never returned.
 */
export function readDayLinesStable(paths: ScopePaths, day: Day, hooks: JournalReadHooks = {}): JournalLine[] {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
    const before = archiveIdentity(paths, day)
    let lines: JournalLine[]
    try {
      lines = readDayLines(paths, day, hooks)
    } catch (error) {
      if (archiveIdentity(paths, day) === before) throw error
      continue
    }
    if (archiveIdentity(paths, day) === before) return lines
  }
  throw new Error(`journal day ${day} kept changing during the read; try again`)
}

/** Folds one day from a consistent lockless view (see `readDayLinesStable`). */
export function foldDay(paths: ScopePaths, day: Day, hooks: JournalReadHooks = {}): Exchange[] {
  return foldLines(day, readDayLinesStable(paths, day, hooks))
}

/** Days that have a plain journal file, ascending (archived days are reached through `readDayLines`). */
export function journalDays(paths: ScopePaths): Day[] {
  if (!existsSync(paths.journalDir)) return []
  const days: Day[] = []
  for (const name of readdirSync(paths.journalDir)) {
    if (!name.endsWith('.jsonl')) continue
    const day = name.slice(0, -'.jsonl'.length)
    if (DaySchema.safeParse(day).success) days.push(day)
  }
  return days.sort()
}

/**
 * Journal reader of one scope. Reads take no lock: every line is appended whole, and a read that
 * overlaps an archive replacement is repeated (`readDayLinesStable`).
 */
export class FileJournalReader implements JournalReader {
  constructor(private readonly paths: ScopePaths, private readonly hooks: JournalReadHooks = {}) {}

  async fold(day: Day): Promise<Exchange[]> {
    return foldDay(this.paths, DaySchema.parse(day), this.hooks)
  }

  async tail(n: number): Promise<Exchange[]> {
    if (n <= 0) return []
    const out: Exchange[] = []
    const days = journalDays(this.paths)
    for (let i = days.length - 1; i >= 0 && out.length < n; i--) {
      const day = days[i]
      if (day !== undefined) out.unshift(...foldDay(this.paths, day, this.hooks))
    }
    return out.slice(-n)
  }

  async get(ref: JournalRef): Promise<Exchange | null> {
    const parsed = parseJournalRef(ref)
    if (parsed === null) return null
    return foldDay(this.paths, parsed.day, this.hooks).find(exchange => exchange.n === parsed.n) ?? null
  }

  async days(): Promise<Day[]> {
    return journalDays(this.paths)
  }
}
