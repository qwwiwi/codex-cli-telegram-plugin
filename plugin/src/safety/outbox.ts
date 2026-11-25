// Persistent outbox + background re-send loop for flood-banned replies.
//
// WHY THIS EXISTS
// ───────────────
// On a LONG Telegram flood ban, `rate-limited-telegram-api.ts` deliberately
// fail-fast THROWS the 429 (instead of sleeping for minutes and freezing the
// agent's turn). The reply tool then tells the agent "not delivered, end your
// turn". Before this outbox, that reply was LOST with the turn — the owner had
// to ping again to get an answer.
//
// The outbox instead PERSISTS the undelivered reply to disk and a background
// flusher re-sends it later, respecting each item's retry_after, WITHOUT
// freezing any turn and WITHOUT extending the ban (it only tries again after
// the item's `notBefore`). Once Telegram lifts the ban the reply is delivered
// automatically.
//
// ANTI-DUPLICATE INVARIANT (critical)
// ───────────────────────────────────
// An item is enqueued ONLY on the fail-fast 429 path, which guarantees the
// message was genuinely NOT delivered — a 429 means Telegram rejected the
// send outright. The reply tool does NOT also retry the send in-turn: it
// enqueues, then ends the turn. So exactly ONE actor ever delivers a given
// reply — the flusher. No double-send is possible: the in-turn attempt failed
// (nothing shipped) and the flusher is the only re-sender.
//
// DESIGN
// ──────
// • One JSON file (`outbox.json`) in the plugin state dir, atomic tmp+rename
//   write (mirrors context-hud's persistence style).
// • FIFO order preserved globally on disk; flushed per-chat in order so a
//   not-due / 429-rescheduled head never lets a later same-chat item jump
//   ahead. Different chats are independent.
// • Best-effort: `flushDue` NEVER throws (a broken outbox must not crash the
//   flusher interval); persistence failures are logged, not propagated.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { parse429 } from './rate-limited-telegram-api.js'
import type { SendMessageOpts } from '../channel/tools.js'
import type { Logger } from '../log.js'
import type { OpenQuestionDetection } from './open-question.js'

export interface OutboxItem {
  /** Unique id (uuid) — diagnostics + dedupe of persisted entries. */
  id: string
  chatId: string
  text: string
  opts: SendMessageOpts
  /** Epoch ms before which the item must NOT be (re)sent. */
  notBefore: number
  /** Send attempts so far (429 reschedules and non-flood failures both bump). */
  attempts: number
  question?: OpenQuestionDetection
}

// The re-send primitive — the SAME rate-limited `sendMessage` the reply tool
// uses, so a re-send that hits a short ban self-retries and a long one
// re-throws the 429 (→ reschedule).
export type OutboxSendFn = (
  chatId: string,
  text: string,
  opts: SendMessageOpts,
) => Promise<{ message_id: number }>

export interface OutboxOptions {
  /** Plugin state dir; the outbox writes `<fileName>` here. */
  stateDir: string
  sendFn: OutboxSendFn
  onDelivered?: (item: Readonly<OutboxItem>, messageId: number) => void
  log: Logger
  /** Test seam: replace Date.now() for enqueue's notBefore computation. */
  now?: () => number
  /** Cap on queued items; enqueueing past it drops the OLDEST. Default 200. */
  maxItems?: number
  /** Non-flood send failures allowed before an item is dropped. Default 5. */
  maxAttempts?: number
  /** Override the on-disk filename (tests / diagnostics). Default outbox.json. */
  fileName?: string
}

const DEFAULT_MAX_ITEMS = 200
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_FILE_NAME = 'outbox.json'

export class Outbox {
  private readonly stateDir: string
  private readonly sendFn: OutboxSendFn
  private readonly onDelivered: OutboxOptions['onDelivered']
  private readonly log: Logger
  private readonly now: () => number
  private readonly maxItems: number
  private readonly maxAttempts: number
  private readonly filePath: string
  private items: OutboxItem[] = []

  constructor(opts: OutboxOptions) {
    this.stateDir = opts.stateDir
    this.sendFn = opts.sendFn
    this.onDelivered = opts.onDelivered
    this.log = opts.log
    this.now = opts.now ?? ((): number => Date.now())
    this.maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.filePath = join(this.stateDir, opts.fileName ?? DEFAULT_FILE_NAME)
    this.load()
  }

