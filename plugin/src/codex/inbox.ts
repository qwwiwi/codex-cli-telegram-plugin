import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import { atomicWriteInRoot } from '../autonomy/store.js'
import type { ContinuationContext } from './continuation.js'
import type { LeaseTicket } from './lease.js'
import type { PartStatus } from './reply-delivery.js'
import { agentFramePrefix, agentProvenance, isProvenance, ownerProvenance, type Provenance } from './provenance.js'

const filename = 'codex-inbox.json'
const limit = 16
export type InboxReply = { text: string; files: string[]; replyTo?: number }
type Work = { continuation?: ContinuationContext; lease?: LeaseTicket; mayRestartBridge?: true;
  verificationEligible?: true; voiceTaskText?: string }
type Outcome = { stage: 'claimed' } | { stage: 'running'; turnId?: string } |
  { stage: 'ready'; reply: InboxReply; continueGoal?: true; restartBridge?: true; restartVerification?: true;
    delivery?: Record<string, PartStatus> }
type Active = { messages: Message[]; outcome: Outcome; work?: Work }
// A side turn Codex accepted (turn/start answered); kept until the side turn finishes.
// `unconfirmed`: a follow-up held by recovery because its dead letter could not be written.
export type SideJob = { messages: Message[]; thread?: string; unconfirmed?: true }
type Pending = { ready: Message[][]; albums: Record<string, Message[]>; accepted: number[]; active?: Active;
  followUp?: Message[]; followUpIndex?: number; sides?: Record<string, SideJob>;
  // Who wrote each held message, keyed by message id. Missing means "not the owner".
  origins?: Record<string, Provenance> }

export class CodexInbox {
  private state: Pending = { ready: [], albums: {}, accepted: [] }

  constructor(private root: string, private ownerId: number) {
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
      if (state.active && (!first || state.origins[String(first.message_id)]?.origin !== 'owner')) {
        state.active = withoutOwnerMetadata(state.active)
      }
      this.state = state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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

  get uncertainFollowUp(): Message | undefined {
    return this.state.followUp?.[0]
  }

  /** Side turns Codex accepted before the bridge stopped. */
  get sideJobs(): Array<SideJob & { id: number }> {
    return Object.entries(this.state.sides ?? {}).map(([id, side]) => ({ id: Number(id), ...side }))
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
  startSide(id: number, thread: string): void {
    const { followUp, followUpIndex: _index, ...pending } = this.state
    if (followUp?.[0]?.message_id !== id) return
    this.save({ ...pending, sides: { ...pending.sides, [String(id)]: { messages: followUp, thread } } })
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

  start(id: number, work?: Work): void {
    this.updateActive(id, { stage: 'running' }, work)
  }

  assignTurn(id: number, turnId: string): void {
    this.updateActive(id, { stage: 'running', turnId })
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
        ...(active.outcome.delivery ? { delivery: active.outcome.delivery } : {}) } : active.outcome
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

// The active record as an agent's: the reply and its delivery state stay,
// everything that acts on the owner's behalf goes.
function withoutOwnerMetadata(active: Active): Active {
  const { work: _work, ...rest } = active
  const outcome: Outcome = active.outcome.stage === 'ready'
    ? { stage: 'ready', reply: active.outcome.reply,
      ...(active.outcome.delivery ? { delivery: active.outcome.delivery } : {}) }
    : active.outcome
  return { ...rest, outcome }
}

function groups(state: Pending): Message[][] {
  return [...state.ready, ...Object.values(state.albums), ...(state.active ? [state.active.messages] : []),
    ...(state.followUp ? [state.followUp] : []), ...Object.values(state.sides ?? {}).map(side => side.messages)]
}
