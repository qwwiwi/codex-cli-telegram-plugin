// Level 1 (spec §9, A2): `recent.md` holds the newest whole exchanges of the journal within a
// byte budget; exchanges that no longer fit are evicted oldest first and queued in
// `state/evicted.jsonl` for the rolling summary (S4). Nothing leaves `recent.md` without a
// pending mark, and nothing is ever cut inside an entry.
//
// The window is computed from structured journal data, not by cutting rendered text: message
// text may contain lines that look like entry headers (`### ...`), so a text-level trim could
// split an entry there. The byte rule is the one of `plugin/src/memory/trim.ts`: drop whole
// entries from the top, keep a single oversized newest entry as it is.
//
// Eviction mark: every exchange at or before the mark has been queued. The mark is the newest
// ref in `state/evicted.jsonl` or in `state/recent.json`, whichever is later. The queue line is
// appended first, so a crash before `recent.json` moves loses nothing; `recent.json` keeps the
// mark when S4 compacts the queue after summarizing it.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { Mutex, lockFor } from '../../../plugin/src/memory/_mutex.js'
import {
  type Clock, type EvictedLine, EvictedLineSchema, type Exchange, formatRecentEntry, type JournalRef,
  JournalRefSchema, parseJournalRef, type RecentReader,
} from '../contract.js'
import { appendLine, writeFileAtomic } from '../store/atomic.js'
import { utf8Bytes } from '../store/estimate.js'
import { withLock } from '../store/lock.js'
import { ensureScope, type ScopePaths } from '../store/paths.js'
import { compareRefs, foldDay, journalDays } from './fold.js'
import { renderRecent } from './render.js'

/** Default byte budget of `recent.md`. */
export const RECENT_MAX_BYTES = 16 * 1024

const RecentStateSchema = z.object({ version: z.literal(1), after: JournalRefSchema.nullable() }).strict()

/** S1's private eviction mark, next to the queue. */
export function recentStatePath(paths: ScopePaths): string {
  return join(paths.stateDir, 'recent.json')
}

/** Valid lines of `state/evicted.jsonl`, in file order; unparsable lines are skipped. */
export function readEvicted(paths: ScopePaths): EvictedLine[] {
  if (!existsSync(paths.evicted)) return []
  const out: EvictedLine[] = []
  for (const raw of readFileSync(paths.evicted, 'utf8').split('\n')) {
    if (raw.trim() === '') continue
    try {
      const parsed = EvictedLineSchema.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    } catch { /* A torn line after a crash: skipped, the next line is intact. */ }
  }
  return out
}

function readStateMark(paths: ScopePaths): JournalRef | null {
  const file = recentStatePath(paths)
  if (!existsSync(file)) return null
  try {
    const parsed = RecentStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data.after : null
  } catch {
    return null
  }
}

/** Newest evicted ref, or null when nothing was evicted yet. */
export function evictionMark(paths: ScopePaths): JournalRef | null {
  let mark = readStateMark(paths)
  for (const line of readEvicted(paths)) {
    if (mark === null || compareRefs(line.ref, mark) > 0) mark = line.ref
  }
  return mark
}

export interface RecentPlan {
  /** What `recent.md` holds, oldest first. */
  held: Exchange[]
  /** Exchanges past the mark that no longer fit, oldest first; queued by `refreshRecentLocked`. */
  evict: Exchange[]
}

/** Read-only: the window after the eviction mark, cut to `maxBytes` on whole entries. */
export function planRecent(paths: ScopePaths, maxBytes: number): RecentPlan {
  const mark = evictionMark(paths)
  const markDay = mark === null ? null : parseJournalRef(mark)?.day ?? null
  const candidates: Exchange[] = []
  for (const day of journalDays(paths)) {
    if (markDay !== null && day < markDay) continue
    for (const exchange of foldDay(paths, day)) {
      if (mark === null || compareRefs(exchange.ref, mark) > 0) candidates.push(exchange)
    }
  }
  // Newest suffix whose joined bytes fit; the newest entry stays even when it alone is too big.
  let start = candidates.length
  let bytes = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    const entry = candidates[i]
    if (entry === undefined) break
    const size = utf8Bytes(formatRecentEntry(entry)) + (start === candidates.length ? 0 : 1)
    if (start < candidates.length && bytes + size > maxBytes) break
    bytes += size
    start = i
  }
  return { held: candidates.slice(start), evict: candidates.slice(0, start) }
}

/**
 * Queues evicted exchanges, moves the mark and rewrites `recent.md` when its bytes change.
 * The caller holds the scope lock and has created the scope layout.
 */
export function refreshRecentLocked(paths: ScopePaths, now: Date, maxBytes: number): RecentPlan {
  const plan = planRecent(paths, maxBytes)
  const at = now.toISOString()
  for (const exchange of plan.evict) {
    appendLine(paths.evicted, JSON.stringify(EvictedLineSchema.parse({ ref: exchange.ref, status: 'pending', at })))
  }
  const last = plan.evict.at(-1)
  if (last !== undefined) writeFileAtomic(recentStatePath(paths), `${JSON.stringify(RecentStateSchema.parse({ version: 1, after: last.ref }))}\n`)
  const text = renderRecent(plan.held)
  if (!existsSync(paths.recent) || readFileSync(paths.recent, 'utf8') !== text) writeFileAtomic(paths.recent, text)
  return plan
}

export interface RecentOptions {
  /** Byte budget of `recent.md`; defaults to `RECENT_MAX_BYTES`. */
  maxBytes?: number
}

/**
 * `recent.md` of one scope. The journal writer refreshes it after every write; `refresh` is for
 * callers that changed the queue or the budget. `exchanges` reads without the lock.
 */
export class FileRecent implements RecentReader {
  private readonly mutex: Mutex
  private readonly maxBytes: number

  constructor(private readonly paths: ScopePaths, private readonly clock: Clock, options: RecentOptions = {}) {
    this.mutex = lockFor(paths.lockDir)
    this.maxBytes = options.maxBytes ?? RECENT_MAX_BYTES
  }

  async exchanges(): Promise<Exchange[]> {
    return planRecent(this.paths, this.maxBytes).held
  }

  /** The eviction queue as S4 reads it. */
  async evicted(): Promise<EvictedLine[]> {
    return readEvicted(this.paths)
  }

  refresh(): Promise<RecentPlan> {
    return this.mutex.run(async () => {
      ensureScope(this.paths.brainHome, this.paths.scope)
      return withLock(this.paths.lockDir, async () => refreshRecentLocked(this.paths, this.clock.now(), this.maxBytes))
    })
  }
}
