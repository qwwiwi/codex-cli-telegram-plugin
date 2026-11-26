import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import { executeChatAction, requestedChatAction } from '../../src/codex/chat-actions.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { ownerProvenance } from '../../src/codex/provenance.js'
import { automaticContinuation } from '../../src/codex/continuation.js'

const owner = { id: 100, is_bot: false as const, first_name: 'Owner' }
const bot = { id: 1, is_bot: true as const, first_name: 'Example Bot' }
const chat = { id: owner.id, type: 'private' as const, first_name: owner.first_name }
function message(id: number, extra: Partial<Message> = {}): Message {
  return { message_id: id, date: 1, chat, from: owner, ...extra } as Message
}

test('preserves verified continuation across a restart before and after sending progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-durable-handoff-'))
  try {
    const continuation = automaticContinuation('finish the task')
    let inbox = new CodexInbox(root, owner.id)
    inbox.receive(message(7), ownerProvenance)
    inbox.take()
    inbox.start(7, { continuation: continuation.context })
    inbox.assignTurn(7, 'turn-7')
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.work?.continuation).toEqual(continuation.context)
    inbox.complete(7, { text: 'Progress', files: [] }, true)
    inbox.complete(7, { text: '', files: [] })
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.outcome).toEqual({ stage: 'ready', reply: { text: '', files: [] }, continueGoal: true })
    expect(inbox.active?.work?.continuation).toEqual(continuation.context)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('cancelling continuation survives restart without discarding queued work', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-cancel-handoff-'))
  try {
    let inbox = new CodexInbox(root, owner.id)
    inbox.receive(message(7), ownerProvenance)
    inbox.receive(message(8), ownerProvenance)
    inbox.take()
    inbox.start(7, { continuation: automaticContinuation('finish').context })
    inbox.complete(7, { text: 'Progress', files: [] }, true)
    inbox.cancelContinuation()
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.work?.continuation).toBeUndefined()
    expect(inbox.active?.outcome).toEqual({ stage: 'ready', reply: { text: 'Progress', files: [] } })
    expect(inbox.size).toBe(1)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('recovers queued work and album fragments after restart without duplicating their IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-durable-inbox-'))
  try {
    let inbox = new CodexInbox(root, owner.id)
    expect(inbox.receive(message(1, { text: 'first' }), ownerProvenance)).toBe('accepted')
    inbox.receive(message(3, { media_group_id: '123' }), ownerProvenance)
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.receive(message(3, { media_group_id: '123' }), ownerProvenance)).toBe('duplicate')
    inbox.receive(message(2, { media_group_id: '123' }), ownerProvenance)
    expect(inbox.sealAlbum('123')).toBe(true)
    expect(inbox.take()?.map(m => m.message_id)).toEqual([1])
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.messages.map(m => m.message_id)).toEqual([1])
    expect(inbox.take()).toBeUndefined()
    inbox.finish(1)
    expect(inbox.take()?.map(m => m.message_id)).toEqual([2, 3])
    inbox.finish(2)
    expect(inbox.take()).toBeUndefined()
    expect(() => inbox.receive(message(4, { from: bot }), ownerProvenance)).toThrow('owner mismatch')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('moves a whole album atomically to the active follow-up and restores its order on fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-durable-album-'))
  try {
    let inbox = new CodexInbox(root, owner.id)
    inbox.receive(message(13, { media_group_id: 'photo-group' }), ownerProvenance)
    inbox.receive(message(12, { media_group_id: 'photo-group' }), ownerProvenance)
    expect(inbox.claimAlbumFollowUp('photo-group')?.map(m => m.message_id)).toEqual([12, 13])
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.uncertainFollowUp?.message_id).toBe(12)
    expect(inbox.take()).toBeUndefined()
    inbox.finishFollowUp(12, true)
    expect(inbox.take()?.map(m => m.message_id)).toEqual([12, 13])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('preserves the claimed request, the assigned turn and the undelivered result', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-durable-inbox-'))
  try {
    let inbox = new CodexInbox(root, owner.id)
    inbox.receive(message(9, { text: 'request' }), ownerProvenance)
    inbox.take()
    inbox.start(9)
    inbox.assignTurn(9, 'turn-9')
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.outcome).toEqual({ stage: 'running', turnId: 'turn-9' })
    inbox.complete(9, { text: 'answer', files: ['result.txt'] })
    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.outcome).toEqual({ stage: 'ready', reply: { text: 'answer', files: ['result.txt'] } })
    inbox.finish(9)
    expect(new CodexInbox(root, owner.id).active).toBeUndefined()
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('reserves the follow-up queue slot and retains its order after fallback or stop', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-follow-up-order-'))
  try {
    let inbox = new CodexInbox(root, owner.id)
    inbox.beginFollowUp(message(5), ownerProvenance)
    for (let id = 6; id < 21; id++) expect(inbox.receive(message(id), ownerProvenance)).toBe('accepted')
    expect(inbox.receive(message(21), ownerProvenance)).toBe('full')
    inbox = new CodexInbox(root, owner.id)
    inbox.finishFollowUp(5, true)
    expect(inbox.size).toBe(16)
    expect(inbox.take()?.[0]?.message_id).toBe(5)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('scopes pin, reaction and edit to the private quoted message and protects system cards', async () => {
  const calls: unknown[] = []
  const api = {
    async pinChatMessage(...args: unknown[]) { calls.push(['pin', ...args]) },
    async unpinChatMessage(...args: unknown[]) { calls.push(['unpin', ...args]) },
    async setMessageReaction(...args: unknown[]) { calls.push(['react', ...args]) },
    async editMessageText(...args: unknown[]) { calls.push(['edit', ...args]) },
  }
  const reply = message(7, { from: bot, text: 'reply' })
  expect(requestedChatAction('Полярная звезда, пожалуйста, закрепи этот ответ', 'Полярная звезда')).toBe('pin')
  expect(requestedChatAction('Полярная звезда, закрепи этот ответ', 'Другой агент')).toBeUndefined()
  expect(requestedChatAction('закрепи этот ответ')).toBe('pin')
  await executeChatAction(api, '100', 1, 'pin', reply, '')
  await executeChatAction(api, '100', 1, 'edit', reply, 'corrected')
  await executeChatAction(api, '100', 1, 'edit', message(8, { text: 'user message' }), 'blocked')
  await executeChatAction(api, '100', 1, 'unpin', message(9, { from: bot, text: '🔐 card' }), '')
  await executeChatAction(api, '100', 1, 'react', reply, '👍')
  expect(calls).toEqual([
    ['pin', '100', 7, { disable_notification: true }],
    ['edit', '100', 7, 'corrected', {}],
    ['react', '100', 7, '👍'],
  ])
})
