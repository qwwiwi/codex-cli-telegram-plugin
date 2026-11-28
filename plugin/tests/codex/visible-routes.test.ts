// Slice 2 acceptance: every remaining outbound route carries the masked shown text. Runs the production stack
// against a fake Bot API: a value registered while the rate limiter waits to retry, the guest answer, a
// Markdown table (rich messages are off), a component (widgets are off), captions.
import { afterEach, expect, test } from 'bun:test'

import { planGuestAnswer } from '../../src/channel/tools.js'
import { AgentComponents } from '../../src/codex/components.js'
import { createTelegramStack } from '../../src/codex/telegram-stack.js'
import { markdownToTelegramHtml } from '../../src/format/html.js'
import { createLogger } from '../../src/log.js'
import { MaskedOverflowError } from '../../src/safety/pre-send-error.js'
import { FAKE_TOKEN, fakeBotApi, type FakeBotApi } from './fake-bot-api.js'

const OWNER = '42'
const VALUE = 'MASKME'
const LATE = 'MASKLATE'
const log = createLogger('visible-routes-test')

const apis: FakeBotApi[] = []
afterEach(() => { for (const api of apis.splice(0)) api.stop() })

function stack(secrets: string[] = [VALUE]): { api: FakeBotApi; telegram: ReturnType<typeof createTelegramStack> } {
  const api = fakeBotApi()
  apis.push(api)
  return { api, telegram: createTelegramStack({ bot: api.bot, token: FAKE_TOKEN, log, secrets, deadLetter: () => undefined }) }
}

const json = (value: unknown): string => JSON.stringify(value)

test('(a) a value registered while the rate limiter sleeps before a retry is masked in the retried request', async () => {
  const secrets = [VALUE]
  const { api, telegram } = stack(secrets)
  api.answerNext('sendMessage', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1',
    parameters: { retry_after: 1 } })
  const sending = telegram.safeTelegram.sendMessage(OWNER, `итог ${LATE} конец`, {})
  while (api.calls.length === 0) await Bun.sleep(5)
  // The first attempt was refused, so nothing was shown; the value is registered during the wait.
  secrets.push(LATE)
  await sending
  const sends = api.calls.filter(call => call.method === 'sendMessage')
  expect(sends).toHaveLength(2)
  expect(sends[1]!.payload.text).toBe('итог [REDACTED] конец')
})

test('(b) a guest answer carries the masked shown text and entities, never a parse_mode', async () => {
  const { api, telegram } = stack()
  await telegram.safeTelegram.answerGuestQuery('q1', '<b>Итог</b>: MA<b>SK</b>ME', { parse_mode: 'HTML' })
  const [call] = api.calls.filter(entry => entry.method === 'answerGuestQuery')
  expect(call).toBeDefined()
  expect(json(call!.payload)).not.toContain(VALUE)
  expect(json(call!.payload)).not.toContain('parse_mode')
  expect(call!.payload.result).toMatchObject({
    type: 'article',
    input_message_content: { message_text: 'Итог: [REDACTED]', entities: [{ type: 'bold', offset: 0, length: 4 }] },
  })
})

test('(b) a guest file answer masks its caption and title; a caption masking grows past 1024 is refused pre-send', async () => {
  const { api, telegram } = stack()
  await telegram.safeTelegram.answerGuestQuery('q2', '<i>MASK</i>ME', {
    parse_mode: 'HTML', file: { kind: 'document', fileId: 'file-1', title: `${VALUE}.txt` },
  })
  const [call] = api.calls.filter(entry => entry.method === 'answerGuestQuery')
  expect(json(call!.payload)).not.toContain(VALUE)
  expect(call!.payload.result).toMatchObject({ type: 'document', caption: '[REDACTED]', caption_entities: [] })
  // `MASKME` (6) becomes `[REDACTED]` (10): 120 of them (839 units) fit 1024 before masking and not after.
  const long = Array.from({ length: 120 }, () => VALUE).join(' ')
  await expect(telegram.safeTelegram.answerGuestQuery('q3', long, {
    file: { kind: 'document', fileId: 'file-1', title: 'a.txt' },
  })).rejects.toBeInstanceOf(MaskedOverflowError)
  expect(api.calls.filter(entry => entry.method === 'answerGuestQuery')).toHaveLength(1)
})

