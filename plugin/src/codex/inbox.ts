import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import { atomicWriteInRoot } from '../autonomy/store.js'
import { PreformattedDocumentError } from '../format/chunk.js'
import { MaskFixedPointError } from '../safety/pre-send-error.js'
import { redactSecrets } from '../safety/redact.js'
import type { ContinuationContext } from './continuation.js'
import type { LeaseTicket } from './lease.js'
import type { PartStatus } from './reply-delivery.js'
import { isPlanV3, planFromLegacyParts, resumePlan, type PlanV3 } from './reply-plan.js'
import { agentFramePrefix, agentProvenance, isProvenance, ownerProvenance, type Provenance } from './provenance.js'
import { object } from './rpc.js'
import {
  legacyOwnerOrigin, ownerOrigin, parseTurnOrigin, storedOrigin, withTurn, type StoredTurnOrigin, type TurnOrigin,
} from './turn-origin.js'

const filename = 'codex-inbox.json'
const limit = 16
export type InboxReply = { text: string; files: string[]; replyTo?: number }
type Work = { continuation?: ContinuationContext; lease?: LeaseTicket; mayRestartBridge?: true;
  verificationEligible?: true; voiceTaskText?: string }
// `thread`: the side thread of an isolated turn (forward, another agent); its turn lives only there.
type Outcome = { stage: 'claimed' } | { stage: 'running'; turnId?: string; thread?: string } |
  { stage: 'ready'; reply: InboxReply; continueGoal?: true; restartBridge?: true; restartVerification?: true;
    delivery?: Record<string, PartStatus>;
    // The masked shown text the `text:N` receipts count pieces of, saved before the first text piece is sent.
    textPlan?: PlanV3 }
// `origin`: the turn origin classified when the turn started; a record without one is a guest's.
type Active = { messages: Message[]; outcome: Outcome; work?: Work; origin?: StoredTurnOrigin }
// A side turn Codex accepted (turn/start answered); kept until the side turn finishes.
// `unconfirmed`: a follow-up held by recovery because its dead letter could not be written.
export type SideJob = { messages: Message[]; thread?: string; unconfirmed?: true; origin?: StoredTurnOrigin }
type Pending = { ready: Message[][]; albums: Record<string, Message[]>; accepted: number[]; active?: Active;
  followUp?: Message[]; followUpIndex?: number; sides?: Record<string, SideJob>;
  // Who wrote each held message, keyed by message id. Missing means "not the owner".
  origins?: Record<string, Provenance> }

export class CodexInbox {
  private state: Pending = { ready: [], albums: {}, accepted: [] }
  private upgradeNotice = false

