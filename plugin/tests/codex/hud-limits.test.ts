import { expect, test } from 'bun:test'

import { CodexLimitsCache, formatCodexLimitsLine, limitWindowLabel, parseRateLimits } from '../../src/status/codex-limits.js'

// 01.12 00:30 in Moscow (UTC+3) is 30 Nov 21:30 UTC.
const WEEK_RESET = Date.UTC(2026, 10, 30, 21, 30) / 1000

test('labels Codex limit windows by their length', () => {
  expect(limitWindowLabel(300)).toBe('5ч')
  expect(limitWindowLabel(10080)).toBe('неделя')
  expect(limitWindowLabel(120)).toBe('2ч')
  expect(limitWindowLabel(2880)).toBe('2д')
})

test('formats used percentages and the weekly reset in Moscow time', () => {
  expect(formatCodexLimitsLine([
    { used: 12, minutes: 300, resetsAt: Date.UTC(2026, 10, 25, 23, 0) / 1000 },
    { used: 36, minutes: 10080, resetsAt: WEEK_RESET },
  ])).toBe('Лимиты Codex: 5ч 12% · неделя 36% (сброс 01.12 00:30 МСК)')
  expect(formatCodexLimitsLine([{ used: 12, minutes: 300 }])).toBe('Лимиты Codex: 5ч 12%')
  expect(formatCodexLimitsLine([{ used: 36, minutes: 10080 }])).toBe('Лимиты Codex: неделя 36%')
  expect(formatCodexLimitsLine([])).toBeUndefined()
})

test('caches Codex limits for a minute and keeps the last value on errors', async () => {
  let now = 1_000_000
  let calls = 0
  let fail = false
  let changes = 0
  const cache = new CodexLimitsCache(async () => {
    calls++
    if (fail) throw new Error('rate limits unavailable')
    return [{ used: calls * 10, minutes: 300 }]
  }, { now: () => now, onChange: () => { changes++ } })

  expect(cache.line()).toBeUndefined()
  await cache.refresh()
  expect(cache.line()).toBe('Лимиты Codex: 5ч 10%')
  expect(changes).toBe(1)

  now += 59_000
  cache.line()
  await cache.refresh()
  expect(calls).toBe(1)

  now += 2_000
  fail = true
  await cache.refresh()
  expect(calls).toBe(2)
  expect(cache.line()).toBe('Лимиты Codex: 5ч 10%')
  expect(changes).toBe(1)

  // A failed read is not retried on every HUD refresh either.
  await cache.refresh()
  expect(calls).toBe(2)

  now += 61_000
  fail = false
  expect(cache.line()).toBe('Лимиты Codex: 5ч 10%')
  await cache.refresh()
  expect(calls).toBe(3)
  expect(cache.line()).toBe('Лимиты Codex: 5ч 30%')
  expect(changes).toBe(2)
})

test('omits the limits line when the first read fails', async () => {
  const cache = new CodexLimitsCache(() => { throw new Error('not logged in') })
  await cache.refresh()
  expect(cache.line()).toBeUndefined()
})

test('reads used percentages, window length and reset time from the App Server reply', () => {
  expect(parseRateLimits({ rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1_764_000_000 },
    secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: WEEK_RESET },
  } } })).toEqual([
    { used: 12, minutes: 300, resetsAt: 1_764_000_000 },
    { used: 36, minutes: 10080, resetsAt: WEEK_RESET },
  ])
  expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 16.8, windowDurationMins: 300, resetsAt: null } } }))
    .toEqual([{ used: 17, minutes: 300 }])
  expect(parseRateLimits({})).toEqual([])
})
