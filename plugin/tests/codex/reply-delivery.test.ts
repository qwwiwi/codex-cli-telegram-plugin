import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexInbox } from '../../src/codex/inbox.js'
import { deliverReplyPart, sendsAsRich, type PartStatus } from '../../src/codex/reply-delivery.js'
import { isPlanV3, replyPieces, type PlanStore, type PlanV3 } from '../../src/codex/reply-plan.js'
import { markdownToTelegramHtml } from '../../src/format/html.js'
import { splitLongBlock } from '../../src/format/paragraphs.js'
import { mask, render, visibleToHtml, type VisibleText } from '../../src/format/visible.js'

const OWNER = 42
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('skips confirmed parts and interrupted sends, and retries proven pre-send failures', async () => {
  const saved = new Map<string, PartStatus>([['text:0', 'sent'], ['file:0', 'sending']])
  const invoke = (key: string, send: () => Promise<object>) => deliverReplyPart(
    saved.get(key), state => { if (state) saved.set(key, state); else saved.delete(key) }, send,
  )
  const calls: string[] = []
  const send = async (label: string) => { calls.push(label); return { message_id: 17 } }
  expect((await invoke('text:0', () => send('old text'))).state).toBe('sent')
  expect((await invoke('file:0', () => send('uncertain file'))).state).toBe('uncertain')
  await expect(invoke('file:1', async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  })).rejects.toThrow('offline')
  expect(saved.has('file:1')).toBe(false)
  expect((await invoke('file:1', () => send('new file'))).state).toBe('sent')
  expect(calls).toEqual(['new file'])
})

// A 50-row list under a title and a prose line, one block without blank lines: two Telegram messages.
const rows = Array.from({ length: 50 }, (_, index) =>
  `- Строка ${String(index).padStart(2, '0')}: сервер проверен, журнал доставки чистый, повторов за сутки нет, место на диске есть, память в норме.`)
const listReply = ['**Отчёт по серверам**', 'Ниже полный список проверок за сутки, по одной строке на сервер.', ...rows].join('\n')

function savedReady(delivery: Record<string, PartStatus>, extra: object = {}): { dir: string; inbox: CodexInbox } {
  const dir = mkdtempSync(join(tmpdir(), 'krot-reply-plan-'))
  dirs.push(dir)
  const message = { message_id: 7, date: 1, text: 'Пришли отчёт', chat: { id: OWNER, type: 'private', first_name: 'O' },
    from: { id: OWNER, is_bot: false, first_name: 'O' } }
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [], albums: {}, accepted: [7], origins: { 7: { origin: 'owner' } },
    active: { messages: [message], outcome: { stage: 'ready', reply: { text: listReply, files: [] }, delivery, ...extra } },
  }))
  return { dir, inbox: new CodexInbox(dir, OWNER) }
}

// The reply as sendFinalText renders it: Markdown → Telegram HTML → masked shown text.
const shown = (reply: string, secrets: readonly string[] = []) => (): VisibleText =>
  mask(render(markdownToTelegramHtml(splitLongBlock(reply)), 'HTML'), secrets)

// Sends the planned pieces the way sendFinalText does and returns the texts that reached the chat.
async function resume(inbox: CodexInbox): Promise<string[]> {
  const sent: string[] = []
  for (const [index, piece] of replyPieces(inbox, 7, shown(listReply), []).entries()) {
    const key = 'text:' + index
    const result = await deliverReplyPart(inbox.replyPart(7, key), state => inbox.setReplyPart(7, key, state),
      async () => { sent.push(piece.text); return { message_id: 100 + index } })
    expect(['sent', 'uncertain', 'failed']).toContain(result.state)
  }
  return sent
}

const rowCount = (chat: string, index: number): number =>
  chat.split(`Строка ${String(index).padStart(2, '0')}:`).length - 1

