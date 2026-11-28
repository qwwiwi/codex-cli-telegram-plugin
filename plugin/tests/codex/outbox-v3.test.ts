// Slice 4 acceptance: the outbox keeps one item per reply (its masked shown text and cuts) and upgrades saved
// v2 parts to it on load. A value cut across two saved parts is masked in the joined text, a body that masking
// grows past the limit is cut again, the file at rest holds no value, and re-cutting never evicts a neighbour.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import type { SendMessageOpts, TelegramApi } from '../../src/channel/tools.js'
import { createLogger } from '../../src/log.js'
import { Outbox } from '../../src/safety/outbox.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

const VALUE = 'MASKME'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function stateDir(items?: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-outbox-v3-'))
  dirs.push(dir)
  if (items) writeFileSync(join(dir, 'outbox.json'), JSON.stringify(items))
  return dir
}

interface Wire { text: string; opts: SendMessageOpts }

// The production re-send: the safe wrapper (masking choke point) over a recording raw transport.
function open(dir: string, secrets: string[], warnings: string[] = [], maxItems?: number): { outbox: Outbox; wire: Wire[] } {
  const wire: Wire[] = []
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const raw: TelegramApi = {
    ...fakeTelegramChat().raw,
    async sendMessage(_chat, text, opts) {
      // Telegram refuses a message over its limit.
      if (text.length > 4096) throw Object.assign(new Error('Bad Request: message is too long'), { error_code: 400 })
      wire.push({ text, opts })
      return { message_id: 100 + wire.length }
    },
  }
  const safe = createSafeTelegramApi(raw, createLogger('test', { stream: quiet }), secrets)
  const log = { ...createLogger('test', { stream: quiet }), warn: (message: string) => { warnings.push(message) } }
  const outbox = new Outbox({ stateDir: dir, log, now: () => 0, secrets, ...(maxItems ? { maxItems } : {}),
    sendFn: (chat, text, opts) => safe.sendMessage(chat, text, opts) })
  return { outbox, wire }
}

const html: SendMessageOpts = { parse_mode: 'HTML', ownerReply: true }

test('v2 parts of one reply with a value across their cut become one masked item; a grown body is cut again', async () => {
  const long = 'ж'.repeat(4090) + VALUE
  const dir = stateDir([
    { v: 2, id: 'a', chatId: '1', text: '<b>Ключ: MAS</b>', opts: { ...html, reply_to_message_id: 9 }, notBefore: 10, attempts: 1 },
    { v: 2, id: 'b', chatId: '1', text: 'KME хвост', opts: html, notBefore: 20, attempts: 3, brainKey: 'k1' },
    { v: 2, id: 'c', chatId: '1', text: long, opts: { ownerReply: true, reply_to_message_id: 11 }, notBefore: 0, attempts: 0 },
  ])
  const { outbox, wire } = open(dir, [VALUE])
  const file = readFileSync(join(dir, 'outbox.json'), 'utf8')
  expect(file).not.toContain(VALUE)
  expect(file).not.toContain('KME')
  const items = outbox.snapshot()
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ v: 3, id: 'a', notBefore: 20, attempts: 3, brainKey: 'k1', sent: 0,
    plan: { text: 'Ключ: [REDACTED] хвост' } })
  // A second load changes no byte.
  open(dir, [VALUE])
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toBe(file)
  await outbox.flushDue(10_000)
  expect(wire.map(message => message.text)).toEqual(['Ключ: [REDACTED] хвост', 'ж'.repeat(4000), 'ж'.repeat(90) + '[REDACTED]'])
  expect(wire[0]?.opts.reply_to_message_id).toBe(9)
  // The bold span ended inside the value: it is clipped to the text that survived masking.
  expect(wire[0]?.opts.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }])
  expect(wire[1]?.opts.reply_to_message_id).toBe(11)
  expect(wire[2]?.opts.reply_to_message_id).toBeUndefined()
  for (const message of wire) expect(message.opts.parse_mode).toBeUndefined()
  expect(outbox.size()).toBe(0)
})

