// The per-chat minute budget keeps slots for the owner's replies. Status edits stop short of the send reserve, and
// auxiliary sends (side cards, queue notices, the HUD card) stop short of the reply reserve, so a final reply never
// waits for a minute-old slot to age out behind them.

import { expect, test } from 'bun:test'

import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

const OWNER = '123'
const log = createLogger('reply-reserve-test')

// A virtual clock with timers: `sleep` parks on it, `runUntil` fires timers in due order.
function virtualClock(start = 1_000_000) {
  let now = start
  const timers: Array<{ due: number; fire: () => void }> = []
  const at = (due: number, fire: () => void): void => {
    timers.push({ due, fire })
    timers.sort((a, b) => a.due - b.due)
  }
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>(resolve => at(now + ms, resolve)),
    at,
    async runUntil(end: number): Promise<void> {
      for (;;) {
        for (let i = 0; i < 50; i++) await Promise.resolve()
        const next = timers[0]
        if (next === undefined || next.due > end) break
        timers.shift()
        now = Math.max(now, next.due)
        next.fire()
      }
      now = Math.max(now, end)
    },
  }
}

test('after 12 status edits and six auxiliary sends a final reply still leaves within two seconds', async () => {
  const chat = fakeTelegramChat()
  const clock = virtualClock()
  const start = clock.now()
  const api = createRateLimitedTelegramApi(chat.raw, log, { jitterMaxMs: 0, now: clock.now, sleep: clock.sleep })
  const bubble = (await chat.raw.sendMessage(OWNER, 'bubble', {})).message_id
  // Twelve status edits, one a second: the edits' whole share of the minute budget.
  for (let second = 0; second < 12; second++) {
    clock.at(start + second * 1000, () => { void api.editMessageText(OWNER, bubble, 'working ' + second, {}) })
  }
  // Six auxiliary sends (side cards, notices) between seconds 12 and 17.
  for (let card = 0; card < 6; card++) {
    clock.at(start + 12_000 + card * 1000, () => { void api.sendMessage(OWNER, 'card ' + card, {}) })
  }
  let sentAt: number | undefined
  clock.at(start + 19_000, () => {
    void api.sendMessage(OWNER, 'Ответ', { ownerReply: true }).then(() => { sentAt = clock.now() })
  })
  await clock.runUntil(start + 21_000)
  expect(sentAt).toBeDefined()
  expect(sentAt! - start).toBeLessThanOrEqual(21_000)
  expect(chat.texts()).toContain('Ответ')
  // The auxiliary sends were capped short of the reply reserve, not dropped: they all leave later.
  await clock.runUntil(start + 90_000)
  expect(chat.texts().filter(text => text.startsWith('card '))).toHaveLength(6)
})

test('a final reply waiting for capacity is not held behind auxiliary sends waiting for the minute budget', async () => {
  const chat = fakeTelegramChat()
  const clock = virtualClock()
  const start = clock.now()
  const api = createRateLimitedTelegramApi(chat.raw, log, { jitterMaxMs: 0, now: clock.now, sleep: clock.sleep })
  // Twenty auxiliary sends at once: most of them wait for the minute budget, in the send queue.
  for (let card = 0; card < 20; card++) void api.sendMessage(OWNER, 'card ' + card, {})
  let sentAt: number | undefined
  clock.at(start + 20_000, () => {
    void api.sendMessage(OWNER, 'Ответ', { ownerReply: true }).then(() => { sentAt = clock.now() })
  })
  await clock.runUntil(start + 22_000)
  expect(sentAt).toBeDefined()
  expect(sentAt! - start).toBeLessThanOrEqual(22_000)
})
