import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import type { SendDocumentOpts, SendMessageOpts, TelegramApi } from '../../src/channel/tools.js'
import { normalizeChatReply } from '../../src/codex/continuation.js'
import { ErrorJournal } from '../../src/codex/error-log.js'
import { ownerTurn, stableTurnPrefix } from '../../src/codex/format-reminder.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { RenderEyes } from '../../src/codex/render-eyes.js'
import type { PartStatus } from '../../src/codex/reply-delivery.js'
import { bridgeOrigin, mainOrigin, storedOrigin, type TurnOrigin } from '../../src/codex/turn-origin.js'
import * as chunk from '../../src/format/chunk.js'
import { splitMessageLegacy } from '../../src/format/chunk-legacy.js'
import { isTelegramHtmlParseError, markdownToTelegramHtml } from '../../src/format/html.js'
import { splitLongBlock, splitLongBlockLegacy } from '../../src/format/paragraphs.js'
import { createLogger } from '../../src/log.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'
import { detectOpenQuestion } from '../../src/safety/open-question.js'
import { Outbox, type OutboxItem } from '../../src/safety/outbox.js'
import { parse429 } from '../../src/safety/rate-limited-telegram-api.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { classifySendError } from '../../src/safety/reliable-telegram-api.js'
import { createSafeTelegramApi, redactOutboundText } from '../../src/safety/safe-telegram-api.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

const owner = 42
const id = 7
const origin = mainOrigin('main')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (const name of ['codex-inbox.json', 'outbox.json']) {
      const file = join(dir, name)
      if (existsSync(file)) unlinkSync(file)
    }
    rmdirSync(dir)
  }
})

function readyReply(source: string, receipts: Record<string, PartStatus>, parts?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'krot-server-reply-test-'))
  dirs.push(dir)
  const inbox = new CodexInbox(dir, owner)
  inbox.receive({ message_id: id, date: 1, text: 'Reply', chat: { id: owner, type: 'private', first_name: 'O' },
    from: { id: owner, is_bot: false, first_name: 'O' } }, { origin: 'owner' })
  inbox.take()
  inbox.complete(id, { text: source, files: [] })
  for (const [key, state] of Object.entries(receipts)) inbox.setReplyPart(id, key, state)
  if (parts) inbox.setReplyPlan(id, parts)
  return { dir, inbox }
}

// Run the production reply callbacks with local fakes. Importing the server starts the bot and poller.
const server = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
const receipts = readFileSync(join(import.meta.dir, '../../src/codex/reply-delivery.ts'), 'utf8')
function section(source: string, start: string, end?: string): string {
  const from = source.indexOf(start)
  const to = end === undefined ? source.length : source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate reply delivery code')
  return source.slice(from, to)
}

