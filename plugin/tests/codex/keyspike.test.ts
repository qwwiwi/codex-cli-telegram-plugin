// S0 phone spike of the secret hand-over design: the owner-only /keytest button and the sealed
// consumption of its web_app_data. Fake values only; the payload must never be logged, dead-lettered
// or passed to the normal update path.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Bot } from 'grammy'
import type { BotFullInfo, Update } from 'grammy/types'

import { getStatePaths, loadConfig, RuntimeEnvSchema } from '../../src/config.js'
import { KEYSPIKE_LENGTH, KeySpike, keyspikeTestString, keyspikeUrl, type KeySpikeApi } from '../../src/codex/keyspike.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { sealWebAppData } from '../../src/telegram/handover-seal.js'
import { TelegramPoller } from '../../src/telegram/poller.js'

const OWNER = 5001
const STRANGER = 6002
const PAGE = 'https://example.github.io/keyspike/'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Captures both the stderr lines and the error-journal sink, so a test can scan everything logged.
function capturingLogger(): { log: ReturnType<typeof createLogger>, logged: () => string } {
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  const log = createLogger('test', {
    stream, sink: (level, name, msg, ctx) => { lines.push(JSON.stringify({ level, name, msg, ctx })) },
  })
  return { log, logged: () => lines.join('\n') }
}

interface Sent { chatId: string, text: string, markup: unknown }

function fakeApi(): { api: KeySpikeApi, sent: Sent[], deleted: Array<[string, number]> } {
  const sent: Sent[] = []
  const deleted: Array<[string, number]> = []
  let next = 900
  return {
    sent, deleted,
    api: {
      sendMessage: async (chatId, text, markup) => { sent.push({ chatId, text, markup }); return { message_id: next++ } },
      deleteMessage: async (chatId, messageId) => { deleted.push([chatId, messageId]) },
    },
  }
}

function privateText(from: number, text: string, chatId = from, chatType: 'private' | 'group' = 'private', isBot = false) {
  return { message_id: 10, chat: { id: chatId, type: chatType }, from: { id: from, is_bot: isBot }, text }
}

function webAppUpdate(updateId: number, from: number, data: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 77, date: 1, chat: { id: from, type: 'private', first_name: 'O' },
      from: { id: from, is_bot: false, first_name: 'O' },
      web_app_data: { data, button_text: 'Открыть тест' },
    },
  } as unknown as Update
}

test('keyspikeUrl is off when unset and accepts only an https page', () => {
  expect(keyspikeUrl(undefined)).toBeUndefined()
  expect(keyspikeUrl('')).toBeUndefined()
  expect(keyspikeUrl(PAGE)).toBe(PAGE)
  expect(() => keyspikeUrl('http://example.github.io/keyspike/')).toThrow()
  expect(() => keyspikeUrl('not a url')).toThrow()
})

test('the test string is exactly 3968 bytes and differs per platform', () => {
  expect(KEYSPIKE_LENGTH).toBe(3968)
  for (const platform of ['android', 'ios', 'tdesktop', 'unknown']) {
    expect(Buffer.byteLength(keyspikeTestString(platform), 'utf8')).toBe(3968)
  }
  expect(keyspikeTestString('ios')).not.toBe(keyspikeTestString('android'))
})

test('the page builds the same test string as the bridge', async () => {
  const path = join(import.meta.dir, '..', '..', '..', 'miniapp', 'keyspike', 'app.js')
  const page: unknown = await import(path)
  if (!page || typeof page !== 'object' || !('buildTestString' in page) || typeof page.buildTestString !== 'function') {
    throw new Error('app.js must export buildTestString')
  }
  const build = page.buildTestString as (platform: string) => unknown
  for (const platform of ['android', 'ios', 'tdesktop', 'weba', 'unknown']) {
    expect(build(platform)).toBe(keyspikeTestString(platform))
  }
})

