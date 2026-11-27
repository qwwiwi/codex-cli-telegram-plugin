// Rolling semantic summary (A2): exchanges S1 evicted from `recent.md` wait in
// `state/evicted.jsonl` and are summarized in batches of `SUMMARY_BATCH` (or all of them when a
// boundary forces it) into `recent-summary.md` lines, each with the journal ref of its exchange.
//
// Provenance (provenance.ts): a batch is summarized by an owner pass over trusted owner text only,
// which alone gives owner-kind lines and proposals, and a reference pass over replies and text not
// typed by the owner, whose lines carry their source as their kind.
//
// Nothing is lost: a batch stays `pending` until its lines are published; a model failure leaves
// it queued and the next run retries the same refs. The model call runs outside the store lock
// (lock.ts: never a model call under the lock); only the publish step takes it.
//
// Bounded work: a run handles only the refs queued when it started, at most `ROLLING_MAX_CALLS`
// model calls. A failed attempt is recorded (`failed`); a ref whose batch failed
// `ROLLING_MAX_ATTEMPTS` times is retried alone, and a failure alone at that count skips it for
// good. No prompt exceeds `ROLLING_MAX_PROMPT_TOKENS`: an exchange too large for one prompt is
// summarized alone, in parts; one that needs more calls than a whole run may make is skipped
// without a call. Skipped exchanges stay readable in the journal.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import {
  type Clock, estimateTokens, EvictedLineSchema, type Exchange, formatSummaryLine, type JournalReader, type JournalRef,
  isReferenceKind, parseSummaryLine, type ProposalStore, type ReceiptStore, SUMMARY_BATCH, SUMMARY_VERSION_LINE, type Summarizer,
  type SummaryLine, SummaryKindSchema, type SummaryRunResult,
} from '../contract.js'
import { appendLine, writeFileAtomic } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import type { ScopePaths } from '../store/paths.js'
import { ownerSummaryPrompt, REFERENCE_OUTPUT_SCHEMA, referenceSummaryPrompt, SUMMARY_OUTPUT_SCHEMA } from './prompt.js'
import { addProposals, isProposalKind, type ProposalCandidate } from './proposals.js'
import { type Pass, passRefs, passTexts, planPasses, PROMPT_OVERHEAD_TOKENS, referenceSource } from './provenance.js'
import { isVersionedSummary, readSummaryLines } from './reader.js'
import { allowedRef, cleanLineText, isVerbatimFragment, parseModelJson } from './validate.js'

/** Lock wait of the background jobs: longer than a hook's, they are off the turn path. */
export const JOB_LOCK_TIMEOUT_MS = 10_000

/** Model calls one rolling-summary run may make. */
export const ROLLING_MAX_CALLS = 10
/** Lone failed attempts after which an evicted exchange is skipped. */
export const ROLLING_MAX_ATTEMPTS = 3
/** Token target of one prompt, rules included; a larger text is sent in parts. */
export const ROLLING_MAX_PROMPT_TOKENS = 16_000
/** Where a `recent-summary.md` of an older provenance version is kept, next to the live file. */
export const SUMMARY_QUARANTINE_FILE = 'recent-summary.quarantine.md'

export interface RollingSummaryDeps {
  paths: ScopePaths
  journal: JournalReader
  receipts: ReceiptStore
  proposals: ProposalStore
  summarizer: Summarizer
  clock: Clock
  lockTimeoutMs?: number
}

/**
 * Refs whose last status in `evicted.jsonl` is `pending`, in queue order. A ref evicted again after
 * it was summarized joins the end of the queue. Torn or invalid lines are skipped.
 */
export function readEvictedQueue(path: string): JournalRef[] {
  return [...readEvictedState(path)].filter(([, s]) => s.status === 'pending').map(([ref]) => ref)
}

interface QueueState {
  status: 'pending' | 'summarized' | 'skipped'
  /** Failed attempts since the ref was (re)queued. */
  failures: number
}

/** Last state of every ref in `evicted.jsonl`, in queue order (a re-queued ref moves to the end). */
export function readEvictedState(path: string): Map<JournalRef, QueueState> {
  const state = new Map<JournalRef, QueueState>()
  if (!existsSync(path)) return state
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    const line = EvictedLineSchema.safeParse(value)
    if (!line.success) continue
    const ref = line.data.ref
    const current = state.get(ref)
    if (line.data.status === 'pending') {
      if (current?.status === 'pending') continue
      state.delete(ref)
      state.set(ref, { status: 'pending', failures: 0 })
    } else if (line.data.status === 'failed') {
      if (current?.status === 'pending') current.failures += 1
    } else if (current !== undefined) current.status = line.data.status
    else state.set(ref, { status: line.data.status, failures: 0 })
  }
  return state
}

const ModelAnswerSchema = z.object({ lines: z.array(z.unknown()) }).passthrough()
const RawLineSchema = z.object({ kind: z.unknown().optional(), text: z.unknown(), ref: z.unknown() }).passthrough()

