// File-backed `SummaryReader`: `recent-summary.md` and `digest/<day>.json` as S4 publishes them.
// Only validated content is returned; a broken line or file is skipped.

import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { type Day, type Digest, DigestSchema, DaySchema, parseSummaryLine, SUMMARY_VERSION_LINE, type SummaryLine, type SummaryReader } from '../contract.js'
import type { ScopePaths } from '../store/paths.js'

/** True when `recent-summary.md` text starts with the current provenance version line. */
export const isVersionedSummary = (text: string): boolean => text.split('\n', 1)[0] === SUMMARY_VERSION_LINE

/**
 * Revision stored in `digest/<day>.json`, also of a digest the reader no longer accepts (an older
 * provenance version), so a regenerated digest keeps counting up; 0 when there is none.
 */
export function readDigestRevision(paths: ScopePaths, day: Day): number {
  try {
    const raw = JSON.parse(readFileSync(paths.digestMeta(day), 'utf8')) as { revision?: unknown } | null
    return typeof raw?.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 0
  } catch {
    return 0
  }
}

/** Parsed lines of `recent-summary.md`, oldest first; invalid lines are skipped. */
export function readSummaryLines(path: string): SummaryLine[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  // A file without the version line predates the two-pass provenance rules: nothing of it is
  // emitted; the next rolling run quarantines it and regenerates its lines (rolling.ts).
  if (!isVersionedSummary(text)) return []
  const lines: SummaryLine[] = []
  for (const raw of text.split('\n')) {
    const line = parseSummaryLine(raw)
    if (line !== null) lines.push(line)
  }
  return lines
}

/** The published digest of `day`, or null when it is missing or invalid. */
export function readDigestMeta(paths: ScopePaths, day: Day): Digest | null {
  const path = paths.digestMeta(day)
  if (!existsSync(path)) return null
  try {
    const parsed = DigestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success && parsed.data.day === day ? parsed.data : null
  } catch {
    return null
  }
}

export class FileSummaryReader implements SummaryReader {
  constructor(private readonly paths: ScopePaths) {}

  async summary(): Promise<SummaryLine[]> {
    return readSummaryLines(this.paths.recentSummary)
  }

  async digest(day: Day): Promise<Digest | null> {
    return readDigestMeta(this.paths, day)
  }

  async digestDays(): Promise<Day[]> {
    if (!existsSync(this.paths.digestDir)) return []
    return readdirSync(this.paths.digestDir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(day => DaySchema.safeParse(day).success && readDigestMeta(this.paths, day) !== null)
      .sort()
  }
}
