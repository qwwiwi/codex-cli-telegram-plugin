// Day sealing (spec §9 level 2, D7, D14): every finished UTC day with a plain journal file gets a
// digest of at most `DIGEST_MAX_LINES` lines built from the full day (an owner pass over trusted
// owner text and a reference pass over the rest, see summary/provenance.ts), each line with a journal ref
// of that day, plus reviewer proposals. Job key = day + input hash: a day whose input is unchanged
// is skipped without a model call. Any failure keeps the previous digest. Days past
// `ARCHIVE_RETENTION_DAYS` whose digest matches their input are then archived (archive.ts).
//
// Bounded work: one run makes at most `maxCalls` model calls (a day is digested whole or not at
// all, so a day that does not fit the rest of the budget waits for the next run; a day larger
// than the whole budget is skipped). A day whose digest failed `SEAL_MAX_ATTEMPTS` times with
// the same input is skipped until its input changes (`state/digest-attempts.json`).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import {
  ARCHIVE_RETENTION_DAYS, type Clock, type Day, type Digest, DIGEST_MAX_LINES, type DigestLine, DigestSchema,
  type Exchange, formatDigestLine, type JournalRef, type Month, type ProposalStore, PROVENANCE_VERSION,
  type ReceiptStore, type SealRunResult, type Summarizer,
} from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import type { ScopePaths } from '../store/paths.js'
import { DIGEST_OUTPUT_SCHEMA, ownerDigestPrompt, REFERENCE_OUTPUT_SCHEMA, referenceDigestPrompt } from '../summary/prompt.js'
import { addProposals, isProposalKind, type ProposalCandidate } from '../summary/proposals.js'
import { type Pass, passRefs, passTexts, planPasses, referenceSource } from '../summary/provenance.js'
import { readDigestMeta, readDigestRevision } from '../summary/reader.js'
import { JOB_LOCK_TIMEOUT_MS } from '../summary/rolling.js'
import { allowedRef, cleanLineText, isVerbatimFragment, parseModelJson } from '../summary/validate.js'
import { archiveMonth, type ArchiveHooks, monthOf } from './archive.js'
import { type DayRead, journalDays, readDay } from './day.js'

/** Token target of one digest prompt, rules included; a larger day or text is sent in several calls. */
export const DIGEST_CHUNK_TOKENS = 16_000
/** Model calls one seal run may make. */
export const SEAL_MAX_CALLS = 24
/** Failed digests of one day with the same input after which the day is skipped. */
export const SEAL_MAX_ATTEMPTS = 4

const ATTEMPTS_FILE = 'digest-attempts.json'
const AttemptsSchema = z.record(z.string(), z.object({ input_hash: z.string(), failures: z.number().int().min(1) }).strict())
type Attempts = z.infer<typeof AttemptsSchema>

export interface SealDeps {
  paths: ScopePaths
  receipts: ReceiptStore
  proposals: ProposalStore
  summarizer: Summarizer
  clock: Clock
  archiveHooks?: ArchiveHooks
  lockTimeoutMs?: number
  /** Model-call budget of one run; defaults to `SEAL_MAX_CALLS`. */
  maxCalls?: number
}

