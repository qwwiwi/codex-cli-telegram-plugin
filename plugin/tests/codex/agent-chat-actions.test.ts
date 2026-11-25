import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentChatActions } from '../../src/codex/chat-actions.js'

test('hides the transport label in native replies and preserves file-only delivery', async () => {
  const sent: string[] = []
  const actions = new AgentChatActions({
    async sendMessage(_chat, text) { sent.push(text); return { message_id: 24 } },
    async editMessageText() {}, async pinChatMessage() {}, async unpinChatMessage() {}, async setMessageReaction() {},
  }, '123', { async sendFile(path) { sent.push(path); return 25 } })
  expect((await actions.call('text', { action: 'reply', text: '**Ответ в чате:** Проверю' }, () => true)).success).toBe(true)
  expect((await actions.call('file', { action: 'reply', text: 'Ответ в чате:', files: ['result.txt'] }, () => true)).success).toBe(true)
  expect(sent).toEqual(['Проверю', 'result.txt'])
})

test('recovers a known target and can send an attachment as a quoted interim reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-agent-targets-'))
  const calls: unknown[][] = []
  const api = {
    async sendMessage() { throw new Error('Expected file-only reply') },
    async editMessageText() {},
    async pinChatMessage() {},
    async unpinChatMessage() {},
    async setMessageReaction() {},
  }
  try {
    new AgentChatActions(api, '123', { root }).remember(19, true, true)
    const restarted = new AgentChatActions(api, '123', {
      root,
      async sendFile(path, target) { calls.push([path, target]) },
    })
    expect(await restarted.receive('file',
      '@@TELEGRAM_ACTION {"action":"reply","target":"last_reply","files":["telegram-outbox/result.txt"]}', () => true))
      .toBe(true)
    expect(calls).toEqual([['telegram-outbox/result.txt', 19]])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('agent can reply to the owner, edit its reply, and pin the same message', async () => {
  const calls: unknown[][] = []
  const actions = new AgentChatActions({
    async sendMessage(chat, text, options) { calls.push(['send', chat, text, options]); return { message_id: 24 } },
    async editMessageText(chat, id, text) { calls.push(['edit', chat, id, text]) },
    async pinChatMessage(chat, id) { calls.push(['pin', chat, id]) },
    async unpinChatMessage() {},
    async setMessageReaction() {},
  }, '123')
  actions.remember(12, false)
  await Promise.all([
    actions.receive('one', '@@TELEGRAM_ACTION {"action":"reply","target":12,"text":"Проверяю"}', () => true),
    actions.receive('two', '@@TELEGRAM_ACTION {"action":"edit","target":"last_reply","text":"Готово"}', () => true),
    actions.receive('three', '@@TELEGRAM_ACTION {"action":"pin","target":"last_reply"}', () => true),
    actions.receive('three', '@@TELEGRAM_ACTION {"action":"pin","target":"last_reply"}', () => true),
  ])
  expect(calls).toEqual([
    ['send', '123', 'Проверяю', { reply_to_message_id: 12 }],
    ['edit', '123', 24, 'Готово'],
    ['pin', '123', 24],
  ])
})

test('agent does not edit owner messages, target unknown IDs, send to other chats, or act after stop', async () => {
  const unexpected = async () => { throw new Error('Unexpected Telegram call') }
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, pinChatMessage: unexpected,
    unpinChatMessage: unexpected, setMessageReaction: unexpected,
  }, '123')
  actions.remember(12, false)
  await actions.receive('edit', '@@TELEGRAM_ACTION {"action":"edit","target":12,"text":"Нет"}', () => true)
  await actions.receive('pin', '@@TELEGRAM_ACTION {"action":"pin","target":999}', () => true)
  await actions.receive('foreign', '@@TELEGRAM_ACTION {"action":"reply","chat_id":999,"text":"Нет"}', () => true)
  await actions.receive('stopped', '@@TELEGRAM_ACTION {"action":"reply","text":"Нет"}', () => false)
  await actions.receive('quoted', 'Пример: @@TELEGRAM_ACTION {"action":"reply","text":"Нет"}', () => true)
  expect(actions.lastReply).toBeUndefined()
})

test('only downloads attachments referenced by a known message in the owner chat', async () => {
  const unexpected = async () => { throw new Error('Unexpected Telegram call') }
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, pinChatMessage: unexpected,
    unpinChatMessage: unexpected, setMessageReaction: unexpected,
  }, '123')
  actions.remember(12, false)
  const downloads: number[] = []
  const download = async (target: number) => { downloads.push(target); return true }
  expect(await actions.receive('known', '@@TELEGRAM_ACTION {"action":"download","target":12}', () => true, download)).toBe(true)
  expect(await actions.receive('unknown', '@@TELEGRAM_ACTION {"action":"download","target":53}', () => true, download)).toBe(false)
  expect(downloads).toEqual([12])
})

