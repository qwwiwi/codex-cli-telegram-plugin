// Outbox regressions: masking between the sends of one flush, a checkpoint per
// delivered piece, legacy v2 grouping, Brain receipts, question snippets at rest, collapsed sent cuts on reload and
// items evicted while a flush is in flight.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import type { SendMessageOpts } from '../../src/channel/tools.js'
import { mainOrigin } from '../../src/codex/turn-origin.js'
import { createLogger } from '../../src/log.js'
import { Outbox, type OutboxSendFn } from '../../src/safety/outbox.js'
import { redactOutboundText } from '../../src/safety/safe-telegram-api.js'

const VALUE = 'MASKME'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function stateDir(items?: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-outbox-loop2-'))
  dirs.push(dir)
  if (items) writeFileSync(join(dir, 'outbox.json'), JSON.stringify(items))
  return dir
}

const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })

interface Wire { chat: string; text: string; opts: SendMessageOpts }

// An outbox over a RAW recording transport (no safe wrapper): whatever it sends, it masked itself.
function open(dir: string, secrets: string[], options: { sendFn?: OutboxSendFn; maxItems?: number;
  delivered?: (string | undefined)[]; redact?: boolean } = {}): { outbox: Outbox; wire: Wire[] } {
  const wire: Wire[] = []
  const sendFn: OutboxSendFn = options.sendFn ?? (async (chat, text, opts) => {
    wire.push({ chat, text, opts })
    return { message_id: 100 + wire.length }
  })
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0, secrets,
    sendFn, ...(options.maxItems ? { maxItems: options.maxItems } : {}),
    ...(options.redact ? { redact: (text: string, mode: SendMessageOpts['parse_mode']) =>
      redactOutboundText(text, mode, secrets) } : {}),
    ...(options.delivered ? { onDelivered: (item: { brainKey?: string }) => { options.delivered?.push(item.brainKey) } } : {}) })
  return { outbox, wire }
}

function file(dir: string): string {
  return readFileSync(join(dir, 'outbox.json'), 'utf8')
}

test('[C1] a value registered after the first send of a flush is masked by the outbox itself in the next request', async () => {
  const dir = stateDir()
  const secrets: string[] = []
  const wire: Wire[] = []
  const { outbox } = open(dir, secrets, { sendFn: async (chat, text, opts) => {
    wire.push({ chat, text, opts })
    if (!secrets.includes(VALUE)) secrets.push(VALUE)
    return { message_id: wire.length }
  } })
  // No line break: the message limit cuts the value itself, after `MA`.
  outbox.enqueue('1', 'г'.repeat(3998) + 'MASKME конец', { ownerReply: true }, 0)
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['г'.repeat(3998) + 'MA', '[REDACTED] конец'])
})

test('[H1] each delivered piece is on disk before the next send starts: a restart mid-flush resends nothing', async () => {
  const dir = stateDir()
  const sent: string[] = []
  let release: (() => void) | undefined
  const { outbox } = open(dir, [], { sendFn: async (_chat, text) => {
    sent.push(text)
    // The second request hangs, like a process that stops mid-flush.
    if (sent.length === 2) await new Promise<void>(resolve => { release = resolve })
    return { message_id: sent.length }
  } })
  outbox.enqueue('1', 'д'.repeat(4000) + 'хвост', { ownerReply: true }, 0)
  const flushing = outbox.flushDue(1_000)
  for (let tick = 0; tick < 10 && release === undefined; tick++) await Promise.resolve()
  expect(sent).toHaveLength(2)
  // A process started now reads the queue as the first piece left it.
  const restarted = open(dir, [])
  expect(restarted.outbox.snapshot()).toMatchObject([{ sent: 1 }])
  await restarted.outbox.flushDue(1_000)
  expect(restarted.wire.map(message => message.text)).toEqual(['хвост'])
  release?.()
  await flushing
})

test('[H2] v2 parts of one reply with different piece-local entities join and mask as one text', async () => {
  const dir = stateDir([
    { v: 2, id: 'a', chatId: '1', text: 'MAS', notBefore: 0, attempts: 0,
      opts: { ownerReply: true, reply_to_message_id: 9, entities: [{ type: 'bold', offset: 0, length: 3 }] } },
    { v: 2, id: 'b', chatId: '1', text: 'KME', notBefore: 0, attempts: 0, opts: { ownerReply: true, entities: [] } },
  ])
  const { outbox, wire } = open(dir, [VALUE])
  expect(outbox.snapshot()).toMatchObject([{ id: 'a', plan: { text: '[REDACTED]' } }])
  expect(file(dir)).not.toContain('MAS')
  expect(file(dir)).not.toContain('KME')
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['[REDACTED]'])
})

test('[H3] two adjacent unquoted v2 replies with their own Brain keys stay two replies; both receipts fire', async () => {
  const dir = stateDir([
    { v: 2, id: 'a', chatId: '1', text: 'первый', opts: { ownerReply: true }, notBefore: 0, attempts: 0, brainKey: 'k1' },
    { v: 2, id: 'b', chatId: '1', text: 'второй', opts: { ownerReply: true }, notBefore: 0, attempts: 0, brainKey: 'k2' },
  ])
  const delivered: (string | undefined)[] = []
  const { outbox, wire } = open(dir, [], { delivered })
  expect(outbox.snapshot().map(item => item.brainKey)).toEqual(['k1', 'k2'])
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['первый', 'второй'])
  expect(delivered).toEqual(['k1', 'k2'])
})

