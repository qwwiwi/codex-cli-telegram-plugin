// The public lane (KROT_MULTIUSER=1): member and guest messages, separate from
// the owner's inbox, steer, goals and leases. One Codex thread, one FIFO queue
// and one empty folder per chat key; at most maxParallel − 1 public turns at
// once, so one slot always stays the owner's. A public message never steers.

import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { redactSecrets } from '../safety/redact.js'
import { frameUserMessage, publicRoleInstructions, userProvenance } from './provenance.js'
import { object } from './rpc.js'
import type { PublicTurnProfile } from './session.js'

export interface PublicItem {
  chatKey: string
  chatId: number
  chatType: string
  chatTitle?: string
  /** The message to reply to. */
  replyTo: number
  /** Forum topic (message_thread_id). */
  threadId?: number
  role: 'member' | 'guest'
  userId: string
  senderName?: string
  text: string
  /** Where the turn is recorded outside the lane (the owner's Brain journal, always as foreign). */
  journal?: PublicJournal
}

/** The record of one public turn: bound before it runs, settled once its reply was or was not sent. */
export interface PublicJournal {
  start(): Promise<void>
  settle(delivered: boolean): Promise<void>
}

export interface PublicRunner {
  runPublic(text: string, profile: PublicTurnProfile):
    Promise<{ status: 'completed' | 'interrupted' | 'failed'; text: string; threadId: string; toolItems: number }>
  stopPublic(threadId: string): Promise<boolean>
}

/** The public app-server of this role is not running: the lane answers «временно недоступно». */
export class PublicUnavailableError extends Error {
  constructor() {
    super('The public Codex app-server is not running')
    this.name = 'PublicUnavailableError'
  }
}

export interface PublicBackend {
  runner: PublicRunner
  /** False once this app-server has exited; it is never replaced by the owner's. */
  alive: () => boolean
}

/**
 * Sends each public turn to the app-server of its role. A missing or dead
 * backend is unavailable: there is no fallback to another role or the owner.
 */
export class PublicRouter implements PublicRunner {
  constructor(private readonly backends: Readonly<Partial<Record<'member' | 'guest', PublicBackend>>>) {}

  runPublic(text: string, profile: PublicTurnProfile): ReturnType<PublicRunner['runPublic']> {
    const backend = profile.role ? this.backends[profile.role] : undefined
    if (!backend || !backend.alive()) return Promise.reject(new PublicUnavailableError())
    return backend.runner.runPublic(text, profile)
  }

  async stopPublic(threadId: string): Promise<boolean> {
    for (const backend of Object.values(this.backends)) {
      if (backend.alive() && await backend.runner.stopPublic(threadId).catch(() => false)) return true
    }
    return false
  }
}

export interface PublicLaneOptions {
  /** KROT_PUBLIC_WORKSPACE_ROOT: absolute, outside the owner workspace and the state directory. */
  root: string
  stateDir: string
  /** KROT_CODEX_MAX_PARALLEL */
  maxParallel: number
  runner: PublicRunner
  send: (chatId: string, text: string, opts: { reply_to_message_id: number; message_thread_id?: number }) => Promise<void>
  secrets: readonly string[]
  timeouts?: { member: number; guest: number }
  /** After a timeout, how long the interrupted turn may take to end before its slot is freed anyway. */
  graceMs?: number
  /**
   * The role this item's sender may use in its chat right now (the access list and the group approval),
   * or undefined when access is gone. Checked at dispatch and by revokeStale(); a queued item whose
   * role no longer matches never runs. Without it every accepted item keeps its role.
   */
  authorize?: (item: PublicItem) => 'member' | 'guest' | undefined
  warn?: (message: string) => void
}

// A turn in flight: its item, its thread once known, and whether it was cancelled (access revoked, lane stopped).
interface RunningTurn { item: PublicItem; threadId?: string; cancelled: boolean }

export type PublicReceive = 'accepted' | 'full' | 'refused' | 'stopping'

interface SavedThread { thread_id: string; role: 'member' | 'guest'; cwd: string; last_used_at: string }

const QUEUE_CAP = 16
const REPLY_CHARS = 4000
// Private chat: the user ID; group: the chat ID; topic: <chatId>__t<topicId>.
const CHAT_KEY = /^-?\d{1,20}(?:__t\d{1,12})?$/u
const DEFAULT_TIMEOUTS = { member: 10 * 60_000, guest: 120_000 }
const APOLOGY_TIMEOUT = 'Не успела ответить вовремя. Попробуй спросить короче.'
const APOLOGY_FAILED = 'Не получилось ответить. Попробуй ещё раз позже.'
const APOLOGY_UNAVAILABLE = 'Извини, сейчас это временно недоступно. Попробуй позже.'

