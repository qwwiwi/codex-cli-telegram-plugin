// Journal and recent (slice S1): level 0 `journal/<day>.jsonl`, level 1 `recent.md` and the
// eviction queue `state/evicted.jsonl` for the rolling summary.

import type { Clock } from '../contract.js'
import { scopePaths, type ScopePaths } from '../store/paths.js'
import { FileJournalReader } from './fold.js'
import { FileRecent, type RecentOptions } from './recent.js'
import { FileJournalWriter, type JournalWriterOptions } from './writer.js'

export { compareRefs, FileJournalReader, foldDay, foldLines, journalDays, parseJournalText, readDayLines } from './fold.js'
export {
  evictionMark, FileRecent, isPublicExchange, planRecent, PUBLIC_KEY_SEGMENT, readEvicted, RECENT_MAX_BYTES,
  type RecentOptions, type RecentPlan,
  recentStatePath, refreshRecentLocked,
} from './recent.js'
export { renderExchange, renderRecent } from './render.js'
export { FileJournalWriter, type JournalWriterOptions } from './writer.js'

export interface Journal {
  paths: ScopePaths
  writer: FileJournalWriter
  reader: FileJournalReader
  recent: FileRecent
}

/** Writer, reader and recent of one scope, sharing one `recent.md` budget. No setup needed. */
export function openJournal(brainHome: string, scope: string, clock: Clock, options: JournalWriterOptions = {}): Journal {
  const paths = scopePaths(brainHome, scope)
  const recentOptions: RecentOptions = {}
  if (options.recentMaxBytes !== undefined) recentOptions.maxBytes = options.recentMaxBytes
  return {
    paths,
    writer: new FileJournalWriter(paths, clock, options),
    reader: new FileJournalReader(paths),
    recent: new FileRecent(paths, clock, recentOptions),
  }
}
