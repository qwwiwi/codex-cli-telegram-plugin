// Fix loop 1 of the masking rebuild, the new seams: the tool reply sender (rendered, masked as one text, then cut),
// maskPiece (a piece masked as the continuation of what was sent before it), the guest answer plan (refused when
// too long, never truncated) and the pure entity-refusal matcher.
import { afterEach, expect, test } from 'bun:test'

import { planGuestAnswer, sendTextReply, type TelegramApi } from '../../src/channel/tools.js'
import { createTelegramStack } from '../../src/codex/telegram-stack.js'
import { maskPiece } from '../../src/format/visible.js'
import { createLogger } from '../../src/log.js'
import { isEntityRejection } from '../../src/safety/safe-telegram-api.js'
import { FAKE_TOKEN, fakeBotApi, type FakeBotApi } from './fake-bot-api.js'

const OWNER = '42'
const VALUE = 'MASKME'
const log = createLogger('mask-seams-api-test')

const apis: FakeBotApi[] = []
afterEach(() => { for (const api of apis.splice(0)) api.stop() })

function stack(secrets: string[] = [VALUE]): { api: FakeBotApi; telegram: ReturnType<typeof createTelegramStack> } {
  const api = fakeBotApi()
  apis.push(api)
  return { api, telegram: createTelegramStack({ bot: api.bot, token: FAKE_TOKEN, log, secrets, deadLetter: () => undefined }) }
}

const sentTexts = (api: FakeBotApi): string[] =>
  api.calls.filter(call => call.method === 'sendMessage').map(call => String(call.payload.text))

test('[S1] a tool reply is masked as one text before it is cut: no piece carries the rest of the value', async () => {
  const { api, telegram } = stack()
  const sentIds: number[] = []
  await sendTextReply(telegram.safeTelegram, OWNER, 'x '.repeat(1999) + 'MASKME tail', 'text', { secrets: [VALUE] }, sentIds)
  const texts = sentTexts(api)
  expect(texts.length).toBe(2)
  expect(sentIds).toHaveLength(2)
  for (const text of texts) {
    expect(text).not.toContain('SKME')
    expect(text.endsWith('MA')).toBe(false)
  }
  expect(texts.join('')).toBe('x '.repeat(1999) + '[REDACTED] tail')
})

test('[S1] an HTML tool reply keeps its formatting as entities and masks a value split by markup', async () => {
  const { api, telegram } = stack()
  await sendTextReply(telegram.safeTelegram, OWNER, '**Итог**: MA**SK**ME', 'html', { secrets: [VALUE] }, [])
  const [send] = api.calls.filter(call => call.method === 'sendMessage')
  expect(send?.payload.text).toBe('Итог: [REDACTED]')
  expect(send?.payload.parse_mode).toBeUndefined()
  expect(send?.payload.entities).toEqual([{ type: 'bold', offset: 0, length: 4 }])
})

test('[S2] a value registered after a tool reply piece landed: the next piece starts with the marker', async () => {
  const secrets: string[] = []
  const { api, telegram } = stack(secrets)
  const raw = telegram.safeTelegram
  const registering: TelegramApi = { ...raw, async sendMessage(chat, text, opts) {
    const sent = await raw.sendMessage(chat, text, opts)
    if (!secrets.includes(VALUE)) secrets.push(VALUE)
    return sent
  } }
  await sendTextReply(registering, OWNER, 'x '.repeat(1999) + 'MASKME tail', 'text', { secrets }, [])
  const texts = sentTexts(api)
  expect(texts).toHaveLength(2)
  expect(texts[0]!.endsWith('MA')).toBe(true)
  expect(texts[1]).toBe('[REDACTED] tail')
})

test('[S2] maskPiece masks the piece as the continuation of the text sent before it', () => {
  expect(maskPiece({ text: 'SKME tail', entities: [{ type: 'bold', offset: 0, length: 4 }] }, [VALUE], 'xxMA'))
    .toEqual({ text: '[REDACTED] tail', entities: [] })
  expect(maskPiece({ text: 'tail', entities: [{ type: 'bold', offset: 0, length: 4 }] }, [VALUE], 'a MASKME '))
    .toEqual({ text: 'tail', entities: [{ type: 'bold', offset: 0, length: 4 }] })
  expect(maskPiece({ text: 'MASKME', entities: [] }, [VALUE])).toEqual({ text: '[REDACTED]', entities: [] })
})

test('[S7] a guest answer longer than one message is refused before staging, never truncated', () => {
  const long = 'слово '.repeat(800)
  const refused = planGuestAnswer(long, 'text', false, [])
  expect('refusal' in refused && refused.refusal).toContain('4096')
  // Masking counts: 120 values fit the caption limit unmasked and not masked.
  const values = Array.from({ length: 120 }, () => VALUE).join(' ')
  const caption = planGuestAnswer(values, 'text', true, [VALUE])
  expect('refusal' in caption && caption.refusal).toContain('1024')
  // Markup is free: the shown text is what counts.
  expect(planGuestAnswer('**' + 'а'.repeat(4090) + '**', 'html', false, [])).toEqual({
    body: '<b>' + 'а'.repeat(4090) + '</b>', parseMode: 'HTML' })
})

test('[N5] isEntityRejection matches explicit-entity 400s and nothing else', () => {
  const bad = (description: string, code = 400) => ({ error_code: code, description, message: description })
  // Descriptions are test placeholders in the shapes the reviews name, not captured Telegram strings.
  expect(isEntityRejection(bad("Bad Request: can't parse entities: Unsupported start tag"))).toBe(true)
  expect(isEntityRejection(bad('Bad Request: ENTITY_BOUNDS_INVALID'))).toBe(true)
  expect(isEntityRejection(bad('Bad Request: ENTITY_TEXT_INVALID'))).toBe(true)
  expect(isEntityRejection(bad('Bad Request: entity end is out of bounds'))).toBe(true)
  expect(isEntityRejection(bad('Bad Request: entity offset is invalid'))).toBe(true)
  expect(isEntityRejection(bad('Bad Request: message is too long'))).toBe(false)
  expect(isEntityRejection(bad('Bad Request: chat not found'))).toBe(false)
  expect(isEntityRejection(bad("Bad Request: can't parse entities", 429))).toBe(false)
  expect(isEntityRejection(new Error("can't parse entities"))).toBe(false)
  expect(isEntityRejection(undefined)).toBe(false)
})
