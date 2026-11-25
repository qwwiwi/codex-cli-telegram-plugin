import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentChatActions } from '../../src/codex/chat-actions.js'

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
