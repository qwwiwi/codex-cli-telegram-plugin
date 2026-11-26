// The HUD card sits above the answer it belongs to, and the HUD's own edits land in the order they were made.
// An interim reply (telegram_action reply) waits for the card like the final reply does, and a HUD edit cancelled
// in the middle of the edit queue never lets a newer edit overtake an older one still in flight.

import { expect, test } from 'bun:test'

import { AgentChatActions } from '../../src/codex/chat-actions.js'
import { HudAnchor, type HudCard } from '../../src/codex/hud-anchor.js'
import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { fakeTelegramChat, settledWithin } from './fake-telegram-chat.js'

const OWNER = '123'
const log = createLogger('hud-order-test')

test('an interim reply waits until the held HUD card landed, so it lands below the card', async () => {
  const chat = fakeTelegramChat()
  let landCard!: () => void
  const hud: HudCard = {
    bump: () => new Promise<void>(resolve => {
      landCard = () => { void chat.raw.sendMessage(OWNER, '📊 HUD', {}).then(() => resolve()) }
    }),
    async updateNow() {},
    async retire() {},
  }
  const anchor = new HudAnchor(hud, OWNER)
  const api = { ...chat.raw, pinChatMessage: async () => undefined, unpinChatMessage: async () => undefined }
  const actions = new AgentChatActions(api, OWNER, { beforeReply: () => anchor.settled() })
  chat.owner('Сделай отчёт')
  anchor.ownerMessage()
  const reply = actions.receive('k1', '@@TELEGRAM_ACTION ' +
    JSON.stringify({ action: 'reply', text: 'Промежуточный ответ' }), () => true)
  expect(await settledWithin(reply!, 20)).toBe('pending')
  landCard()
  expect(await reply).toBe(true)
  expect(chat.texts()).toEqual(['Сделай отчёт', '📊 HUD', 'Промежуточный ответ'])
})

test('a HUD edit cancelled in the middle of the edit queue keeps the newer edit behind the older one', async () => {
  const order: string[] = []
  const chat = fakeTelegramChat()
  const releases = new Map<string, () => void>()
  const raw = {
    ...chat.raw,
    editMessageText: (_chat: string, id: number, text: string) => new Promise<void>(resolve => {
      order.push('start ' + text)
      releases.set(text, () => { order.push('done ' + text); resolve() })
      void id
    }),
  }
  const api = createRateLimitedTelegramApi(raw, log, { jitterMaxMs: 0 })
  const first = api.editMessageText(OWNER, 1, 'A', {})
  const cancel = new AbortController()
  const middle = api.editMessageText(OWNER, 2, 'B', { signal: cancel.signal })
  const last = api.editMessageText(OWNER, 3, 'C', {})
  await Bun.sleep(5)
  expect(order).toEqual(['start A'])
  cancel.abort()
  await expect(middle).rejects.toThrow('send cancelled')
  await Bun.sleep(5)
  // C must still wait for A, which is in flight.
  expect(order).toEqual(['start A'])
  releases.get('A')!()
  await first
  await Bun.sleep(5)
  releases.get('C')!()
  await last
  expect(order).toEqual(['start A', 'done A', 'start C', 'done C'])
})