const bindReplies = new Function('dependencies', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { inbox, telegram, secrets, log, classifySendError, redactOutboundText, redactSecrets, markdownToTelegramHtml,
    isTelegramHtmlParseError, normalizeChatReply, validateTelegramHtml, splitLongBlock, splitLongBlockLegacy,
    splitMessageLegacy, splitMessage, splitMessageFrom, splitPlainFallback, plainTextWithLinks,
    redactedRenderOffset, resumeMessagePlan, protectPlainFallbackCuts, TELEGRAM_MAX_MESSAGE, PreformattedDocumentError,
    join, tmpdir, mkdtemp, writeFile, unlink, rmdir, ownerChat, outbox, parse429, detectOpenQuestion, renderEyes
  } = dependencies
  const sendsAsRich = () => false
  const config = { richMessages: { enabled: false } }
  const questionConfig = { enabled: true }
  const ownerEffects = { questionSeen: async () => {} }
  const hudAnchor = { settled: async () => {} }
  const agentChat = { remember: () => {} }
  const withoutDeletedQuote = (send: (id?: number) => Promise<unknown>, id?: number) => send(id)
  ${section(receipts, 'export async function deliverReplyPart', '/** The richMessages').replace('export ', '')}
  ${section(receipts, 'export function plannedTextParts').replace('export ', '')}
  ${section(server, '  async function sendTextDocument(', '  let onDeferredDelivery:')}
  ${section(server, '    async function sendFinalText(', '    const actionApi =')}
  const { sendReply } = {
    ${section(server, '      sendReply: (source, target)', '      autonomy:')}
  }
  // The outbox's delivery callback, with its Brain, status and question effects stubbed.
  const brain = { recover: async () => null }
  const recordBrainDelivery = async () => {}
  const warnError = () => {}
  const work = { repost: () => {} }
  const parseTurnOrigin = () => undefined
  let onDeferredDelivery
  ${section(server, '    onDeferredDelivery = (item, id) => {', '    function chatContext(')}
  return { sendFinalText, sendReply, sendTextDocument, onDeferredDelivery }
`))

interface ReplyCallbacks {
  sendFinalText(source: string, origin: TurnOrigin, files: boolean, target?: number, id?: number,
    onSent?: (id: number) => void, brainKey?: string): Promise<boolean>
  sendReply(source: string, target?: number): Promise<{ messageId: number }>
  sendTextDocument(api: Pick<TelegramApi, 'sendDocument'>, chat: string, body: string, target?: number): Promise<unknown>
  onDeferredDelivery(item: Readonly<OutboxItem>, messageId: number): void
}

function hasReplyCallbacks(value: unknown): value is ReplyCallbacks {
  return typeof value === 'object' && value !== null &&
    'sendFinalText' in value && typeof value.sendFinalText === 'function' &&
    'sendReply' in value && typeof value.sendReply === 'function' &&
    'sendTextDocument' in value && typeof value.sendTextDocument === 'function' &&
    'onDeferredDelivery' in value && typeof value.onDeferredDelivery === 'function'
}

function delivery(inbox: CodexInbox, secrets: readonly string[], telegram: Partial<TelegramApi>,
  warn: (message: string) => void = () => {}, outbox?: Outbox, renderEyes = new RenderEyes({ secrets })): ReplyCallbacks {
  const replies: unknown = bindReplies({ inbox, secrets, telegram, log: { warn }, ownerChat: String(owner), ...chunk,
    classifySendError, redactOutboundText, redactSecrets, markdownToTelegramHtml, isTelegramHtmlParseError,
    normalizeChatReply, validateTelegramHtml, splitLongBlock, splitLongBlockLegacy, splitMessageLegacy,
    join, tmpdir, mkdtemp, writeFile, unlink, rmdir, outbox, parse429, detectOpenQuestion, renderEyes })
  if (!hasReplyCallbacks(replies)) throw new Error('Could not bind reply callbacks')
  return replies
}

test('legacy resume sends no fragments of secrets formatted as strikeout or inline code', async () => {
  const strike = 'stub~~violet~~plum'
  const code = 'mint`amber`cobalt'
  const prefix = 'ф'.repeat(4000 - markdownToTelegramHtml(strike).length - 1) + strike + ' '
  const source = prefix + `keep ${strike} and ` + 'з'.repeat(4100) + ` ${code} end`
  const original = markdownToTelegramHtml(source)
  const cut = splitMessageLegacy(original).ends[0]!
  const sent: string[] = []
  const { inbox } = readyReply(source, { rich: 'fallback', 'text:0': 'sent' })
  await delivery(inbox, [strike, code], {
    async sendMessage(_chat, text) { sent.push(text); return { message_id: 51 } },
  }).sendFinalText(source, origin, false, id, id)
  expect(sent).toHaveLength(2)
  for (const part of sent) expect(/stub|violet|plum|mint|amber|cobalt/.test(part)).toBe(false)
  const visible = chunk.htmlToPlainText(original.slice(cut))
  expect(sent.join('')).toBe(visible.replace('stubvioletplum', '[REDACTED]').replace('mintambercobalt', '[REDACTED]'))
})

const tailMarker = 'unsent tail marker'
const repeatedValue = 'ж'.repeat(35)
// Redacting the single long value also removes the delimiter that opens the rendered bold span before the cut.
const longValue = 'ж'.repeat(598) + '**'
test.each([
  ['15 matches of a 35-character value', repeatedValue,
    'opening ' + (repeatedValue + ' ').repeat(14) + 'ф'.repeat(4200) + ` ${tailMarker} ${repeatedValue}`],
  ['one 600-character value', longValue, 'opening **' + 'ф'.repeat(4200) + ` ${tailMarker} ${longValue}`],
])('legacy resume keeps the unsent tail when redacting %s', async (_label, value, source) => {
  const original = markdownToTelegramHtml(splitLongBlockLegacy(normalizeChatReply(source)))
  const { chunks } = splitMessageLegacy(original)
  expect(chunks).toHaveLength(2)
  expect(chunks[0]).not.toContain(tailMarker)
  expect(chunks[1]).toContain(tailMarker)

  const { dir } = readyReply(source, { rich: 'fallback', 'text:0': 'sent' })
  const inbox = new CodexInbox(dir, owner)
  expect(inbox.replyPlan(id)).toBeUndefined()
  const sent: string[] = []
  await delivery(inbox, [value], {
    async sendMessage(_chat, text) { sent.push(text); return { message_id: 51 } },
  }).sendFinalText(source, origin, false, id, id)

  expect(sent.join('')).toContain(tailMarker)
  expect(sent.join('')).not.toContain('ж')
})

test.each([
  ['malformed JSON', encodeURIComponent('{')],
  ['malformed URI encoding', '%'],
  ['invalid JSON shape', 'null'],
])('plain fallback recomputes saved pieces and warns once for %s', async (_label, encoded) => {
  const source = '<b>pending plain</b>'
  const parts = ['already delivered', source]
  const { dir, inbox } = readyReply(source, { rich: 'fallback', 'text:0': 'sent' },
    [...parts, `<u data-plain-fallbacks="${encoded}"></u>`])
  const warnings: string[] = []
  const warn = (message: string) => { warnings.push(message) }
  const sent: string[] = []
  let offline = true
  const sendMessage = async (_chat: string, text: string, opts: SendMessageOpts) => {
    if (offline) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    if (opts.parse_mode === 'HTML') throw new Error("can't parse entities")
    sent.push(text)
    return { message_id: 51 }
  }

  await expect(delivery(inbox, [], { sendMessage }, warn).sendFinalText(source, origin, false, id, id)).rejects.toThrow('offline')
  offline = false
  const reloaded = new CodexInbox(dir, owner)
  await delivery(reloaded, [], { sendMessage }, warn).sendFinalText(source, origin, false, id, id)

  expect(sent).toEqual(['pending plain'])
  expect(reloaded.replyPart(id, 'text:1:plain:0')).toBe('sent')
  expect(warnings).toHaveLength(1)
})

test('plain fallback resumes at its saved cut after configured redactions change', async () => {
  const source = '<a href="file:///' + 'д'.repeat(4400) + '">short</a> suffix'
  const firstPlan = chunk.splitPlainFallback(source)
  expect(firstPlan).toHaveLength(2)
  const { dir, inbox } = readyReply(source, { rich: 'fallback' }, [source])
  const sent: string[] = []
  let offline = true
  const sendMessage = async (_chat: string, text: string, opts: SendMessageOpts) => {
    expect(opts.parse_mode).toBeUndefined()
    if (sent.length === 1 && offline) {
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    }
    sent.push(text)
    return { message_id: 50 + sent.length }
  }
  await expect(delivery(inbox, [], { sendMessage }).sendFinalText(source, origin, false, id, id)).rejects.toThrow('offline')
  expect(sent).toEqual(firstPlan.slice(0, 1))
  offline = false
  const reloaded = new CodexInbox(dir, owner)
  await delivery(reloaded, ['short'], { sendMessage }).sendFinalText(source, origin, false, id, id)
  expect(sent[1]?.length).toBe(firstPlan[1]?.length)
  expect(sent).toEqual(firstPlan)
})

test('plain fallback masks the unsent fragment of a newly configured secret at a saved cut', async () => {
  const before = 'д'.repeat(4096 - 'label (file:///'.length - 'anchor'.length)
  const after = 'я'.repeat(400)
  const source = `<a href="file:///${before}anchorpiece${after}">label</a> suffix`
  const { dir, inbox } = readyReply(source, { rich: 'fallback' }, [source])
  const sent: string[] = []
  await expect(delivery(inbox, [], {
    async sendMessage(_chat, text) {
      if (sent.length > 0) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
      sent.push(text)
      return { message_id: 51 }
    },
  }).sendFinalText(source, origin, false, id, id)).rejects.toThrow('offline')
  expect(sent[0]?.endsWith('anchor')).toBe(true)
  const reloaded = new CodexInbox(dir, owner)
  await delivery(reloaded, ['anchorpiece'], {
    async sendMessage(_chat, text) { sent.push(text); return { message_id: 52 } },
  }).sendFinalText(source, origin, false, id, id)
  expect(sent[1]?.startsWith('piece')).toBe(false)
  expect(sent[1]).toBe(after + ') suffix')
})

test('a flooded plain fallback preserves guest origin and completes Brain only on its last piece', async () => {
  const prefix = 'word '.repeat(780).trimEnd()
  const url = 'https://example.com/' + 'x'.repeat(220)
  const source = prefix + ' [read](' + url + ')'
  const { dir, inbox } = readyReply(source, {})
  const guest = bridgeOrigin('main')
  const brainKey = 'scope:77'
  const sent: string[] = []
  const delivered: (string | undefined)[] = []
  const open = () => new Outbox({
    stateDir: dir, log: createLogger('test'), now: () => 0,
    sendFn: async (_chat, text) => { sent.push(text); return { message_id: 50 + sent.length } },
    onDelivered: item => { delivered.push(item.brainKey) },
  })
  const reply = delivery(inbox, [], {
    async sendMessage(_chat, _text, options) {
      if (options.parse_mode === 'HTML') throw new Error("can't parse entities")
      throw { error_code: 429, parameters: { retry_after: 5 } }
    },
  }, undefined, open())
  expect(await reply.sendFinalText(source, guest, false, id, undefined, undefined, brainKey)).toBe(true)
  const reloaded = open()
  const items = reloaded.snapshot()
  expect(items.map(item => item.origin)).toEqual([storedOrigin(guest), storedOrigin(guest)])
  expect(items.map(item => item.opts)).toEqual([{ ownerReply: true, reply_to_message_id: id }, { ownerReply: true }])
  await reloaded.flushDue(5_000)
  expect(sent.join('')).toBe(prefix + ' read (' + url + ')')
  expect(delivered).toEqual([undefined, brainKey])
})

test('a flooded final document persists the owner origin, question and Brain completion together', async () => {
  const value = 'fake~~violet~~plum'
  const spaces = ' '.repeat(8100)
  const question = 'Жду твоего ответа'
  const source = '```\n' + value + spaces + 'end\n```\n\n' + question
  const { dir, inbox } = readyReply(source, {})
  const brainKey = 'scope:77'
  const documents: string[] = []
  const open = () => new Outbox({
    stateDir: dir, log: createLogger('test'), now: () => 0,
    sendFn: async () => { throw new Error('Expected document delivery') },
    sendDocument: async (_chat, text) => { documents.push(text); return { message_id: 51 } },
  })
  const reply = delivery(inbox, [value], {
    async sendMessage() { throw new Error('Expected document delivery') },
    async sendDocument() { throw { error_code: 429, parameters: { retry_after: 5 } } },
  }, undefined, open())
  expect(await reply.sendFinalText(source, origin, false, id, undefined, undefined, brainKey)).toBe(true)
  const reloaded = open()
  expect(reloaded.snapshot()).toMatchObject([{
    document: true, origin: storedOrigin(origin), brainKey,
    opts: { ownerReply: true, reply_to_message_id: id },
    question: { code: 'OQ_WAIT_ANSWER', snippet: question },
  }])
  await reloaded.flushDue(5_000)
  expect(documents).toEqual(['[REDACTED]' + spaces + 'end\n\n' + question])
})

test('an unpartitionable interim reply sends the redacted text document and returns its message ID', async () => {
  const value = 'fake~~violet~~plum'
  const spaces = ' '.repeat(8100)
  const source = '```\n' + value + spaces + 'end\n```'
  const { inbox } = readyReply(source, {})
  const uploads: { body: string; options: SendDocumentOpts }[] = []
  const reply = await delivery(inbox, [value], {
    async sendMessage() { throw new Error('Expected document delivery') },
    async sendDocument(_chat, file, options) {
      uploads.push({ body: readFileSync(file, 'utf8'), options })
      return { message_id: 51 }
    },
  }).sendReply(source, id)
  expect(reply).toEqual({ messageId: 51 })
  expect(uploads).toEqual([{ body: '[REDACTED]' + spaces + 'end',
    options: { filename: 'reply.txt', ownerReply: true, reply_to_message_id: id } }])
})

test('a whitespace-only code block within the interim reply input limit is delivered as a document', async () => {
  const spaces = ' '.repeat(3800)
  const source = '```\n' + spaces + '\n```'
  const { inbox } = readyReply(source, {})
  const reply = await delivery(inbox, [], {
    async sendMessage() { throw new Error('Expected document delivery') },
    async sendDocument(_chat, file) {
      expect(readFileSync(file, 'utf8')).toBe(spaces)
      return { message_id: 51 }
    },
  }).sendReply(source)
  expect(reply).toEqual({ messageId: 51 })
})

test('a reply document forwards the owner reply flag even without a quote', async () => {
  const { inbox } = readyReply('text', {})
  const uploads: SendDocumentOpts[] = []
  await delivery(inbox, [], {}).sendTextDocument({ async sendDocument(_chat, _file, options) {
    uploads.push(options)
    return { message_id: 51 }
  } }, String(owner), 'text')
  expect(uploads).toEqual([{ filename: 'reply.txt', ownerReply: true }])
})

// R42 «eyes»: what the owner saw after a send, diffed against the model's text.
function eyesFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-eyes-test-'))
  const journal = new ErrorJournal({ dir })
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const log = createLogger('render', { stream: quiet,
    sink: (level, name, message, context) => journal.record(level, name, message, context) })
  const history = join(dir, 'render-diffs.json')
  const eyes = new RenderEyes({ log, secrets: [], file: history })
  const journaled = (): unknown[] => readdirSync(dir).filter(name => name.startsWith('errors-'))
    .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line): unknown => JSON.parse(line))
  return { eyes, journaled, history, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
// The eyes write their journal lines and history after the send path returned (one macrotask later).
const diagnosticsWritten = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('[R42] a degraded final reply is journaled as a warn and noted once in the next owner turn', async () => {
  const { eyes, journaled, cleanup } = eyesFixture()
  try {
    // The renderer escapes `&amp;` and leaves a bold span across lines unconverted: the owner sees both raw.
    const source = 'Итог: Tom &amp; Jerry.\n\nЭто **важно\nочень** сейчас.'
    const { inbox } = readyReply(source, {})
    const sent: string[] = []
    await delivery(inbox, [], { async sendMessage(_chat, text) {
      sent.push(text)
      return { message_id: 100 }
    } }, undefined, undefined, eyes).sendFinalText(source, origin, false, id, id)
    expect(sent).toHaveLength(1)
    await diagnosticsWritten()
    expect(journaled()).toEqual([expect.objectContaining({ level: 'warn', area: 'render', status: 'raw_markup', messageId: 100 })])
    const note = eyes.takeNote()
    expect(note).toContain('в прошлом ответе Telegram показал «&amp;» вместо «&»')
    // Two raw spans of one kind: the note names the kind once.
    expect(note.match(/вместо/g)).toHaveLength(1)
    // The note goes after the stable cache prefix, into the volatile part of the next turn.
    const turn = ownerTurn(true, [note, 'Следующий вопрос'])
    expect(turn.startsWith(stableTurnPrefix(true, '') + '\n\n' + note)).toBe(true)
    // Once per degradation: the turn after that carries no note.
    expect(eyes.takeNote()).toBe('')
  } finally { cleanup() }
})

test('[R42] a clean final reply leaves no note and no render warning', async () => {
  const { eyes, journaled, cleanup } = eyesFixture()
  try {
    const source = 'Обычный **жирный** текст.\n\nВторой абзац с `<b>` в коде.'
    const { inbox } = readyReply(source, {})
    await delivery(inbox, [], { async sendMessage() { return { message_id: 101 } } }, undefined, undefined, eyes)
      .sendFinalText(source, origin, false, id, id)
    await diagnosticsWritten()
    expect(journaled()).toEqual([])
    expect(eyes.takeNote()).toBe('')
    expect(eyes.recent()).toEqual([expect.objectContaining({ messageIds: [101], formats: ['HTML'], degradations: [] })])
  } finally { cleanup() }
})

test('[R42] an interim reply is recorded in the format and text the outbound sanitizer delivered', async () => {
  const eyes = new RenderEyes({ secrets: [] })
  const source = '<b class="demo">Example</b>'
  // The premise: the rendered HTML fails the pre-send validator, so the safe wrapper sends it without parse_mode.
  expect(validateTelegramHtml(markdownToTelegramHtml(source)).downgraded).toBe(true)
  const { inbox } = readyReply(source, {})
  const chat = fakeTelegramChat()
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const safe = createSafeTelegramApi(chat.raw, createLogger('test', { stream: quiet }), [])
  const { messageId } = await delivery(inbox, [], safe, undefined, undefined, eyes).sendReply(source)
  expect(chat.texts()).toEqual(['Example'])
  // Recorded as what the owner got: plain «Example», a refused HTML part, not the HTML the wrapper was handed.
  expect(eyes.shown(messageId)).toEqual({ format: 'plain', text: 'Example', messageId })
  expect(eyes.recent()).toEqual([expect.objectContaining({ messageIds: [messageId], formats: ['plain'],
    degradations: [{ kind: 'broken_tags', code: 'html_refused' }] })])
})

test('[R42] a reply deferred by a flood wait is recorded when the outbox delivers it, with its message ID', async () => {
  const eyes = new RenderEyes({ secrets: [] })
  const source = 'Итог: **готово**.'
  const { dir, inbox } = readyReply(source, {})
  const flushed: string[] = []
  let replies: ReplyCallbacks | undefined
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test'), now: () => 0,
    sendFn: async (_chat, text) => { flushed.push(text); return { message_id: 77 } },
    // The production wiring: Outbox.onDelivered -> onDeferredDelivery.
    onDelivered: (item, messageId) => replies?.onDeferredDelivery(item, messageId) })
  replies = delivery(inbox, [], { async sendMessage() { throw { error_code: 429, parameters: { retry_after: 5 } } } },
    undefined, outbox, eyes)
  expect(await replies.sendFinalText(source, origin, false, id)).toBe(true)
  // Queued, not shown: nothing is recorded before Telegram took the reply.
  expect(eyes.recent()).toEqual([])
  await outbox.flushDue(5_000)
  expect(flushed).toHaveLength(1)
  expect(eyes.recent()).toEqual([expect.objectContaining({ messageIds: [77], formats: ['HTML'], degradations: [] })])
  const [sentText] = flushed
  if (typeof sentText !== 'string') throw new Error('The outbox did not send the deferred reply')
  expect(eyes.shown(77)).toEqual({ format: 'HTML', text: sentText, messageId: 77 })
})

test('[R42] a transport rejection reaches the caller before the eyes write their journal line and history', async () => {
  const { eyes, journaled, history, cleanup } = eyesFixture()
  try {
    const source = 'Итог **важно**'
    const { inbox } = readyReply(source, {})
    const reply = delivery(inbox, [], { async sendMessage(_chat, _text, options) {
      // Telegram refuses the HTML, then the plain fallback hits a transport failure.
      if (options.parse_mode === 'HTML') throw new Error("can't parse entities")
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    } }, undefined, undefined, eyes)
    let atCaller: { error: string; journal: number; history: boolean } | undefined
    await reply.sendFinalText(source, origin, false, id).catch((error: unknown) => {
      atCaller = { error: String(error), journal: journaled().length, history: existsSync(history) }
    })
    // No fsync of the journal or the history ran between the failure and its caller.
    expect(atCaller).toEqual({ error: 'Error: offline', journal: 0, history: false })
    // The diff itself is in memory at once (the next turn's note does not wait for the disk).
    expect(eyes.recent()).toEqual([expect.objectContaining({ degradations: [{ kind: 'broken_tags', code: 'html_refused' }] })])
    await diagnosticsWritten()
    expect(journaled()).toEqual([expect.objectContaining({ level: 'warn', area: 'render', status: 'broken_tags' })])
    expect(existsSync(history)).toBe(true)
  } finally { cleanup() }
})