test('reports the actual Telegram IDs and does not repeat a reply if feedback fails', async () => {
  const receipts: unknown[] = []
  let sends = 0
  const actions = new AgentChatActions({
    async sendMessage() { sends++; return { message_id: 24 } },
    async editMessageText() {},
    async pinChatMessage() {},
    async unpinChatMessage() {},
    async setMessageReaction() {},
  }, '123', { async sendFile() { return 25 } })
  const feedback = async (result: unknown) => { receipts.push(result); throw new Error('Turn closed') }
  const message = '@@TELEGRAM_ACTION {"action":"reply","text":"Готово","files":["result.txt"],"request_id":"r1"}'
  expect(await actions.receive('reply-1', message, () => true, undefined, feedback)).toBe(true)
  expect(await actions.receive('reply-1', message, () => true, undefined, feedback)).toBe(false)
  expect(sends).toBe(1)
  expect(receipts).toEqual([{ request_id: 'r1', action: 'reply', ok: true, message_ids: [24, 25] }])
})

test('remembers an agent reply sent through the rich renderer for subsequent edits', async () => {
  const edited: unknown[] = []
  const actions = new AgentChatActions({
    async sendMessage() { throw new Error('Expected shared rich sender') },
    async editMessageText() { throw new Error('Expected rich edit') },
    async pinChatMessage() {},
    async unpinChatMessage() {},
    async setMessageReaction() {},
  }, '123', {
    async sendReply() { return { messageId: 55, rich: true } },
    async editRich(id, text) { edited.push([id, text]) },
  })
  expect(await actions.receive('reply-1', '@@TELEGRAM_ACTION {"action":"reply","text":"**Итог**"}', () => true)).toBe(true)
  expect(await actions.receive('edit-1', '@@TELEGRAM_ACTION {"action":"edit","target":"last_reply","text":"Новый итог"}', () => true)).toBe(true)
  expect(edited).toEqual([[55, 'Новый итог']])
})

test('a native chat action waits for Telegram and returns the actual IDs once per call', async () => {
  const sent = Promise.withResolvers<{ message_id: number }>()
  let sends = 0
  const actions = new AgentChatActions({
    async sendMessage() { sends++; return sent.promise },
    async editMessageText() {}, async pinChatMessage() {}, async unpinChatMessage() {}, async setMessageReaction() {},
  }, '123', { async sendFile() { return 25 } })
  const args = { action: 'reply', text: 'Готово', files: ['result.txt'] }
  let completed = false
  const result = actions.call('call-1', args, () => true).then(value => {
    completed = true
    return value
  })
  const replay = actions.call('call-1', args, () => true)
  await Promise.resolve()
  expect(completed).toBe(false)
  sent.resolve({ message_id: 24 })
  const response = await result
  expect(await replay).toEqual(response)
  expect(sends).toBe(1)
  expect(response.success).toBe(true)
  expect(response.contentItems[0].type).toBe('inputText')
  expect(JSON.parse(response.contentItems[0].text)).toEqual({ action: 'reply', ok: true, message_ids: [24, 25] })
})

test('native chat actions enforce target ownership and discard queued calls after stop', async () => {
  const blocker = Promise.withResolvers<{ message_id: number }>()
  const unexpected = async () => { throw new Error('Unexpected Telegram call') }
  const actions = new AgentChatActions({
    sendMessage: () => blocker.promise, editMessageText: unexpected, pinChatMessage: unexpected,
    unpinChatMessage: unexpected, setMessageReaction: unexpected,
  }, '123')
  actions.remember(12, false)
  expect((await actions.call('edit', { action: 'edit', target: 12, text: 'Отказ' }, () => true)).success).toBe(false)
  expect((await actions.call('foreign', { action: 'reply', chat_id: 999, text: 'Отказ' }, () => true)).success).toBe(false)
  const reply = actions.call('reply', { action: 'reply', text: 'В работе' }, () => true)
  let current = true
  const queued = actions.call('pin', { action: 'pin', target: 12 }, () => current)
  current = false
  blocker.resolve({ message_id: 24 })
  expect((await reply).success).toBe(true)
  expect((await queued).success).toBe(false)
})

test('native download returns only the file from a known Telegram message', async () => {
  const unexpected = async () => { throw new Error('Unexpected Telegram call') }
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, pinChatMessage: unexpected,
    unpinChatMessage: unexpected, setMessageReaction: unexpected,
  }, '123')
  actions.remember(12, false)
  const targets: number[] = []
  const download = async (target: number) => {
    targets.push(target)
    return target === 12 ? { path: '/inbox/report.pdf', size: 23 } : undefined
  }
  const denied = await actions.call('unknown', { action: 'download', target: 53 }, () => true, download)
  expect(denied.success).toBe(false)
  const result = await actions.call('download', { action: 'download', target: 12 }, () => true, download)
  expect(targets).toEqual([12])
  expect(result.success).toBe(true)
  expect(JSON.parse(result.contentItems[0].text)).toEqual({
    action: 'download', ok: true, message_ids: [12], attachment: { path: '/inbox/report.pdf', size: 23 },
  })
})