export interface SealReport extends SealRunResult {
  /** One line per day or month that failed; its previous state is kept. */
  errors: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (date: Date): Day => date.toISOString().slice(0, 10)

const DigestAnswerSchema = z.object({ lines: z.array(z.unknown()), proposals: z.array(z.unknown()).optional() }).passthrough()
const RawItemSchema = z.object({ kind: z.unknown().optional(), text: z.unknown(), ref: z.unknown() }).passthrough()

interface PassResult {
  lines: DigestLine[]
  proposals: ProposalCandidate[]
}

/**
 * Valid lines and proposals of one pass's answer. Provenance is decided here, from the pass and the
 * journal: an owner pass (trusted owner text only) gives owner lines and proposals; a reference
 * pass gives lines with the source of the cited exchange and never a proposal.
 */
function validatePass(raw: string, pass: Pass, byRef: ReadonlyMap<JournalRef, Exchange>, quota: number): PassResult {
  const answer = DigestAnswerSchema.safeParse(parseModelJson(raw))
  if (!answer.success) throw new Error('the model answer is not the digest JSON')
  const refs = passRefs(pass)
  const sources = passTexts(pass)
  const clean = (item: unknown): { text: string; exchange: Exchange; kind: unknown } | null => {
    const parsed = RawItemSchema.safeParse(item)
    if (!parsed.success) return null
    const text = cleanLineText(parsed.data.text)
    const ref = allowedRef(parsed.data.ref, refs)
    const exchange = ref === null ? undefined : byRef.get(ref)
    if (text === null || exchange === undefined || isVerbatimFragment(text, sources)) return null
    return { text, exchange, kind: parsed.data.kind }
  }
  const lines: DigestLine[] = []
  for (const item of answer.data.lines) {
    const line = clean(item)
    if (line === null) continue
    // A reference-only line keeps its provenance; HOT never shows it as the owner's.
    lines.push(pass.kind === 'owner' ? { text: line.text, ref: line.exchange.ref } : { text: line.text, ref: line.exchange.ref, source: referenceSource(line.exchange) })
  }
  if (answer.data.lines.length > 0 && lines.length === 0) throw new Error('no digest line passed validation')
  const proposals: ProposalCandidate[] = []
  // Proposals only from the owner pass; whatever a reference pass puts there is ignored.
  for (const item of pass.kind === 'owner' ? answer.data.proposals ?? [] : []) {
    const candidate = clean(item)
    if (candidate === null || typeof candidate.kind !== 'string' || !isProposalKind(candidate.kind)) continue
    proposals.push({ kind: candidate.kind, text: candidate.text, ref: candidate.exchange.ref, origin: candidate.exchange.origin })
  }
  // Whole lines beyond the quota are dropped; no text is cut.
  return { lines: lines.slice(0, quota), proposals }
}

function renderDigest(digest: Digest): string {
  const head = `# Digest ${digest.day} · revision ${digest.revision} · covered to ${digest.covered_to}\n`
  return `${head}${digest.lines.map(line => `${formatDigestLine(line)}\n`).join('')}`
}

function readAttempts(paths: ScopePaths): Attempts {
  const path = join(paths.stateDir, ATTEMPTS_FILE)
  if (!existsSync(path)) return {}
  try {
    const parsed = AttemptsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

async function updateAttempts(deps: SealDeps, day: Day, inputHash: string | null): Promise<void> {
  await withLock(deps.paths.lockDir, async () => {
    const attempts = readAttempts(deps.paths)
    const previous = attempts[day]
    if (inputHash === null) {
      if (previous === undefined) return
      delete attempts[day]
    } else {
      attempts[day] = { input_hash: inputHash, failures: previous?.input_hash === inputHash ? previous.failures + 1 : 1 }
    }
    writeFileAtomic(join(deps.paths.stateDir, ATTEMPTS_FILE), `${JSON.stringify(attempts)}\n`)
  }, { timeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS })
}

async function digestDay(deps: SealDeps, read: DayRead, passes: readonly Pass[], signal: AbortSignal): Promise<void> {
  const byRef = new Map<JournalRef, Exchange>(read.exchanges.map(exchange => [exchange.ref, exchange]))
  const count = { owner: passes.filter(pass => pass.kind === 'owner').length, reference: passes.filter(pass => pass.kind === 'reference').length }
  const seen = { owner: 0, reference: 0 }
  const lines: Record<Pass['kind'], DigestLine[]> = { owner: [], reference: [] }
  const candidates: ProposalCandidate[] = []
  for (const pass of passes) {
    const of = count[pass.kind]
    const quota = of === 1 ? DIGEST_MAX_LINES : Math.max(1, Math.floor(DIGEST_MAX_LINES / of))
    const part = { index: (seen[pass.kind] += 1), of }
    const owner = pass.kind === 'owner'
    const prompt = owner ? ownerDigestPrompt(read.day, pass.items, quota, part) : referenceDigestPrompt(read.day, pass.items, quota, part)
    const raw = await deps.summarizer(prompt, owner ? DIGEST_OUTPUT_SCHEMA : REFERENCE_OUTPUT_SCHEMA, signal)
    if (signal.aborted) throw new Error('cancelled')
    const result = validatePass(raw, pass, byRef, quota)
    lines[pass.kind].push(...result.lines)
    candidates.push(...result.proposals)
  }
  const last = read.exchanges.at(-1)
  if (last === undefined) throw new Error('the day has no exchange')
  const digest = DigestSchema.parse({
    day: read.day,
    // Counts on from a digest of an older provenance version too (the reader no longer returns it).
    revision: readDigestRevision(deps.paths, read.day) + 1,
    input_hash: read.inputHash,
    covered_to: last.ref,
    provenance: PROVENANCE_VERSION,
    // The owner's lines first; reference lines take what is left of the day's ten.
    lines: [...lines.owner, ...lines.reference].slice(0, DIGEST_MAX_LINES),
  })
  await withLock(deps.paths.lockDir, async () => {
    // A line appended while the model ran makes this digest describe a day that no longer exists.
    if (readDay(deps.paths, read.day).inputHash !== read.inputHash) throw new Error('the journal day changed while its digest was generated; retried next run')
    // Proposals before the digest files: content-derived ids make a retry harmless.
    await addProposals('reviewer', candidates, deps)
    // The .md is a rendered view; the .json is what readers trust, so it is written last.
    writeFileAtomic(deps.paths.digest(read.day), renderDigest(digest))
    writeFileAtomic(deps.paths.digestMeta(read.day), `${JSON.stringify(digest, null, 2)}\n`)
  }, { timeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS })
}

/** The published digest of `day` matches the day as it reads now (a late append makes it stale). */
function isCovered(paths: ScopePaths, day: Day): boolean {
  try {
    return readDigestMeta(paths, day)?.input_hash === readDay(paths, day).inputHash
  } catch {
    return false
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Seals every finished day that needs it, then archives days past retention. */
export async function sealDays(deps: SealDeps, signal: AbortSignal): Promise<SealReport> {
  const now = deps.clock.now()
  const today = utcDay(now)
  const report: SealReport = { sealed: [], archived: [], errors: [] }
  const verified: Day[] = []
  const budget = deps.maxCalls ?? SEAL_MAX_CALLS
  let calls = 0
  for (const day of journalDays(deps.paths)) {
    if (day >= today || signal.aborted) continue
    let started: DayRead | null = null
    try {
      const read = readDay(deps.paths, day)
      if (read.exchanges.length === 0) continue
      const previous = readDigestMeta(deps.paths, day)
      if (previous?.input_hash !== read.inputHash) {
        const failures = readAttempts(deps.paths)[day]
        if (failures !== undefined && failures.input_hash === read.inputHash && failures.failures >= SEAL_MAX_ATTEMPTS) {
          report.errors.push(`digest ${day}: skipped after ${SEAL_MAX_ATTEMPTS} failed attempts; new journal lines for the day retry it`)
          continue
        }
        // One call per pass; no prompt exceeds `DIGEST_CHUNK_TOKENS` (an oversized text goes in parts).
        const passes = planPasses(read.exchanges, DIGEST_CHUNK_TOKENS)
        if (passes.length > budget) {
          report.errors.push(`digest ${day}: skipped, needs ${passes.length} model calls, over the run budget of ${budget}`)
          continue
        }
        // Not enough budget left this run: the day waits for the next one (not an error).
        if (calls + passes.length > budget) continue
        calls += passes.length
        started = read
        await digestDay(deps, read, passes, signal)
        await updateAttempts(deps, day, null)
        report.sealed.push(day)
      }
      verified.push(day)
    } catch (error) {
      if (started !== null && !signal.aborted) await updateAttempts(deps, day, started.inputHash).catch(() => undefined)
      report.errors.push(`digest ${day}: ${message(error)}`)
    }
  }

  const cutoff = utcDay(new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * DAY_MS))
  const byMonth = new Map<Month, Day[]>()
  for (const day of verified) {
    if (day >= cutoff) continue
    byMonth.set(monthOf(day), [...byMonth.get(monthOf(day)) ?? [], day])
  }
  for (const [month, days] of byMonth) {
    if (signal.aborted) break
    try {
      await archiveMonth(deps.paths, month, days, {
        ...(deps.archiveHooks === undefined ? {} : { hooks: deps.archiveHooks }),
        lockTimeoutMs: deps.lockTimeoutMs ?? JOB_LOCK_TIMEOUT_MS,
        covered: day => isCovered(deps.paths, day),
      })
      report.archived.push(month)
    } catch (error) {
      report.errors.push(message(error))
    }
  }
  return report
}
