// Outbox entries saved before secrets were masked in the source: a deferred reply's HTML parts were redacted one by
// one, so a configured secret cut across two parts (or escaped as `&amp;`) survived and a replay showed it whole.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { htmlToPlainText } from '../../src/format/chunk.js'
import { createLogger } from '../../src/log.js'
import { Outbox } from '../../src/safety/outbox.js'
import { bridgeOrigin, parseTurnOrigin } from '../../src/codex/turn-origin.js'
import { createOwnerEffects } from '../../src/codex/owner-effects.js'
import { OpenQuestionStore } from '../../src/state/open-question-store.js'
import { redactOutboundText } from '../../src/safety/safe-telegram-api.js'

const SECRET = 'Synth&Secret<value>"42"'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function legacyOutbox(items: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-outbox-legacy-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'outbox.json'), JSON.stringify(items))
  return dir
}

function open(dir: string, sent: string[]): Outbox {
  return new Outbox({
    stateDir: dir, log: createLogger('test'), now: () => 0,
    sendFn: async (_chat, text, opts) => {
      // What the safe wrapper does per message: redact that one message, then send.
      sent.push(redactOutboundText(text, opts.parse_mode, [SECRET]))
      return { message_id: 50 + sent.length }
    },
    redact: (text, parseMode) => redactOutboundText(text, parseMode, [SECRET]),
  })
}

const escaped = 'Synth&amp;Secret&lt;value&gt;&quot;42&quot;'
const opts = { parse_mode: 'HTML', ownerReply: true }

test('a legacy deferred reply with a secret split across two HTML parts replays redacted', async () => {
  const cut = 'Synth&amp;Sec'.length
  const dir = legacyOutbox([
    { id: 'a', chatId: '1', text: '<b>Ключ: ' + escaped.slice(0, cut), opts: { ...opts, reply_to_message_id: 9 },
      notBefore: 10, attempts: 1 },
    { id: 'b', chatId: '1', text: escaped.slice(cut) + ' хвост</b>', opts, notBefore: 10, attempts: 1 },
  ])
  const sent: string[] = []
  await open(dir, sent).flushDue(10_000)
  const shown = sent.map(htmlToPlainText).join('')
  expect(shown).not.toContain(SECRET)
  expect(shown).not.toContain('Secret<value>')
  expect(shown).toContain('Ключ: [REDACTED] хвост')
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toBe('[]')
})

test('an unpartitionable migrated reply is delivered as a redacted document and retains its receipt', async () => {
  const spaces = ' '.repeat(8_100)
  const dir = legacyOutbox([
    { id: 'head', chatId: '1', text: '<pre>' + escaped.slice(0, 10), opts, notBefore: 10, attempts: 3 },
    { id: 'tail', chatId: '1', text: escaped.slice(10) + spaces + 'end</pre>', opts, notBefore: 10, attempts: 0 },
  ])
  const documents: string[] = []
  const create = () => new Outbox({
    stateDir: dir, log: createLogger('test'), sendFn: async () => { throw new Error('Expected a document') },
    sendDocument: async (_chat, text) => { documents.push(text); return { message_id: 51 } },
    redact: (text, parseMode) => redactOutboundText(text, parseMode, [SECRET]),
  })
  const migrated = create().snapshot()
  expect(migrated.map(({ id, attempts }) => ({ id, attempts }))).toEqual([{ id: 'head', attempts: 3 }])
  const restarted = create()
  expect(restarted.snapshot()).toEqual(migrated)
  await restarted.flushDue(10_000)
  expect(documents).toEqual(['[REDACTED]' + spaces + 'end'])
  expect(restarted.size()).toBe(0)
})

test('a secret cut inside a code block, where the old chunker closed and reopened the block, replays redacted', async () => {
  const cut = 'Synth&amp;'.length
  const dir = legacyOutbox([
    { id: 'e', chatId: '2', text: '<pre><code>' + escaped.slice(0, cut) + '</code></pre>', opts, notBefore: 1, attempts: 0 },
    { id: 'f', chatId: '2', text: '<pre><code>' + escaped.slice(cut) + '\nend</code></pre>', opts, notBefore: 1, attempts: 0 },
  ])
  const sent: string[] = []
  await open(dir, sent).flushDue(10_000)
  // One reply, one message: the shown text (the code block travels as an entity beside it).
  expect(sent).toEqual(['[REDACTED]\nend'])
})