function readThreads(path: string, warn?: (message: string) => void): Map<string, SavedThread> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const record = object(raw)
    const threads = object(record.threads)
    if (record.version !== 1) throw new Error('bad version')
    const result = new Map<string, SavedThread>()
    for (const [key, value] of Object.entries(threads)) {
      const entry = object(value)
      if (CHAT_KEY.test(key) && typeof entry.thread_id === 'string' && entry.thread_id !== '' &&
          (entry.role === 'member' || entry.role === 'guest') && typeof entry.cwd === 'string' &&
          typeof entry.last_used_at === 'string') {
        result.set(key, { thread_id: entry.thread_id, role: entry.role, cwd: entry.cwd, last_used_at: entry.last_used_at })
      }
    }
    return result
  } catch (error) {
    // A missing or broken file only costs the chats their history: every chat starts a fresh thread.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn?.('public-threads.json is unreadable; public chats start fresh threads')
    return new Map()
  }
}

export class PublicLane {
  private readonly queues = new Map<string, PublicItem[]>()
  private readonly running = new Map<string, RunningTurn>()
  // Turn counter at the last turn each chat got (scheduling order).
  private readonly served = new Map<string, number>()
  private turns = 0
  private readonly threads: Map<string, SavedThread>
  private readonly statePath: string
  private stopping = false

  constructor(private readonly options: PublicLaneOptions) {
    this.statePath = join(options.stateDir, 'public-threads.json')
    this.threads = readThreads(this.statePath, options.warn)
  }

  /** Public turns allowed at once: one slot of KROT_CODEX_MAX_PARALLEL stays the owner's. */
  get slots(): number {
    return Math.max(1, this.options.maxParallel - 1)
  }

