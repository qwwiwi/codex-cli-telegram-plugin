import { expect, test } from 'bun:test'
import type { Message } from 'grammy/types'

import { busyNotice, SideRegistry } from '../../src/codex/parallel.js'
import { SideStatusCard, sideActivityLine, sideFirstStage, sideThinking } from '../../src/codex/side-status.js'

type Call = { op: 'send' | 'edit' | 'delete'; id?: number; text?: string; opts?: Record<string, unknown> }

function fakeTelegram() {
  const calls: Call[] = []
  let next = 900
  return {
    calls,
    api: {
      async sendMessage(_chat: string, text: string, opts: Record<string, unknown>) {
        calls.push({ op: 'send' as const, text, opts })
        return { message_id: ++next }
      },
      async editMessageText(_chat: string, id: number, text: string) { calls.push({ op: 'edit' as const, id, text }) },
      async deleteMessage(_chat: string, id: number) { calls.push({ op: 'delete' as const, id }) },
    },
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const voice = { message_id: 77, date: 1, chat: { id: 1, type: 'private', first_name: 'O' },
  voice: { file_id: 'f', file_unique_id: 'u', duration: 4 } } as Message

test('[R94] a message routed to a side turn gets one silent status card at once, edited in place and removed after the reply', async () => {
  const { api, calls } = fakeTelegram()
  const card = new SideStatusCard(api, '1', 77, { editIntervalMs: 40 })
  // The voice is still being transcribed: the owner sees this before the side turn thinks.
  card.show(sideFirstStage(voice))
  await wait(0)
  expect(calls).toEqual([{ op: 'send', text: 'Параллельно: слушаю голосовое…',
    opts: { reply_to_message_id: 77, disable_notification: true } }])
  card.show(sideThinking)
  // Progress lines arrive quickly: edits are throttled, the newest line wins.
  for (const step of ['Читаю файл a.ts', 'Читаю файл b.ts', 'Запускаю тесты']) card.show(sideThinking + '\n' + step)
  await wait(120)
  const edits = calls.filter(call => call.op === 'edit')
  expect(edits.length).toBeGreaterThanOrEqual(1)
  expect(edits.length).toBeLessThanOrEqual(2)
  expect(edits.every(edit => edit.id === 901)).toBe(true)
  expect(edits.at(-1)?.text).toBe('Параллельно: думаю…\nЗапускаю тесты')
  await card.close()
  expect(calls.at(-1)).toEqual({ op: 'delete', id: 901 })
  expect(calls.filter(call => call.op === 'send')).toHaveLength(1)
  // Nothing more after the card is gone.
  card.show(sideThinking + '\nпоздняя строка')
  await wait(60)
  expect(calls.at(-1)).toEqual({ op: 'delete', id: 901 })
})

test('[R94] a card closed while its first send is in flight is still removed; a text message starts at «думаю»', async () => {
  const { api, calls } = fakeTelegram()
  const card = new SideStatusCard(api, '1', 78, { editIntervalMs: 40 })
  // A plain text message has nothing to transcribe.
  card.show(sideFirstStage({}))
  await card.close()
  expect(calls.map(call => call.op)).toEqual(['send', 'delete'])
  expect(calls[0]?.text).toBe('Параллельно: думаю…')
  // A failing Telegram call never throws out of the card.
  const broken = new SideStatusCard({
    sendMessage: async () => { throw new Error('offline') },
    editMessageText: async () => undefined, deleteMessage: async () => undefined,
  }, '1', 79, { editIntervalMs: 10 })
  broken.show(sideThinking)
  await broken.close()
})

test('[R94] side progress lines come from the side thread\'s tool items, redacted', () => {
  const line = sideActivityLine({ method: 'item/started', params: { threadId: 's1', item: {
    type: 'commandExecution', command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x.example' } } }, [])
  expect(line).toBeDefined()
  expect(line).not.toContain('abcdefghijklmnop')
  expect(sideActivityLine({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'ls' } } }, []))
    .toBeUndefined()
})

test('[R94] a queued message hears «В очереди: возьму после «<title>»» first', () => {
  const sides = new SideRegistry()
  sides.begin(7, 'Найди рецепт борща')
  const notice = busyNotice({ title: 'Перепиши лендинг', elapsedMs: 5 * 60_000 }, sides.titles, 2)
  expect(notice.split('\n')[0]).toBe('В очереди: возьму после «Перепиши лендинг».')
  expect(notice).toContain('5 мин')
  expect(notice).toContain('Найди рецепт борща')
})

test('[R94] the card still appears without the quote when the owner deleted the message', async () => {
  const calls: Call[] = []
  const card = new SideStatusCard({
    async sendMessage(_chat: string, text: string, opts: Record<string, unknown>) {
      if (opts.reply_to_message_id !== undefined) {
        throw Object.assign(new Error('Bad Request: message to be replied not found'),
          { error_code: 400, description: 'Bad Request: message to be replied not found' })
      }
      calls.push({ op: 'send', text, opts })
      return { message_id: 5 }
    },
    async editMessageText() { return undefined },
    async deleteMessage(_chat: string, id: number) { calls.push({ op: 'delete', id }) },
  }, '1', 80, { editIntervalMs: 10 })
  card.show(sideThinking)
  await card.close()
  expect(calls).toEqual([{ op: 'send', text: sideThinking, opts: { disable_notification: true } }, { op: 'delete', id: 5 }])
})