test('the upgrade rewrites a legacy queue once and joins a run into one reply item', () => {
  const plain = [
    { id: 'c', chatId: '1', text: 'первая часть ', opts: { ...opts, reply_to_message_id: 3 }, notBefore: 5, attempts: 0 },
    { id: 'd', chatId: '1', text: 'вторая часть', opts, notBefore: 5, attempts: 0 },
  ]
  const dir = legacyOutbox(plain)
  const first = open(dir, []).snapshot()
  expect(first.map(item => item.plan.text)).toEqual(['первая часть вторая часть'])
  expect(first.map(item => item.id)).toEqual(['c'])
  // Saved as migrated: a second start reads the same queue and rewrites nothing.
  const after = readFileSync(join(dir, 'outbox.json'), 'utf8')
  expect(open(dir, []).snapshot()).toEqual(first)
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toBe(after)
})

test('the Brain key of a deferred reply survives a restart and reaches the delivery callback of its last part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-outbox-brain-'))
  dirs.push(dir)
  const log = createLogger('test')
  const first = new Outbox({ stateDir: dir, log, now: () => 0, sendFn: async () => ({ message_id: 1 }) })
  first.enqueue('1', 'Part one', { parse_mode: 'HTML' }, 5)
  first.enqueue('1', 'Part two', { parse_mode: 'HTML' }, 5, { origin: bridgeOrigin(null), brainKey: 'scope:77' })
  expect(JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')).map((item: { brainKey?: string }) => item.brainKey))
    .toEqual([undefined, 'scope:77'])
  const delivered: Array<[string | undefined, number]> = []
  const restarted = new Outbox({
    stateDir: dir, log, now: () => 0, sendFn: async (_chat, text) => ({ message_id: text === 'Part one' ? 61 : 62 }),
    onDelivered: (item, id) => { delivered.push([item.brainKey, id]) },
  })
  await restarted.flushDue(10_000)
  expect(delivered).toEqual([[undefined, 61], [`scope:77`, 62]])
})

test('O1-7 a deferred question saved without an origin is delivered and stays out of the owner questions', async () => {
  const dir = legacyOutbox([{ id: 'q', chatId: '42', text: 'Жду твоего ответа', opts: {}, notBefore: 1, attempts: 0, v: 2,
    question: { code: 'OQ_WAIT', snippet: 'Жду твоего ответа' } }])
  const log = createLogger('test')
  const leases: number[] = []
  const questionStore = new OpenQuestionStore(join(dir, 'open-questions.json'), log)
  const effects = createOwnerEffects({
    chatId: '42', questionStore, currentThread: () => 'main', warn: () => {},
    leases: { recordQuestion: async messageId => { leases.push(messageId) } },
    brain: { openQuestions: async () => {} }, controls: { setPendingOwnerTask: () => {} },
  })
  const seen: Array<Promise<void>> = []
  const outbox = new Outbox({ stateDir: dir, log, now: () => 0, sendFn: async () => ({ message_id: 80 }),
    onDelivered: (item, id) => { if (item.question) seen.push(effects.questionSeen(parseTurnOrigin(item.origin, id), id, item.question)) } })
  await outbox.flushDue(10_000)
  await Promise.all(seen)
  expect(outbox.size()).toBe(0)
  expect(questionStore.get('42')?.messageId).toBe(80)
  expect(parseTurnOrigin(questionStore.get('42')?.origin, 80).role).toBe('guest')
  expect(leases).toEqual([])
})

test('a rewritten legacy reply keeps its largest retry count, once, after restart', async () => {
  const dir = legacyOutbox([
    { id: 'head', chatId: '1', text: 'а'.repeat(3950) + escaped.slice(0, 10),
      opts: { ...opts, reply_to_message_id: 9 }, notBefore: 10, attempts: 4 },
    { id: 'tail', chatId: '1', text: escaped.slice(10) + 'б'.repeat(150), opts, notBefore: 10, attempts: 1 },
  ])
  const migrated = open(dir, []).snapshot()
  expect(migrated.map(item => item.attempts)).toEqual([4])
  expect(migrated[0]?.id).toBe('head')
  expect(migrated[0]?.opts.reply_to_message_id).toBe(9)
  const sent: string[] = []
  const restarted = open(dir, sent)
  expect(restarted.snapshot()).toEqual(migrated)
  await restarted.flushDue(10_000)
  expect(sent.map(htmlToPlainText).join('')).toBe('а'.repeat(3950) + '[REDACTED]' + 'б'.repeat(150))
})