test('[H3] an unversioned reply redacted across its parts keeps its Brain key; the next reply keeps its own', async () => {
  const dir = stateDir([
    { id: 'a', chatId: '1', text: 'Ключ: MAS', opts: { ownerReply: true, reply_to_message_id: 9 }, notBefore: 0, attempts: 0 },
    { id: 'b', chatId: '1', text: 'KME', opts: { ownerReply: true }, notBefore: 0, attempts: 0, brainKey: 'k1' },
    { id: 'c', chatId: '1', text: 'следующий', opts: { ownerReply: true }, notBefore: 0, attempts: 0, brainKey: 'k2' },
  ])
  const delivered: (string | undefined)[] = []
  const { outbox, wire } = open(dir, [VALUE], { delivered, redact: true })
  await outbox.flushDue(1_000)
  expect(wire.map(message => message.text)).toEqual(['Ключ: [REDACTED]', 'следующий'])
  expect(delivered).toEqual(['k1', 'k2'])
})

test('[H4] a question snippet is masked on enqueue', () => {
  const dir = stateDir()
  const { outbox } = open(dir, [VALUE])
  outbox.enqueue('1', 'Ключ MASKME подходит?', { ownerReply: true }, 0, { origin: mainOrigin('main'),
    question: { code: 'OQ_TEST', snippet: 'Ключ MASKME подходит?' } })
  expect(outbox.snapshot()[0]?.question?.snippet).toBe('Ключ [REDACTED] подходит?')
  expect(file(dir)).not.toContain(VALUE)
})

test('[H4] a saved question snippet is masked on reload, for a v2 part and a v3 item', () => {
  const question = { code: 'OQ_TEST', snippet: 'Ключ MASKME подходит?' }
  const dir = stateDir([
    { v: 2, id: 'a', chatId: '1', text: 'Ключ MASKME подходит?', opts: { ownerReply: true }, notBefore: 0, attempts: 0,
      question },
    { v: 3, id: 'b', chatId: '2', plan: { v: 3, text: 'Ключ [REDACTED] подходит?', entities: [], cuts: [25] }, sent: 0,
      opts: { ownerReply: true }, notBefore: 0, attempts: 0, question },
  ])
  const { outbox } = open(dir, [VALUE])
  expect(outbox.snapshot().map(item => item.question?.snippet)).toEqual(['Ключ [REDACTED] подходит?',
    'Ключ [REDACTED] подходит?'])
  expect(file(dir)).not.toContain(VALUE)
})

test('[H5] a sent cut that a later value collapses to 0 survives a reload and the rest is delivered', async () => {
  const dir = stateDir()
  const secrets: string[] = []
  let flood = true
  const sent: string[] = []
  const sendFn: OutboxSendFn = async (_chat, text) => {
    if (sent.length === 1 && flood) throw { error_code: 429, parameters: { retry_after: 5 } }
    sent.push(text)
    return { message_id: sent.length }
  }
  const { outbox } = open(dir, secrets, { sendFn })
  const value = 'MASK\nME'
  outbox.enqueue('1', value + 'е'.repeat(3998) + ' конец', { ownerReply: true }, 0)
  await outbox.flushDue(1_000)
  expect(sent).toEqual(['MASK\n'])
  secrets.push(value)
  await outbox.flushDue(10_000)
  // The sent piece now lies inside the marker: its cut collapsed to 0.
  expect(outbox.snapshot()[0]?.plan.cuts[0]).toBe(0)
  const reloaded = open(dir, secrets, { sendFn })
  expect(reloaded.outbox.snapshot()).toMatchObject([{ sent: 1 }])
  flood = false
  await reloaded.outbox.flushDue(20_000)
  expect(sent.slice(1).join('')).toBe('[REDACTED]' + 'е'.repeat(3998) + ' конец')
  expect(reloaded.outbox.size()).toBe(0)
})

test('[H6] an item evicted while a flush is in flight is never sent', async () => {
  const dir = stateDir()
  const sent: string[] = []
  let release: (() => void) | undefined
  const { outbox } = open(dir, [], { maxItems: 2, sendFn: async (_chat, text) => {
    sent.push(text)
    if (text === 'A') await new Promise<void>(resolve => { release = resolve })
    return { message_id: sent.length }
  } })
  outbox.enqueue('1', 'A', { ownerReply: true }, 0)
  outbox.enqueue('1', 'B', { ownerReply: true }, 0)
  const flushing = outbox.flushDue(1_000)
  for (let tick = 0; tick < 10 && release === undefined; tick++) await Promise.resolve()
  expect(sent).toEqual(['A'])
  // At capacity two, C and D push A and B out of the queue while A's request is in flight.
  outbox.enqueue('1', 'C', { ownerReply: true }, 0)
  outbox.enqueue('1', 'D', { ownerReply: true }, 0)
  expect(file(dir)).not.toContain('"B"')
  release?.()
  await flushing
  expect(sent).toEqual(['A'])
  expect(outbox.snapshot().map(item => item.plan.text)).toEqual(['C', 'D'])
})