  /**
   * @param secrets The live secret list: a saved reply (its source and its plan) is masked with it on load, before
   *                the first write, so the file never holds a value registered since it was saved.
   */
  constructor(private root: string, private ownerId: number, secrets?: ReadonlyArray<string>) {
    try {
      const saved = JSON.parse(readFileSync(join(this.root, filename), 'utf8')) as Omit<Pending, 'followUp'> & {
        followUp?: Message | Message[]
      }
      const { followUp, ...pending } = saved
      const state: Pending = { ...pending, ...(followUp ? { followUp: Array.isArray(followUp) ? followUp : [followUp] } : {}) }
      if (!Array.isArray(state.ready) || !Array.isArray(state.accepted) || !state.albums ||
          (state.sides !== undefined && (typeof state.sides !== 'object' || state.sides === null ||
            !Object.values(state.sides).every(side => side.thread === undefined || typeof side.thread === 'string'))) ||
          (state.origins !== undefined && (typeof state.origins !== 'object' || state.origins === null ||
            !Object.values(state.origins).every(isProvenance))) ||
          !groups(state).every(group =>
            Array.isArray(group) && group.length > 0 && group.length <= 10 && group.every(msg => this.isOwner(msg)))) {
        throw new Error('Invalid Codex inbox')
      }
      // A file saved before provenance existed: only the webhook framed its input this way.
      const legacy = !state.origins
      if (!state.origins) {
        state.origins = Object.fromEntries(groups(state).flat().map(msg => [String(msg.message_id),
          msg.message_id < 0 && (msg.text ?? '').startsWith(agentFramePrefix) ? agentProvenance('unknown') : ownerProvenance]))
      }
      // Recovery acts on the active record's continuation, restart, lease,
      // task text and attachments for the owner. Only a saved owner provenance
      // earns them; a legacy record in flight has none and is treated as an
      // agent's (fail closed). A merely claimed record is re-run from the queue.
      const first = state.active?.messages[0]
      if (legacy && first && state.active?.outcome.stage !== 'claimed') {
        state.origins[String(first.message_id)] = agentProvenance('unknown')
      }
      // The saved reply plan is upgraded to v3 once, before any send (migrateReplyPlan).
      const outcome = state.active?.outcome
      const upgraded = outcome?.stage === 'ready' ? migrateReplyPlan(outcome) : 'unchanged'
      if (upgraded !== 'unchanged') this.upgradeNotice = upgraded === 'notice'
      // Masked and its cuts mapped (resume steps 2-4) before anything below writes the record.
      const remasked = outcome?.stage === 'ready' ? maskSavedReply(outcome, secrets) : false
      // A record saved before origins were persisted: with owner provenance and no side thread it was
      // an owner turn on the main thread; anything else is a guest's.
      if (state.active && first && state.active.origin === undefined) {
        const owner = state.origins[String(first.message_id)]?.origin === 'owner' && !threadOf(state.active.outcome)
        state.active = { ...state.active, origin: storedOrigin(owner ? legacyOwnerOrigin(first.message_id)
          : parseTurnOrigin(undefined, first.message_id)) }
      }
      // Owner metadata needs both an owner provenance and an owner origin.
      if (state.active && (!first || state.origins[String(first.message_id)]?.origin !== 'owner' ||
          !ownerOrigin(parseTurnOrigin(state.active.origin, first.message_id)))) {
        state.active = withoutOwnerMetadata(state.active)
      }
      this.state = state
      if (upgraded !== 'unchanged' || remasked) this.save(state)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /**
   * True once after an upgrade left part of the pending reply unsent (its receipts could not be matched to the
   * new plan): the bridge tells the owner that the reply may be incomplete.
   */
  takeUpgradeNotice(): boolean {
    const notice = this.upgradeNotice
    this.upgradeNotice = false
    return notice
  }

  get size(): number {
    return this.state.ready.length
  }

  get recoveredAlbums(): Record<string, Message[]> {
    return this.state.albums
  }

  get active(): Active | undefined {
    return this.state.active
  }

  /** Whether the message still waits in the queue (not taken, not a follow-up or side job). */
  isQueued(id: number): boolean {
    return this.state.ready.some(group => group.some(message => message.message_id === id))
  }

  get uncertainFollowUp(): Message | undefined {
    return this.state.followUp?.[0]
  }

  /** Side turns Codex accepted before the bridge stopped. */
  get sideJobs(): Array<Omit<SideJob, 'origin'> & { id: number; origin: TurnOrigin }> {
    return Object.entries(this.state.sides ?? {}).map(([id, side]) => ({
      ...side, id: Number(id), origin: parseTurnOrigin(side.origin, Number(id)),
    }))
  }

  /** The origin of the active turn, bound to the thread and turn saved for it; a record without one is a guest's. */
  get activeOrigin(): TurnOrigin | undefined {
    const active = this.state.active
    const first = active?.messages[0]
    if (!active || !first) return undefined
    const origin = parseTurnOrigin(active.origin, first.message_id)
    const outcome = active.outcome
    const thread = threadOf(outcome) ?? origin.thread
    const turn = (outcome.stage === 'running' ? outcome.turnId : undefined) ?? origin.turn
    return thread !== undefined && turn !== undefined ? withTurn(origin, thread, turn) : origin
  }

  /** Who wrote a held message; an id the inbox does not hold is never the owner's. */
  provenance(id: number): Provenance {
    return this.state.origins?.[String(id)] ?? agentProvenance('unknown')
  }

  beginFollowUp(message: Message, provenance: Provenance): 'accepted' | 'duplicate' | 'full' {
    if (!this.isOwner(message)) throw new Error('Codex inbox owner mismatch')
    if (this.state.accepted.includes(message.message_id)) return 'duplicate'
    if (this.state.followUp || this.state.ready.length + Object.keys(this.state.albums).length >= limit) return 'full'
    this.save({ ...this.state, accepted: [...this.state.accepted.slice(-299), message.message_id],
      followUp: [message], followUpIndex: this.state.ready.length, origins: this.withOrigin(message, provenance) })
    return 'accepted'
  }

  /** Codex accepted the side turn of the uncertain follow-up: keep it as a side job until it finishes. */
  startSide(id: number, thread: string, origin: TurnOrigin): void {
    const { followUp, followUpIndex: _index, ...pending } = this.state
    if (followUp?.[0]?.message_id !== id) return
    this.save({ ...pending, sides: { ...pending.sides,
      [String(id)]: { messages: followUp, thread, origin: storedOrigin(origin) } } })
  }

  /** Moves the uncertain follow-up out of the queue's way, keeping its record as a side job. */
  holdFollowUp(id: number): void {
    const { followUp, followUpIndex: _index, ...pending } = this.state
    if (followUp?.[0]?.message_id !== id) return
    this.save({ ...pending, sides: { ...pending.sides, [String(id)]: { messages: followUp, unconfirmed: true } } })
  }

  finishSide(id: number): void {
    const sides = { ...this.state.sides }
    if (!Object.hasOwn(sides, String(id))) return
    delete sides[String(id)]
    this.save({ ...this.state, sides })
  }

  finishFollowUp(id: number, enqueue = false): void {
    const { followUp, followUpIndex, ...pending } = this.state
    if (followUp?.[0]?.message_id === id) {
      const ready = pending.ready.slice()
      if (enqueue) ready.splice(followUpIndex ?? ready.length, 0, followUp)
      this.save({ ...pending, ready })
    }
  }

  receive(message: Message, provenance: Provenance, prioritize = false): 'accepted' | 'duplicate' | 'full' {
    if (!this.isOwner(message)) throw new Error('Codex inbox owner mismatch')
    if (this.state.accepted.includes(message.message_id)) return 'duplicate'
    const group = message.media_group_id
    if (group && !/^[a-zA-Z0-9_-]{1,64}$/.test(group)) throw new Error('Invalid Telegram media group')
    const count = this.state.ready.length + Object.keys(this.state.albums).length + Number(!!this.state.followUp)
    if (count >= limit && (!group || !Object.hasOwn(this.state.albums, group))) return 'full'
    const accepted = [...this.state.accepted.slice(-299), message.message_id]
    const origins = this.withOrigin(message, provenance)
    if (group) {
      const existing = Object.hasOwn(this.state.albums, group) ? this.state.albums[group]! : []
      if (existing.length >= 10) return 'full'
      this.save({ ...this.state, accepted, origins, albums: { ...this.state.albums, [group]: [...existing, message] } })
    } else {
      const ready = prioritize ? [[message], ...this.state.ready] : [...this.state.ready, [message]]
      const followUpIndex = this.state.followUpIndex
      this.save({ ...this.state, accepted, ready, origins,
        ...(prioritize && followUpIndex !== undefined ? { followUpIndex: followUpIndex + 1 } : {}) })
    }
    return 'accepted'
  }

  sealAlbum(id: string): boolean {
    return this.moveAlbum(id, false) !== undefined
  }

  claimAlbumFollowUp(id: string): Message[] | undefined {
    if (this.state.followUp) return
    return this.moveAlbum(id, true)
  }

  private moveAlbum(id: string, followUp: boolean): Message[] | undefined {
    const group = Object.hasOwn(this.state.albums, id) ? this.state.albums[id] : undefined
    if (!group) return
    const albums = { ...this.state.albums }
    delete albums[id]
    const ordered = [...group].sort((a, b) => a.message_id - b.message_id)
    this.save(followUp ? { ...this.state, albums, followUp: ordered, followUpIndex: this.state.ready.length }
      : { ...this.state, albums, ready: [...this.state.ready, ordered] })
    return ordered
  }

  take(): Message[] | undefined {
    if (this.state.active || this.state.followUp) return undefined
    const [group, ...ready] = this.state.ready
    if (group) this.save({ ...this.state, ready, active: { messages: group, outcome: { stage: 'claimed' } } })
    return group
  }

  retryClaim(): void {
    const { active, ...pending } = this.state
    if (active?.outcome.stage === 'claimed') this.save({ ...pending, ready: [active.messages, ...pending.ready] })
  }

  /** The turn started with this origin; owner work is kept only for an owner origin. */
  start(id: number, origin: TurnOrigin, work?: Work): void {
    const active = this.state.active
    if (active?.messages[0]?.message_id !== id) return
    const { work: _previous, ...rest } = active
    this.save({ ...this.state, active: { ...rest, outcome: { stage: 'running' }, origin: storedOrigin(origin),
      ...(work && ownerOrigin(origin) ? { work } : {}) } })
  }

  assignTurn(id: number, turnId: string, thread?: string): void {
    this.updateActive(id, { stage: 'running', turnId, ...(thread === undefined ? {} : { thread }) })
  }

  complete(id: number, reply: InboxReply, continueGoal?: boolean, restartBridge?: boolean, restartVerification?: boolean): void {
    const previous = this.state.active?.outcome
    const ready = previous?.stage === 'ready' ? previous : undefined
    const pending = continueGoal ?? ready?.continueGoal
    const restart = restartBridge ?? ready?.restartBridge
    const verify = restartVerification ?? ready?.restartVerification
    this.updateActive(id, { stage: 'ready', reply, ...(pending ? { continueGoal: true } : {}),
      ...(!pending && restart ? { restartBridge: true, ...(verify ? { restartVerification: true } : {}) } : {}) })
  }

  replyPart(id: number, key: string): PartStatus | undefined {
    const active = this.state.active
    return active?.messages[0]?.message_id === id && active.outcome.stage === 'ready'
      ? active.outcome.delivery?.[key] : undefined
  }

  setReplyPart(id: number, key: string, value: PartStatus | undefined): void {
    const active = this.state.active
    if (active?.messages[0]?.message_id !== id || active.outcome.stage !== 'ready') {
      throw new Error('Pending reply changed during delivery')
    }
    const delivery = { ...active.outcome.delivery }
    if (value) delivery[key] = value
    else delete delivery[key]
    this.updateActive(id, { ...active.outcome, delivery })
  }

  /** Whether any text piece of the pending reply has a receipt (`text:N`, a legacy `text:N:plain:M` too). */
  hasTextReceipt(id: number): boolean {
    const active = this.state.active
    return active?.messages[0]?.message_id === id && active.outcome.stage === 'ready' &&
      Object.keys(active.outcome.delivery ?? {}).some(key => TEXT_RECEIPT_RE.test(key))
  }

  replyPlan(id: number): PlanV3 | undefined {
    const active = this.state.active
    return active?.messages[0]?.message_id === id && active.outcome.stage === 'ready'
      ? active.outcome.textPlan : undefined
  }

  /** Mask the stored reply text with the current secrets, so the record at rest holds no newly registered value. */
  redactReply(id: number, redact: (text: string) => string): void {
    const active = this.state.active
    if (active?.messages[0]?.message_id !== id || active.outcome.stage !== 'ready') return
    const text = redact(active.outcome.reply.text)
    if (text !== active.outcome.reply.text) this.updateActive(id, { ...active.outcome, reply: { ...active.outcome.reply, text } })
  }

  setReplyPlan(id: number, plan: PlanV3): void {
    const active = this.state.active
    if (active?.messages[0]?.message_id !== id || active.outcome.stage !== 'ready') {
      throw new Error('Pending reply changed during delivery')
    }
    this.updateActive(id, { ...active.outcome, textPlan: plan })
  }

  finish(id: number): void {
    const { active, ...pending } = this.state
    if (active?.messages[0]?.message_id === id) this.save(pending)
  }

  cancelContinuation(): void {
    const active = this.state.active
    if (!active) return
    const { continuation, mayRestartBridge, verificationEligible, voiceTaskText, ...work } = active.work ?? {}
    const restart = active.outcome.stage === 'ready' && active.outcome.restartBridge
    if (!continuation && !mayRestartBridge && !verificationEligible && !voiceTaskText && !restart) return
    const outcome = active.outcome.stage === 'ready'
      ? { stage: 'ready' as const, reply: active.outcome.reply,
        ...(active.outcome.delivery ? { delivery: active.outcome.delivery } : {}),
        ...(active.outcome.textPlan ? { textPlan: active.outcome.textPlan } : {}) } : active.outcome
    this.save({ ...this.state, active: { ...active, work, outcome } })
  }

  private updateActive(id: number, outcome: Outcome, work?: Work): void {
    const active = this.state.active
    if (active?.messages[0]?.message_id === id) this.save({
      ...this.state, active: { ...active, outcome, ...(work ? { work } : {}) },
    })
  }

  clear(): number {
    const count = this.state.ready.length + Object.keys(this.state.albums).length
    if (count) this.save({ ...this.state, ready: [], albums: {} })
    return count
  }

  private isOwner(message: Message): boolean {
    return message?.chat?.type === 'private' && message.chat.id === this.ownerId &&
      message.from?.id === this.ownerId && !message.from.is_bot && Number.isSafeInteger(message.message_id)
  }

  private withOrigin(message: Message, provenance: Provenance): Record<string, Provenance> {
    return { ...this.state.origins, [String(message.message_id)]: provenance }
  }

  private save(state: Pending): void {
    // Keep origins only for messages the inbox still holds.
    const held = new Set(groups(state).flat().map(msg => String(msg.message_id)))
    state = { ...state, origins: Object.fromEntries(Object.entries(state.origins ?? {}).filter(([id]) => held.has(id))) }
    atomicWriteInRoot({ root: this.root }, filename, JSON.stringify(state) + '\n')
    this.state = state
  }
}

// The active record as an agent's: the reply text and its delivery state stay,
// everything that acts on the owner's behalf goes, workspace attachments too
// (the running recovery likewise extracts them only for the owner).
function withoutOwnerMetadata(active: Active): Active {
  const { work: _work, ...rest } = active
  if (active.outcome.stage !== 'ready') return { ...rest, outcome: active.outcome }
  const { reply, delivery, textPlan } = active.outcome
  const textParts = Object.entries(delivery ?? {}).filter(([key]) => !key.startsWith('file:'))
  const outcome: Outcome = { stage: 'ready', reply: { ...reply, files: [] },
    ...(textParts.length ? { delivery: Object.fromEntries(textParts) } : {}), ...(textPlan ? { textPlan } : {}) }
  return { ...rest, outcome }
}

const TEXT_RECEIPT_RE = /^text:\d+(?::plain:\d+)?$/
// The plain-fallback metadata entry a v0.6 plan kept as its last part.
const LEGACY_METADATA_PREFIX = '<u data-plain-fallbacks="'

type ReadyOutcome = Extract<Outcome, { stage: 'ready' }>

// A v3 plan with nothing left to send: what an upgrade leaves when no saved part may be sent again.
const NOTHING_PENDING: PlanV3 = { v: 3, text: '', entities: [], cuts: [] }

/**
 * Upgrade a pending reply's saved plan to v3, decided by its receipts. Every upgraded record ends with a v3 plan
 * (or none, with no receipts), so a second run changes nothing.
 *   A. no text receipt: the old plan is dropped and the reply is planned fresh;
 *   B. every part has a receipt: nothing is pending (an empty v3 plan);
 *   C. some parts have receipts, no plain-fallback receipt, every saved part shows text: the parts become one v3
 *      plan with the same cuts, so the receipts keep their pieces;
 *   D. anything else (a plain-fallback receipt, a blanked slot, receipts without a plan, plain-fallback metadata,
 *      an unreadable plan): the pending parts are marked uncertain (never sent automatically), the plan is empty,
 *      and the owner is told the reply may be incomplete.
 * `rich` and `text:document` receipts are untouched.
 */
export function migrateReplyPlan(outcome: ReadyOutcome): 'unchanged' | 'upgraded' | 'notice' {
  const saved: unknown = outcome.textPlan
  const delivery = outcome.delivery ?? {}
  const textKeys = Object.keys(delivery).filter(key => TEXT_RECEIPT_RE.test(key))
  if (isPlanV3(saved) || (saved === undefined && textKeys.length === 0)) return 'unchanged'
  delete outcome.textPlan
  if (textKeys.length === 0) return 'upgraded'
  const parts = Array.isArray(saved) && saved.every(part => typeof part === 'string') ? saved : undefined
  const metadataPart = parts?.at(-1)
  const metadata = metadataPart?.startsWith(LEGACY_METADATA_PREFIX) === true ? metadataPart : undefined
  const htmlParts = parts?.filter(part => !part.startsWith(LEGACY_METADATA_PREFIX))
  // Delivered: a part's HTML went, or it fell back to plain text and every plain piece the old plan named has a
  // receipt. A `fallback` receipt whose plain pieces are unknown or not all receipted is not delivered.
  const plainPieces = legacyPlainPieces(metadata)
  const delivered = (index: number): boolean => {
    const receipt = delivery['text:' + index]
    if (receipt === undefined) return false
    if (receipt !== 'fallback') return true
    const count = plainPieces?.get(index)
    if (count === undefined) return false
    for (let piece = 0; piece < count; piece++) if (delivery[`text:${index}:plain:${piece}`] === undefined) return false
    return true
  }
  if (htmlParts !== undefined && htmlParts.length > 0 && htmlParts.every((_part, index) => delivered(index))) {
    outcome.textPlan = NOTHING_PENDING
    return 'upgraded'
  }
  const fallback = textKeys.some(key => key.includes(':plain:') || delivery[key] === 'fallback')
  const plan = parts !== undefined && !fallback && metadata === undefined && parts.every(part =>
    !part.startsWith(LEGACY_METADATA_PREFIX)) ? planFromLegacyParts(parts) : undefined
  if (plan !== undefined) {
    outcome.textPlan = plan
    return 'upgraded'
  }
  const marked = { ...delivery }
  for (let index = 0; index < (htmlParts?.length ?? 0); index++) {
    if (marked['text:' + index] === undefined) marked['text:' + index] = 'uncertain'
  }
  outcome.delivery = marked
  outcome.textPlan = NOTHING_PENDING
  // Something was not delivered (a pending part, a plain fallback cut short) or cannot be matched: tell the owner.
  return 'notice'
}

// The plain-fallback sub-plan a v0.6 plan kept as its last part: how many plain pieces each fallen-back part had.
// Undefined when it is missing or unreadable.
function legacyPlainPieces(metadata: string | undefined): Map<number, number> | undefined {
  const end = '"></u>'
  if (metadata === undefined || !metadata.endsWith(end)) return undefined
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(metadata.slice(LEGACY_METADATA_PREFIX.length, -end.length)))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const counts = new Map<number, number>()
    for (const [key, pieces] of Object.entries(parsed)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || !Array.isArray(pieces)) return undefined
      counts.set(Number(key), pieces.length)
    }
    return counts
  } catch {
    return undefined
  }
}

