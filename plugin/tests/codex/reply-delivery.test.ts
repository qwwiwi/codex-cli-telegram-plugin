import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexInbox } from '../../src/codex/inbox.js'
import { deliverReplyPart, plannedTextParts, type PartStatus } from '../../src/codex/reply-delivery.js'
import { splitMessage } from '../../src/format/chunk.js'
import { markdownToTelegramHtml } from '../../src/format/html.js'

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

// Sends the planned parts the way sendFinalText does and returns what reached the chat.
async function resume(inbox: CodexInbox): Promise<string[]> {
  const sent: string[] = []
  for (const [index, part] of plannedTextParts(inbox, 7, listReply).entries()) {
    const key = 'text:' + index
    const result = await deliverReplyPart(inbox.replyPart(7, key), state => inbox.setReplyPart(7, key, state),
      async () => { sent.push(part); return { message_id: 100 + index } })
    expect(result.state).toBe('sent')
  }
  return sent
}

const rowCount = (chat: string, index: number): number =>
  chat.split(`Строка ${String(index).padStart(2, '0')}:`).length - 1

test('[R92] a reply whose first chunk went out before paragraph grouping resumes with the old chunks and loses no row', async () => {
  // What the version before paragraph grouping sent: the safety net left this text as it was (no line over 450).
  const legacy = splitMessage(markdownToTelegramHtml(listReply))
  expect(legacy.length).toBe(2)
  const { inbox } = savedReady({ rich: 'fallback', 'text:0': 'sent' })
  const chat = [legacy[0] ?? '', ...await resume(inbox)].join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
})

test('[R92] a new delivery saves its chunk plan, and a resumed delivery sends the saved chunks', async () => {
  const { dir, inbox } = savedReady({ rich: 'fallback' })
  const first = plannedTextParts(inbox, 7, listReply)
  expect(first.length).toBeGreaterThan(1)
  // Part 0 went out, then the bridge restarted.
  inbox.setReplyPart(7, 'text:0', 'sent')
  const reloaded = new CodexInbox(dir, OWNER)
  expect(reloaded.replyPlan(7)).toEqual(first)
  const chat = [first[0] ?? '', ...await resume(reloaded)].join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
})

test('[R92] an empty saved chunk plan is not trusted: the reply text still goes out', async () => {
  const { inbox } = savedReady({ rich: 'fallback' }, { textPlan: [] })
  const chat = (await resume(inbox)).join('\n')
  for (const index of rows.keys()) expect(rowCount(chat, index)).toBe(1)
})
