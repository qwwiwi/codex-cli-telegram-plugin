// Codex account rate limits for the pinned context HUD: one line such as
// «Лимиты Codex: потрачено за неделю 36% · за 5ч 12% (сброс 01.12 00:30 МСК)».
//
// The HUD renders synchronously and must never wait on (or fail because of)
// the App Server, so the limits come from a small cache: the HUD reads the last
// known line and a stale cache refreshes itself in the background. A failed
// read keeps the last known value (or no line at all) and is retried only after
// the cache lifetime, never on every HUD refresh.

import { object } from '../codex/rpc.js'

export interface CodexLimitWindow {
  // Used share of the window, rounded percent (never "left").
  used: number
  minutes?: number
  // Unix time in seconds when the window resets.
  resetsAt?: number
}

const FIVE_HOURS = 300
const WEEK = 10_080
const LIMITS_TTL_MS = 60_000

const MSK = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * Parse an `account/rateLimits/read` reply into the used share of each window.
 * Prefers the `codex` limit bucket and falls back to the legacy single
 * `rateLimits` snapshot; windows without a usable percentage are skipped.
 */
export function parseRateLimits(reply: Record<string, unknown>): CodexLimitWindow[] {
  const rate = object(object(reply.rateLimitsByLimitId).codex ?? reply.rateLimits)
  return [rate.primary, rate.secondary].map(object).flatMap(window =>
    typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? [{ used: Math.round(window.usedPercent),
        ...(typeof window.windowDurationMins === 'number' ? { minutes: window.windowDurationMins } : {}),
        ...(typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}) }]
      : [])
}

/** Short Russian label of a limit window: 300 → «5ч», 10080 → «неделя», else «Nч» / «Nд». */
export function limitWindowLabel(minutes: number | undefined): string {
  if (minutes === undefined || minutes <= 0) return 'период'
  if (minutes === FIVE_HOURS) return '5ч'
  if (minutes === WEEK) return 'неделя'
  if (minutes % 1440 === 0) return `${minutes / 1440}д`
  if (minutes < 60) return `${minutes}мин`
  return `${Math.round(minutes / 60)}ч`
}

// «DD.MM HH:MM МСК» for a unix time in seconds.
function formatResetMsk(epochSeconds: number): string {
  const parts = Object.fromEntries(MSK.formatToParts(new Date(epochSeconds * 1000)).map(p => [p.type, p.value]))
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute} МСК`
}

/**
 * Render the HUD limits line, or undefined when no window is known. The line
 * says the share is SPENT («потрачено за неделю 36% · за 5ч 12%»), weekly window
 * first. Only the weekly window carries its reset time, and only when the App
 * Server gave one.
 */
export function formatCodexLimitsLine(windows: ReadonlyArray<CodexLimitWindow>): string | undefined {
  if (windows.length === 0) return undefined
  const ordered = [...windows.filter(w => w.minutes === WEEK), ...windows.filter(w => w.minutes !== WEEK)]
  const parts = ordered.map((w, index) =>
    `${index === 0 ? 'потрачено ' : ''}за ${w.minutes === WEEK ? 'неделю' : limitWindowLabel(w.minutes)} ${w.used}%`)
  const week = windows.find(w => w.minutes === WEEK && w.resetsAt !== undefined)
  const reset = week?.resetsAt !== undefined ? ` (сброс ${formatResetMsk(week.resetsAt)})` : ''
  return `Лимиты Codex: ${parts.join(' · ')}${reset}`
}

export interface CodexLimitsCacheOptions {
  ttlMs?: number
  now?: () => number
  // Fired when the rendered line changes, so the HUD can refresh itself.
  onChange?: () => void
  onError?: (error: unknown) => void
}

export class CodexLimitsCache {
  private value: string | undefined
  private fetchedAt: number | undefined
  private inflight: Promise<void> | undefined

  constructor(
    private readonly read: () => Promise<CodexLimitWindow[]>,
    private readonly options: CodexLimitsCacheOptions = {},
  ) {}

  /** Last known limits line; starts a background refresh when it is stale. Never throws. */
  line(): string | undefined {
    void this.refresh()
    return this.value
  }

  /** Re-read the limits when the cached value is older than the TTL. Never rejects. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    const now = this.now()
    if (this.fetchedAt !== undefined && now - this.fetchedAt < (this.options.ttlMs ?? LIMITS_TTL_MS)) {
      return Promise.resolve()
    }
    this.inflight = (async () => {
      try {
        const line = formatCodexLimitsLine(await this.read())
        if (line !== this.value) {
          this.value = line
          this.options.onChange?.()
        }
      } catch (error) {
        // Keep the last known line; the next attempt waits for the TTL.
        this.options.onError?.(error)
      } finally {
        this.fetchedAt = this.now()
        this.inflight = undefined
      }
    })()
    return this.inflight
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
