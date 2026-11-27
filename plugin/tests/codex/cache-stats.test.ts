import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheStats, cacheDoctorProblem, cacheStatusLine } from '../../src/codex/cache-stats.js'

// Prompt-cache share of Codex input: per thread and over the last 24 hours, from
// thread/tokenUsage/updated notifications (cached input is part of input).

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-cache-stats-'))
  dirs.push(dir)
  return join(dir, 'cache-stats.json')
}

const hour = 60 * 60 * 1000
const usage = (totalInput: number, totalCached: number, lastInput: number, lastCached: number) => ({
  total: { totalTokens: totalInput + 10, inputTokens: totalInput, cachedInputTokens: totalCached },
  last: { totalTokens: lastInput + 10, inputTokens: lastInput, cachedInputTokens: lastCached },
  modelContextWindow: 258000,
})

test('cache share per thread comes from the thread totals and the 24 h share from the new input only', () => {
  let now = Date.UTC(2026, 10, 26, 10)
  const stats = new CacheStats({ now: () => now })
  stats.record('main', usage(100_000, 90_000, 100_000, 90_000))
  // A repeated notification with unchanged totals is not counted twice.
  stats.record('main', usage(100_000, 90_000, 100_000, 90_000))
  stats.record('main', usage(200_000, 186_000, 100_000, 96_000))
  stats.record('side', usage(50_000, 10_000, 50_000, 10_000))
  expect(stats.thread('main')).toEqual({ input: 200_000, cached: 186_000, percent: 93 })
  expect(stats.thread('side')).toEqual({ input: 50_000, cached: 10_000, percent: 20 })
  expect(stats.thread('unknown')).toBeUndefined()
  expect(stats.day()).toEqual({ input: 250_000, cached: 196_000, percent: 78 })
  // After 24 hours the old input leaves the window.
  now += 25 * hour
  stats.record('main', usage(210_000, 195_000, 10_000, 9_000))
  expect(stats.day()).toEqual({ input: 10_000, cached: 9_000, percent: 90 })
})

test('a thread whose totals restart, or that reports no totals, counts its last request', () => {
  const stats = new CacheStats({ now: () => Date.UTC(2026, 10, 26, 10) })
  stats.record('main', usage(100_000, 90_000, 100_000, 90_000))
  stats.record('main', usage(20_000, 10_000, 20_000, 10_000))
  stats.record('other', { last: { inputTokens: 1_000, cachedInputTokens: 500 }, modelContextWindow: 1 })
  stats.record('broken', { last: { inputTokens: 'x' } })
  stats.record('broken', null)
  expect(stats.day()).toEqual({ input: 121_000, cached: 100_500, percent: 83 })
  expect(stats.thread('broken')).toBeUndefined()
})

test('the 24 h counters survive a bridge restart through the state file', () => {
  const file = tempFile()
  const now = Date.UTC(2026, 10, 26, 10)
  new CacheStats({ file, now: () => now }).record('main', usage(100_000, 93_000, 100_000, 93_000))
  const restarted = new CacheStats({ file, now: () => now + hour })
  expect(restarted.day()).toEqual({ input: 100_000, cached: 93_000, percent: 93 })
  expect(restarted.thread('main')).toEqual({ input: 100_000, cached: 93_000, percent: 93 })
  // The same totals after the restart are not counted again.
  restarted.record('main', usage(100_000, 93_000, 100_000, 93_000))
  expect(restarted.day()?.input).toBe(100_000)
  writeFileSync(file, '{not json')
  expect(new CacheStats({ file, now: () => now }).day()).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe('{not json')
})

test('/status and /doctor show the cache share as «Кеш: N% входа» for the thread and for 24 h', () => {
  expect(cacheStatusLine({ input: 200_000, cached: 186_000, percent: 93 }, { input: 1_000_000, cached: 910_000, percent: 91 }))
    .toBe('Кеш: 93% входа в этом диалоге, 91% за 24 ч')
  expect(cacheStatusLine(undefined, { input: 1_000_000, cached: 910_000, percent: 91 })).toBe('Кеш: 91% входа за 24 ч')
  expect(cacheStatusLine({ input: 10, cached: 9, percent: 90 }, undefined)).toBe('Кеш: 90% входа в этом диалоге')
  expect(cacheStatusLine(undefined, undefined)).toBeUndefined()
})

test('/doctor flags a 24 h cache share below 70% only with at least 200k input tokens', () => {
  expect(cacheDoctorProblem({ input: 199_999, cached: 0, percent: 0 })).toBeUndefined()
  expect(cacheDoctorProblem(undefined)).toBeUndefined()
  const problem = cacheDoctorProblem({ input: 400_000, cached: 200_000, percent: 50 })
  expect(problem?.text).toContain('Кеш: 50% входа за 24 ч')
  expect(problem?.text).toContain('70%')
  expect(problem?.fix).toBeTruthy()
  expect(problem?.fix).not.toContain('\n')
})

test('/doctor flags 69.5% but not 70% when both cache shares display as 70%', () => {
  expect(cacheDoctorProblem({ input: 200_000, cached: 139_000, percent: 70 })?.text).toContain('Кеш: ≈70%')
  expect(cacheDoctorProblem({ input: 200_000, cached: 140_000, percent: 70 })).toBeUndefined()
})