/**
 * Valid lines of one pass's answer; null when the answer is unusable (the batch stays queued).
 * The kind of a line is decided here: an owner kind only in the owner pass, whose data is trusted
 * owner text alone; in the reference pass the source of the cited exchange, from the journal.
 */
function validatePass(raw: string, pass: Pass, byRef: ReadonlyMap<JournalRef, Exchange>): SummaryLine[] | null {
  const answer = ModelAnswerSchema.safeParse(parseModelJson(raw))
  if (!answer.success) return null
  const refs = passRefs(pass)
  const sources = passTexts(pass)
  const lines: SummaryLine[] = []
  for (const item of answer.data.lines) {
    const line = RawLineSchema.safeParse(item)
    if (!line.success) continue
    const text = cleanLineText(line.data.text)
    const ref = allowedRef(line.data.ref, refs)
    const exchange = ref === null ? undefined : byRef.get(ref)
    if (text === null || ref === null || exchange === undefined || isVerbatimFragment(text, sources)) continue
    if (pass.kind === 'reference') {
      lines.push({ kind: referenceSource(exchange), text, ref })
      continue
    }
    const kind = SummaryKindSchema.safeParse(line.data.kind)
    if (!kind.success || isReferenceKind(kind.data)) continue
    lines.push({ kind: kind.data, text, ref })
  }
  // Lines were offered but none survived: treat as a failure rather than publish nothing.
  if (answer.data.lines.length > 0 && lines.length === 0) return null
  return lines
}

interface BatchOutcome {
  proposals: number
}

async function summarizeBatch(deps: RollingSummaryDeps, batch: readonly JournalRef[], exchanges: readonly Exchange[], passes: readonly Pass[], signal: AbortSignal): Promise<BatchOutcome | null> {
  const byRef = new Map(exchanges.map(exchange => [exchange.ref, exchange]))
  const lines: SummaryLine[] = []
  const candidates: ProposalCandidate[] = []
  for (const pass of passes) {
    const owner = pass.kind === 'owner'
    let raw: string
    try {
      raw = await deps.summarizer(owner ? ownerSummaryPrompt(pass.items) : referenceSummaryPrompt(pass.items), owner ? SUMMARY_OUTPUT_SCHEMA : REFERENCE_OUTPUT_SCHEMA, signal)
    } catch {
      return null
    }
    if (signal.aborted) return null
    const valid = validatePass(raw, pass, byRef)
    if (valid === null) return null
    lines.push(...valid)
    // Proposals only from the owner pass.
    if (!owner) continue
    for (const line of valid) {
      const origin = byRef.get(line.ref)?.origin
      if (isProposalKind(line.kind)) candidates.push({ kind: line.kind, text: line.text, ref: line.ref, ...(origin === undefined ? {} : { origin }) })
    }
  }

  // Proposals first: their ids are content-derived, so a crash before publishing only repeats them.
  const proposals = await addProposals('summarizer', candidates, deps)

  const batchRefs = new Set(batch)
  await withLock(deps.paths.lockDir, async () => {
    quarantineLegacySummaryLocked(deps)
    // Replace any earlier lines of these refs (a retry after a crash), keep the rest in order.
    const kept = readSummaryLines(deps.paths.recentSummary).filter(line => !batchRefs.has(line.ref))
    const text = [...kept, ...lines].map(line => `${formatSummaryLine(line)}\n`).join('')
    writeFileAtomic(deps.paths.recentSummary, `${SUMMARY_VERSION_LINE}\n${text}`)
    const at = deps.clock.now().toISOString()
    for (const ref of batch) appendLine(deps.paths.evicted, JSON.stringify(EvictedLineSchema.parse({ ref, status: 'summarized', at })))
  }, { timeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS })
  return { proposals }
}

/**
 * A `recent-summary.md` without the provenance version line was written under the old rules (a
 * line's provenance could follow the model's citation). The caller holds the scope lock: the file
 * is moved to `SUMMARY_QUARANTINE_FILE` (appended when one exists) and every ref it summarized is
 * queued again, so its lines are regenerated by the two passes.
 */
function quarantineLegacySummaryLocked(deps: RollingSummaryDeps): void {
  const path = deps.paths.recentSummary
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  if (isVersionedSummary(text)) return
  const quarantine = join(dirname(path), SUMMARY_QUARANTINE_FILE)
  writeFileAtomic(quarantine, `${existsSync(quarantine) ? readFileSync(quarantine, 'utf8') : ''}${text}`)
  const state = readEvictedState(deps.paths.evicted)
  const at = deps.clock.now().toISOString()
  const refs = new Set(text.split('\n').map(parseSummaryLine).filter((line): line is SummaryLine => line !== null).map(line => line.ref))
  for (const ref of refs) {
    if (state.get(ref)?.status !== 'pending') appendLine(deps.paths.evicted, JSON.stringify(EvictedLineSchema.parse({ ref, status: 'pending', at })))
  }
  rmSync(path)
}

