// One journal day as the digest sees it: every archived revision of the day, then the plain file
// (spec §5.3 lines), folded by key. Reading the archived revisions too means a late delivery to an
// archived day is digested together with the rest of that day, never on its own.

import { existsSync, readdirSync } from 'node:fs'

import { type Day, DaySchema, type Exchange, ExchangeSchema, formatJournalRef, type JournalLine } from '../contract.js'
import type { ScopePaths } from '../store/paths.js'
import { readDayLinesStable } from '../journal/fold.js'
import { sha256 } from './archive.js'

export interface DayRead {
  day: Day
  /** Folded exchanges in `n` order. */
  exchanges: Exchange[]
  /** Hash of the folded day: the digest job key together with the day (D7). */
  inputHash: string
}

/** Days with a plain journal file, ascending. */
export function journalDays(paths: ScopePaths): Day[] {
  if (!existsSync(paths.journalDir)) return []
  return readdirSync(paths.journalDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
    .filter(day => DaySchema.safeParse(day).success)
    .sort()
}


/** Folds by key, the last value of each field winning, as the journal reader does (spec §5.3). */
export function foldLines(day: Day, lines: readonly JournalLine[]): Exchange[] {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const line of lines) byKey.set(line.key, { ...byKey.get(line.key), ...line })
  const exchanges: Exchange[] = []
  for (const value of byKey.values()) {
    const parsed = ExchangeSchema.safeParse({ ...value, ref: formatJournalRef(day, Number(value.n)) })
    if (parsed.success) exchanges.push(parsed.data)
  }
  return exchanges.sort((a, b) => a.n - b.n)
}

// Only the fields the digest reads, in a fixed order, so the hash does not depend on line layout.
function canonical(exchange: Exchange): unknown[] {
  return [exchange.ref, exchange.key, exchange.origin, exchange.status, exchange.input_kind, exchange.input ?? null, exchange.reply ?? null, exchange.error ?? null]
}

/** Reads and folds one day. Throws `ArchiveError` when the day's month archive cannot be read. */
export function readDay(paths: ScopePaths, day: Day): DayRead {
  // The journal's own archive-aware reader: one path for the writer, the reader and the digest.
  const exchanges = foldLines(day, readDayLinesStable(paths, day))
  return { day, exchanges, inputHash: sha256(JSON.stringify(exchanges.map(canonical))) }
}