  get size(): number {
    return this.running.size + [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  }

  receive(item: PublicItem): PublicReceive {
    if (this.stopping) return 'stopping'
    if (!CHAT_KEY.test(item.chatKey)) return 'refused'
    const queue = this.queues.get(item.chatKey) ?? []
    if (queue.length >= QUEUE_CAP) return 'full'
    queue.push(item)
    this.queues.set(item.chatKey, queue)
    this.pump()
    return 'accepted'
  }

  /** Drops every queued message; running turns finish on their own but send no reply (the bridge is stopping). */
  stop(): void {
    this.stopping = true
    this.queues.clear()
    for (const turn of this.running.values()) turn.cancelled = true
  }

  // True while the item's sender still has exactly the role the item was accepted with.
  private allowed(item: PublicItem): boolean {
    return !this.options.authorize || this.options.authorize(item) === item.role
  }

  /**
   * After an access change: drops every queued item whose sender lost its role, and interrupts
   * every running turn of such a sender. An interrupted turn sends no reply.
   */
  revokeStale(): void {
    for (const [chatKey, queue] of this.queues) {
      const kept = queue.filter(queued => this.allowed(queued))
      if (kept.length) this.queues.set(chatKey, kept)
      else this.queues.delete(chatKey)
    }
    for (const turn of this.running.values()) {
      if (turn.cancelled || this.allowed(turn.item)) continue
      turn.cancelled = true
      if (turn.threadId) {
        void this.options.runner.stopPublic(turn.threadId).catch(() => this.options.warn?.('Could not stop a revoked public turn'))
      }
    }
  }

  // True once the turn is cancelled; a sender who lost the role cancels it here even before revokeStale ran.
  private cancelled(turn: RunningTurn): boolean {
    if (!turn.cancelled && !this.allowed(turn.item)) turn.cancelled = true
    return turn.cancelled
  }

  private pump(): void {
    while (this.running.size < this.slots) {
      // The waiting chat served longest ago goes first, so one busy chat cannot starve the others.
      const chatKey = [...this.queues.keys()].filter(key => !this.running.has(key))
        .sort((a, b) => (this.served.get(a) ?? 0) - (this.served.get(b) ?? 0))[0]
      if (chatKey === undefined) return
      const queue = this.queues.get(chatKey)!
      const item = queue.shift()!
      if (queue.length === 0) this.queues.delete(chatKey)
      // Access is checked again at dispatch: a sender removed or re-roled while queued never runs.
      if (!this.allowed(item)) continue
      this.served.set(chatKey, ++this.turns)
      if (this.served.size > 4096) this.served.delete(this.served.keys().next().value!)
      const turn: RunningTurn = { item, cancelled: false }
      this.running.set(chatKey, turn)
      void this.run(item, turn).catch(() => this.options.warn?.('A public turn failed')).finally(() => {
        this.running.delete(chatKey)
        this.pump()
      })
    }
  }

  private async run(item: PublicItem, turn: RunningTurn): Promise<void> {
    const cwd = join(this.options.root, item.chatKey)
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const saved = this.threads.get(item.chatKey)
    const provenance = userProvenance({ role: item.role, userId: item.userId, chatKey: item.chatKey })
    const chat = item.chatType === 'private' ? 'личный чат' : 'группа «' + (item.chatTitle ?? item.chatId) + '»'
    const text = frameUserMessage(provenance, { ...(item.senderName ? { name: item.senderName } : {}), chat }, item.text)
    const timeouts = this.options.timeouts ?? DEFAULT_TIMEOUTS
    await item.journal?.start().catch(() => this.options.warn?.('Could not record a public turn in Brain'))
    // Access revoked or the lane stopped while the turn was journaled: it never starts and is recorded as not delivered.
    if (this.cancelled(turn)) {
      await item.journal?.settle(false).catch(() => this.options.warn?.('Could not record a public reply in Brain'))
      return
    }
    let threadId: string | undefined
    let timedOut = false
    let grace: ReturnType<typeof setTimeout> | undefined
    // Settles only when an interrupted turn never ends: the slot is freed with the apology.
    const abandoned = new Promise<undefined>(resolveAbandoned => {
      const timer = setTimeout(() => {
        timedOut = true
        if (threadId) void this.options.runner.stopPublic(threadId).catch(() => this.options.warn?.('Could not stop a public turn'))
        grace = setTimeout(() => resolveAbandoned(undefined), this.options.graceMs ?? 30_000)
      }, timeouts[item.role])
      grace = timer
    })
    let answer: string
    try {
      // The chat folder must be a real folder: a symlink could point the thread at any files.
      if (!lstatSync(cwd).isDirectory()) {
        this.options.warn?.('A public chat folder is not a plain folder; its turn is refused')
        throw new Error('chat folder is not a plain folder')
      }
      const result = await Promise.race([this.options.runner.runPublic(text, {
        cwd, instructions: publicRoleInstructions(item.role), role: item.role,
        // A thread of another role is never continued: a role change starts fresh.
        ...(saved && saved.role === item.role ? { threadId: saved.thread_id } : {}),
        onThread: id => {
          threadId = id
          turn.threadId = id
          if (timedOut || turn.cancelled) void this.options.runner.stopPublic(id).catch(() => undefined)
        },
        // Checked again right before turn/start: a revocation during the thread open starts no turn.
        cancelled: () => this.cancelled(turn),
      }), abandoned])
      if (!result) {
        this.options.warn?.('A public turn did not end after its interrupt; its slot is freed')
        throw new Error('abandoned')
      }
      this.remember(item, result.threadId, cwd)
      answer = timedOut ? APOLOGY_TIMEOUT
        : result.status === 'completed' && result.text.trim() ? result.text : APOLOGY_FAILED
    } catch (error) {
      answer = timedOut ? APOLOGY_TIMEOUT : error instanceof PublicUnavailableError ? APOLOGY_UNAVAILABLE : APOLOGY_FAILED
    } finally {
      clearTimeout(grace)
    }
    // Cancelled while it ran (access revoked, the lane stopped): no reply, the journal records it as not delivered.
    if (turn.cancelled) {
      await item.journal?.settle(false).catch(() => this.options.warn?.('Could not record a public reply in Brain'))
      return
    }
    const safe = redactSecrets(answer, this.options.secrets)
    const reply = safe.length > REPLY_CHARS ? safe.slice(0, REPLY_CHARS - 1) + '…' : safe
    let delivered = false
    try {
      await this.options.send(String(item.chatId), reply, {
        reply_to_message_id: item.replyTo,
        ...(item.threadId !== undefined ? { message_thread_id: item.threadId } : {}),
      })
      delivered = true
    } finally {
      await item.journal?.settle(delivered).catch(() => this.options.warn?.('Could not record a public reply in Brain'))
    }
  }

  private remember(item: PublicItem, threadId: string, cwd: string): void {
    this.threads.set(item.chatKey, { thread_id: threadId, role: item.role, cwd, last_used_at: new Date().toISOString() })
    try {
      const temp = this.statePath + '.' + randomUUID() + '.tmp'
      writeFileSync(temp, JSON.stringify({ version: 1, threads: Object.fromEntries(this.threads) }, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.statePath)
    } catch {
      this.options.warn?.('Could not save public-threads.json')
    }
  }
}
