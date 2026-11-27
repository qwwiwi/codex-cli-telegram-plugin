import { parseCodexCommand } from '../codex/commands.js'
import { buildRouteKey } from '../router/route-key.js'
import type { AccessRole, StoredRole } from './store.js'

/** What the gate needs to know about an approved group. */
export interface GateChat {
  mode: 'members' | 'open'
  topics: 'per-topic' | 'shared'
}

/** The fields of a Telegram entity the gate reads. */
export interface GateEntity {
  type: string
  offset: number
  length: number
  user?: { id: number }
}

/** An inbound Telegram message, reduced to what the gate reads. */
export interface GateMessage {
  messageId: number
  chatId: number
  chatType: string
  /** chat.is_forum: a supergroup with topics. */
  isForum?: boolean
  fromId: number
  isBot: boolean
  text?: string | undefined
  caption?: string | undefined
  entities?: readonly GateEntity[] | undefined
  captionEntities?: readonly GateEntity[] | undefined
  /** reply_to_message: its sender and whether it is the forum topic's root service message. */
  replyTo?: { fromId: number | undefined; topicRoot: boolean } | undefined
  /** message_thread_id */
  threadId?: number | undefined
  /** is_topic_message */
  isTopicMessage?: boolean | undefined
  forwarded: boolean
}

export interface GateContext {
  ownerId: string
  botId: number
  botUsername: string
  roleOf: (userId: string) => AccessRole | undefined
  /** An approved group, or undefined when the group is pending or unknown. */
  chat: (chatId: string) => GateChat | undefined
}

export type GateDropReason =
  | 'bot' | 'chat_type' | 'chat_mismatch' | 'chat_not_approved' | 'not_addressed' | 'not_listed'

export type GateDecision =
  /** The owner's private chat: the existing Codex path, unchanged. */
  | { kind: 'owner' }
  /** The S1 access controller (a stranger's private message, a listed user's /start). */
  | { kind: 'access' }
  /** A non-owner thread: the public lane (S3), never the owner's inbox. The kind keeps its S2 name. */
  | { kind: 'placeholder'; role: StoredRole; chatKey: string; chatId: number; replyTo: number; threadId?: number }
  | { kind: 'drop'; reason: GateDropReason }

function mentions(text: string | undefined, entities: readonly GateEntity[] | undefined, context: GateContext): boolean {
  if (!entities) return false
  const handle = '@' + context.botUsername.toLowerCase()
  return entities.some(entity => {
    if (entity.type === 'text_mention') return entity.user?.id === context.botId
    // Entity offsets are UTF-16 code units, the same units String.slice uses.
    return entity.type === 'mention' && text !== undefined &&
      text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle
  })
}

/**
 * Whether a group message is meant for the bot: an @mention entity, a reply to
 * one of her messages, or `/cmd@bot`. A forwarded message never is. In a forum
 * every message replies to the topic root, which does not count.
 */
export function isAddressed(message: GateMessage, context: GateContext): boolean {
  if (message.forwarded || context.botUsername === '') return false
  if (mentions(message.text, message.entities, context)) return true
  if (mentions(message.caption, message.captionEntities, context)) return true
  if (message.replyTo && !message.replyTo.topicRoot && message.replyTo.fromId === context.botId) return true
  const command = /^\/[a-z][a-z0-9_]*@([A-Za-z0-9_]+)(?:\s|$)/iu.exec(message.text?.trim() ?? '')
  return command !== null && command[1]!.toLowerCase() === context.botUsername.toLowerCase()
}

function isTopic(message: GateMessage): boolean {
  return message.isForum === true && message.isTopicMessage === true && message.threadId !== undefined
}

/** Private chat: the user ID. Group: the chat ID. Forum topic: `<chatId>__t<topicId>` unless topics are shared. */
export function chatKeyOf(message: GateMessage, chat: GateChat | undefined): string {
  if (message.chatType === 'private') return String(message.fromId)
  if (isTopic(message) && chat?.topics !== 'shared') return buildRouteKey(String(message.chatId), String(message.threadId))
  return String(message.chatId)
}

/**
 * The deterministic inbound gate, before any model: sender → role → chat
 * ceiling → addressing. Only the owner's own private chat is owner-privileged;
 * in a group the owner gets the member ceiling.
 */
export function gateInbound(message: GateMessage, context: GateContext): GateDecision {
  if (message.isBot) return { kind: 'drop', reason: 'bot' }
  const fromId = String(message.fromId)
  if (message.chatType === 'private') {
    if (message.chatId !== message.fromId) return { kind: 'drop', reason: 'chat_mismatch' }
    if (fromId === context.ownerId) return { kind: 'owner' }
    const role = context.roleOf(fromId)
    if (role === undefined || role === 'owner') return { kind: 'access' }
    if (!message.forwarded && parseCodexCommand(message.text?.trim(), context.botUsername)?.name === 'start') {
      return { kind: 'access' }
    }
    return { kind: 'placeholder', role, chatKey: chatKeyOf(message, undefined), chatId: message.chatId, replyTo: message.messageId }
  }
  if (message.chatType !== 'group' && message.chatType !== 'supergroup') return { kind: 'drop', reason: 'chat_type' }
  const chat = context.chat(String(message.chatId))
  if (!chat) return { kind: 'drop', reason: 'chat_not_approved' }
  if (!isAddressed(message, context)) return { kind: 'drop', reason: 'not_addressed' }
  const listed = context.roleOf(fromId)
  const role: StoredRole | undefined = listed === 'owner' ? 'member' : listed ?? (chat.mode === 'open' ? 'guest' : undefined)
  if (role === undefined) return { kind: 'drop', reason: 'not_listed' }
  return {
    kind: 'placeholder', role, chatKey: chatKeyOf(message, chat), chatId: message.chatId, replyTo: message.messageId,
    ...(isTopic(message) ? { threadId: message.threadId! } : {}),
  }
}

/**
 * The role a public item accepted earlier may use now, by the same rules as gateInbound: a private
 * chat needs a listed member or guest, a group needs its approval (the owner gets the member ceiling,
 * an open group gives the unlisted the guest role). Undefined when that access is gone.
 */
export function currentPublicRole(item: { chatType: string; chatId: number; userId: string },
  context: Pick<GateContext, 'ownerId' | 'roleOf' | 'chat'>): StoredRole | undefined {
  if (item.chatType === 'private') {
    if (item.userId === context.ownerId || String(item.chatId) !== item.userId) return undefined
    const role = context.roleOf(item.userId)
    return role === 'owner' ? undefined : role
  }
  if (item.chatType !== 'group' && item.chatType !== 'supergroup') return undefined
  const chat = context.chat(String(item.chatId))
  if (!chat) return undefined
  const listed = context.roleOf(item.userId)
  return listed === 'owner' ? 'member' : listed ?? (chat.mode === 'open' ? 'guest' : undefined)
}

/** Sent instead of a Codex answer to every non-owner thread until isolated sessions exist. */
export const PLACEHOLDER_TEXT = 'Скоро: ответы здесь появятся в следующем обновлении. Пока я отвечаю только владельцу в личном чате.'

/** The placeholder reply: same chat, as a reply to the message, inside the same forum topic. */
export function placeholderReply(decision: Extract<GateDecision, { kind: 'placeholder' }>): {
  chatId: string; text: string; opts: { reply_to_message_id: number; message_thread_id?: number }
} {
  return {
    chatId: String(decision.chatId),
    text: PLACEHOLDER_TEXT,
    opts: {
      reply_to_message_id: decision.replyTo,
      ...(decision.threadId !== undefined ? { message_thread_id: decision.threadId } : {}),
    },
  }
}