test('/keytest from the owner in the private chat sends a one-time web_app reply keyboard', async () => {
  const { api, sent } = fakeApi()
  const { log } = capturingLogger()
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api, log, now: () => 1_800_000_000_000 })
  expect(await spike.command(privateText(OWNER, '/keytest'))).toBe(true)
  expect(sent).toHaveLength(1)
  const markup = sent[0]!.markup as {
    keyboard: Array<Array<{ text: string, web_app: { url: string } }>>, one_time_keyboard: boolean
  }
  expect(sent[0]!.chatId).toBe(String(OWNER))
  expect(markup.one_time_keyboard).toBe(true)
  const url = new URL(markup.keyboard[0]![0]!.web_app.url)
  expect(url.origin + url.pathname).toBe(PAGE)
  expect(url.searchParams.get('rid')).toMatch(/^[A-Za-z0-9_-]{22}$/)
  // Uncompressed SEC1 P-256 point: 65 bytes = 87 base64url characters.
  expect(url.searchParams.get('pk')).toMatch(/^[A-Za-z0-9_-]{87}$/)
  expect(url.searchParams.get('exp')).toBe(String(1_800_000_000 + 600))
})

test('/keytest is refused for a stranger, a group, a bot sender and other text', async () => {
  const { api, sent } = fakeApi()
  const { log } = capturingLogger()
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api, log })
  expect(await spike.command(privateText(STRANGER, '/keytest'))).toBe(false)
  expect(await spike.command(privateText(OWNER, '/keytest', -100, 'group'))).toBe(false)
  expect(await spike.command(privateText(OWNER, '/keytest', OWNER, 'private', true))).toBe(false)
  expect(await spike.command(privateText(OWNER, '/keys'))).toBe(false)
  expect(await spike.command(privateText(OWNER, 'hello /keytest'))).toBe(false)
  expect(sent).toHaveLength(0)
})

test('the owner hand-over deletes the service message, removes the keyboard and never logs the payload', async () => {
  const { api, sent, deleted } = fakeApi()
  const { log, logged } = capturingLogger()
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api, log })
  const data = keyspikeTestString('android')
  await spike.handover({
    update_id: 42, chat_id: OWNER, chat_type: 'private', from_id: OWNER, from_is_bot: false, message_id: 77, data,
  })
  expect(deleted).toEqual([[String(OWNER), 77]])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.markup).toEqual({ remove_keyboard: true })
  expect(sent[0]!.text).toContain('3968')
  expect(sent[0]!.text).toContain('совпадает')
  expect(sent[0]!.text).not.toContain('не совпадает')
  expect(sent[0]!.text).toContain('android')
  const text = logged()
  expect(text).toContain('keyspike')
  expect(text).not.toContain(data.slice(0, 40))
  expect(text).not.toContain(data.slice(-40))
})

test('a tampered payload is reported as a mismatch without echoing it', async () => {
  const { api, sent } = fakeApi()
  const { log, logged } = capturingLogger()
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api, log })
  const data = 'ks0.android.' + 'Z'.repeat(100) + 'SECRETMARKER'
  await spike.handover({
    update_id: 43, chat_id: OWNER, chat_type: 'private', from_id: OWNER, from_is_bot: false, message_id: 78, data,
  })
  expect(sent[0]!.text).toContain('не совпадает')
  expect(sent[0]!.text).not.toContain('SECRETMARKER')
  expect(logged()).not.toContain('SECRETMARKER')
})

test('a hand-over from a non-owner is dropped silently', async () => {
  const { api, sent, deleted } = fakeApi()
  const { log } = capturingLogger()
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api, log })
  await spike.handover({
    update_id: 44, chat_id: STRANGER, chat_type: 'private', from_id: STRANGER, from_is_bot: false, message_id: 5,
    data: keyspikeTestString('ios'),
  })
  expect(sent).toHaveLength(0)
  expect(deleted).toHaveLength(0)
})

test('the hand-over consumer never throws when Telegram calls fail', async () => {
  const { log } = capturingLogger()
  const failing: KeySpikeApi = {
    sendMessage: async () => { throw new Error('send failed SECRETMARKER') },
    deleteMessage: async () => { throw new Error('delete failed') },
  }
  const spike = new KeySpike({ url: PAGE, ownerId: OWNER, api: failing, log })
  await spike.handover({
    update_id: 45, chat_id: OWNER, chat_type: 'private', from_id: OWNER, from_is_bot: false, message_id: 6,
    data: keyspikeTestString('ios'),
  })
})