  // Append an undelivered reply. `retryAfterSec` is the ban's cooldown (from
  // the 429) — the item won't be re-sent before now()+retryAfterSec. Persists
  // synchronously so a crash right after enqueue can't lose the reply.
  enqueue(chatId: string, text: string, opts: SendMessageOpts, retryAfterSec: number, question?: OpenQuestionDetection): void {
    const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 0
    this.items.push({
      id: randomUUID(),
      chatId,
      text,
      opts,
      notBefore: this.now() + wait * 1000,
      attempts: 0,
      ...(question ? { question } : {}),
    })
    // Bounded: never grow without limit. Drop the OLDEST (front) so the most
    // recent replies survive — and NEVER silently (warn on every drop).
    while (this.items.length > this.maxItems) {
      const dropped = this.items.shift()
      this.log.warn('outbox overflow, dropped oldest undelivered reply', {
        max_items: this.maxItems,
        dropped_chat_id: dropped?.chatId,
        dropped_id: dropped?.id,
      })
    }
    this.persist()
  }

  // Re-send every DUE item, per-chat in FIFO order. NEVER throws — a broken
  // outbox must not crash the background interval. Persists once at the end if
  // anything changed.
  async flushDue(now: number): Promise<void> {
    try {
      // Group by chat, preserving global FIFO order within each chat. The
      // returned arrays hold the SAME item objects as `this.items`, so
      // mutating notBefore/attempts below updates the live queue too.
      const byChat = new Map<string, OutboxItem[]>()
      for (const item of this.items) {
        const arr = byChat.get(item.chatId)
        if (arr === undefined) byChat.set(item.chatId, [item])
        else arr.push(item)
      }

      const toRemove = new Set<OutboxItem>()
      let changed = false

      for (const arr of byChat.values()) {
        for (const item of arr) {
          // FIFO: a not-due head holds the whole chat this round.
          if (item.notBefore > now) break
          try {
            const result = await this.sendFn(item.chatId, item.text, item.opts)
            toRemove.add(item)
            changed = true
            try { this.onDelivered?.(item, result.message_id) } catch { this.log.warn('Could not record delivered outbox message') }
            // Delivered — drain the next same-chat item this round.
            continue
          } catch (err) {
            const flood = parse429(err)
            if (flood !== null) {
              // Still banned: reschedule past the new cooldown and hold the
              // rest of this chat behind it. NOT counted toward maxAttempts —
              // a flood is transient, we keep retrying until the ban lifts.
              item.notBefore = now + flood.retryAfter * 1000
              item.attempts += 1
              changed = true
              this.log.warn('outbox re-send hit 429, rescheduled', {
                chat_id: item.chatId,
                id: item.id,
                retry_after_s: flood.retryAfter,
                attempts: item.attempts,
              })
              break
            }
            // Non-flood (permanent-ish) error: count it and drop once the
            // budget is spent, else hold the chat and retry next round.
            item.attempts += 1
            changed = true
            if (item.attempts >= this.maxAttempts) {
              toRemove.add(item)
              this.log.warn('outbox item dropped after max attempts', {
                chat_id: item.chatId,
                id: item.id,
                attempts: item.attempts,
                error: err instanceof Error ? err.message : String(err),
              })
              // Dropped the head → the next same-chat item becomes eligible.
              continue
            }
            this.log.warn('outbox re-send failed, will retry', {
              chat_id: item.chatId,
              id: item.id,
              attempts: item.attempts,
              error: err instanceof Error ? err.message : String(err),
            })
            break
          }
        }
      }

      if (toRemove.size > 0) {
        this.items = this.items.filter((it) => !toRemove.has(it))
      }
      if (changed) this.persist()
    } catch (err) {
      // Catch-all: flushDue must never reject (it runs from a bare interval).
      this.log.error('outbox flushDue failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Number of queued items (tests / diagnostics). */
  size(): number {
    return this.items.length
  }

  /** Read-only view of the queue (tests / diagnostics). */
  snapshot(): ReadonlyArray<Readonly<OutboxItem>> {
    return this.items.map((it) => ({ ...it }))
  }

  // ── persistence ────────────────────────────────────────────────────

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      // Missing file → empty queue (fresh install / first run). Not an error.
      this.items = []
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('outbox file is not an array')
      const items: OutboxItem[] = []
      for (const entry of parsed) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as OutboxItem).chatId === 'string' &&
          typeof (entry as OutboxItem).text === 'string' &&
          typeof (entry as OutboxItem).notBefore === 'number'
        ) {
          const e = entry as OutboxItem
          items.push({
            id: typeof e.id === 'string' ? e.id : randomUUID(),
            chatId: e.chatId,
            text: e.text,
            opts: (e.opts ?? {}) as SendMessageOpts,
            notBefore: e.notBefore,
            attempts: typeof e.attempts === 'number' ? e.attempts : 0,
            ...(e.question && typeof e.question.code === 'string' && typeof e.question.snippet === 'string'
              ? { question: e.question } : {}),
          })
        }
      }
      this.items = items
    } catch (err) {
      // Corrupt JSON → start empty rather than crash the process. Log loudly.
      this.log.warn('outbox file corrupt, starting empty', {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
      this.items = []
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      // Atomic write: tmp + rename so a crash mid-write can't leave a
      // half-written (corrupt) outbox file.
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      this.log.warn('outbox persist failed (ignored)', {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
