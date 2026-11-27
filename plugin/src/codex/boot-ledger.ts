// Boot ledger (docs/design/self-update-spec.md, S3 and S4): one record per bridge start in
// <state>/boot-ledger.json, so a restart loop is visible to the next start even when every
// process dies before it can log anything. Reads and writes fail open: a ledger problem must
// never stop the bridge from starting.
import { renameSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const MAX_BOOTS = 50
/** Two boots further apart than this do not belong to one restart chain (the Hermes rule). */
export const CHAIN_GAP_MS = 300_000
/** Uptime after the first getUpdates and the Codex handshake that marks a boot healthy. */
export const HEALTHY_UPTIME_MS = 120_000
const BACKOFF_WINDOW_MS = 120_000
const BACKOFF_FREE_BOOTS = 5

const BootSchema = z.object({
  at: z.number(),
  commit: z.string(),
  invocation: z.string(),
  planned: z.boolean(),
  healthyAt: z.number().optional(),
  exit: z.number().int().optional(),
  // The first boot after the owner's /restart in safe mode (S5).
  trial: z.boolean().optional(),
  // This boot ran in safe mode: stopping it does not end the chain, only the owner's /restart does.
  safe: z.boolean().optional(),
})
const LedgerSchema = z.object({
  v: z.literal(1),
  boots: z.array(BootSchema),
  clearedAt: z.number().optional(),
  // Set by /restart in safe mode: the next boot is a trial.
  trialNext: z.boolean().optional(),
  // `at` of the first boot of the chain the owner was already told about (one notice per chain).
  noticedChainAt: z.number().optional(),
})
/** Unhealthy boots in a chain that put the bridge into safe mode (S5). */
export const SAFE_MODE_CHAIN = 3
export type BootRecord = z.infer<typeof BootSchema>
export type LedgerState = z.infer<typeof LedgerSchema>

export function emptyLedger(): LedgerState {
  return { v: 1, boots: [] }
}

/**
 * Trailing boots without a health mark or a clean exit 0, each within CHAIN_GAP_MS of the next one.
 * A negative gap (clock moved backwards) keeps the chain; boots before clearedAt do not count.
 */
export function chainLength(state: LedgerState): number {
  let length = 0
  for (let i = state.boots.length - 1; i >= 0; i--) {
    const boot = state.boots[i]!
    // A healthy boot or an operator stop (exit 0) is not part of a crash loop; a stopped safe-mode boot still is.
    if (boot.healthyAt !== undefined || (boot.exit === 0 && !boot.safe)) break
    if (state.clearedAt !== undefined && boot.at <= state.clearedAt) break
    const next = state.boots[i + 1]
    if (next && next.at - boot.at > CHAIN_GAP_MS) break
    length++
  }
  return length
}

/** What /doctor shows of the ledger (S11). */
export interface BootSummary {
  /** Boots kept in the ledger (at most MAX_BOOTS). */
  boots: number
  /** Unhealthy boots in a row, the running one included. */
  chain: number
  /** The latest boot that recorded its exit code, with the time it started. */
  lastExit?: { code: number; at: number }
  /** The latest boot runs in safe mode. */
  safe: boolean
}

/** Reads <state>/boot-ledger.json for /doctor; a missing or corrupt ledger reads as empty. Never throws. */
export function readBootSummary(stateDir: string): BootSummary {
  let state = emptyLedger()
  try {
    const parsed = LedgerSchema.safeParse(JSON.parse(readFileSync(join(stateDir, 'boot-ledger.json'), 'utf8')))
    if (parsed.success) state = parsed.data
  } catch { /* missing or unreadable: nothing recorded */ }
  const exited = state.boots.findLast(boot => boot.exit !== undefined)
  return {
    boots: state.boots.length,
    chain: chainLength(state),
    ...(exited?.exit !== undefined ? { lastExit: { code: exited.exit, at: exited.at } } : {}),
    safe: state.boots.at(-1)?.safe === true,
  }
}

/** Delay before connecting when more than five boots fell into the last 120 s: min(300, 5·2^(n−5)) s. */
export function backoffDelayMs(bootsInWindow: number): number {
  if (bootsInWindow <= BACKOFF_FREE_BOOTS) return 0
  return Math.min(300, 5 * 2 ** (bootsInWindow - BACKOFF_FREE_BOOTS)) * 1000
}

export interface HealthMarkOptions {
  now?: () => number
  /** Schedules run after ms; returns a cancel function. */
  setTimer?: (run: () => void, ms: number) => () => void
}

/**
 * Healthy = the first successful getUpdates and the Codex handshake, then HEALTHY_UPTIME_MS of uptime
 * counted from bootAt. Calls mark once.
 */
export class HealthMark {
  private seenPoll = false
  private seenHandshake = false
  private cancelTimer: (() => void) | undefined
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => () => void

  constructor(private readonly mark: () => void, private readonly bootAt: number, options: HealthMarkOptions = {}) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  }

  polled(): void {
    this.seenPoll = true
    this.arm()
  }

  handshake(): void {
    this.seenHandshake = true
    this.arm()
  }

  cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  private arm(): void {
    if (!this.seenPoll || !this.seenHandshake || this.cancelTimer) return
    const wait = Math.max(0, this.bootAt + HEALTHY_UPTIME_MS - this.now())
    this.cancelTimer = this.setTimer(() => this.mark(), wait)
  }
}

