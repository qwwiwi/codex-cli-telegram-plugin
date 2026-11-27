// Owner restart notices: «Перезапускаю мост…» before a planned stop, «Мост снова на связи…» once the
// next boot polls Telegram. The stop time and the last measured restart durations live in
// <state>/restart-timings.json, so the next process can measure the restart and the next stop can
// name a typical duration. Everything fails open: a notice problem never delays or blocks a restart.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import type { RestartIntent } from './restart-intent.js'

/** Measured restarts kept for the median. */
export const RESTART_HISTORY = 10
/** The longest wait for Telegram before the process may exit. */
export const STOP_NOTICE_WAIT_MS = 3_000
/** A stop longer than this (the service was stopped by hand, the host was off) is not a typical restart. */
const MAX_SAMPLE_MS = 600_000

const FileSchema = z.object({
  v: z.literal(1),
  stoppedAt: z.number().optional(),
  durations: z.array(z.number()).default([]),
})
type TimingsFile = z.infer<typeof FileSchema>

export interface RestartNoticeDeps {
  stateDir: string
  /** Sends to the owner chat; the signal aborts a send still waiting for the rate budget. */
  send: (text: string, signal: AbortSignal) => Promise<unknown>
  now?: () => number
  waitMs?: number
  onError?: (error: unknown, action: string) => void
}

/** «около N секунд»: genitive after «около». */
function secondsGenitive(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'секунды' : 'секунд'
}

/** «занял N секунд»: accusative. */
function secondsAccusative(n: number): string {
  const ten = n % 10
  const hundred = n % 100
  if (ten === 1 && hundred !== 11) return 'секунду'
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'секунды'
  return 'секунд'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const toSeconds = (ms: number) => Math.max(1, Math.round(ms / 1000))

export class RestartNotices {
  private readonly path: string
  private readonly now: () => number
  private readonly onError: (error: unknown, action: string) => void
  private stopNotice: Promise<void> | undefined
  /** What this boot reports once the bridge is back: the stop it follows, or a crash. */
  private pending: { kind: 'restart'; stoppedAt: number } | { kind: 'crash' } | undefined

  constructor(private readonly deps: RestartNoticeDeps) {
    this.path = join(deps.stateDir, 'restart-timings.json')
    this.now = deps.now ?? Date.now
    this.onError = deps.onError ?? (() => undefined)
  }

  /**
   * Call once per boot, right after the boot ledger: takes the recorded stop off disk (one notice per
   * stop, even if this boot dies early). Safe mode reports nothing: its own notice covers the restart loop.
   */
  boot(state: { crashed: boolean; safe: boolean }): void {
    const file = this.read()
    const stoppedAt = file.stoppedAt
    if (stoppedAt !== undefined) {
      delete file.stoppedAt
      // Still on disk: the next boot would report the same stop again, so this one stays silent.
      if (!this.write(file)) return
    }
    if (state.safe) return
    if (stoppedAt !== undefined) this.pending = { kind: 'restart', stoppedAt }
    else if (state.crashed) this.pending = { kind: 'crash' }
  }

  /**
   * Before a planned stop: records the stop time, then tells the owner in one message. Resolves once
   * Telegram answered or after the bounded wait; never rejects. Sends once per process. An agent-requested
   * restart opens the message with «Итоговый ответ доставлен.»: the bridge sends no separate notice for it.
   */
  stopping(kind?: RestartIntent['kind']): Promise<void> {
    this.stopNotice ??= this.sendStop(kind === 'agent' ? 'Итоговый ответ доставлен. ' : '')
    return this.stopNotice
  }

  /** After the bridge is back and polled Telegram: the measured restart or the crash notice, once. */
  async back(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    let text = 'Мост перезапустился после сбоя'
    if (pending.kind === 'restart') {
      const took = this.now() - pending.stoppedAt
      if (took >= 0 && took <= MAX_SAMPLE_MS) {
        const file = this.read()
        file.durations = [...file.durations, took].slice(-RESTART_HISTORY)
        this.write(file)
      }
      const seconds = toSeconds(Math.max(0, took))
      text = `Мост снова на связи. Перезапуск занял ${seconds} ${secondsAccusative(seconds)}`
    }
    await this.deps.send(text, new AbortController().signal).catch((error: unknown) => this.onError(error, 'send'))
  }

  private async sendStop(lead: string): Promise<void> {
    const file = this.read()
    file.stoppedAt = this.now()
    this.write(file)
    let text = lead + 'Перезапускаю мост.'
    if (file.durations.length > 0) {
      const seconds = toSeconds(median(file.durations))
      text = `${lead}Перезапускаю мост. Обычно это занимает около ${seconds} ${secondsGenitive(seconds)}`
    }
    await this.sendBounded(text, 'Stop notice not sent within the wait')
  }

  /**
   * The owner's acknowledgement of a committed restart (/restart in safe mode, an installed /update, a
   * rollback): the same bounded, cancelled send as the stop notice, so a silent Telegram never holds the
   * restart. Resolves once Telegram answered or after the bounded wait; never rejects.
   */
  acknowledge(text: string): Promise<void> {
    return this.sendBounded(text, 'Restart acknowledgement not sent within the wait')
  }

  /** Sends and waits at most waitMs; then aborts the send, which cancels it wherever it is. */
  private async sendBounded(text: string, timeoutMessage: string): Promise<void> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        abort.abort()
        this.onError(new Error(timeoutMessage), 'timeout')
        resolve()
      }, this.deps.waitMs ?? STOP_NOTICE_WAIT_MS)
    })
    const sent = this.deps.send(text, abort.signal).then(() => undefined, (error: unknown) => this.onError(error, 'send'))
    await Promise.race([sent, timeout])
    clearTimeout(timer)
  }

  private read(): TimingsFile {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error, 'read')
      return { v: 1, durations: [] }
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
    } catch { /* corrupt JSON: start over */ }
    this.onError(new Error('Restart timings file is corrupt; starting a new one'), 'parse')
    return { v: 1, durations: [] }
  }

  /** True once the new content replaced the file; false (reported) when the write or the rename failed. */
  private write(file: TimingsFile): boolean {
    const temp = this.path + '.' + process.pid + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(file) + '\n', { mode: 0o600 })
      renameSync(temp, this.path)
      return true
    } catch (error) {
      this.onError(error, 'write')
      return false
    }
  }
}
