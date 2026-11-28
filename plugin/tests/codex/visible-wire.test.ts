// Slice 1 acceptance: what leaves the process is the text Telegram shows plus entities, never markup. Runs the
// production stack (grammY → rate limiter → safe wrapper) against a fake Bot API and checks every captured
// request: no registered value in the text, no parse_mode, no link target carrying the value, entities in bounds.
import { afterEach, expect, test } from 'bun:test'

import { createTelegramStack } from '../../src/codex/telegram-stack.js'
import { createLogger } from '../../src/log.js'
import { FAKE_TOKEN, fakeBotApi, type CapturedCall, type FakeBotApi } from './fake-bot-api.js'

const OWNER = '42'
const VALUE = 'MASKME'
// A pattern rule's match (Bearer + opaque word); a placeholder, not a credential.
const BEARER_WORD = 'PLACEHOLDERWORD'
const log = createLogger('visible-wire-test')

const apis: FakeBotApi[] = []
afterEach(() => { for (const api of apis.splice(0)) api.stop() })

function stack(secrets: string[] = [VALUE]): { api: FakeBotApi; telegram: ReturnType<typeof createTelegramStack> } {
  const api = fakeBotApi()
  apis.push(api)
  return { api, telegram: createTelegramStack({ bot: api.bot, token: FAKE_TOKEN, log, secrets, deadLetter: () => undefined }) }
}

interface WireEntity { type: string; offset: number; length: number; url?: string }

function wireEntities(call: CapturedCall): WireEntity[] {
  const raw = call.payload.entities
  if (raw === undefined) return []
  expect(Array.isArray(raw)).toBe(true)
  return (Array.isArray(raw) ? raw : []).map((entity: unknown) => {
    expect(typeof entity).toBe('object')
    const record = entity !== null && typeof entity === 'object' ? entity : {}
    const type = 'type' in record && typeof record.type === 'string' ? record.type : ''
    const offset = 'offset' in record && typeof record.offset === 'number' ? record.offset : -1
    const length = 'length' in record && typeof record.length === 'number' ? record.length : -1
    const url = 'url' in record && typeof record.url === 'string' ? record.url : undefined
    return { type, offset, length, ...(url === undefined ? {} : { url }) }
  })
}

function expectSafe(call: CapturedCall): WireEntity[] {
  const text = call.payload.text
  expect(typeof text).toBe('string')
  const shown = typeof text === 'string' ? text : ''
  expect(shown).not.toContain(VALUE)
  expect(shown).not.toContain(BEARER_WORD)
  expect(call.payload.parse_mode).toBeUndefined()
  const entities = wireEntities(call)
  for (const entity of entities) {
    expect(entity.offset).toBeGreaterThanOrEqual(0)
    expect(entity.length).toBeGreaterThan(0)
    expect(entity.offset + entity.length).toBeLessThanOrEqual(shown.length)
    expect(entity.url ?? '').not.toContain(VALUE)
  }
  return entities
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['markup inside a value', `<b>Итог</b>: MA<b>SK</b>ME`],
  ['a numeric entity inside a value', `<b>Итог</b>: MA&#83;KME`],
  ['a value in a hidden link target, completed by its label', `<b>Итог</b>: <a href="https://x/?k=${VALUE}">MA</a>SKME`],
  ['markup between a pattern prefix and its word', `<b>Итог</b>: Bearer <i>${BEARER_WORD}</i>`],
]

for (const [name, html] of CASES) {
  test(`sendMessage through the real stack: ${name}`, async () => {
    const { api, telegram } = stack()
    await telegram.safeTelegram.sendMessage(OWNER, html, { parse_mode: 'HTML' })
    const sends = api.calls.filter(call => call.method === 'sendMessage')
    expect(sends).toHaveLength(1)
    const entities = expectSafe(sends[0]!)
    // The formatting the reader sees is kept beside the masked text.
    expect(entities).toContainEqual({ type: 'bold', offset: 0, length: 4 })
  })

  test(`editMessageText through the real stack: ${name}`, async () => {
    const { api, telegram } = stack()
    await telegram.safeTelegram.editMessageText(OWNER, 77, html, { parse_mode: 'HTML' })
    const edits = api.calls.filter(call => call.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(expectSafe(edits[0]!)).toContainEqual({ type: 'bold', offset: 0, length: 4 })
  })
}

test('a link without a value keeps its target as a text_link entity', async () => {
  const { api, telegram } = stack()
  await telegram.safeTelegram.sendMessage(OWNER, 'См. <a href="https://example.org/a?b=1&amp;c=2">док</a>', { parse_mode: 'HTML' })
  const [send] = api.calls.filter(call => call.method === 'sendMessage')
  expect(send?.payload.text).toBe('См. док')
  expect(expectSafe(send!)).toEqual([{ type: 'text_link', offset: 4, length: 3, url: 'https://example.org/a?b=1&c=2' }])
})

test('the sent record carries the masked shown text, drawn as HTML for render records', async () => {
  const { telegram } = stack()
  const result = await telegram.safeTelegram.sendMessage(OWNER, 'MA<b>SK</b>ME и <i>всё</i>', { parse_mode: 'HTML' })
  expect(result.sent).toEqual({ text: '[REDACTED] и <i>всё</i>', format: 'HTML' })
  const plain = await telegram.safeTelegram.sendMessage(OWNER, 'просто MASKME', {})
  expect(plain.sent).toEqual({ text: 'просто [REDACTED]', format: 'plain' })
})