test('(b) the guest caption is measured masked before the staging upload', () => {
  const long = Array.from({ length: 120 }, () => VALUE).join(' ')
  expect(long.length).toBeLessThanOrEqual(1024)
  const refused = planGuestAnswer(long, 'text', true, [VALUE])
  expect('refusal' in refused && refused.refusal).toContain('1024')
  expect(planGuestAnswer('**коротко**', 'html', true, [VALUE])).toEqual({ body: '<b>коротко</b>', parseMode: 'HTML' })
})

test('(c) a Markdown table with a value across cell formatting: zero rich sends, one text message, value absent', async () => {
  const { api, telegram } = stack()
  const markdown = '| Ключ | Значение |\n|---|---|\n| a | MA**SK**ME |\n'
  const rich = await telegram.safeTelegram.sendRichMessage(OWNER, markdown, {})
  expect(rich).toEqual({ fallback: true })
  await telegram.safeTelegram.sendMessage(OWNER, markdownToTelegramHtml(markdown), { parse_mode: 'HTML' })
  expect(api.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0)
  const sends = api.calls.filter(call => call.method === 'sendMessage')
  expect(sends).toHaveLength(1)
  expect(json(sends[0]!.payload)).not.toContain(VALUE)
  expect(sends[0]!.payload.entities).toEqual([{ type: 'pre', offset: 0, length: String(sends[0]!.payload.text).length }])
})

test('(c) a Rich Message edit goes as a text + entities edit', async () => {
  const { api, telegram } = stack()
  const result = await telegram.safeTelegram.editRichMessage!(OWNER, 9, '**Итог** MA**SK**ME')
  expect(api.calls.map(call => call.method)).toEqual(['editMessageText'])
  const [edit] = api.calls
  expect(edit!.payload.rich_message).toBeUndefined()
  expect(edit!.payload.text).toBe('Итог [REDACTED]')
  expect(edit!.payload.entities).toEqual([{ type: 'bold', offset: 0, length: 4 }])
  expect(result.sent).toEqual({ text: '<b>Итог</b> [REDACTED]', format: 'HTML' })
})

test('(d) send_component with data fields MA + SKME: zero widget sends, the data arrives as text', async () => {
  const { api, telegram } = stack()
  const components = new AgentComponents(telegram.safeTelegram, OWNER)
  const outcome = await components.run('send_component',
    { component: 'kpi', data: { title: 'MA', metrics: [{ label: 'SKME', value: 12 }] } }, () => true)
  expect(outcome).toMatchObject({ ok: true, delivery: 'text' })
  expect(api.calls.filter(call => call.method === 'sendWidget')).toHaveLength(0)
  expect(api.calls.filter(call => call.method === 'sendMessage')).toHaveLength(1)
})

test('captions on photos and documents are masked and sent with caption entities', async () => {
  const { api, telegram } = stack()
  await telegram.safeTelegram.sendDocument(OWNER, import.meta.path, { caption: `файл ${VALUE}` })
  const [call] = api.calls.filter(entry => entry.method === 'sendDocument')
  expect(call).toBeDefined()
  // A multipart upload: the fake server reads no JSON body, so only the masking result is checked here.
  const refused = telegram.safeTelegram.sendPhoto(OWNER, import.meta.path,
    { caption: Array.from({ length: 120 }, () => VALUE).join(' ') })
  await expect(refused).rejects.toBeInstanceOf(MaskedOverflowError)
  expect(api.calls.filter(entry => entry.method === 'sendPhoto')).toHaveLength(0)
})