test('sealWebAppData takes a direct submission out and strips nested copies', () => {
  const direct = sealWebAppData(webAppUpdate(7, OWNER, 'PAYLOAD'))
  expect(direct).toEqual({ kind: 'handover', handover: {
    update_id: 7, chat_id: OWNER, chat_type: 'private', from_id: OWNER, from_is_bot: false, message_id: 77, data: 'PAYLOAD',
  } })
  const nested = {
    update_id: 8,
    message: {
      message_id: 2, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false }, text: 'hi',
      reply_to_message: { message_id: 1, date: 1, chat: { id: OWNER, type: 'private' }, web_app_data: { data: 'PAYLOAD', button_text: 'b' } },
    },
  }
  const sealed = sealWebAppData(nested)
  expect(sealed.kind).toBe('update')
  expect(JSON.stringify(sealed)).not.toContain('PAYLOAD')
  expect(sealWebAppData(null)).toEqual({ kind: 'update', update: null })
})

async function pollOnceWith(updates: Update[], onHandover: ((h: unknown) => Promise<void>) | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'krotov-keyspike-'))
  temporary.push(root)
  const env = { TELEGRAM_BOT_TOKEN: '100001:fake-token', TELEGRAM_EXPECTED_BOT_ID: '100001', TELEGRAM_STATE_DIR: root }
  const config = loadConfig(env)
  const paths = getStatePaths(config, RuntimeEnvSchema.parse(env))
  ensureStateDirs(paths)
  const botInfo = { id: 100001, is_bot: true, first_name: 'Test', username: 'test_bot' } as unknown as BotFullInfo
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo })
  const { log, logged } = capturingLogger()
  const dispatched: unknown[] = []
  const poller = new TelegramPoller({
    bot, config, statePaths: paths, log,
    onUpdate: async update => { dispatched.push(update) },
    ...(onHandover ? { onHandover } : {}),
  }, { getUpdates: async () => updates, sleep: async () => undefined })
  const result = await poller.pollOnce()
  const deadLetters = readdirSync(paths.deadLetterUpdates)
  return { result, dispatched, deadLetters, logged }
}

test('the poller hands a web_app_data update to onHandover only, before validation, and advances the offset', async () => {
  const handed: unknown[] = []
  const update = webAppUpdate(100, OWNER, 'PAYLOAD-SECRET')
  const { result, dispatched, deadLetters, logged } = await pollOnceWith([update], async h => { handed.push(h) })
  expect(handed).toHaveLength(1)
  expect(dispatched).toHaveLength(0)
  expect(deadLetters).toHaveLength(0)
  expect(result.offsetAfter).toBe(101)
  expect(logged()).not.toContain('PAYLOAD-SECRET')
})

test('a throwing hand-over consumer writes no dead letter and logs no payload', async () => {
  const update = webAppUpdate(200, OWNER, 'PAYLOAD-SECRET')
  const { result, dispatched, deadLetters, logged } = await pollOnceWith([update], async () => {
    throw new Error('boom PAYLOAD-SECRET')
  })
  expect(dispatched).toHaveLength(0)
  expect(deadLetters).toHaveLength(0)
  expect(result.offsetAfter).toBe(201)
  expect(logged()).not.toContain('PAYLOAD-SECRET')
})

test('a web_app_data update that fails validation is still sealed, not dead-lettered', async () => {
  const broken = { update_id: 300, message: { web_app_data: { data: 'PAYLOAD-SECRET' }, chat: { id: OWNER, type: 'private' } } }
  const handed: unknown[] = []
  const { deadLetters, logged } = await pollOnceWith([broken as unknown as Update], async h => { handed.push(h) })
  expect(handed).toHaveLength(1)
  expect(deadLetters).toHaveLength(0)
  expect(logged()).not.toContain('PAYLOAD-SECRET')
})

test('with the spike off the poller passes web_app_data on exactly as before', async () => {
  const update = webAppUpdate(400, OWNER, 'PAYLOAD')
  const { dispatched } = await pollOnceWith([update], undefined)
  expect(dispatched).toEqual([update])
})
