// Level 3 (spec §9, D8): journal days past retention move into `archive/<month>.tar.gz` with a
// `<month>.tar.gz.sha256` checksum (sha256sum format). A plain journal file is removed only after
// the new archive was read back and every entry matched, and only if the file did not change
// meanwhile. A day archived again (a late delivery appended to it later) becomes a new revision
// entry `<day>.r<k>.jsonl`; the earlier entries are never rewritten.
//
// Replacing an existing archive: the new one is written next to it, verified, and only then
// renamed over it; the checksum file is removed before the rename and rewritten after it, so a
// crash leaves either a matching checksum or none (a missing checksum is accepted when the gzip
// and tar structure read back cleanly, since gzip carries its own CRC). A plain file is never
// unlinked while the checksum is missing: a retry after such a crash restores it first.
//
// `covered(day)` (the digest of the day matches the day as it is now) is checked before a day is
// taken and again under the lock right before its plain file is removed, so a delivery appended
// while the digest was generated keeps its plain file and is digested by the next run.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

import { type Day, DaySchema, type Month } from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import type { ScopePaths } from '../store/paths.js'
import { packTar, type TarFile, unpackTar } from './tar.js'

export type ArchiveEntry = TarFile

export class ArchiveError extends Error {
  constructor(readonly month: Month, message: string) {
    super(`archive ${month}: ${message}`)
    this.name = 'ArchiveError'
  }
}

export interface ArchiveHooks {
  /** Test seam: runs after the new archive is written and before it is read back. */
  beforeVerify?: (path: string) => void | Promise<void>
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

export const monthOf = (day: Day): Month => day.slice(0, 7)

export function archiveEntryName(day: Day, revision: number): string {
  return revision === 1 ? `${day}.jsonl` : `${day}.r${revision}.jsonl`
}

export function parseArchiveEntryName(name: string): { day: Day; revision: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\.r([2-9]|[1-9]\d+))?\.jsonl$/.exec(name)
  if (!match?.[1] || !DaySchema.safeParse(match[1]).success) return null
  return { day: match[1], revision: match[2] === undefined ? 1 : Number(match[2]) }
}

function checksumLine(month: Month, digest: string): string {
  return `${digest}  ${month}.tar.gz\n`
}