async function mark(deps: RollingSummaryDeps, refs: readonly JournalRef[], status: 'failed' | 'skipped', reason: string): Promise<void> {
  if (refs.length === 0) return
  await withLock(deps.paths.lockDir, async () => {
    const at = deps.clock.now().toISOString()
    for (const ref of refs) appendLine(deps.paths.evicted, JSON.stringify(EvictedLineSchema.parse({ ref, status, at, reason })))
  }, { timeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS })
}

const exchangeTokens = (exchange: Exchange): number => estimateTokens(JSON.stringify([exchange.input ?? '', exchange.reply ?? '', exchange.error ?? '']))

/**
 * Summarizes full batches of the evictions queued at the start; with `force` (a session boundary)
 * also the last partial batch. Stops at the first failed batch, which stays queued for the next run.
 */
export async function runRollingSummary(deps: RollingSummaryDeps, signal: AbortSignal, force: boolean): Promise<SummaryRunResult> {
  if (existsSync(deps.paths.recentSummary) && !isVersionedSummary(readFileSync(deps.paths.recentSummary, 'utf8'))) {
    await withLock(deps.paths.lockDir, async () => quarantineLegacySummaryLocked(deps), { timeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS })
  }
  const backlog = new Set(readEvictedQueue(deps.paths.evicted))
  const result: SummaryRunResult = { summarized: 0, proposals: 0, queued: backlog.size }
  const batchTokens = ROLLING_MAX_PROMPT_TOKENS - PROMPT_OVERHEAD_TOKENS
  let calls = 0
  while (!signal.aborted && calls < ROLLING_MAX_CALLS) {
    const state = readEvictedState(deps.paths.evicted)
    const queue = [...state].filter(([ref, s]) => s.status === 'pending' && backlog.has(ref))
    if (!(queue.length >= SUMMARY_BATCH || (force && queue.length > 0))) break
    const [head] = queue
    // A ref whose batch failed `ROLLING_MAX_ATTEMPTS` times goes alone, so one bad exchange
    // cannot hold a whole batch hostage; a transient outage still retries the whole batch.
    const candidates = head !== undefined && head[1].failures >= ROLLING_MAX_ATTEMPTS ? [head] : queue.slice(0, SUMMARY_BATCH)

    const batch: JournalRef[] = []
    const exchanges: Exchange[] = []
    const missing: JournalRef[] = []
    let tokens = 0
    let failed = false
    for (const [ref] of candidates) {
      let exchange: Exchange | null
      try {
        exchange = await deps.journal.get(ref)
      } catch {
        failed = true // An unreadable archive: retried later, never marked done unread.
        break
      }
      // A null lookup is never "done": the ref stays queued for a later run (see below).
      if (exchange === null) {
        missing.push(ref)
        continue
      }
      const size = exchangeTokens(exchange)
      if (exchanges.length > 0 && tokens + size > batchTokens) break
      tokens += size
      batch.push(ref)
      exchanges.push(exchange)
      // Larger than one prompt: it goes alone and its text is sent in parts.
      if (size > batchTokens) break
    }
    // Not found now: a failed attempt, retried by a later run; given up only after
    // `ROLLING_MAX_ATTEMPTS` runs, as `skipped` with the reason, never as `summarized`.
    for (const ref of missing) {
      backlog.delete(ref)
      await mark(deps, [ref], 'failed', 'not found in the journal')
      if ((state.get(ref)?.failures ?? 0) + 1 >= ROLLING_MAX_ATTEMPTS) {
        await mark(deps, [ref], 'skipped', `not found in the journal ${ROLLING_MAX_ATTEMPTS} times`)
        result.skipped = (result.skipped ?? 0) + 1
      }
    }
    if (failed) break
    if (batch.length === 0) continue

    const passes = planPasses(exchanges, ROLLING_MAX_PROMPT_TOKENS)
    if (passes.length > ROLLING_MAX_CALLS) {
      // Only a lone oversized exchange needs more calls than a whole run may make.
      await mark(deps, batch, 'skipped', 'oversized')
      result.skipped = (result.skipped ?? 0) + batch.length
      continue
    }
    // Not enough of the call budget left: the batch waits for the next run.
    if (calls + passes.length > ROLLING_MAX_CALLS) break
    calls += passes.length
    const outcome = await summarizeBatch(deps, batch, exchanges, passes, signal)
    if (outcome === null) {
      if (signal.aborted) break
      await mark(deps, batch, 'failed', 'model call failed or its answer was rejected')
      const alone = batch.length === 1 && batch[0] !== undefined ? batch[0] : null
      if (alone !== null && (head?.[1].failures ?? 0) + 1 >= ROLLING_MAX_ATTEMPTS && head?.[0] === alone) {
        await mark(deps, [alone], 'skipped', `rejected ${ROLLING_MAX_ATTEMPTS} times`)
        result.skipped = (result.skipped ?? 0) + 1
      }
      break
    }
    result.summarized += batch.length
    result.proposals += outcome.proposals
  }
  result.queued = readEvictedQueue(deps.paths.evicted).length
  return result
}
