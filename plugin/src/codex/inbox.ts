import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import { atomicWriteInRoot } from '../autonomy/store.js'
import type { ContinuationContext } from './continuation.js'
import type { LeaseTicket } from './lease.js'

const filename = 'codex-inbox.json'
const limit = 16
export type InboxReply = { text: string; files: string[]; replyTo?: number }
type Work = { continuation?: ContinuationContext; lease?: LeaseTicket }
type Outcome = { stage: 'claimed' } | { stage: 'running'; turnId?: string } |
  { stage: 'ready'; reply: InboxReply; continueGoal?: true }
type Active = { messages: Message[]; outcome: Outcome; work?: Work }
type Pending = { ready: Message[][]; albums: Record<string, Message[]>; accepted: number[]; active?: Active; followUp?: Message[] }

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
          ![...state.ready, ...Object.values(state.albums), ...(state.active ? [state.active.messages] : []),
            ...(state.followUp ? [state.followUp] : [])].every(group =>
            Array.isArray(group) && group.length > 0 && group.length <= 10 && group.every(msg => this.isOwner(msg)))) {
        throw new Error('Invalid Codex inbox')
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

  beginFollowUp(message: Message): 'accepted' | 'duplicate' | 'full' {
    if (!this.isOwner(message)) throw new Error('Codex inbox owner mismatch')
    if (this.state.accepted.includes(message.message_id)) return 'duplicate'
    if (this.state.followUp || this.state.ready.length + Object.keys(this.state.albums).length >= limit) return 'full'
    this.save({ ...this.state, accepted: [...this.state.accepted.slice(-299), message.message_id], followUp: [message] })
    return 'accepted'
  }

  finishFollowUp(id: number, enqueue = false): void {
    const { followUp, ...pending } = this.state
    if (followUp?.[0]?.message_id === id) {
      this.save(enqueue ? { ...pending, ready: [...pending.ready, followUp] } : pending)
    }
  }

  receive(message: Message): 'accepted' | 'duplicate' | 'full' {
    if (!this.isOwner(message)) throw new Error('Codex inbox owner mismatch')
    if (this.state.accepted.includes(message.message_id)) return 'duplicate'
    const group = message.media_group_id
    if (group && !/^[a-zA-Z0-9_-]{1,64}$/.test(group)) throw new Error('Invalid Telegram media group')
    const count = this.state.ready.length + Object.keys(this.state.albums).length
    if (count >= limit && (!group || !Object.hasOwn(this.state.albums, group))) return 'full'
    const accepted = [...this.state.accepted.slice(-299), message.message_id]
    if (group) {
      const existing = Object.hasOwn(this.state.albums, group) ? this.state.albums[group]! : []
      if (existing.length >= 10) return 'full'
      this.save({ ...this.state, accepted, albums: { ...this.state.albums, [group]: [...existing, message] } })
    } else {
      this.save({ ...this.state, accepted, ready: [...this.state.ready, [message]] })
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
    this.save(followUp ? { ...this.state, albums, followUp: ordered }
      : { ...this.state, albums, ready: [...this.state.ready, ordered] })
    return ordered
  }

  take(): Message[] | undefined {
    if (this.state.active) return undefined
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

  complete(id: number, reply: InboxReply, continueGoal?: boolean): void {
    const previous = this.state.active?.outcome
    const pending = continueGoal ?? (previous?.stage === 'ready' && previous.continueGoal)
    this.updateActive(id, { stage: 'ready', reply, ...(pending ? { continueGoal: true } : {}) })
  }

  finish(id: number): void {
    const { active, ...pending } = this.state
    if (active?.messages[0]?.message_id === id) this.save(pending)
  }

  cancelContinuation(): void {
    const active = this.state.active
    if (!active?.work?.continuation) return
    const { continuation: _, ...work } = active.work
    const outcome = active.outcome.stage === 'ready'
      ? { stage: 'ready' as const, reply: active.outcome.reply } : active.outcome
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

  private save(state: Pending): void {
    atomicWriteInRoot({ root: this.root }, filename, JSON.stringify(state) + '\n')
    this.state = state
  }
}