/**
 * Mask a saved reply with the current secrets: its source text, and its v3 plan through resume steps 2-4 (the sent
 * cuts mapped through the edits, the pending text cut again). True when anything changed. A plan masking cannot
 * settle on (a registered value the marker cannot hide) is left as saved: its delivery refuses it. A pending text
 * masking leaves uncuttable is saved masked as one piece.
 */
export function maskSavedReply(outcome: ReadyOutcome, secrets: ReadonlyArray<string> | undefined): boolean {
  let changed = false
  const text = redactSecrets(outcome.reply.text, secrets)
  if (text !== outcome.reply.text) {
    outcome.reply = { ...outcome.reply, text }
    changed = true
  }
  const plan = outcome.textPlan
  if (plan === undefined || plan.cuts.length === 0) return changed
  let done = 0
  while (done < plan.cuts.length && outcome.delivery?.['text:' + done] !== undefined) done += 1
  let resumed: PlanV3
  try {
    resumed = resumePlan(plan, done, secrets)
  } catch (error) {
    if (error instanceof MaskFixedPointError) return changed
    if (!(error instanceof PreformattedDocumentError)) throw error
    // The masked pending text can no longer be cut into messages: it is kept masked as one document piece (the
    // outbox's rule for an uncuttable item), never as saved. Its delivery sends it as a document.
    resumed = resumePlan(plan, done, secrets, Number.POSITIVE_INFINITY)
  }
  if (JSON.stringify(resumed) === JSON.stringify(plan)) return changed
  outcome.textPlan = resumed
  return true
}

function threadOf(outcome: Outcome): string | undefined {
  return outcome.stage === 'running' ? outcome.thread : undefined
}

function groups(state: Pending): Message[][] {
  return [...state.ready, ...Object.values(state.albums), ...(state.active ? [state.active.messages] : []),
    ...(state.followUp ? [state.followUp] : []), ...Object.values(state.sides ?? {}).map(side => side.messages)]
}

/** Where restart recovery reads a running turn from: the main thread's history or one side thread's turns. */
export interface TurnHistory {
  main(): Promise<unknown[]>
  side(thread: string): Promise<unknown[]>
}

/**
 * The saved Codex turn of a recovered running task. An isolated turn is looked up only on its own
 * side thread, never in the main thread's history; an unreadable side thread gives no turn.
 */
export async function recoveredTurn(turnId: string | undefined, thread: string | undefined,
  history: TurnHistory): Promise<Record<string, unknown> | undefined> {
  if (!turnId) return undefined
  const turns = thread === undefined ? await history.main() : await history.side(thread).catch(() => [])
  return turns.map(object).find(turn => turn.id === turnId)
}
