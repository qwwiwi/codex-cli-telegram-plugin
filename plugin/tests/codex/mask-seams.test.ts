// Fix loop 1 of the masking rebuild (reviews in docs/design/v061/reviews): a value is masked across message cuts
// on every attempt, every shown field of a request goes through the wire guard, masking fails closed on a value
// the marker cannot hide, and Telegram's refusal of the entities resends the same text without them.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTelegramApi } from '../../src/channel/tools.js'
import { createTelegramStack } from '../../src/codex/telegram-stack.js'
import { cutPoints, mask } from '../../src/format/visible.js'
import { createLogger } from '../../src/log.js'
import { MaskFixedPointError } from '../../src/safety/pre-send-error.js'
import { FAKE_TOKEN, fakeBotApi, type FakeAnswer, type FakeBotApi } from './fake-bot-api.js'

const OWNER = '42'
const VALUE = 'MASKME'
const LATE = 'MASKLATE'
const log = createLogger('mask-seams-test')
const json = (value: unknown): string => JSON.stringify(value)

const apis: FakeBotApi[] = []
const dirs: string[] = []
afterEach(() => {
  for (const api of apis.splice(0)) api.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stack(secrets: string[] = [VALUE]): { api: FakeBotApi; telegram: ReturnType<typeof createTelegramStack> } {
  const api = fakeBotApi()
  apis.push(api)
  return { api, telegram: createTelegramStack({ bot: api.bot, token: FAKE_TOKEN, log, secrets, deadLetter: () => undefined }) }
}

const sentTexts = (api: FakeBotApi): string[] =>
  api.calls.filter(call => call.method === 'sendMessage').map(call => String(call.payload.text))

// ─── S3: a value the marker cannot hide ────────────────────────────────

test('[S3] a registered value equal to the marker fails closed instead of passing unchanged', async () => {
  expect(() => mask({ text: 'итог [REDACTED]', entities: [] }, ['[REDACTED]'])).toThrow(MaskFixedPointError)
  const { api, telegram } = stack(['[REDACTED]'])
  await expect(telegram.safeTelegram.sendMessage(OWNER, 'итог [REDACTED]', {})).rejects.toBeInstanceOf(MaskFixedPointError)
  expect(api.calls).toHaveLength(0)
  // A value that holds the marker is replaced by it and settles.
  expect(mask({ text: 'a [REDACTED]42 b', entities: [] }, ['[REDACTED]42']).text).toBe('a [REDACTED] b')
})

// ─── S2: the seam between pieces ───────────────────────────────────

test('[S2] the wire guard checks the seam on every attempt: a value registered during a 429 wait is masked', async () => {
  const secrets: string[] = []
  const { api, telegram } = stack(secrets)
  api.answerNext('sendMessage', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1',
    parameters: { retry_after: 1 } })
  const sending = telegram.safeTelegram.sendMessage(OWNER, 'SKME tail', { entities: [], sentBefore: 'xxMA' })
  while (api.calls.length === 0) await Bun.sleep(5)
  secrets.push(VALUE)
  await sending
  expect(sentTexts(api)).toEqual(['SKME tail', '[REDACTED] tail'])
  expect(api.calls.every(call => call.payload.sentBefore === undefined)).toBe(true)
})

// ─── S4 / B1: buttons and file names at the wire ───────────────────────

test('[S4] inline buttons go through the wire guard on every attempt, also on a value registered during a wait', async () => {
  const secrets: string[] = []
  const { api, telegram } = stack(secrets)
  api.answerNext('sendMessage', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1',
    parameters: { retry_after: 1 } })
  const markup = { inline_keyboard: [[{ text: `ключ ${LATE}`, url: `https://example.org/?k=${LATE}` },
    { text: 'ok', callback_data: 'cb' }]] }
  const sending = telegram.safeTelegram.sendMessage(OWNER, 'вопрос', { reply_markup: markup })
  while (api.calls.length === 0) await Bun.sleep(5)
  secrets.push(LATE)
  await sending
  const sends = api.calls.filter(call => call.method === 'sendMessage')
  expect(sends).toHaveLength(2)
  expect(json(sends[1]!.payload)).not.toContain(LATE)
  expect(sends[1]!.payload.reply_markup).toEqual({ inline_keyboard: [[
    { text: 'ключ [REDACTED]', url: 'https://example.org/?k=[REDACTED]' }, { text: 'ok', callback_data: 'cb' }]] })
})