test('[R92] a new delivery saves its chunk plan, and a resumed delivery sends the saved chunks', async () => {
  const { dir, inbox } = savedReady({ rich: 'fallback' })
  const first = replyPieces(inbox, 7, shown(listReply), [])
  expect(first.length).toBeGreaterThan(1)
  const plan = inbox.replyPlan(7)
  // Part 0 went out, then the bridge restarted.
  inbox.setReplyPart(7, 'text:0', 'sent')
  const reloaded = new CodexInbox(dir, OWNER)
  expect(reloaded.replyPlan(7)).toEqual(plan)
  const chat = [first[0]?.text ?? '', ...await resume(reloaded)].join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
})

test('[R92] an empty saved v0.6 chunk plan without receipts is dropped: the reply text still goes out', async () => {
  const { inbox } = savedReady({ rich: 'fallback' }, { textPlan: [] })
  const chat = (await resume(inbox)).join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
})

test('a prose reply goes out as HTML whose paragraphs and list keep an empty line between them in Telegram', () => {
  // Telegram renders a Rich Message's Markdown paragraphs on new lines with no empty line between them; the HTML path
  // sends the blank lines as written. Rich stays for what only Telegram's Markdown renders: tables, math, task lists.
  const reply = 'Первый абзац с **жирным** словом.\n\nВторой абзац перед списком:\n\n- пункт `один`\n- пункт два\n\n' +
    'Третий абзац с `code` в конце.'
  const rich = { enabled: true, perChatOptOut: [] }
  expect(sendsAsRich(reply, String(OWNER), rich)).toBe(false)
  const plans = new Map<number, PlanV3>()
  const store: PlanStore = {
    replyPart: () => undefined, hasTextReceipt: () => false, replyPlan: id => plans.get(id),
    setReplyPlan: (id, plan) => { plans.set(id, plan) },
  }
  expect(replyPieces(store, 1, shown(reply), []).map(visibleToHtml)).toEqual([
    'Первый абзац с <b>жирным</b> словом.\n\nВторой абзац перед списком:\n\n- пункт <code>один</code>\n- пункт два\n\n' +
    'Третий абзац с <code>code</code> в конце.',
  ])
  expect(sendsAsRich('Итоги:\n\n| Сервер | Статус |\n| --- | --- |\n| a | ok |', String(OWNER), rich)).toBe(true)
  expect(sendsAsRich('Площадь:\n\n$$S = \\pi r^2$$', String(OWNER), rich)).toBe(true)
  expect(sendsAsRich('План:\n\n- [x] собрать\n- [ ] выкатить', String(OWNER), rich)).toBe(true)
  // Off, opted out or with files: never rich.
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  expect(sendsAsRich(table, String(OWNER), { enabled: false, perChatOptOut: [] })).toBe(false)
  expect(sendsAsRich(table, String(OWNER), { enabled: true, perChatOptOut: [String(OWNER)] })).toBe(false)
  expect(sendsAsRich(table, String(OWNER), rich, true)).toBe(false)
})

// Inbox migration of a v0.6 plan (string parts of self-balanced HTML), decided by its receipts.
const legacyParts = ['<b>Первая часть</b> текста\n\n', '<i>Вторая часть</i> текста MASKME']

test('inbox migration A: no text receipt drops the old plan and plans the reply fresh', async () => {
  const { dir, inbox } = savedReady({ rich: 'fallback' }, { textPlan: legacyParts })
  expect(inbox.replyPlan(7)).toBeUndefined()
  expect(inbox.takeUpgradeNotice()).toBe(false)
  const chat = (await resume(inbox)).join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
  expect(new CodexInbox(dir, OWNER).replyPlan(7)?.v).toBe(3)
})

test('inbox migration B: every part has a receipt, nothing is pending', async () => {
  const { inbox } = savedReady({ rich: 'fallback', 'text:0': 'sent', 'text:1': 'sent' }, { textPlan: legacyParts })
  expect(inbox.replyPlan(7)).toEqual({ v: 3, text: '', entities: [], cuts: [] })
  expect(inbox.takeUpgradeNotice()).toBe(false)
  expect(await resume(inbox)).toEqual([])
  expect(inbox.replyPart(7, 'text:1')).toBe('sent')
})

