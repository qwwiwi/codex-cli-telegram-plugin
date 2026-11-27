// Turn origin: who a turn runs for, decided once when the input is classified.
//
// Every sink that acts for the owner or writes owner memory takes an origin (see owner-effects.ts);
// an owner writer accepts only an OwnerTurnOrigin, and only this module can make one. The value
// is immutable and persisted with every artifact derived from the turn; a missing or damaged
// stored value reads as a guest's (fail closed).

import type { Message } from 'grammy/types'
import { z } from 'zod'

import { BrainOriginSchema, InputKindSchema, type BrainOrigin, type InputKind } from '../../../codex-brain/src/contract.js'
import { classifyBrainOrigin, type BrainClassification } from './brain-origin.js'
import type { Provenance } from './provenance.js'

// Not exported: no other module can construct a value carrying it.
const ownerBrand: unique symbol = Symbol('owner-turn-origin')

interface OriginFields {
  /** Brain exchange key, `<scope>:<message_id>`. */
  readonly key: string
  readonly messageId: number
  readonly origin: BrainOrigin
  readonly inputKind: InputKind
  readonly isolate: boolean
  readonly role: 'owner' | 'side' | 'guest'
  /** Bound by withTurn(); absent until Codex accepted the turn. */
  readonly thread?: string
  readonly turn?: string
}

/** The turn ran for the owner on his main thread. Only this module makes one. */
export interface OwnerTurnOrigin extends OriginFields {
  readonly role: 'owner'
  readonly isolate: false
  readonly [ownerBrand]: true
}

export interface ForeignTurnOrigin extends OriginFields {
  readonly role: 'side' | 'guest'
}

export type TurnOrigin = OwnerTurnOrigin | ForeignTurnOrigin

/** The persisted form of a TurnOrigin (JSON drops the brand; parseTurnOrigin restores it). */
export const StoredTurnOriginSchema = z.object({
  key: z.string().min(1).max(300),
  messageId: z.number().int(),
  origin: BrainOriginSchema,
  inputKind: InputKindSchema,
  isolate: z.boolean(),
  role: z.enum(['owner', 'side', 'guest']),
  thread: z.string().min(1).max(200).optional(),
  turn: z.string().min(1).max(200).optional(),
})
export type StoredTurnOrigin = z.infer<typeof StoredTurnOriginSchema>

export interface ClassifyOptions {
  /** Brain is enabled: only then does foreign text run isolated. */
  brain: boolean
  key: string
  side?: boolean
  confirmedVoice?: string | undefined
  continuation?: boolean
  /** Side only: the reply target is the bot's answer from the verified owner side thread the reply reuses. */
  trustedReply?: boolean
  /** Main only: the receiving bot, whose own replies preserve direct origin. */
  replyBotId?: number
}

type Fields = Omit<OriginFields, 'role' | 'isolate'>

function owner(fields: Fields): OwnerTurnOrigin {
  const value: OwnerTurnOrigin = { ...fields, role: 'owner', isolate: false, [ownerBrand]: true }
  Object.freeze(value)
  return value
}

function foreign(fields: Fields, role: ForeignTurnOrigin['role'], isolate: boolean): ForeignTurnOrigin {
  const value: ForeignTurnOrigin = { ...fields, role, isolate }
  Object.freeze(value)
  return value
}

function guestFallback(messageId: number): ForeignTurnOrigin {
  return foreign({ key: 'unknown:' + messageId, messageId, origin: 'agent', inputKind: 'text' }, 'guest', true)
}

// Higher is less trusted.
function distrust(item: BrainClassification): number {
  if (item.origin === 'agent') return 4
  if (item.isolate) return 3
  if (item.origin === 'owner-forward' || item.origin === 'continuation') return 2
  return 0
}

/**
 * The least trusted classification of all items. A media item without a caption carries no text,
 * so it does not lower an album whose other items carry the owner's own words.
 */
function leastTrusted(items: readonly BrainClassification[]): BrainClassification {
  const textual = items.filter(item => !(item.origin === 'owner-forward' && item.inputKind === 'media' && !item.isolate))
  const pool = textual.length ? textual : items
  const worst = pool.reduce((left, right) => distrust(right) > distrust(left) ? right : left)
  return items.some(item => item.inputKind === 'forward') ? { ...worst, inputKind: 'forward' } : worst
}

