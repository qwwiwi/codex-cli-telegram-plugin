import { expect, test } from 'bun:test'
import { chatKeyOf, currentPublicRole, gateInbound, isAddressed, type GateChat, type GateMessage } from '../../src/access/gate.js'
import type { AccessRole } from '../../src/access/store.js'

const OWNER = 1001
const MEMBER = 2002
const GUEST = 3003
const STRANGER = 4004
const BOT_ID = 9009
const GROUP = -100777
const OPEN_GROUP = -100888
const UNAPPROVED = -100999

const roles: Record<string, AccessRole> = { [OWNER]: 'owner', [MEMBER]: 'member', [GUEST]: 'guest' }
const chats: Record<string, GateChat> = {
  [GROUP]: { mode: 'members', topics: 'per-topic' },
  [OPEN_GROUP]: { mode: 'open', topics: 'shared' },
}
const context = {
  ownerId: String(OWNER), botId: BOT_ID, botUsername: 'Krot_Bot',
  roleOf: (id: string) => roles[id], chat: (id: string) => chats[id],
}

function dm(fromId: number, text: string, extra: Partial<GateMessage> = {}): GateMessage {
  return { messageId: 5, chatId: fromId, chatType: 'private', fromId, isBot: false, text, forwarded: false, ...extra }
}
function mention(text = '@krot_bot привет'): Partial<GateMessage> {
  return { text, entities: [{ type: 'mention', offset: text.indexOf('@'), length: '@krot_bot'.length }] }
}
function group(fromId: number, chatId: number, extra: Partial<GateMessage> = {}): GateMessage {
  return { messageId: 7, chatId, chatType: 'supergroup', fromId, isBot: false, text: 'просто болтаем', forwarded: false, ...extra }
}

test('[S2] gate: only the owner private chat takes the owner path', () => {
  expect(gateInbound(dm(OWNER, 'привет'), context)).toEqual({ kind: 'owner' })
  // The owner in a group gets the member ceiling, never the owner path.
  expect(gateInbound(group(OWNER, GROUP, mention()), context)).toMatchObject({ kind: 'placeholder', role: 'member' })
  // A private chat whose id is not the sender's is not trusted.
  expect(gateInbound(dm(OWNER, 'привет', { chatId: 5555 }), context)).toEqual({ kind: 'drop', reason: 'chat_mismatch' })
})

test('[S2] gate: private chats by role', () => {
  expect(gateInbound(dm(MEMBER, 'вопрос'), context))
    .toEqual({ kind: 'placeholder', role: 'member', chatKey: String(MEMBER), chatId: MEMBER, replyTo: 5 })
  expect(gateInbound(dm(GUEST, 'вопрос'), context)).toMatchObject({ kind: 'placeholder', role: 'guest', chatKey: String(GUEST) })
  // A listed user's /start and a stranger's anything go to the S1 access controller.
  expect(gateInbound(dm(MEMBER, '/start'), context)).toEqual({ kind: 'access' })
  expect(gateInbound(dm(STRANGER, 'привет'), context)).toEqual({ kind: 'access' })
  expect(gateInbound(dm(MEMBER, 'x', { isBot: true }), context)).toEqual({ kind: 'drop', reason: 'bot' })
})

test('[S2] gate: groups need approval and an address', () => {
  expect(gateInbound(group(MEMBER, UNAPPROVED, mention()), context)).toEqual({ kind: 'drop', reason: 'chat_not_approved' })
  expect(gateInbound(group(MEMBER, GROUP), context)).toEqual({ kind: 'drop', reason: 'not_addressed' })
  expect(gateInbound(group(MEMBER, GROUP, mention()), context))
    .toEqual({ kind: 'placeholder', role: 'member', chatKey: String(GROUP), chatId: GROUP, replyTo: 7 })
  // members mode: listed people only; a guest is listed.
  expect(gateInbound(group(GUEST, GROUP, mention()), context)).toMatchObject({ kind: 'placeholder', role: 'guest' })
  expect(gateInbound(group(STRANGER, GROUP, mention()), context)).toEqual({ kind: 'drop', reason: 'not_listed' })
  // open mode: a stranger is served as a guest.
  expect(gateInbound(group(STRANGER, OPEN_GROUP, mention()), context)).toMatchObject({ kind: 'placeholder', role: 'guest' })
  expect(gateInbound(group(MEMBER, GROUP, { ...mention(), chatType: 'channel' }), context))
    .toEqual({ kind: 'drop', reason: 'chat_type' })
  expect(gateInbound(group(MEMBER, GROUP, { ...mention(), isBot: true }), context)).toEqual({ kind: 'drop', reason: 'bot' })
})