test('inbox migration C: a partly sent plan becomes one v3 plan with the same cuts and resumes masked', async () => {
  const { inbox } = savedReady({ rich: 'fallback', 'text:0': 'sent' }, { textPlan: legacyParts })
  const plan = inbox.replyPlan(7)
  expect(plan).toEqual({ v: 3, text: 'Первая часть текста\n\nВторая часть текста MASKME', cuts: [21, 47], entities: [
    { type: 'bold', offset: 0, length: 12 }, { type: 'italic', offset: 21, length: 12 }] })
  expect(inbox.takeUpgradeNotice()).toBe(false)
  const pieces = replyPieces(inbox, 7, shown(listReply), ['MASKME'])
  expect(pieces.map(piece => piece.text)).toEqual(['Первая часть текста\n\n', 'Вторая часть текста [REDACTED]'])
  expect(pieces[1]?.entities).toEqual([{ type: 'italic', offset: 0, length: 12 }])
})

test.each([
  ['a plain-fallback receipt', { 'text:0': 'fallback', 'text:0:plain:0': 'sent' }, legacyParts],
  ['a blanked slot', { 'text:0': 'sent' }, ['', legacyParts[1]!]],
  ['plain-fallback metadata', { 'text:0': 'sent' }, [...legacyParts, '<u data-plain-fallbacks="%7B%7D"></u>']],
  ['receipts without a plan', { 'text:0': 'sent' }, undefined],
] satisfies [string, Record<string, PartStatus>, string[] | undefined][])(
'inbox migration D: %s marks the pending parts uncertain and tells the owner once', async (_label, receipts, parts) => {
  const delivery: Record<string, PartStatus> = { rich: 'fallback', ...receipts }
  const { dir, inbox } = savedReady(delivery, parts === undefined ? {} : { textPlan: parts })
  expect(inbox.replyPlan(7)).toEqual({ v: 3, text: '', entities: [], cuts: [] })
  expect(inbox.takeUpgradeNotice()).toBe(true)
  expect(inbox.takeUpgradeNotice()).toBe(false)
  expect(await resume(inbox)).toEqual([])
  if (parts !== undefined) expect(inbox.replyPart(7, 'text:1')).toBe('uncertain')
  // The upgrade wrote v3 state: a second load changes no byte and gives no second notice.
  const file = join(dir, 'codex-inbox.json')
  const first = readFileSync(file, 'utf8')
  const again = new CodexInbox(dir, OWNER)
  expect(readFileSync(file, 'utf8')).toBe(first)
  expect(again.takeUpgradeNotice()).toBe(false)
})

test('inbox migration runs once: a second load of an upgraded file changes no byte', () => {
  const { dir } = savedReady({ rich: 'fallback', 'text:0': 'sent' }, { textPlan: legacyParts })
  const file = join(dir, 'codex-inbox.json')
  const first = readFileSync(file, 'utf8')
  expect(first).toContain('"v":3')
  new CodexInbox(dir, OWNER)
  expect(readFileSync(file, 'utf8')).toBe(first)
})

// Case C with a value cut across the saved parts: `MA` already went, `SKME tail` is pending.
function seamReady(secrets: readonly string[]): { dir: string; inbox: CodexInbox } {
  const dir = mkdtempSync(join(tmpdir(), 'krot-reply-plan-'))
  dirs.push(dir)
  const message = { message_id: 7, date: 1, text: 'Пришли отчёт', chat: { id: OWNER, type: 'private', first_name: 'O' },
    from: { id: OWNER, is_bot: false, first_name: 'O' } }
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [], albums: {}, accepted: [7], origins: { 7: { origin: 'owner' } },
    active: { messages: [message], outcome: { stage: 'ready', reply: { text: 'MASKME tail', files: [] },
      delivery: { rich: 'fallback', 'text:0': 'sent' }, textPlan: ['MA', 'SKME tail'] } },
  }))
  return { dir, inbox: new CodexInbox(dir, OWNER, secrets) }
}

