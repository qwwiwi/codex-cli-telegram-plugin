// Parallel owner messages while a main turn runs: every message must get its side card at once, and one slow
// HUD operation must not hold the other sends of the chat. Each test reproduces one serial point found live
// (three voices sent in parallel were answered one after another, behind a 30 s HUD guard).

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EditOpts } from '../../src/channel/tools.js'
import { routeWhileBusy, SideRegistry } from '../../src/codex/parallel.js'
import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi, SendCancelledError } from '../../src/safety/rate-limited-telegram-api.js'
import { ContextHud } from '../../src/status/context-hud.js'
import { fakeTelegramChat, settledWithin } from './fake-telegram-chat.js'

const OWNER = '123'
const log = createLogger('parallel-delivery-test')

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
        // Let every chain woken by the previous timer reach its next sleep.
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

test('a send during a running turn leaves within 2 s although the status bubble edits every 1.1 s', async () => {
  const chat = fakeTelegramChat()
  const clock = virtualClock()
  const start = clock.now()
  const api = createRateLimitedTelegramApi(chat.raw, log, { jitterMaxMs: 0, now: clock.now, sleep: clock.sleep })
  const bubble = (await api.sendMessage(OWNER, 'bubble', {})).message_id
  // The status bubble of the main turn: a new frame every 1.1 s (status.interval_ms default).
  let frame = 0
  const tick = (): void => {
    void api.editMessageText(OWNER, bubble, 'working ' + frame++, {}).catch(() => undefined)
    clock.at(clock.now() + 1100, tick)
  }
  clock.at(start + 1100, tick)
  // Owner messages arrive at different points of the minute; each gets a side card.
  const latency: Record<string, number> = {}
  for (const second of [20, 35, 50, 75, 100]) {
    clock.at(start + second * 1000, () => {
      const sentAt = clock.now()
      void api.sendMessage(OWNER, 'card ' + second, {}).then(() => { latency['card ' + second] = clock.now() - sentAt })
    })
  }
  await clock.runUntil(start + 130_000)

  for (const second of [20, 35, 50, 75, 100]) expect(latency['card ' + second]).toBeLessThanOrEqual(2000)
  // The bubble keeps moving: it still gets most of the chat's minute budget.
  expect(frame).toBeGreaterThan(100)
  expect(chat.texts().find(text => text.startsWith('working'))).toBeDefined()
})

test('an edit cancelled while it waits for rate-limit capacity stops waiting and never reaches Telegram', async () => {
  const chat = fakeTelegramChat()
  const api = createRateLimitedTelegramApi(chat.raw, log, {
    perChatBurstCapacity: 1, perChatRefillPerSec: 1, jitterMaxMs: 0,
    // Time stands still: an edit that needs a token waits until cancelled.
    sleep: () => new Promise<void>(() => undefined),
  })
  const card = (await api.sendMessage(OWNER, 'HUD 1', {})).message_id
  const cancel = new AbortController()
  const editing = api.editMessageText(OWNER, card, 'HUD 2', { signal: cancel.signal })
  await Bun.sleep(1)

  cancel.abort()

  expect(await settledWithin(editing, 100)).toBe('rejected')
  expect(await editing.catch((error: unknown) => error)).toBeInstanceOf(SendCancelledError)
  expect(chat.texts()).toEqual(['HUD 1'])
})

function hudOver(api: ConstructorParameters<typeof ContextHud>[0]['api']) {
  let renders = 0
  return new ContextHud({
    api, log, sessionInfo: { get: () => ({}) }, windowTokens: 0,
    ownerChatIds: [OWNER], stateDir: mkdtempSync(join(tmpdir(), 'parallel-delivery-')), enabled: true,
    render: () => ({ text: 'HUD ' + ++renders, keyboard: { inline_keyboard: [] } }),
  })
}

test('a HUD move does not wait behind refreshes whose edits are stuck behind the status bubble', async () => {
  const chat = fakeTelegramChat()
  const stuck: string[] = []
  const hud = hudOver({
    sendMessage: chat.raw.sendMessage,
    // Every refresh edit waits for rate-limit capacity that does not come; only its signal ends the wait.
    editMessageText: (_chat: string, _id: number, text: string, opts: EditOpts) => new Promise<void>((_resolve, reject) => {
      stuck.push(text)
      opts.signal?.addEventListener('abort', () => reject(new SendCancelledError()), { once: true })
    }),
    deleteMessage: chat.raw.deleteMessage,
    async pinChatMessage() {},
    async unpinChatMessage() {},
  })
  await hud.updateNow(OWNER)
  expect(chat.texts()).toEqual(['HUD 1'])
  // Turn progress refreshes the card twice: the first edit is stuck, the second waits behind it.
  void hud.updateNow(OWNER)
  void hud.updateNow(OWNER)
  await Bun.sleep(1)
  expect(stuck).toEqual(['HUD 2'])

  // An owner message arrives: the card moves under it at once.
  chat.owner('owner voice')
  const move = hud.bump(OWNER)

  expect(await settledWithin(move, 100)).toBe('resolved')
  expect(chat.texts()).toEqual(['owner voice', 'HUD 3'])
  // The superseded refresh never runs after the move.
  await Bun.sleep(5)
  expect(stuck).toEqual(['HUD 2'])
})

test('a HUD card send that hangs in flight does not hold the side card behind it', async () => {
  const chat = fakeTelegramChat()
  const limited = createRateLimitedTelegramApi(chat.raw, log, { jitterMaxMs: 0 })
  const hud = hudOver({
    sendMessage: limited.sendMessage,
    editMessageText: limited.editMessageText,
    deleteMessage: chat.raw.deleteMessage,
    async pinChatMessage() {},
    async unpinChatMessage() {},
  })
  await hud.updateNow(OWNER)
  // Telegram does not answer the next HUD card send.
  chat.hold('HUD')
  chat.owner('owner voice')
  void hud.bump(OWNER)
  await Bun.sleep(1)

  const card = limited.sendMessage(OWNER, 'Параллельно: слушаю голосовое…', { disable_notification: true })

  expect(await settledWithin(card, 100)).toBe('resolved')
  chat.releaseAll()
})

test('three voices sent while the main turn runs all go to side turns up to the cap', () => {
  const sides = new SideRegistry()
  const routes = [1, 2, 3].map(id => {
    const route = routeWhileBusy({ text: undefined }, { keywords: ['стоп'], maxParallel: 7, sides })
    if (route.route === 'side') sides.begin(id, 'voice ' + id)
    return route.route
  })
  expect(routes).toEqual(['side', 'side', 'side'])
})