/** The only place that maps an input to a role. */
export function classifyTurn(messages: readonly Message[], ownerId: number, sender: Provenance,
  options: ClassifyOptions): TurnOrigin {
  const first = messages[0]
  if (!first) throw new Error('A turn needs at least one message')
  const agent = sender.origin === 'agent'
  const items = messages.map((message, index) => classifyBrainOrigin(message, ownerId, {
    ...(agent ? { agent: true } : {}),
    ...(options.side ? { side: true } : {}),
    ...(options.continuation ? { continuation: true } : {}),
    ...(options.trustedReply ? { trustedReply: true } : {}),
    ...(options.replyBotId === undefined ? {} : { replyBotId: options.replyBotId }),
    ...(index === 0 && options.confirmedVoice !== undefined ? { confirmedVoice: options.confirmedVoice } : {}),
  }))
  const chosen = leastTrusted(items)
  const isolate = options.brain && chosen.isolate
  const fields: Fields = { key: options.key, messageId: first.message_id, origin: chosen.origin, inputKind: chosen.inputKind }
  if (agent || isolate) return foreign(fields, 'guest', isolate)
  if (options.side) return foreign(fields, 'side', isolate)
  return owner(fields)
}

/**
 * A member or guest message (KROT_MULTIUSER=1): always a guest's and isolated, whether Brain is on or not.
 * classifyTurn is the owner inbox's classifier; a public-lane input never goes through it, so it can never
 * become an OwnerTurnOrigin, write owner memory or fork the owner's main thread.
 */
export function userTurnOrigin(message: Message, ownerId: number, key: string): ForeignTurnOrigin {
  const item = classifyBrainOrigin(message, ownerId, { guest: true })
  return foreign({ key, messageId: message.message_id, origin: item.origin, inputKind: item.inputKind }, 'guest', true)
}

/** The owner's own words of a turn for the journal: a confirmed transcript, or the joined texts and captions. */
export function ownerWords(messages: readonly Message[], confirmedVoice?: string): string | undefined {
  if (confirmedVoice?.trim()) return confirmedVoice
  const words = messages.map(message => (message.text ?? message.caption)?.trim()).filter((text): text is string => !!text)
  return words.length ? words.join('\n\n') : undefined
}

/** A new frozen origin bound to the thread and turn Codex accepted. */
export function withTurn<T extends TurnOrigin>(origin: T, thread: string, turn: string): T {
  const bound: T = { ...origin, thread, turn }
  Object.freeze(bound)
  return bound
}

/** The only narrowing to an owner origin. */
export function ownerOrigin(origin: TurnOrigin | undefined): OwnerTurnOrigin | undefined {
  return origin?.role === 'owner' ? origin : undefined
}

/** The bridge's own notices and command replies: never the owner's turn. */
export function bridgeOrigin(thread: string | null): ForeignTurnOrigin {
  return foreign({ key: 'bridge', messageId: 0, origin: 'agent', inputKind: 'text',
    ...(thread ? { thread } : {}) }, 'guest', true)
}

/** The owner's main thread outside any one turn: a goal result, the export of his open questions. */
export function mainOrigin(thread: string): OwnerTurnOrigin {
  return owner({ key: 'main', messageId: 0, origin: 'continuation', inputKind: 'text', thread })
}

/** A pre-M5 inbox record of an owner turn on the main thread (saved before origins were persisted). */
export function legacyOwnerOrigin(messageId: number): OwnerTurnOrigin {
  return owner({ key: 'legacy:' + messageId, messageId, origin: 'owner-forward', inputKind: 'text' })
}

/** The persisted copy (plain data, no brand). */
export function storedOrigin(origin: TurnOrigin): StoredTurnOrigin {
  return {
    key: origin.key, messageId: origin.messageId, origin: origin.origin, inputKind: origin.inputKind,
    isolate: origin.isolate, role: origin.role,
    ...(origin.thread === undefined ? {} : { thread: origin.thread }),
    ...(origin.turn === undefined ? {} : { turn: origin.turn }),
  }
}

/** Reads a persisted origin; a missing, damaged or inconsistent one is a guest's. */
export function parseTurnOrigin(value: unknown, messageId: number): TurnOrigin {
  const parsed = StoredTurnOriginSchema.safeParse(value)
  if (!parsed.success) return guestFallback(messageId)
  const { role, isolate, thread, turn, ...rest } = parsed.data
  const fields: Fields = { ...rest, ...(thread === undefined ? {} : { thread }), ...(turn === undefined ? {} : { turn }) }
  if (role === 'owner') return isolate ? guestFallback(messageId) : owner(fields)
  return foreign(fields, role, isolate)
}