test('[S2] addressing: @mention, reply to her message, /cmd@bot; nothing else', () => {
  const at = (extra: Partial<GateMessage>) => isAddressed(group(MEMBER, GROUP, extra), context)
  expect(at(mention())).toBe(true)
  expect(at(mention('ну @KROT_BOT скажи'))).toBe(true)
  // A plain-text "@krot_bot" without a mention entity, or a longer username, is not an address.
  expect(at({ text: '@krot_bot привет' })).toBe(false)
  expect(at({ text: '@krot_bot2 hi', entities: [{ type: 'mention', offset: 0, length: 10 }] })).toBe(false)
  expect(at({ text: 'эй', entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: BOT_ID } }] })).toBe(true)
  expect(at({ caption: 'фото @krot_bot', captionEntities: [{ type: 'mention', offset: 5, length: 9 }], text: undefined })).toBe(true)
  expect(at({ replyTo: { fromId: BOT_ID, topicRoot: false } })).toBe(true)
  expect(at({ replyTo: { fromId: MEMBER, topicRoot: false } })).toBe(false)
  // In a forum every message "replies" to the topic root; that is not a reply to her.
  expect(at({ replyTo: { fromId: BOT_ID, topicRoot: true } })).toBe(false)
  expect(at({ text: '/help@krot_bot' })).toBe(true)
  expect(at({ text: '/help' })).toBe(false)
  expect(at({ text: '/help@other_bot' })).toBe(false)
  // A forwarded message is never an address.
  expect(at({ ...mention(), forwarded: true })).toBe(false)
})

test('[S2] chat keys: private per user, group, per topic', () => {
  expect(chatKeyOf(dm(MEMBER, 'x'), undefined)).toBe(String(MEMBER))
  expect(chatKeyOf(group(MEMBER, GROUP), chats[GROUP])).toBe(String(GROUP))
  const topic = group(MEMBER, GROUP, { isForum: true, isTopicMessage: true, threadId: 42 })
  expect(chatKeyOf(topic, chats[GROUP])).toBe(GROUP + '__t42')
  expect(chatKeyOf({ ...topic, threadId: 43 }, chats[GROUP])).toBe(GROUP + '__t43')
  // topics: shared keeps one key for the whole group.
  expect(chatKeyOf({ ...topic, chatId: OPEN_GROUP }, chats[OPEN_GROUP])).toBe(String(OPEN_GROUP))
  // A reply thread in a non-forum group is not a topic.
  expect(chatKeyOf(group(MEMBER, GROUP, { threadId: 42 }), chats[GROUP])).toBe(String(GROUP))
  // The placeholder answers into the same topic.
  expect(gateInbound({ ...topic, ...mention() }, context))
    .toEqual({ kind: 'placeholder', role: 'member', chatKey: GROUP + '__t42', chatId: GROUP, replyTo: 7, threadId: 42 })
})

test('[S2] the placeholder answers in the same chat and topic, never through Codex', async () => {
  const { placeholderReply } = await import('../../src/access/gate.js')
  const topic = group(MEMBER, GROUP, { ...mention(), isForum: true, isTopicMessage: true, threadId: 42 })
  const decision = gateInbound(topic, context)
  if (decision.kind !== 'placeholder') throw new Error('expected a placeholder')
  const reply = placeholderReply(decision)
  expect(reply.chatId).toBe(String(GROUP))
  expect(reply.text.toLowerCase()).toContain('скоро')
  expect(reply.opts).toEqual({ reply_to_message_id: 7, message_thread_id: 42 })
  const direct = gateInbound(dm(MEMBER, 'вопрос'), context)
  if (direct.kind !== 'placeholder') throw new Error('expected a placeholder')
  expect(placeholderReply(direct).opts).toEqual({ reply_to_message_id: 5 })
})

test('[S2] /chats is an owner access command only with the flag on', async () => {
  const { accessCommand } = await import('../../src/access/routing.js')
  expect(accessCommand('chats', true)).toBe('chats')
  expect(accessCommand('chats', false)).toBeUndefined()
})

test('S4 R3 gate: the role a queued public item may still use is recomputed from the current access list and groups', () => {
  // Private chat: the listed role; a removed user or the owner gets none.
  expect(currentPublicRole({ chatType: 'private', chatId: MEMBER, userId: String(MEMBER) }, context)).toBe('member')
  expect(currentPublicRole({ chatType: 'private', chatId: GUEST, userId: String(GUEST) }, context)).toBe('guest')
  expect(currentPublicRole({ chatType: 'private', chatId: STRANGER, userId: String(STRANGER) }, context)).toBeUndefined()
  expect(currentPublicRole({ chatType: 'private', chatId: OWNER, userId: String(OWNER) }, context)).toBeUndefined()
  // Group: only an approved group; the owner gets the member ceiling; an open group gives strangers the guest role.
  expect(currentPublicRole({ chatType: 'supergroup', chatId: GROUP, userId: String(OWNER) }, context)).toBe('member')
  expect(currentPublicRole({ chatType: 'supergroup', chatId: GROUP, userId: String(STRANGER) }, context)).toBeUndefined()
  expect(currentPublicRole({ chatType: 'supergroup', chatId: OPEN_GROUP, userId: String(STRANGER) }, context)).toBe('guest')
  expect(currentPublicRole({ chatType: 'supergroup', chatId: UNAPPROVED, userId: String(MEMBER) }, context)).toBeUndefined()
  expect(currentPublicRole({ chatType: 'channel', chatId: GROUP, userId: String(MEMBER) }, context)).toBeUndefined()
})