export interface SafeModeEntry {
  /** chain: too many unhealthy boots in a row; trial: the boot after /restart did not get healthy. */
  reason: 'chain' | 'trial'
  chain: number
  /** The owner has not been told about this chain yet. */
  notify: boolean
}

export interface BootStart {
  /** Unhealthy boots in the current chain, this one included. */
  chain: number
  /** This start followed an exit 75 of the previous boot. */
  planned: boolean
  /** How long to wait before connecting (S4). */
  delayMs: number
}

export interface BootLedgerOptions {
  now?: () => number
  onError?: (error: unknown, action: string) => void
}

export class BootLedger {
  private readonly path: string
  private readonly now: () => number
  private readonly onError: (error: unknown, action: string) => void
  protected state: LedgerState = emptyLedger()
  private invocation: string | undefined

  constructor(stateDir: string, options: BootLedgerOptions = {}) {
    this.path = join(stateDir, 'boot-ledger.json')
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? (() => undefined)
  }

  /** Records this start and reports the chain it belongs to. */
  begin(boot: { commit: string; invocation: string }): BootStart {
    this.state = this.read()
    const now = this.now()
    const previous = this.state.boots.at(-1)
    const planned = previous?.exit === 75
    const record: BootRecord = { at: now, commit: boot.commit, invocation: boot.invocation, planned }
    if (this.state.trialNext) record.trial = true
    delete this.state.trialNext
    this.state.boots.push(record)
    this.state.boots = this.state.boots.slice(-MAX_BOOTS)
    this.invocation = boot.invocation
    this.write()
    const recent = this.state.boots.filter(record => now - record.at <= BACKOFF_WINDOW_MS).length
    return { chain: chainLength(this.state), planned, delayMs: backoffDelayMs(recent) }
  }

  /** Marks the current boot healthy (S3 health mark). */
  markHealthy(): void {
    const boot = this.current()
    if (!boot || boot.healthyAt !== undefined) return
    boot.healthyAt = this.now()
    this.write()
  }

  /** Records the exit code of the current boot when the process ends on its own. */
  recordExit(code: number): void {
    const boot = this.current()
    if (!boot) return
    boot.exit = code
    this.write()
  }

  /**
   * Whether this boot must run in safe mode (call after begin): a chain of SAFE_MODE_CHAIN unhealthy
   * boots, or the boot right after an unhealthy trial. notify is false when this chain was already announced.
   */
  safeMode(): SafeModeEntry | undefined {
    const chain = chainLength(this.state)
    const boots = this.state.boots
    const previous = boots.at(-2)
    // An operator's clean stop of the trial boot (exit 0) is not a failed trial.
    const trialFailed = previous?.trial === true && previous.healthyAt === undefined && previous.exit !== 0
    if (chain < SAFE_MODE_CHAIN && !trialFailed) return
    // chain is 0 only when the clock went back past clearedAt; the current boot then starts the chain.
    const chainStartedAt = (chain > 0 ? boots[boots.length - chain] : boots.at(-1))?.at ?? this.now()
    return { reason: trialFailed ? 'trial' : 'chain', chain, notify: this.state.noticedChainAt !== chainStartedAt }
  }

  /** Records that the owner was told about the current chain. */
  noticeSent(): void {
    const chain = chainLength(this.state)
    const start = chain > 0 ? this.state.boots[this.state.boots.length - chain] : this.state.boots.at(-1)
    if (!start) return
    this.state.noticedChainAt = start.at
    this.write()
  }

  /**
   * The previous boot ran healthy and then ended with an unplanned exit code (not 0, not 75); call after
   * begin. A boot without a recorded exit (kill, host reboot) is not counted, nor is a crash before the
   * health mark: that one belongs to a restart chain, which the safe-mode notice reports once.
   */
  previousCrashed(): boolean {
    const previous = this.state.boots.at(-2)
    return previous !== undefined && previous.healthyAt !== undefined && previous.exit !== undefined &&
      previous.exit !== 0 && previous.exit !== 75
  }

  /** Marks the current boot as a safe-mode boot. */
  markSafe(): void {
    const boot = this.current()
    if (!boot) return
    boot.safe = true
    this.write()
  }

  /** The owner's /restart in safe mode: earlier boots stop counting and the next boot is a trial. */
  clearForTrial(): void {
    this.state.clearedAt = this.now()
    this.state.trialNext = true
    this.write()
  }

  protected current(): BootRecord | undefined {
    return this.state.boots.findLast(boot => boot.invocation === this.invocation)
  }

  private read(): LedgerState {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error, 'read')
      return emptyLedger()
    }
    try {
      const parsed = LedgerSchema.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
    } catch { /* corrupt JSON: start over */ }
    this.onError(new Error('Boot ledger is corrupt; starting a new one'), 'parse')
    return emptyLedger()
  }

  protected write(): void {
    const temp = this.path + '.' + process.pid + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(this.state) + '\n', { mode: 0o600 })
      renameSync(temp, this.path)
    } catch (error) {
      this.onError(error, 'write')
    }
  }
}