test('[S4] the raw adapter masks button text and url of a send and an edit itself', async () => {
  const api = fakeBotApi()
  apis.push(api)
  const raw = createTelegramApi(api.bot, FAKE_TOKEN, visible => mask(visible, [VALUE]))
  const markup = { inline_keyboard: [[{ text: VALUE, url: `https://example.org/${VALUE}` }]] }
  await raw.sendMessage(OWNER, 'a', { entities: [], reply_markup: markup })
  await raw.editMessageText(OWNER, 5, 'b', { entities: [], reply_markup: markup })
  expect(api.calls.map(call => call.method)).toEqual(['sendMessage', 'editMessageText'])
  for (const call of api.calls) expect(json(call.payload)).not.toContain(VALUE)
})

test('[S4][B1] the effective upload file name is masked: an explicit one and the one taken from the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-mask-seams-'))
  dirs.push(dir)
  const named = join(dir, `${VALUE}-notes.txt`)
  writeFileSync(named, 'notes')
  const { api, telegram } = stack()
  await telegram.safeTelegram.sendDocument(OWNER, named, { caption: `файл ${VALUE}` })
  await telegram.safeTelegram.sendDocument(OWNER, named, { filename: `${VALUE}.txt` })
  await telegram.safeTelegram.sendPhoto(OWNER, named, { filename: `${VALUE}.png` })
  const uploads = api.calls.filter(call => call.method === 'sendDocument' || call.method === 'sendPhoto')
  expect(uploads).toHaveLength(3)
  expect(uploads.map(call => call.files)).toEqual([['[REDACTED]-notes.txt'], ['[REDACTED].txt'], ['[REDACTED].png']])
  for (const call of uploads) expect(json(call.payload)).not.toContain(VALUE)
  // The raw adapter guards the name on its own, so a value registered after the wrapper ran is masked too.
  const rawApi = fakeBotApi()
  apis.push(rawApi)
  await createTelegramApi(rawApi.bot, FAKE_TOKEN, visible => mask(visible, [VALUE])).sendDocument(OWNER, named, {})
  expect(rawApi.calls[0]?.files).toEqual(['[REDACTED]-notes.txt'])
})

// ─── S7: guest answers and rich edits ──────────────────────────────────

const entityRefusal: FakeAnswer = { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported" }

test('[S7] a guest answer whose entities Telegram refuses goes once more as the same text without them', async () => {
  const { api, telegram } = stack()
  api.answerNext('answerGuestQuery', entityRefusal)
  await telegram.safeTelegram.answerGuestQuery('q1', '<b>Итог</b> готово MASKME', { parse_mode: 'HTML' })
  const calls = api.calls.filter(call => call.method === 'answerGuestQuery')
  expect(calls.map(call => call.payload.result)).toEqual([
    { type: 'article', id: 'answer', title: 'Ответ', input_message_content: {
      message_text: 'Итог готово [REDACTED]', entities: [{ type: 'bold', offset: 0, length: 4 }] } },
    { type: 'article', id: 'answer', title: 'Ответ', input_message_content: {
      message_text: 'Итог готово [REDACTED]', entities: [] } },
  ])
})

test('[S7] a rich edit whose entities Telegram refuses is retried as the same text without them', async () => {
  const { api, telegram } = stack()
  api.answerNext('editMessageText', entityRefusal)
  await telegram.safeTelegram.editRichMessage!(OWNER, 9, '**Итог** MASKME')
  const edits = api.calls.filter(call => call.method === 'editMessageText')
  expect(edits.map(call => [call.payload.text, call.payload.entities])).toEqual([
    ['Итог [REDACTED]', [{ type: 'bold', offset: 0, length: 4 }]],
    ['Итог [REDACTED]', []],
  ])
})

// ─── Non-blocking: a viable cut before the document fallback ───────────

test('a blank run longer than a message is cut where the next piece still shows text, not sent as a document', () => {
  const text = 'A\n\n' + ' '.repeat(4000) + 'B'
  expect(cutPoints(text, 4000)).toEqual([4, text.length])
})