async function resumeWith(inbox: CodexInbox, secrets: readonly string[]): Promise<string[]> {
  const sent: string[] = []
  for (const [index, piece] of replyPieces(inbox, 7, shown('unused', secrets), secrets).entries()) {
    const key = 'text:' + index
    await deliverReplyPart(inbox.replyPart(7, key), state => inbox.setReplyPart(7, key, state),
      async () => { sent.push(piece.text); return { message_id: 100 + index } })
  }
  return sent
}

test('[S5] the upgrade masks and maps the cuts before its first write: the file never holds the value', async () => {
  const secrets = ['MASKME']
  const { dir, inbox } = seamReady(secrets)
  const file = readFileSync(join(dir, 'codex-inbox.json'), 'utf8')
  expect(file).not.toContain('MASKME')
  expect(file).not.toContain('SKME')
  expect(inbox.replyPlan(7)).toEqual({ v: 3, text: '[REDACTED] tail', entities: [], cuts: [0, 15] })
  expect(inbox.takeUpgradeNotice()).toBe(false)
  expect(await resumeWith(inbox, secrets)).toEqual(['[REDACTED] tail'])
})

test('[S5] a saved v3 plan is masked with the current secrets on load, before anything else writes it', () => {
  const { dir } = seamReady([])
  expect(readFileSync(join(dir, 'codex-inbox.json'), 'utf8')).toContain('"v":3')
  const reloaded = new CodexInbox(dir, OWNER, ['MASKME'])
  expect(reloaded.replyPlan(7)?.text).toBe('[REDACTED] tail')
  expect(readFileSync(join(dir, 'codex-inbox.json'), 'utf8')).not.toContain('MASKME')
})

test('[S6] a sent piece the marker swallowed keeps its receipt across a second restart; the tail still goes', async () => {
  const { dir, inbox } = seamReady([])
  const secrets = ['MASKME']
  // The resume maps the sent cut into the marker's start: the saved cuts become [0, 15].
  replyPieces(inbox, 7, shown('unused', secrets), secrets)
  expect(inbox.replyPlan(7)?.cuts).toEqual([0, 15])
  const again = new CodexInbox(dir, OWNER)
  expect(again.takeUpgradeNotice()).toBe(false)
  expect(again.replyPlan(7)?.cuts).toEqual([0, 15])
  expect(await resumeWith(again, secrets)).toEqual(['[REDACTED] tail'])
  expect(isPlanV3({ v: 3, text: 'aaaabbbb', entities: [], cuts: [4, 4, 8] })).toBe(true)
  expect(isPlanV3({ v: 3, text: 'aaaabbbb', entities: [], cuts: [4, 2] })).toBe(false)
})

test('[N4] a legacy fallback receipt without its plain receipts is case D: pending pieces uncertain, with a notice', async () => {
  const { inbox } = savedReady({ rich: 'fallback', 'text:0': 'fallback', 'text:1': 'sent' }, { textPlan: legacyParts })
  expect(inbox.takeUpgradeNotice()).toBe(true)
  expect(inbox.replyPlan(7)).toEqual({ v: 3, text: '', entities: [], cuts: [] })
  expect(await resume(inbox)).toEqual([])
})

test('[N4] a legacy reply fully delivered through plain fallbacks upgrades without a notice', async () => {
  const metadata = '<u data-plain-fallbacks="' + encodeURIComponent(JSON.stringify({ 0: ['p0', 'p1'] })) + '"></u>'
  const { inbox } = savedReady({ rich: 'fallback', 'text:0': 'fallback', 'text:0:plain:0': 'sent',
    'text:0:plain:1': 'sent', 'text:1': 'sent' }, { textPlan: [...legacyParts, metadata] })
  expect(inbox.takeUpgradeNotice()).toBe(false)
  expect(inbox.replyPlan(7)).toEqual({ v: 3, text: '', entities: [], cuts: [] })
  expect(await resume(inbox)).toEqual([])
})
