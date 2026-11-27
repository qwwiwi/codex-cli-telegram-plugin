// One gated member or guest message into the public lane (KROT_MULTIUSER=1).
//
// The message never reaches the owner's inbox, main thread or side turns: it runs on its role's own
// app-server with only its own framed text (no owner main summary, no owner instructions). Brain
// journals it as foreign through userTurnOrigin (a guest's, isolated, origin agent) and without its
// text, so it can never become owner memory or a quoted line of the owner's handoff.

import type { Message } from 'grammy/types'

import type { BrainPort, TurnTicket } from '../../../codex-brain/src/contract.js'
import { PUBLIC_KEY_SEGMENT } from '../../../codex-brain/src/journal/index.js'
import type { GateDecision } from '../access/gate.js'
import { MEMORY_REFUSED } from './brain-commands.js'
import { parseCodexCommand } from './commands.js'
import type { PublicJournal, PublicLane, PublicReceive } from './public-lane.js'
import { userTurnOrigin } from './turn-origin.js'

type PublicDecision = Extract<GateDecision, { kind: 'placeholder' }>
type ReplyOpts = { reply_to_message_id: number; message_thread_id?: number }

export interface PublicIntakeDeps {
  /** Undefined when the public lane is off: the user gets the text-only notice. */
  lane: Pick<PublicLane, 'receive'> | undefined
  brain: Pick<BrainPort, 'turnStarting' | 'turnDelivered'>
  ownerId: number
  /** The bridge's Brain scope (`bridgeScope`). */
  scope: string
  /** The bot's username, so `/memory@bot` is recognised like `/memory`. */
  botUsername: string
  send: (chatId: string, text: string, opts: ReplyOpts) => Promise<void>
  warn: (message: string) => void
}

const TEXT_ONLY = 'Пока я понимаю только текстовые сообщения.'
const QUEUE_FULL = 'Очередь этого чата заполнена, напиши позже.'

/** The Brain exchange key of a public message: never the `<scope>:<message_id>` key of an owner message. */
export function publicBrainKey(scope: string, chatKey: string, messageId: number): string {
  // The Brain recent window leaves these keys out of the owner's accounting (isPublicExchange).
  return scope + PUBLIC_KEY_SEGMENT + chatKey + ':' + messageId
}

function brainJournal(brain: PublicIntakeDeps['brain'], message: Message, ownerId: number, key: string): PublicJournal {
  const origin = userTurnOrigin(message, ownerId, key)
  let ticket: TurnTicket | null = null
  return {
    async start() {
      // No input text and no memory cue: the journal keeps only that a foreign exchange happened.
      ticket = await brain.turnStarting({
        sessionId: 'unbound', key: origin.key, origin: origin.origin, inputKind: origin.inputKind, cue: false,
      })
    },
    async settle(delivered) {
      if (!ticket) return
      await brain.turnDelivered(ticket, delivered ? { status: 'delivered' }
        : { status: 'failed', error: 'The public reply could not be sent' })
    },
  }
}

/**
 * Queues one member or guest message on the public lane and answers in the same chat when it cannot.
 * A `/memory` command gets the fixed owner-only refusal, before any inference or journal entry.
 */
export async function publicIntake(deps: PublicIntakeDeps, message: Message, decision: PublicDecision):
  Promise<PublicReceive | 'unsupported' | 'memory_refused'> {
  const opts: ReplyOpts = {
    reply_to_message_id: decision.replyTo,
    ...(decision.threadId !== undefined ? { message_thread_id: decision.threadId } : {}),
  }
  const chatId = String(decision.chatId)
  if (!message.forward_origin && parseCodexCommand(message.text?.trim(), deps.botUsername)?.name === 'memory') {
    await deps.send(chatId, MEMORY_REFUSED, opts).catch(() => deps.warn('Could not answer a non-owner message'))
    return 'memory_refused'
  }
  const text = (message.text ?? message.caption)?.trim()
  if (!deps.lane || !text) {
    await deps.send(chatId, TEXT_ONLY, opts).catch(() => deps.warn('Could not answer a non-owner message'))
    return 'unsupported'
  }
  const chat = message.chat
  const from = message.from
  const outcome = deps.lane.receive({
    chatKey: decision.chatKey, chatId: decision.chatId, chatType: chat.type,
    ...('title' in chat && chat.title ? { chatTitle: chat.title } : {}),
    replyTo: decision.replyTo, ...(decision.threadId !== undefined ? { threadId: decision.threadId } : {}),
    role: decision.role, userId: String(from?.id ?? ''),
    senderName: [from?.first_name, from?.last_name].filter(Boolean).join(' '),
    text,
    journal: brainJournal(deps.brain, message, deps.ownerId, publicBrainKey(deps.scope, decision.chatKey, message.message_id)),
  })
  if (outcome === 'full') {
    await deps.send(chatId, QUEUE_FULL, opts).catch(() => deps.warn('Could not answer a non-owner message'))
  } else if (outcome !== 'accepted') deps.warn('A non-owner message was not queued: ' + outcome)
  return outcome
}