test('a value registered after the enqueue re-cuts its reply at the flush and evicts no other reply', async () => {
  const dir = stateDir()
  const secrets: string[] = []
  const warnings: string[] = []
  const { outbox, wire } = open(dir, secrets, warnings, 2)
  // 4,096 shown characters fit one message; once MASKME reads [REDACTED] they do not.
  outbox.enqueue('1', 'а'.repeat(4090) + VALUE, { ownerReply: true }, 0)
  outbox.enqueue('1', 'второй ответ', { ownerReply: true }, 0)
  secrets.push(VALUE)
  expect(outbox.size()).toBe(2)
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['а'.repeat(4000), 'а'.repeat(90) + '[REDACTED]', 'второй ответ'])
  expect(warnings.filter(message => message.includes('overflow') || message.includes('dropped'))).toEqual([])
  expect(outbox.size()).toBe(0)
})

test('a reply stopped by a flood after its first piece resumes with the next piece, under one item', async () => {
  const dir = stateDir()
  const secrets: string[] = []
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const sent: string[] = []
  let floods = 0
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0, secrets,
    sendFn: async (_chat, text) => {
      if (sent.length === 1 && floods === 0) {
        floods += 1
        throw { error_code: 429, parameters: { retry_after: 5 } }
      }
      sent.push(text)
      return { message_id: 200 + sent.length }
    } })
  // No line break: the message limit cuts the value itself, after `MA`.
  outbox.enqueue('1', 'б'.repeat(3998) + 'MASKME конец', { ownerReply: true }, 0)
  await outbox.flushDue(1_000)
  expect(sent).toHaveLength(1)
  expect(outbox.snapshot()[0]).toMatchObject({ sent: 1 })
  secrets.push(VALUE)
  await outbox.flushDue(10_000)
  expect(sent).toHaveLength(2)
  // The sent piece ended in `MA`: the whole marker lands in the pending piece, `SKME` never goes out.
  expect(sent[0]).toBe('б'.repeat(3998) + 'MA')
  expect(sent[1]).toBe('[REDACTED] конец')
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).not.toContain('SKME')
  expect(outbox.size()).toBe(0)
})

test('[S2] a value registered between two pieces of one flush is masked across the cut, also at the wire', async () => {
  const dir = stateDir()
  const secrets: string[] = []
  const { outbox, wire } = open(dir, secrets)
  outbox.enqueue('1', 'в'.repeat(3998) + 'MASKME конец', { ownerReply: true }, 0)
  // The value is registered the moment the first piece reaches the transport.
  const record = wire.push.bind(wire)
  wire.push = (...messages: Wire[]): number => {
    const length = record(...messages)
    if (!secrets.includes(VALUE)) secrets.push(VALUE)
    return length
  }
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['в'.repeat(3998) + 'MA', '[REDACTED] конец'])
  // The piece carries the plan's text before it (the swallowed `MA` now lies in the marker), so the wire guard
  // can recheck the seam on a retry.
  expect(wire[1]?.opts.sentBefore).toBe('в'.repeat(3998))
  expect(outbox.size()).toBe(0)
})

test('a saved reply that can no longer be cut into messages goes as a document and keeps its neighbours', async () => {
  // A blank run past the message limit right after a line break: no message cut is possible.
  const blank = 'а\n' + ' '.repeat(8000) + 'б'
  const dir = stateDir([
    { v: 3, id: 'x', chatId: '1', plan: { v: 3, text: blank, entities: [], cuts: [2, blank.length] }, sent: 0,
      opts: { ownerReply: true }, notBefore: 0, attempts: 0 },
    { v: 3, id: 'y', chatId: '1', plan: { v: 3, text: 'сосед', entities: [], cuts: [5] }, sent: 0,
      opts: { ownerReply: true }, notBefore: 0, attempts: 0 },
  ])
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const messages: string[] = []
  const documents: string[] = []
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0, secrets: [],
    sendFn: async (_chat, text) => { messages.push(text); return { message_id: 1 } },
    sendDocument: async (_chat, text) => { documents.push(text); return { message_id: 2 } } })
  expect(outbox.snapshot().map(item => [item.id, item.document === true])).toEqual([['x', true], ['y', false]])
  await outbox.flushDue(1_000)
  expect(documents).toEqual([blank])
  expect(messages).toEqual(['сосед'])
  expect(outbox.size()).toBe(0)
})
