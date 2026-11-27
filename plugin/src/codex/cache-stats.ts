// Prompt-cache share of Codex input, shown in /status and /doctor as «Кеш: N% входа».
// Source: thread/tokenUsage/updated notifications of every thread the bridge runs (main, side, subagent).
// Cached input is part of input. Per thread the share comes from the thread's own totals; the 24-hour
// share sums the new input of each notification into hourly buckets, so a repeated notification with
// unchanged totals is not counted twice. The buckets and the last totals per thread are kept in a small
// JSON file in the state directory so a bridge restart does not reset the day. Errors never reach the bridge.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { z } from 'zod'

import { atomicWriteInRoot } from '../autonomy/store.js'
import type { DoctorProblem } from './doctor-command.js'

const hourMs = 60 * 60 * 1000
const dayHours = 24
const maxThreads = 64
/** /doctor flags a 24-hour share below this percentage... */
export const lowCacheSharePercent = 70
/** ...once the day has at least this many input tokens, so a few small requests never count. */
export const lowCacheMinInput = 200_000

export interface CacheShare { input: number; cached: number; percent: number }

type Counts = { input: number; cached: number }

const CountsSchema = z.object({ input: z.number().nonnegative(), cached: z.number().nonnegative() })
const FileSchema = z.object({
  buckets: z.array(CountsSchema.extend({ hour: z.number().int() })),
  threads: z.record(CountsSchema),
})

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

// One usage breakdown ({ inputTokens, cachedInputTokens }); cached input never exceeds input.
function counts(value: unknown): Counts | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('inputTokens' in value) || !('cachedInputTokens' in value)) return undefined
  const input = count(value.inputTokens)
  const cached = count(value.cachedInputTokens)
  return input === undefined || cached === undefined ? undefined : { input, cached: Math.min(cached, input) }
}

function share({ input, cached }: Counts): CacheShare | undefined {
  return input > 0 ? { input, cached, percent: Math.min(100, Math.round(cached / input * 100)) } : undefined
}

export interface CacheStatsOptions {
  /** The JSON state file; without it the counters live in memory only. */
  file?: string
  now?: () => number
}

export class CacheStats {
  private readonly now: () => number
  private buckets: (Counts & { hour: number })[] = []
  private threads = new Map<string, Counts>()

  constructor(private readonly options: CacheStatsOptions = {}) {
    this.now = options.now ?? Date.now
    this.load()
  }

  /** Takes one thread/tokenUsage/updated `tokenUsage` payload; anything malformed is ignored. */
  record(threadId: string, tokenUsage: unknown): void {
    if (typeof tokenUsage !== 'object' || tokenUsage === null) return
    const total = 'total' in tokenUsage ? counts(tokenUsage.total) : undefined
    const last = 'last' in tokenUsage ? counts(tokenUsage.last) : undefined
    const previous = this.threads.get(threadId)
    // Totals that grew give the new input exactly; a first sight or totals that restarted fall back to the last request.
    const delta = previous && total && total.input >= previous.input && total.cached >= previous.cached
      ? { input: total.input - previous.input, cached: total.cached - previous.cached }
      : last
    const totalsChanged = !!total && (total.input !== previous?.input || total.cached !== previous.cached)
    if (totalsChanged) {
      this.threads.delete(threadId)
      this.threads.set(threadId, total)
      if (this.threads.size > maxThreads) {
        const oldest = this.threads.keys().next()
        if (!oldest.done) this.threads.delete(oldest.value)
      }
    }
    const added = !!delta && delta.input > 0
    if (added) this.add({ input: delta.input, cached: Math.min(delta.cached, delta.input) })
    // A repeated notification changes nothing and writes nothing.
    if (totalsChanged || added) this.save()
  }

  /** The share of one thread, from its latest totals. */
  thread(threadId: string | null | undefined): CacheShare | undefined {
    const totals = threadId ? this.threads.get(threadId) : undefined
    return totals ? share(totals) : undefined
  }

  /** The share over the last 24 hours (the current hour and the 23 before it). */
  day(): CacheShare | undefined {
    const sum = this.recent().reduce((acc, bucket) => ({ input: acc.input + bucket.input, cached: acc.cached + bucket.cached }),
      { input: 0, cached: 0 })
    return share(sum)
  }

  private recent(): (Counts & { hour: number })[] {
    const oldest = Math.floor(this.now() / hourMs) - dayHours + 1
    return this.buckets.filter(bucket => bucket.hour >= oldest)
  }

  private add(delta: Counts): void {
    const hour = Math.floor(this.now() / hourMs)
    this.buckets = this.recent()
    const bucket = this.buckets.find(item => item.hour === hour)
    if (bucket) {
      bucket.input += delta.input
      bucket.cached += delta.cached
    } else this.buckets.push({ hour, ...delta })
  }

  private load(): void {
    const file = this.options.file
    if (!file || !existsSync(file)) return
    try {
      const data = FileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      this.buckets = data.buckets
      this.threads = new Map(Object.entries(data.threads).slice(-maxThreads))
    } catch {
      // A damaged file starts the counters afresh; it is replaced on the next write.
    }
  }

  private save(): void {
    const file = this.options.file
    if (!file) return
    try {
      atomicWriteInRoot({ root: dirname(file) }, basename(file),
        JSON.stringify({ buckets: this.recent(), threads: Object.fromEntries(this.threads) }))
    } catch {
      // Statistics only: a failed write never breaks a turn.
    }
  }
}

/** The /status and /doctor line: «Кеш: 93% входа в этом диалоге, 91% за 24 ч»; undefined without data. */
export function cacheStatusLine(thread: CacheShare | undefined, day: CacheShare | undefined): string | undefined {
  if (thread && day) return `Кеш: ${thread.percent}% входа в этом диалоге, ${day.percent}% за 24 ч`
  if (day) return `Кеш: ${day.percent}% входа за 24 ч`
  if (thread) return `Кеш: ${thread.percent}% входа в этом диалоге`
  return undefined
}

/** A /doctor problem when under 70% of at least 200k input tokens of the last 24 hours came from the cache. */
export function cacheDoctorProblem(day: CacheShare | undefined): DoctorProblem | undefined {
  if (!day || day.input < lowCacheMinInput || day.cached * 100 >= day.input * lowCacheSharePercent) return undefined
  const percent = day.percent === lowCacheSharePercent ? `≈${day.percent}` : day.percent
  return {
    text: `Кеш: ${percent}% входа за 24 ч (${day.cached.toLocaleString('ru')} из ${day.input.toLocaleString('ru')} токенов), ` +
      `ниже ${lowCacheSharePercent}%: Codex заново оплачивает уже отправленный текст.`,
    fix: 'Смена модели и новый диалог начинают кеш заново: держите одну модель в течение дня (/cc → «Модель») ' +
      'и не начинайте новый диалог (/new) без нужды. Если так и было, обновите мост: ./update.sh.',
  }
}
