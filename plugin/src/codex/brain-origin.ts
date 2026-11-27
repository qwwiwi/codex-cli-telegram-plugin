import type { BrainOrigin, InputKind } from '../../../codex-brain/src/contract.js'
import { hasMemoryCue } from '../../../codex-brain/src/cue.js'

// The cue the hook pack uses too (one shared pattern).
export { hasMemoryCue }

interface MessageOrigin {
  message_id: number
  from?: { id: number; is_bot?: boolean } | undefined
  chat: { type: string; id: number }
  text?: string | undefined
  caption?: string | undefined
  entities?: readonly { type: string }[] | undefined
  caption_entities?: readonly { type: string }[] | undefined
  voice?: unknown
  forward_origin?: unknown
  reply_to_message?: unknown
  quote?: unknown
  external_reply?: unknown
  is_automatic_forward?: boolean | undefined
  sender_chat?: unknown
  via_bot?: unknown
  sender_business_bot?: unknown
  business_connection_id?: string | undefined
  message_thread_id?: number | undefined
}

interface OriginOptions {
  agent?: boolean
  side?: boolean
  guest?: boolean
  continuation?: boolean
  confirmedVoice?: string | undefined
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
 * A reply, a reply quote or an external reply is not: the owner's own text stays his, and only that
 * text is journaled (the quoted target is never stored as his words).
 */
export function hasForeignText(message: MessageOrigin): boolean {
  return !!(message.forward_origin || message.is_automatic_forward ||
    [...(message.entities ?? []), ...(message.caption_entities ?? [])]
      .some(entity => entity.type === 'blockquote' || entity.type === 'expandable_blockquote'))
}

export function classifyBrainOrigin(message: MessageOrigin, owner: number, options: OriginOptions = {}): BrainClassification {
  const forwarded = hasForeignText(message)
  const inputKind = forwarded ? 'forward' : message.voice ? 'voice' : message.text?.trim() ? 'text' : 'media'
  if (options.continuation || message.message_id <= 0 && !options.agent) return { origin: 'continuation', inputKind, isolate: false }
  if (options.agent || options.side || options.guest || !isOwnerPrivateChat(owner, message.from, message.chat) ||
      message.sender_chat || message.via_bot || message.sender_business_bot || message.business_connection_id ||
      message.message_thread_id !== undefined) return { origin: 'agent', inputKind, isolate: true }
  if (forwarded) return { origin: 'owner-forward', inputKind, isolate: true }
  // His typed text, his confirmed voice transcript, or his caption on his own photo or document.
  const direct = inputKind === 'voice' ? options.confirmedVoice?.trim()
    : inputKind === 'text' ? message.text?.trim() : message.caption?.trim()
  // Unconfirmed or untranscribed voice and media without a caption: main thread, no owner rights.
  return { origin: direct ? 'owner-direct' : 'owner-forward', inputKind, isolate: false }
}
