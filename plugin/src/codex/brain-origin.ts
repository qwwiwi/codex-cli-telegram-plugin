import type { BrainOrigin, InputKind } from '../../../codex-brain/src/contract.js'
import { hasMemoryCue } from '../../../codex-brain/src/cue.js'
import { isOwnBotReply } from '../prompt/build.js'

// The cue the hook pack uses too (one shared pattern).
export { hasMemoryCue }

/**
 * Text, captions, and provenance metadata of a message: every field foreignProvenance reads. A reply target
 * carries the same fields, so an incoming message and the reply target it embeds are judged by one rule.
 */
interface ReplyTarget {
  from?: { id: number; is_bot?: boolean } | undefined
  chat?: { type: string; id: number } | undefined
  text?: string | undefined
  caption?: string | undefined
  entities?: readonly { type: string }[] | undefined
  caption_entities?: readonly { type: string }[] | undefined
  forward_origin?: unknown
  is_automatic_forward?: boolean | undefined
  sender_chat?: unknown
  via_bot?: unknown
  sender_business_bot?: unknown
  business_connection_id?: string | undefined
  message_thread_id?: number | undefined
}

interface MessageOrigin extends ReplyTarget {
  message_id: number
  chat: { type: string; id: number }
  voice?: unknown
  reply_to_message?: ReplyTarget | undefined
  quote?: unknown
  external_reply?: unknown
}

interface OriginOptions {
  agent?: boolean
  side?: boolean
  guest?: boolean
  continuation?: boolean
  confirmedVoice?: string | undefined
  /** The reply target is the bot's answer from the verified owner side thread the reply runs in. */
  trustedReply?: boolean
  /** Check main-turn text and voice replies against the receiving bot's identity. */
  replyBotId?: number
}

export interface BrainClassification {
  origin: BrainOrigin
  inputKind: InputKind
  /** Run in an isolated side thread: foreign text, another agent, or a chat that is not the owner's private one. */
  isolate: boolean
}

export function isOwnerPrivateChat(owner: number, from: MessageOrigin['from'], chat: MessageOrigin['chat'] | undefined): boolean {
  return from?.id === owner && !from.is_bot && chat?.type === 'private' && chat.id === owner
}

/**
 * Text that is not the owner's own words: a forward, an automatic forward or a pasted block quote.
 * Reply metadata and the target it embeds are checked separately by hasForeignReply.
 */
export function hasForeignText(message: ReplyTarget): boolean {
  return !!(message.forward_origin || message.is_automatic_forward ||
    [...(message.entities ?? []), ...(message.caption_entities ?? [])]
      .some(entity => entity.type === 'blockquote' || entity.type === 'expandable_blockquote'))
}

/**
 * Not sent by the owner himself in his private chat: another sender or a bot, another chat (when the
 * message carries one), a channel, an inline bot, a business bot or connection, or a topic.
 */
function foreignSender(message: ReplyTarget, owner: number, botId?: number): boolean {
  const ownBot = botId !== undefined && isOwnBotReply(message.from, botId)
  return (!ownBot && (message.from?.id !== owner || message.from.is_bot === true)) ||
    (message.chat !== undefined && !(message.chat.type === 'private' && message.chat.id === owner)) ||
    !!(message.sender_chat || message.via_bot || message.sender_business_bot || message.business_connection_id) ||
    message.message_thread_id !== undefined
}

/**
 * The one rule for a message that is not the owner's own words from his own chat: foreign text or a
 * foreign sender. It judges an incoming message and the reply target a side turn embeds alike, so a
 * marker that isolates one isolates the other.
 */
export function foreignProvenance(message: ReplyTarget, owner: number, botId?: number): boolean {
  return hasForeignText(message) || foreignSender(message, owner, botId)
}

/**
 * A reply that brings someone else's words along: the Telegram preparation embeds the reply target
 * into the turn text, so a target with foreign provenance is foreign, and so is a reply to a message
 * in another chat (external_reply).
 */
export function hasForeignReply(message: MessageOrigin, owner: number, trustedReply = false, botId?: number): boolean {
  const target = message.reply_to_message
  if (message.external_reply || (botId !== undefined && message.quote && !target)) return true
  return !!target && !trustedReply && foreignProvenance(target, owner, botId)
}

export function classifyBrainOrigin(message: MessageOrigin, owner: number, options: OriginOptions = {}): BrainClassification {
  const forwarded = hasForeignText(message)
  const inputKind = forwarded ? 'forward' : message.voice ? 'voice' : message.text?.trim() ? 'text' : 'media'
  if (options.continuation || message.message_id <= 0 && !options.agent) return { origin: 'continuation', inputKind, isolate: false }
  // A foreign sender is another agent; foreign text alone is the owner's forward (below).
  if (options.agent || options.guest || foreignSender(message, owner)) return { origin: 'agent', inputKind, isolate: true }
  // Owner side turns keep their non-writing Brain origin. Foreign text, in the message or in the reply
  // target it embeds, requires isolation: an owner side forks the main thread and sees its summary.
  if (options.side) return { origin: 'agent', inputKind,
    isolate: forwarded || hasForeignReply(message, owner, options.trustedReply) }
  if (forwarded) return { origin: 'owner-forward', inputKind, isolate: true }
  // His typed text, his confirmed voice transcript, or his caption on his own photo or document.
  const direct = inputKind === 'voice' ? options.confirmedVoice?.trim()
    : inputKind === 'text' ? message.text?.trim() : message.caption?.trim()
  const foreignReply = inputKind !== 'media' && options.replyBotId !== undefined &&
    hasForeignReply(message, owner, false, options.replyBotId)
  return { origin: direct && !foreignReply ? 'owner-direct' : 'owner-forward', inputKind, isolate: false }
}
