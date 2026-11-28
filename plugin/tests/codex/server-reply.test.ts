import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import type { SendDocumentOpts, SendMessageOpts, SendRichMessageResult, TelegramApi } from '../../src/channel/tools.js'
import { normalizeChatReply } from '../../src/codex/continuation.js'
import { ErrorJournal } from '../../src/codex/error-log.js'
import { ownerTurn, stableTurnPrefix } from '../../src/codex/format-reminder.js'
import { CodexInbox } from '../../src/codex/inbox.js'
// A namespace import, so this file also loads against older sources that lack shownSent (red-then-green runs).
import * as renderEyesModule from '../../src/codex/render-eyes.js'
const { RenderEyes } = renderEyesModule
const shownSent: unknown = Reflect.get(renderEyesModule, 'shownSent')
import { renderPreview } from '../../src/codex/render-preview.js'
import type { PartStatus } from '../../src/codex/reply-delivery.js'
import { bridgeOrigin, mainOrigin, storedOrigin, type TurnOrigin } from '../../src/codex/turn-origin.js'
import * as chunk from '../../src/format/chunk.js'
import { splitMessageLegacy } from '../../src/format/chunk-legacy.js'
import { isTelegramHtmlParseError, markdownToTelegramHtml } from '../../src/format/html.js'
import { splitLongBlock, splitLongBlockLegacy } from '../../src/format/paragraphs.js'
import { createLogger } from '../../src/log.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'
import { detectOpenQuestion } from '../../src/safety/open-question.js'
import { Outbox, type OutboxItem, type OutboxSent } from '../../src/safety/outbox.js'
import { parse429 } from '../../src/safety/rate-limited-telegram-api.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { classifySendError } from '../../src/safety/reliable-telegram-api.js'
import { createRichLatch } from '../../src/safety/rich-latch.js'
// A namespace import, like render-eyes above: older sources lack MaskedOverflowError.
import * as preSendErrors from '../../src/safety/pre-send-error.js'
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
    // keepShownSecretsWhole: its name in older sources, bound for red-then-green runs against them.
    maskShownSecrets, keepShownSecretsWhole, maskAcrossCuts, maskedPlainFallback, telegramTextLength, shownSent, MaskedOverflowError,
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
  ${section(server, '    onDeferredDelivery = (item, id, sent) => {', '    function chatContext(')}
  // The agent's edit of a Rich Message, from the AgentChatActions options.
  const { editRich } = {
    ${section(server, '      editRich: async (id, text) => {', '\n    })\n    onDeferredDelivery')}
  }
  return { sendFinalText, sendReply, sendTextDocument, onDeferredDelivery, editRich }
