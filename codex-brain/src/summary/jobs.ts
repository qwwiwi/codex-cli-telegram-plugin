// `BrainJobs` of one scope: the rolling summary and day sealing, started by the bridge off the turn
// path (slice plan S6). They make model calls, so no hook may ever run them (slice plan K5).

import { readBrainConfig } from '../config.js'
import type {
  BrainJobs, Clock, JournalReader, ProposalStore, ReceiptStore, SealRunResult, Summarizer, SummaryRunResult,
} from '../contract.js'
import { type ArchiveHooks } from '../digest/archive.js'
import { sealDays } from '../digest/seal.js'
import { ensureScope } from '../store/paths.js'
import { runRollingSummary } from './rolling.js'

export interface BrainJobsDeps {
  brainHome: string
  scope: string
  journal: JournalReader
  receipts: ReceiptStore
  proposals: ProposalStore
  summarizer: Summarizer
  clock: Clock
  archiveHooks?: ArchiveHooks
}

export interface BrainJobsWithErrors extends BrainJobs {
  /** Failures of the last `sealDays` run, one line each (days and months kept as they were). */
  lastSealErrors(): string[]
}

export function createBrainJobs(deps: BrainJobsDeps): BrainJobsWithErrors {
  let sealErrors: string[] = []
  // Brain switched off in config.json means no background work and no model call (spec §11).
  const enabled = (): boolean => readBrainConfig(deps.brainHome).enabled
  return {
    async summarize(signal: AbortSignal, force: boolean): Promise<SummaryRunResult> {
      if (!enabled()) return { summarized: 0, proposals: 0, queued: 0 }
      const paths = ensureScope(deps.brainHome, deps.scope)
      return runRollingSummary({ ...deps, paths }, signal, force)
    },
    async sealDays(signal: AbortSignal): Promise<SealRunResult> {
      sealErrors = []
      if (!enabled()) return { sealed: [], archived: [] }
      const paths = ensureScope(deps.brainHome, deps.scope)
      const report = await sealDays({ ...deps, paths }, signal)
      sealErrors = report.errors
      return { sealed: report.sealed, archived: report.archived }
    },
    lastSealErrors: () => [...sealErrors],
  }
}