function decode(month: Month, bytes: Uint8Array): ArchiveEntry[] {
  try {
    return unpackTar(gunzipSync(bytes))
  } catch (error) {
    throw new ArchiveError(month, `cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Entries of `archive/<month>.tar.gz` in archive order; [] when there is none. Throws
 * `ArchiveError` when the checksum file does not match or the archive cannot be decoded.
 */
export function readArchive(paths: ScopePaths, month: Month): ArchiveEntry[] {
  return loadArchive(paths, month).entries
}

/** Hash of the archive bytes on disk, or null when there is no archive. */
function archiveHash(paths: ScopePaths, month: Month): string | null {
  const path = paths.archive(month)
  return existsSync(path) ? sha256(readFileSync(path)) : null
}

function loadArchive(paths: ScopePaths, month: Month): { entries: ArchiveEntry[]; hash: string | null } {
  const path = paths.archive(month)
  if (!existsSync(path)) return { entries: [], hash: null }
  const bytes = readFileSync(path)
  const hash = sha256(bytes)
  const checksumPath = paths.archiveChecksum(month)
  if (existsSync(checksumPath) && readFileSync(checksumPath, 'utf8') !== checksumLine(month, hash)) {
    throw new ArchiveError(month, 'checksum does not match; left untouched for a manual check')
  }
  return { entries: decode(month, bytes), hash }
}

/** Archive entries of one day, ordered by revision. */
export function dayEntries(entries: readonly ArchiveEntry[], day: Day): ArchiveEntry[] {
  return entries
    .map(entry => ({ entry, parsed: parseArchiveEntryName(entry.name) }))
    .filter(item => item.parsed?.day === day)
    .sort((a, b) => (a.parsed?.revision ?? 0) - (b.parsed?.revision ?? 0))
    .map(item => item.entry)
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The folded content of journal bytes in order (by key, the last value of each field wins), as one
 * comparable string. Lines that do not parse are skipped, as the journal reader skips them.
 */
export function foldKey(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder()
  const byKey = new Map<string, Record<string, unknown>>()
  for (const chunk of chunks) {
    for (const raw of decoder.decode(chunk).split('\n')) {
      if (raw.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      if (typeof record.key !== 'string') continue
      byKey.set(record.key, { ...byKey.get(record.key), ...record })
    }
  }
  return JSON.stringify([...byKey.entries()].sort(byName).map(([key, record]) => [key, Object.entries(record).sort(byName)]))
}

/**
 * Moves the plain journal files of `days` (all in `month`) into the month archive. Throws
 * `ArchiveError` and keeps every plain file when anything fails before the read-back passed.
 *
 * The new archive is built and verified outside the store lock; the swap and the plain-file
 * removal run under it, and only if the archive is still the one this run started from. Another
 * run (bridge timer and `brain digest` at once) that replaced it meanwhile makes this run fail
 * with every plain file kept, instead of renaming an archive that lacks the other run's days.
 */
export interface ArchiveOptions {
  hooks?: ArchiveHooks
  lockTimeoutMs: number
  /** True when the day's published digest covers the day as it is now; a day that is not covered keeps its plain file. */
  covered?: (day: Day) => boolean
}

export async function archiveMonth(paths: ScopePaths, month: Month, days: readonly Day[], options: ArchiveOptions): Promise<void> {
  const covered = options.covered ?? ((): boolean => true)
  const { entries: existing, hash: startHash } = loadArchive(paths, month)
  const entries: ArchiveEntry[] = [...existing]
  const toRemove: { day: Day; hash: string }[] = []
  for (const day of days) {
    if (monthOf(day) !== month) throw new ArchiveError(month, `day ${day} belongs to another month`)
    const plain = paths.journal(day)
    if (!existsSync(plain)) continue
    const data = readFileSync(plain)
    const hash = sha256(data)
    if (!covered(day)) continue
    const earlier = dayEntries(existing, day)
    toRemove.push({ day, hash })
    // Already archived with these exact bytes (a crash after the archive, before the removal).
    // Only the latest revision counts: bytes equal to an earlier one (A, B, then A again) are new
    // lines of the day, and dropping them would let the archive fold return B.
    const latest = earlier.at(-1)
    if (latest !== undefined && sha256(latest.data) === hash) continue
    const revision = Math.max(0, ...earlier.map(entry => parseArchiveEntryName(entry.name)?.revision ?? 0)) + 1
    entries.push({ name: archiveEntryName(day, revision), data })
  }
  if (toRemove.length === 0) return

  const target = paths.archive(month)
  const staging = entries.length > existing.length ? `${target}.new-${process.pid}-${randomBytes(6).toString('hex')}` : null
  try {
    let written: Uint8Array | null = null
    if (staging !== null) {
      writeFileAtomic(staging, gzipSync(packTar(entries)))
      await options.hooks?.beforeVerify?.(staging)
      written = readFileSync(staging)
      const back = decode(month, written)
      const same = back.length === entries.length && back.every((entry, i) => entry.name === entries[i]?.name && sha256(entry.data) === sha256(entries[i]?.data ?? new Uint8Array()))
      if (!same) throw new ArchiveError(month, 'read-back does not match the journal files')
    }
    await withLock(paths.lockDir, async () => {
      if (archiveHash(paths, month) !== startHash) throw new ArchiveError(month, 'changed by another run meanwhile; plain files kept, retried next run')
      if (staging !== null && written !== null) {
        rmSync(paths.archiveChecksum(month), { force: true })
        renameSync(staging, target)
        writeFileAtomic(paths.archiveChecksum(month), checksumLine(month, sha256(written)))
      } else if (startHash !== null && !existsSync(paths.archiveChecksum(month))) {
        // A crash after an earlier rename left no checksum: the archive read back cleanly above.
        writeFileAtomic(paths.archiveChecksum(month), checksumLine(month, startHash))
      }
      // Remove a plain file only if it still holds the archived bytes: a late append keeps it.
      const kept: Day[] = []
      for (const { day, hash } of toRemove) {
        const plain = paths.journal(day)
        if (!existsSync(plain)) continue
        const data = readFileSync(plain)
        if (sha256(data) !== hash || !covered(day)) continue
        // The archive alone must fold to what the archive plus the plain file folds to.
        const archived = dayEntries(entries, day).map(entry => entry.data)
        if (foldKey(archived) !== foldKey([...archived, data])) {
          kept.push(day)
          continue
        }
        rmSync(plain)
      }
      if (kept.length > 0) throw new ArchiveError(month, `the archived fold of ${kept.join(', ')} differs from the journal; plain files kept`)
    }, { timeoutMs: options.lockTimeoutMs })
  } catch (error) {
    if (staging !== null) rmSync(staging, { force: true })
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError(month, error instanceof Error ? error.message : String(error))
  }
}
