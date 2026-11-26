import { expect, test } from 'bun:test'

import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { fakeTelegramChat, settledWithin } from './fake-telegram-chat.js'

const OWNER = '123'
const log = createLogger('hud-send-cancel-test')

test('[R04] a HUD send cancelled in flight releases the chat queue, and the answer still waits for the rate limit', async () => {
  const chat = fakeTelegramChat()
  chat.hold('HUD')
  // Virtual clock: a single per-chat token, refilled once a second.
  let now = 1_000_000
  const sleeps: number[] = []
  const api = createRateLimitedTelegramApi(chat.raw, log, {
    perChatBurstCapacity: 1, perChatRefillPerSec: 1, jitterMaxMs: 0,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms },
  })
  const card = new AbortController()
  const hud = api.sendMessage(OWNER, 'HUD A', { signal: card.signal })
  await Bun.sleep(1)
  const answer = api.sendMessage(OWNER, 'answer', {})
  await Bun.sleep(1)
  // Same-chat FIFO: the answer waits behind the card that Telegram has not answered.
  expect(chat.rawCalls).toEqual(['HUD A'])

  card.abort()

  expect(await settledWithin(answer, 100)).toBe('resolved')
  expect(chat.rawCalls).toEqual(['HUD A', 'answer'])
  // The answer did not bypass the limiter: it waited for the token the card spent.
  expect(sleeps).toEqual([1000])
  // The card that lands late still reports its id, so the HUD can retire it.
  chat.releaseAll()
  expect((await hud).message_id).toBeGreaterThan(0)
  expect(chat.texts()).toEqual(['answer', 'HUD A'])
})

test('[R04] a HUD send cancelled while queued never reaches Telegram and the answer keeps its place in line', async () => {
  const chat = fakeTelegramChat()
  chat.hold('earlier')
  const api = createRateLimitedTelegramApi(chat.raw, log, { jitterMaxMs: 0 })
  const earlier = api.sendMessage(OWNER, 'earlier', {})
  const card = new AbortController()
  const hud = api.sendMessage(OWNER, 'HUD A', { signal: card.signal })
  const answer = api.sendMessage(OWNER, 'answer', {})
  await Bun.sleep(1)

  card.abort()

  expect(await settledWithin(hud, 100)).toBe('rejected')
  // The answer still waits for the send that was ahead of the cancelled card.
  expect(chat.rawCalls).toEqual(['earlier'])
  chat.releaseAll()
  await Promise.all([earlier, answer])
  expect(chat.rawCalls).toEqual(['earlier', 'answer'])
})

test('[R04] a HUD send cancelled while it waits for rate-limit capacity stops waiting and never reaches Telegram', async () => {
  const chat = fakeTelegramChat()
  let now = 1_000_000
  const api = createRateLimitedTelegramApi(chat.raw, log, {
    perChatBurstCapacity: 1, perChatRefillPerSec: 1, jitterMaxMs: 0,
    now: () => now,
    // Time stands still: a send that needs a token waits until cancelled.
    sleep: () => new Promise<void>(() => undefined),
  })
  await api.sendMessage(OWNER, 'earlier', {})
  const card = new AbortController()
  const hud = api.sendMessage(OWNER, 'HUD A', { signal: card.signal })
  await Bun.sleep(1)

  card.abort()

  expect(await settledWithin(hud, 100)).toBe('rejected')
  expect(chat.rawCalls).toEqual(['earlier'])
  now += 1000
})
