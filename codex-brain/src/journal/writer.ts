// Level 0 writer (spec §5.3, D6): one JSONL file per UTC day, one appended line per status
// transition, `recent.md` refreshed after every write.
//
// - Text is redacted (`redactSecrets`) before it is written; nothing else is stored unredacted.
// - Every append runs under the scope lock (other processes: CLI, hooks) and an in-process mutex
//   keyed by the same lock directory, so lines never interleave and `n` is unique per day.
// - `bind` is idempotent by key: a retried bind (after a crash, or after UTC midnight) returns the
//   existing ref, so a retry completes the same exchange instead of starting a second one.
// - A transition line goes to the file of the exchange's ref, so a day folds on its own.

import { lockFor, type Mutex } from '../../../plugin/src/memory/_mutex.js'
import { redactSecrets } from '../../../plugin/src/safety/redact.js'
import {
  type BindInput, type Clock, type Day, formatJournalRef, type JournalLine, JournalLineSchema, type JournalRef,
  type JournalStatus, type JournalWriter, parseJournalRef, TimestampSchema,
} from '../contract.js'
import { appendLine } from '../store/atomic.js'
import { withLock } from '../store/lock.js'
import { ensureScope, type ScopePaths } from '../store/paths.js'
import { foldLines, readDayLines } from './fold.js'
import { RECENT_MAX_BYTES, refreshRecentLocked } from './recent.js'

/** Max length of a stored error (`JournalLineSchema.error`). */
const ERROR_MAX = 500
const DAY_MS = 24 * 60 * 60 * 1000

export interface JournalWriterOptions {
  /** Byte budget of `recent.md`; defaults to `RECENT_MAX_BYTES`. */
  recentMaxBytes?: number
  /** Scope-lock wait of one append; defaults to the hook budget `LOCK_TIMEOUT_MS`. */
  lockTimeoutMs?: number
}

const dayOf = (timestamp: string): Day => new Date(timestamp).toISOString().slice(0, 10)
const previousDay = (day: Day): Day => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
const redactError = (error: string): string => redactSecrets(error).slice(0, ERROR_MAX)

export class FileJournalWriter implements JournalWriter {
  private readonly mutex: Mutex
  private readonly recentMaxBytes: number
  private readonly lockTimeoutMs: number | undefined
  private ready = false

  constructor(private readonly paths: ScopePaths, private readonly clock: Clock, options: JournalWriterOptions = {}) {
    this.mutex = lockFor(paths.lockDir)
    this.recentMaxBytes = options.recentMaxBytes ?? RECENT_MAX_BYTES
    this.lockTimeoutMs = options.lockTimeoutMs
  }

  // Queues `fn` behind earlier calls of this process, then runs it and the recent refresh under
  // the scope lock. Enqueued synchronously, so `flush` waits for every call made before it.
  private write<T>(fn: () => T): Promise<T> {
    return this.mutex.run(async () => {
      if (!this.ready) {
        ensureScope(this.paths.brainHome, this.paths.scope)
        this.ready = true
      }
      return withLock(this.paths.lockDir, async () => {
        const result = fn()
        refreshRecentLocked(this.paths, this.clock.now(), this.recentMaxBytes)
        return result
      }, this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs })
    })
  }

  private append(day: Day, line: JournalLine): void {
    appendLine(this.paths.journal(day), JSON.stringify(JournalLineSchema.parse(line)))
  }

  private findKey(day: Day, key: string): JournalRef | null {
    // The day of the message and the day before: a retry after UTC midnight finds its exchange.
    for (const candidate of [day, previousDay(day)]) {
      const hit = readDayLines(this.paths, candidate).find(line => line.key === key)
      if (hit !== undefined) return formatJournalRef(candidate, hit.n)
    }
    return null
  }

  bind(input: BindInput): Promise<JournalRef> {
    const tsIn = TimestampSchema.parse(input.ts_in ?? this.clock.now().toISOString())
    const day = dayOf(tsIn)
    return this.write(() => {
      const existing = this.findKey(day, input.key)
      if (existing !== null) return existing
      const n = readDayLines(this.paths, day).reduce((max, line) => Math.max(max, line.n), 0) + 1
      const line: JournalLine = { n, key: input.key, origin: input.origin, status: 'bound', ts_in: tsIn, input_kind: input.input_kind }
      if (input.thread !== undefined) line.thread = input.thread
      if (input.turn !== undefined) line.turn = input.turn
      if (input.input !== undefined) line.input = redactSecrets(input.input)
      if (input.error !== undefined) line.error = redactError(input.error)
      this.append(day, line)
      return formatJournalRef(day, n)
    })
  }

  // Appends a transition of the exchange `ref`; `status` undefined keeps the folded status.
  private transition(ref: JournalRef, status: JournalStatus | undefined, extra: Partial<JournalLine>): Promise<void> {
    const parsed = parseJournalRef(ref)
    if (parsed === null) return Promise.reject(new Error(`invalid journal ref ${ref}`))
    return this.write(() => {
      const lines = readDayLines(this.paths, parsed.day)
      const first = lines.find(line => line.n === parsed.n)
      if (first === undefined) throw new Error(`unknown journal ref ${ref}`)
      const [current] = foldLines(parsed.day, lines.filter(line => line.key === first.key))
      const line: JournalLine = {
        n: first.n, key: first.key, origin: first.origin, status: status ?? current?.status ?? first.status,
        input_kind: first.input_kind, ...extra,
      }
      this.append(parsed.day, line)
    })
  }

  /** A `bound` line carrying `turn`; a late call after `answered` keeps the later status. */
  started(ref: JournalRef, turn: string): Promise<void> {
    return this.transition(ref, undefined, { turn })
  }

  answered(ref: JournalRef, reply: string): Promise<void> {
    return this.transition(ref, 'answered', { reply: redactSecrets(reply) })
  }

  delivered(ref: JournalRef): Promise<void> {
    return this.transition(ref, 'delivered', { ts_out: this.clock.now().toISOString() })
  }

  failed(ref: JournalRef, error?: string): Promise<void> {
    return this.transition(ref, 'failed', error === undefined ? {} : { error: redactError(error) })
  }

  cancelled(ref: JournalRef): Promise<void> {
    return this.transition(ref, 'cancelled', {})
  }

  /**
   * Every append is fsynced before its call resolves; flush waits for the calls this process
   * queued before it (PreCompact, spec §8.2).
   */
  flush(): Promise<void> {
    return this.mutex.run(async () => undefined)
  }
}