`))

interface ReplyCallbacks {
  sendFinalText(source: string, origin: TurnOrigin, files: boolean, target?: number, id?: number,
    onSent?: (id: number) => void, brainKey?: string): Promise<boolean>
  sendReply(source: string, target?: number): Promise<{ messageId: number }>
  sendTextDocument(api: Pick<TelegramApi, 'sendDocument'>, chat: string, body: string, target?: number):
    Promise<{ message_id: number; body: string }>
  onDeferredDelivery(item: Readonly<OutboxItem>, messageId: number, sent: OutboxSent): void
  editRich(id: number, text: string): Promise<void>
}

function hasReplyCallbacks(value: unknown): value is ReplyCallbacks {
  return typeof value === 'object' && value !== null &&
    'sendFinalText' in value && typeof value.sendFinalText === 'function' &&
    'sendReply' in value && typeof value.sendReply === 'function' &&
    'sendTextDocument' in value && typeof value.sendTextDocument === 'function' &&
    'onDeferredDelivery' in value && typeof value.onDeferredDelivery === 'function' &&
    'editRich' in value && typeof value.editRich === 'function'
}

function delivery(inbox: CodexInbox, secrets: readonly string[], telegram: Partial<TelegramApi>,
  warn: (message: string) => void = () => {}, outbox?: Outbox, renderEyes = new RenderEyes({ secrets })): ReplyCallbacks {
  const replies: unknown = bindReplies({ inbox, secrets, telegram, log: { warn }, ownerChat: String(owner), ...chunk,
    classifySendError, redactOutboundText, redactSecrets, markdownToTelegramHtml, isTelegramHtmlParseError,
    normalizeChatReply, validateTelegramHtml, splitLongBlock, splitLongBlockLegacy, splitMessageLegacy,
    join, tmpdir, mkdtemp, writeFile, unlink, rmdir, outbox, parse429, detectOpenQuestion, renderEyes, shownSent,
    MaskedOverflowError: Reflect.get(preSendErrors, 'MaskedOverflowError') })
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

test('[R42] an interim document preview uses the uploaded body when rendering exposes a token', async () => {
  const { eyes, journaled, cleanup } = eyesFixture()
  try {
    const value = 'mock-value-123'
    const source = 'Bearer **' + value + '**\n\n```\nx' + ' '.repeat(8100) + 'end\n```'
    const { inbox } = readyReply(source, {})
    const uploads: string[] = []
    const { messageId } = await delivery(inbox, [], {
      async sendMessage() { throw new Error('Expected document delivery') },
      async sendDocument(_chat, file) {
        uploads.push(readFileSync(file, 'utf8'))
        return { message_id: 51 }
      },
    }, undefined, undefined, eyes).sendReply(source)
    expect(uploads.map(body => body.startsWith('Bearer [REDACTED]'))).toEqual([true])
    const [upload] = uploads
    if (upload === undefined) throw new Error('Missing document upload')
    const shown = eyes.shown(messageId)
    expect(shown?.format).toBe('document')
    const preview = renderPreview({ message_id: messageId }, { shown: id => eyes.shown(id), secrets: [] })
    const expected = renderPreview({ message_id: messageId }, {
      shown: () => ({ format: 'document', text: upload, messageId }), secrets: [],
    })
    expect(preview.success).toBe(true)
    expect(preview.contentItems[1]?.imageUrl === expected.contentItems[1]?.imageUrl).toBe(true)
    expect(shown?.text === upload).toBe(true)
    await diagnosticsWritten()
    expect(journaled()).toEqual([expect.objectContaining({ area: 'render', status: 'dropped_markup', messageId })])
    expect(JSON.stringify(journaled()).includes(value)).toBe(false)
  } finally { cleanup() }
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
    onDelivered: (item, messageId, sent) => replies?.onDeferredDelivery(item, messageId, sent) })
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

test('[R42] identical queued replies keep their own diff when the degraded item is dropped', async () => {
  const eyes = new RenderEyes({})
  const source = 'Same reply'
  const { dir, inbox } = readyReply(source, {})
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  let replies: ReplyCallbacks | undefined
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }),
    now: () => 0, maxItems: 1, sendFn: async () => ({ message_id: 78 }),
    onDelivered: (item, messageId, sent) => replies?.onDeferredDelivery(item, messageId, sent) })
  let refuseHtml = true
  replies = delivery(inbox, [], { async sendMessage(_chat, _text, options) {
    if (refuseHtml && options.parse_mode === 'HTML') throw new Error("can't parse entities")
    throw { error_code: 429, parameters: { retry_after: 5 } }
  } }, undefined, outbox, eyes)
  expect(await replies.sendFinalText(source, origin, false, id)).toBe(true)
  expect(outbox.snapshot()).toMatchObject([{ text: source }])
  expect(outbox.snapshot()[0]?.opts.parse_mode).toBeUndefined()
  const firstId = outbox.snapshot()[0]?.id
  refuseHtml = false
  expect(await replies.sendFinalText(source, origin, false, id)).toBe(true)
  expect(outbox.snapshot()).toMatchObject([{ text: source, opts: { parse_mode: 'HTML' } }])
  expect(outbox.snapshot()[0]?.id).not.toBe(firstId)
  await outbox.flushDue(5_000)
  expect(eyes.recent()).toEqual([expect.objectContaining({ messageIds: [78], formats: ['HTML'], degradations: [] })])
  expect(eyes.shown(78)).toEqual({ format: 'HTML', text: source, messageId: 78 })
  expect(eyes.takeNote()).toBe('')
})

test('[R42] a direct plain fallback sends and records the masked text when plain conversion exposes a token', async () => {
  const value = 'mock-value-123'
  const source = '<a href="file:///tmp/x">link</a> Bearer **' + value + '**'
  const eyes = new RenderEyes({})
  const { inbox } = readyReply(source, {})
  const sent: string[] = []
  await delivery(inbox, [], { async sendMessage(_chat, text, options) {
    expect(options.parse_mode).toBeUndefined()
    sent.push(text)
    return { message_id: 61 }
  } }, undefined, undefined, eyes).sendFinalText(source, origin, false, id)
  expect(sent).toEqual(['link (file:///tmp/x) Bearer [REDACTED]'])
  expect(eyes.shown(61)).toEqual({ format: 'plain', text: 'link (file:///tmp/x) Bearer [REDACTED]', messageId: 61 })
})

test('[R42] a deferred document is recorded with the body the outbox uploaded', async () => {
  const eyes = new RenderEyes({})
  const value = 'late-secret-value'
  const source = 'Note ' + value + '\n\n```\nx' + ' '.repeat(8100) + 'end\n```'
  const { dir, inbox } = readyReply(source, {})
  // The shared redaction list: a key issued after the enqueue is masked by the outbox's upload.
  const secrets: string[] = []
  const uploads: string[] = []
  let flood = true
  const api = { async sendDocument(_chat: string, file: string) {
    if (flood) throw { error_code: 429, parameters: { retry_after: 5 } }
    uploads.push(readFileSync(file, 'utf8'))
    return { message_id: 81 }
  } }
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  let replies: ReplyCallbacks | undefined
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0,
    sendFn: async () => { throw new Error('Expected a document') },
    sendDocument: async (chat, text, options) => {
      if (!replies) throw new Error('Reply callbacks are not bound')
      return replies.sendTextDocument(api, chat, text, options.reply_to_message_id)
    },
    onDelivered: (item, messageId, sent) => replies?.onDeferredDelivery(item, messageId, sent) })
  replies = delivery(inbox, secrets, api, undefined, outbox, eyes)
  expect(await replies.sendFinalText(source, origin, false, id)).toBe(true)
  expect(outbox.snapshot()).toMatchObject([{ document: true }])
  secrets.push(value)
  flood = false
  await outbox.flushDue(5_000)
  expect(uploads).toHaveLength(1)
  const [upload] = uploads
  if (upload === undefined) throw new Error('Missing document upload')
  expect(upload.includes(value)).toBe(false)
  expect(eyes.shown(81)?.text === upload).toBe(true)
  expect(eyes.shown(81)?.format).toBe('document')
})

test('[R42] a resumed plain piece that grows past the message limit is recorded as the uploaded document', async () => {
  const before = 'д'.repeat(4096 - 'label (file:///'.length - 'anchor'.length)
  const after = 'я'.repeat(400)
  const source = `<a href="file:///${before}anchorpiece${after}">label</a> suffix`
  const { dir, inbox } = readyReply(source, { rich: 'fallback' }, [source])
  await expect(delivery(inbox, [], {
    async sendMessage() { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) },
  }).sendFinalText(source, origin, false, id, id)).rejects.toThrow('offline')
  const eyes = new RenderEyes({})
  const uploads: string[] = []
  const reloaded = new CodexInbox(dir, owner)
  // The new secret crosses the saved cut: protecting it moves its tail into the first piece, past 4096 characters.
  await delivery(reloaded, ['anchorpiece'], {
    async sendMessage() { return { message_id: 92 } },
    async sendDocument(_chat, file) {
      uploads.push(readFileSync(file, 'utf8'))
      return { message_id: 91 }
    },
  }, undefined, undefined, eyes).sendFinalText(source, origin, false, id, id)
  expect(uploads).toHaveLength(1)
  const [upload] = uploads
  if (upload === undefined) throw new Error('Missing document upload')
  expect(eyes.shown(91)?.format).toBe('document')
  expect(eyes.shown(91)?.text === upload).toBe(true)
  expect(eyes.recent()[0]?.formats).toEqual(['document', 'plain'])
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

// The production transport: a recording raw Telegram behind the real safe wrapper (the redaction choke point).
function safeRecordingTelegram(secrets: readonly string[], options: { flood?: () => boolean } = {}) {
  const messages: { id: number; text: string; format: 'HTML' | 'plain' | 'document' }[] = []
  let next = 300
  const unused = async (): Promise<never> => { throw new Error('not used') }
  const raw: TelegramApi = {
    async sendMessage(_chat, text, opts) {
      if (options.flood?.()) throw { error_code: 429, parameters: { retry_after: 5 } }
      if (opts.parse_mode === 'HTML' && validateTelegramHtml(text).downgraded) throw new Error("can't parse entities")
      // Telegram's limit, counted on what it shows: a longer message is refused for good.
      const shown = opts.parse_mode === 'HTML' ? chunk.htmlToPlainText(text) : text
      if (shown.length > chunk.TELEGRAM_MAX_MESSAGE) throw { error_code: 400, description: 'Bad Request: message is too long' }
      next += 1
      messages.push({ id: next, text, format: opts.parse_mode === 'HTML' ? 'HTML' : 'plain' })
      return { message_id: next }
    },
    async sendDocument(_chat, file) {
      if (options.flood?.()) throw { error_code: 429, parameters: { retry_after: 5 } }
      next += 1
      messages.push({ id: next, text: readFileSync(file, 'utf8'), format: 'document' })
      return { message_id: next }
    },
    editMessageText: unused, setMessageReaction: unused, sendChatAction: unused, sendPhoto: unused,
    downloadFile: unused, deleteMessage: unused, answerGuestQuery: unused, sendWidget: unused,
    sendRichMessage: async (): Promise<SendRichMessageResult> => ({ fallback: true }),
  }
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  return { messages, safe: createSafeTelegramApi(raw, createLogger('test', { stream: quiet }), secrets) }
}

// A raw HTML file link forces the plain fallback, where the cut separates `Bearer` from its bold value.
const bearerValue = 'Zq7Kp2Wm9X'
const straddlingBearer = '<a href="file:///' + 'д'.repeat(4073) + '">x</a> Bearer **' + bearerValue + '**'

test.each([
  ['a direct send', undefined],
  ['a planned send', id],
])('[R42] %s of a plain fallback masks a token split from its prefix by the cut, sent and recorded', async (_label, planned) => {
  const eyes = new RenderEyes({})
  const { inbox } = readyReply(straddlingBearer, {})
  const { messages, safe } = safeRecordingTelegram([])
  await delivery(inbox, [], safe, undefined, undefined, eyes).sendFinalText(straddlingBearer, origin, false, id, planned)
  expect(messages.length).toBeGreaterThan(1)
  // A hard cut inside the value leaves no part whole in one message: check the messages joined, too.
  expect(messages.map(message => message.text).join('').includes(bearerValue)).toBe(false)
  for (const message of messages) {
    expect(message.text.includes(bearerValue)).toBe(false)
    expect(eyes.shown(message.id)).toEqual({ format: message.format, text: message.text, messageId: message.id })
  }
})

test('[R42] a deferred plain text is recorded with the text the outbox actually sent', async () => {
  const eyes = new RenderEyes({})
  const value = 'late-path-value-42'
  const source = 'See https://example.com/files/' + value + '/report.txt now'
  const { dir, inbox } = readyReply(source, {})
  // The shared redaction list: a key issued after the enqueue is masked by the transport at the flush.
  const secrets: string[] = []
  let flood = true
  const { messages, safe } = safeRecordingTelegram(secrets, { flood: () => flood })
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  let replies: ReplyCallbacks | undefined
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0,
    sendFn: (chat, text, options) => safe.sendMessage(chat, text, options),
    onDelivered: (item, messageId, sent) => replies?.onDeferredDelivery(item, messageId, sent) })
  replies = delivery(inbox, secrets, safe, undefined, outbox, eyes)
  expect(await replies.sendFinalText(source, origin, false, id)).toBe(true)
  secrets.push(value)
  flood = false
  await outbox.flushDue(5_000)
  expect(messages).toHaveLength(1)
  const [message] = messages
  if (message === undefined) throw new Error('The outbox did not send the deferred reply')
  expect(message.text.includes(value)).toBe(false)
  expect(eyes.shown(message.id)).toEqual({ format: message.format, text: message.text, messageId: message.id })
})

// Synthetic secrets at every offset around each cut: a registered value and a pattern token behind its prefix.
const registered = 'Kv9-registered-77'
const fallbackLink = '<a href="file:///tmp/a">x</a>'
const shapes: [string, (filler: string) => string, string][] = [
  ['plain fallback, registered', filler => fallbackLink + ' ' + filler + ' ' + registered + ' tail', registered],
  ['plain fallback, bearer', filler => fallbackLink + ' ' + filler + ' Bearer **' + bearerValue + '** tail', bearerValue],
  ['HTML, registered', filler => filler + ' **' + registered + '** tail', registered],
  ['HTML, bearer', filler => filler + ' Bearer **' + bearerValue + '** tail', bearerValue],
  ['document, registered', filler => '```\n' + filler + ' ' + registered + ' ' + ' '.repeat(8200) + 'end\n```', registered],
  ['document, bearer', filler => '```\n' + filler + ' Bearer ' + bearerValue + ' ' + ' '.repeat(8200) + 'end\n```', bearerValue],
  // Markup inside a registered value: source masking misses it, only the text Telegram shows joins it.
  ['plain fallback, markup-split registered', filler => fallbackLink + ' ' + filler + ' MA**SK**ME tail', 'MASKME'],
  ['HTML, markup-split registered', filler => filler + ' MA**SK**ME tail', 'MASKME'],
]
// What Telegram shows for a sent message: HTML is parsed, anything else is literal.
const shownText = (message: { text: string; format: string }): string =>
  message.format === 'HTML' ? chunk.htmlToPlainText(message.text) : message.text
test.each(shapes)('[R42] property: %s at every offset around a cut never reaches Telegram or a record', async (_label, shape, raw) => {
  for (let length = 3960; length <= 4110; length += 1) {
    const filler = 'слово '.repeat(Math.ceil(length / 6)).slice(0, length).trimEnd()
    const source = shape(filler)
    for (const planned of [undefined, id]) {
      const eyes = new RenderEyes({})
      const { inbox } = readyReply(source, {})
      const { messages, safe } = safeRecordingTelegram([registered, 'MASKME'])
      await delivery(inbox, [registered, 'MASKME'], safe, undefined, undefined, eyes)
        .sendFinalText(source, origin, false, id, planned)
      expect(messages.length).toBeGreaterThan(0)
      if (messages.map(shownText).join('').includes(raw)) {
        throw new Error(`raw value sent across a cut at filler ${length} (${String(planned)})`)
      }
      for (const message of messages) {
        if (shownText(message).includes(raw)) throw new Error(`raw value sent at filler ${length} (${String(planned)})`)
        const shown = eyes.shown(message.id)
        if (shown?.text !== message.text || shown.format !== message.format) {
          throw new Error(`record differs from the sent message at filler ${length} (${String(planned)})`)
        }
      }
    }
  }
}, 120_000)

// MASKME is a registered value; bold markup splits it, so source masking misses it and only the shown text holds it.
const maskme = 'MASKME'
const splitMaskme = 'MA**SK**ME'

test.each([
  ['a direct send', undefined],
  ['a planned send', id],
])('[R42] %s whose shown secret grows past the limit once masked goes as split plain text', async (_label, planned) => {
  // 4,090 + 6 shown characters: within the limit before masking, 4,100 once MASKME reads [REDACTED].
  const source = '!'.repeat(4090) + splitMaskme
  expect(chunk.htmlToPlainText(markdownToTelegramHtml(source))).toHaveLength(chunk.TELEGRAM_MAX_MESSAGE)
  const eyes = new RenderEyes({})
  const { inbox } = readyReply(source, {})
  const { messages, safe } = safeRecordingTelegram([maskme])
  await delivery(inbox, [maskme], safe, undefined, undefined, eyes).sendFinalText(source, origin, false, id, planned)
  expect(messages.length).toBeGreaterThan(1)
  const joined = messages.map(message => message.text).join('')
  expect(joined.includes(maskme)).toBe(false)
  expect(joined).toBe('!'.repeat(4090) + '[REDACTED]')
  for (const message of messages) {
    expect(eyes.shown(message.id)).toEqual({ format: message.format, text: message.text, messageId: message.id })
  }
  if (planned !== undefined) expect(inbox.replyPart(id, 'text:0')).toBe('fallback')
})

test('[R42] a saved HTML part that masking grows past the limit goes as split plain text, not a refused send', async () => {
  // A plan saved before shown-text masking: the wrapper masks MASKME and the plain text outgrows the message limit.
  const part = '!'.repeat(4090) + 'MA<b>SK</b>ME'
  expect(chunk.telegramTextLength(part)).toBe(chunk.TELEGRAM_MAX_MESSAGE)
  const eyes = new RenderEyes({})
  const { inbox } = readyReply('ignored', { rich: 'fallback' }, [part])
  const { messages, safe } = safeRecordingTelegram([maskme])
  await delivery(inbox, [maskme], safe, undefined, undefined, eyes).sendFinalText('ignored', origin, false, id, id)
  expect(inbox.replyPart(id, 'text:0')).toBe('fallback')
  expect(messages.map(message => message.text).join('')).toBe('!'.repeat(4090) + '[REDACTED]')
  for (const message of messages) {
    expect(message.format).toBe('plain')
    expect(eyes.shown(message.id)).toEqual({ format: message.format, text: message.text, messageId: message.id })
  }
})

test('[R42] a fresh reply plan never persists a secret the shown text joins', async () => {
  const source = 'Ключ ' + splitMaskme + ' тут'
  const { dir, inbox } = readyReply(source, {})
  const { messages, safe } = safeRecordingTelegram([maskme])
  await delivery(inbox, [maskme], safe).sendFinalText(source, origin, false, id, id)
  const plan = new CodexInbox(dir, owner).replyPlan(id) ?? []
  expect(plan.length).toBeGreaterThan(0)
  for (const part of plan) expect(chunk.htmlToPlainText(part).includes(maskme)).toBe(false)
  expect(messages.map(message => message.text)).toEqual(['Ключ [REDACTED] тут'])
})

test('[R42] a flooded HTML reply never queues a secret the shown text joins', async () => {
  const source = 'Ключ ' + splitMaskme + ' тут'
  const { dir, inbox } = readyReply(source, {})
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const outbox = new Outbox({ stateDir: dir, log: createLogger('test', { stream: quiet }), now: () => 0,
    sendFn: async () => ({ message_id: 90 }) })
  const { safe } = safeRecordingTelegram([maskme], { flood: () => true })
  expect(await delivery(inbox, [maskme], safe, undefined, outbox).sendFinalText(source, origin, false, id)).toBe(true)
  expect(outbox.snapshot().length).toBeGreaterThan(0)
  for (const item of outbox.snapshot()) expect(chunk.htmlToPlainText(item.text).includes(maskme)).toBe(false)
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8').includes('MA<b>SK</b>ME')).toBe(false)
})

test('[R42] a resumed plain fallback masks a pattern token across the saved cut it already sent', async () => {
  // The saved part fails the validator, so it goes as plain text; its plain cut lands inside the Bearer value.
  const part = '<b class="demo">x</b>' + 'а'.repeat(4084) + ' Bearer <b>' + bearerValue + '</b>'
  const pieces = chunk.splitPlainFallback(part)
  expect(pieces).toHaveLength(2)
  expect(pieces[0]!.endsWith('Bearer Zq7')).toBe(true)
  const { inbox } = readyReply('ignored', { rich: 'fallback', 'text:0': 'fallback', 'text:0:plain:0': 'sent' }, [part])
  const { messages, safe } = safeRecordingTelegram([])
  await delivery(inbox, [], safe).sendFinalText('ignored', origin, false, id, id)
  expect(inbox.replyPart(id, 'text:0:plain:1')).toBe('sent')
  expect(messages).toHaveLength(1)
  for (const fragment of ['Kp2', 'Wm9X']) expect(messages[0]!.text.includes(fragment)).toBe(false)
})

test('[R42] an agent edit of a Rich Message goes through the safe wrapper and updates its preview', async () => {
  const eyes = new RenderEyes({})
  eyes.record({ source: 'old', parts: [{ format: 'rich', text: 'old', messageId: 70 }] })
  const edits: string[] = []
  const unused = async (): Promise<never> => { throw new Error('not used') }
  const raw: TelegramApi = {
    sendMessage: unused, sendRichMessage: unused, sendWidget: unused, editMessageText: unused,
    setMessageReaction: unused, sendChatAction: unused, sendDocument: unused, sendPhoto: unused,
    downloadFile: unused, deleteMessage: unused, answerGuestQuery: unused,
    async editRichMessage(_chat, _id, markdown) { edits.push(markdown); return {} },
  }
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const safe = createSafeTelegramApi(raw, createLogger('test', { stream: quiet }), [maskme])
  const { inbox } = readyReply('x', {})
  await delivery(inbox, [maskme], safe, undefined, undefined, eyes).editRich(70, '| a |\n|---|\n| ' + maskme + ' |')
  expect(edits).toEqual(['| a |\n|---|\n| [REDACTED] |'])
  expect(eyes.shown(70)).toEqual({ format: 'rich', text: '| a |\n|---|\n| [REDACTED] |', messageId: 70 })
})

test('the key spike sends its fixed texts through the safe wrapper', async () => {
  const sent: { text: string; markup: unknown }[] = []
  let options: { api?: { sendMessage(chat: string, text: string, markup: { remove_keyboard: true }): Promise<unknown> } } = {}
  const bind = new Function('dependencies', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    const { keyspikePage, ownerId, log, KeySpike, safeTelegram } = dependencies
    ${section(server, '  const keyspike = keyspikePage', '  const poller')}
    return keyspike
  `))
  bind({ keyspikePage: 'https://example.com/k', ownerId: owner, log: { warn() {} }, safeTelegram: {
    async sendMessage(_chat: string, text: string, opts: SendMessageOpts) {
      sent.push({ text, markup: opts.reply_keyboard })
      return { message_id: 1 }
    },
  }, KeySpike: class { constructor(value: typeof options) { options = value } } })
  await options.api?.sendMessage(String(owner), 'Тест ключа', { remove_keyboard: true })
  expect(sent).toEqual([{ text: 'Тест ключа', markup: { remove_keyboard: true } }])
})

test('[R42] a rich send reports the redacted Markdown it sent', async () => {
  const unused = async (): Promise<never> => { throw new Error('not used') }
  const bodies: string[] = []
  const raw: TelegramApi = {
    sendMessage: unused, sendWidget: unused, editMessageText: unused, setMessageReaction: unused,
    sendChatAction: unused, sendDocument: unused, sendPhoto: unused, downloadFile: unused, deleteMessage: unused,
    answerGuestQuery: unused,
    async sendRichMessage(_chat, markdown) { bodies.push(markdown); return { message_id: 71 } },
  }
  const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
  const safe = createSafeTelegramApi(raw, createLogger('test', { stream: quiet }), [maskme], createRichLatch())
  const result = await safe.sendRichMessage(String(owner), 'Ключ ' + maskme, {})
  expect(bodies).toEqual(['Ключ [REDACTED]'])
  expect(result).toEqual({ message_id: 71, sent: { text: 'Ключ [REDACTED]', format: 'rich' } })
})
