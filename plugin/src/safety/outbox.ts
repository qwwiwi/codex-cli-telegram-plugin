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

import { plainTextWithLinks, PreformattedDocumentError, splitMessage, splitPlainMessage } from '../format/chunk.js'
import { mask, maskString, render, type Entity, type VisibleText } from '../format/visible.js'
import { isPlanV3, newPlan, planPieces, resumePlan, textBefore, type PlanV3 } from '../codex/reply-plan.js'
import { parse429 } from './rate-limited-telegram-api.js'
import type { SendMessageOpts, SentMessage } from '../channel/tools.js'
import type { Logger } from '../log.js'
import type { OpenQuestionDetection } from './open-question.js'
import { storedOrigin, StoredTurnOriginSchema, type StoredTurnOrigin, type TurnOrigin } from '../codex/turn-origin.js'

/**
 * One deferred reply (v3): its masked shown text and cuts, and how many pieces already went. A reply is one item
 * whatever its length, so cutting it again (a value registered while it waits) never changes the queue length.
 */
export interface OutboxItem {
  v: 3
  /** Unique id (uuid) — diagnostics + dedupe of persisted entries. */
  id: string
  chatId: string
  plan: PlanV3
  /** Pieces of `plan` already delivered. */
  sent: number
  /** Send options of the first piece; later pieces go without the quote. Never a parse_mode. */
  opts: SendMessageOpts
  /** Epoch ms before which the item must NOT be (re)sent. */
  notBefore: number
  /** Send attempts so far (429 reschedules and non-flood failures both bump). */
  attempts: number
  question?: OpenQuestionDetection
  /** The Brain exchange key of the reply: delivering its last piece completes that exchange. */
  brainKey?: string
  /** The origin of the turn whose reply this is; an item without one (or a damaged one) is a guest's. */
  origin?: StoredTurnOrigin
  /** The reply goes as one .txt document of the plan's text. */
  document?: true
}

// A part as saved by the v0.6 outbox (unversioned, or v2): one item per message of a reply.
interface LegacyItem {
  id: string
  chatId: string
  text: string
  opts: SendMessageOpts
  notBefore: number
  attempts: number
  question?: OpenQuestionDetection
  brainKey?: string
  origin?: StoredTurnOrigin
  document?: true
  v?: 2
}

// The re-send primitive — the SAME rate-limited `sendMessage` the reply tool
// uses, so a re-send that hits a short ban self-retries and a long one
// re-throws the 429 (→ reschedule).
export type OutboxSendFn = (
  chatId: string,
  text: string,
  opts: SendMessageOpts,
) => Promise<OutboxSent>

/**
 * What a re-send delivered: its message ID and, for a document, the body actually uploaded (redacted at upload); for
 * a text, the payload the safe wrapper sent.
 */
export interface OutboxSent extends SentMessage {
  body?: string
}

export interface OutboxOptions {
  /** Plugin state dir; the outbox writes `<fileName>` here. */
  stateDir: string
  sendFn: OutboxSendFn
  sendDocument?: OutboxSendFn
  /**
   * Called once per delivered piece. `item.question` is set only for the first piece and `item.brainKey` only for
   * the last, so a caller acting on them acts once per reply.
   */
  onDelivered?: (item: Readonly<OutboxItem>, messageId: number, sent: OutboxSent) => void
  log: Logger
  /** Test seam: replace Date.now() for enqueue's notBefore computation. */
  now?: () => number
  /** Cap on queued items; enqueueing past it drops the OLDEST. Default 200. */
  maxItems?: number
  /** Non-flood send failures allowed before an item is dropped. Default 5. */
  maxAttempts?: number
  /** Override the on-disk filename (tests / diagnostics). Default outbox.json. */
  fileName?: string
  /**
   * The outbound redaction (the safe wrapper's, see redactOutboundText) applied to an unversioned legacy reply whose
   * parts are joined on load: a secret cut across two parts is found only in the joined text. Default: none.
   */
  redact?: (text: string, parseMode: SendMessageOpts['parse_mode']) => string
  /** The live secret list: every plan is masked with it on load and before each send. Default: patterns only. */
  secrets?: ReadonlyArray<string>
}

// Send options of two parts of one reply: everything but the quote, which only the first part carries.
function sameSendOptions(a: SendMessageOpts, b: SendMessageOpts): boolean {
  const { reply_to_message_id: _a, ...left } = a
  const { reply_to_message_id: _b, ...right } = b
  // Both come from the same enqueue call site, so their keys are in the same order.
  return JSON.stringify(left) === JSON.stringify(right)
}

// Send options of two parts of one reply as the v2 -> v3 upgrade compares them: entities are piece-local (each part
// carries its own spans), so they never tell two replies apart.
function samePartOptions(a: SendMessageOpts, b: SendMessageOpts): boolean {
  const { entities: _a, ...left } = a
  const { entities: _b, ...right } = b
  return sameSendOptions(left, right)
}

const CLOSERS_RE = /(?:<\/[a-zA-Z][\w-]*>)+$/
const OPENERS_RE = /^(?:<[a-zA-Z][\w-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?>)+/
const TAG_NAME_RE = /<\/?([a-zA-Z][\w-]*)/g

// Joins two consecutive HTML parts of one reply. The chunker closed the tags open at a cut and reopened them on the
// next part; that seam is removed, so a secret cut inside a <code> span reads as one run of text again.
function joinParts(left: string, right: string, html: boolean): string {
  if (!html) return left + right
  const closers = CLOSERS_RE.exec(left)?.[0] ?? ''
  const openers = OPENERS_RE.exec(right)?.[0] ?? ''
  const closed = [...closers.matchAll(TAG_NAME_RE)].map(match => match[1]!.toLowerCase())
  const reopened = [...openers.matchAll(TAG_NAME_RE)].map(match => match[1]!.toLowerCase())
  if (closed.length === 0 || closed.join(' ') !== [...reopened].reverse().join(' ')) return left + right
  return left.slice(0, left.length - closers.length) + right.slice(openers.length)
}

/** What a turn's reply part carries into the outbox. */
export interface OutboxReply {
  origin: TurnOrigin
  question?: OpenQuestionDetection | undefined
  brainKey?: string | undefined
  document?: boolean
}

// A saved origin is kept only when it is well formed; otherwise the item has none and reads as a guest's.
function storedOriginField(value: unknown): { origin?: StoredTurnOrigin } {
  const parsed = StoredTurnOriginSchema.safeParse(value)
  return parsed.success ? { origin: parsed.data } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Saved send options, as written by an enqueue: kept as they are (they came from this process).
function savedOpts(value: unknown): SendMessageOpts {
  return isRecord(value) ? value : {}
}

function savedQuestion(value: unknown): { question?: OpenQuestionDetection } {
  return isRecord(value) && typeof value.code === 'string' && typeof value.snippet === 'string'
    ? { question: { code: value.code, snippet: value.snippet } } : {}
}

function savedCommon(entry: Record<string, unknown>): Pick<OutboxItem, 'id' | 'attempts'> &
  Partial<Pick<OutboxItem, 'question' | 'brainKey' | 'origin' | 'document'>> {
  return {
    id: typeof entry.id === 'string' ? entry.id : randomUUID(),
    attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
    ...(entry.document === true ? { document: entry.document } : {}),
    ...savedQuestion(entry.question),
    ...(typeof entry.brainKey === 'string' && entry.brainKey ? { brainKey: entry.brainKey } : {}),
    ...storedOriginField(entry.origin),
  }
}

// A v3 item as saved; undefined for anything else.
function readItem(entry: unknown): OutboxItem | undefined {
  if (!isRecord(entry) || entry.v !== 3 || typeof entry.chatId !== 'string' || typeof entry.notBefore !== 'number' ||
      !isPlanV3(entry.plan) || typeof entry.sent !== 'number' || !Number.isSafeInteger(entry.sent) || entry.sent < 0 ||
      entry.sent > entry.plan.cuts.length) return undefined
  return { v: 3, chatId: entry.chatId, plan: entry.plan, sent: entry.sent, opts: savedOpts(entry.opts),
    notBefore: entry.notBefore, ...savedCommon(entry) }
}

// A part saved by the v0.6 outbox (unversioned or v2); undefined for anything else.
function readLegacyItem(entry: unknown): LegacyItem | undefined {
  if (!isRecord(entry) || entry.v === 3 || typeof entry.chatId !== 'string' || typeof entry.text !== 'string' ||
      typeof entry.notBefore !== 'number') return undefined
  return { chatId: entry.chatId, text: entry.text, opts: savedOpts(entry.opts), notBefore: entry.notBefore,
    ...(entry.v === 2 ? { v: entry.v } : {}), ...savedCommon(entry) }
}

const DEFAULT_MAX_ITEMS = 200
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_FILE_NAME = 'outbox.json'

export class Outbox {
  private readonly stateDir: string
  private readonly sendFn: OutboxSendFn
  private readonly sendDocument: OutboxOptions['sendDocument']
  private readonly onDelivered: OutboxOptions['onDelivered']
  private readonly log: Logger
  private readonly now: () => number
  private readonly maxItems: number
  private readonly maxAttempts: number
  private readonly filePath: string
  private readonly redact: NonNullable<OutboxOptions['redact']>
  private readonly secrets: ReadonlyArray<string> | undefined
  private items: OutboxItem[] = []

  constructor(opts: OutboxOptions) {
    this.stateDir = opts.stateDir
    this.sendFn = opts.sendFn
    this.sendDocument = opts.sendDocument
    this.onDelivered = opts.onDelivered
    this.log = opts.log
    this.now = opts.now ?? ((): number => Date.now())
    this.maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.filePath = join(this.stateDir, opts.fileName ?? DEFAULT_FILE_NAME)
    this.redact = opts.redact ?? ((text: string): string => text)
    this.secrets = opts.secrets
    this.load()
  }

  // Append an undelivered reply. `retryAfterSec` is the ban's cooldown (from
  // the 429) — the item won't be re-sent before now()+retryAfterSec. Persists
  // synchronously so a crash right after enqueue can't lose the reply. Return the item's UUID for delivery tracking.
  // A reply of a turn passes `reply`: its origin is required, so a deferred question keeps whose question it is.
  // `text` is rendered by `opts.parse_mode` (or taken with `opts.entities`); a document reply is its plain body.
  enqueue(chatId: string, text: string, opts: SendMessageOpts, retryAfterSec: number, reply?: OutboxReply): string {
    const { parse_mode: parseMode, entities, ...rest } = opts
    const shown = reply?.document ? { text, entities: [] } : entities !== undefined && parseMode === undefined
      ? { text, entities } : render(text, parseMode)
    return this.enqueueReply(chatId, shown, rest, retryAfterSec, reply)
  }

  /** Append the rest of an undelivered reply as one item: its shown text, masked and cut here. */
  enqueueReply(chatId: string, shown: VisibleText, opts: SendMessageOpts, retryAfterSec: number,
    reply?: OutboxReply): string {
    return this.add(chatId, this.planned(mask(shown, this.secrets), reply?.document === true), 0, opts, retryAfterSec,
      reply, false)
  }

  /**
   * Append a reply a flood stopped mid-delivery: its whole plan and how many pieces of it already went. The outbox
   * masks the whole text again with the current secrets (a value across the last sent cut moves that cut to the
   * start of its marker) and sends from piece `sent`; the shown text before it comes from the plan itself.
   */
  enqueuePlan(chatId: string, plan: PlanV3, sent: number, opts: SendMessageOpts, retryAfterSec: number,
    reply?: OutboxReply): string {
    if (!Number.isSafeInteger(sent) || sent < 0 || sent > plan.cuts.length) {
      throw new RangeError(`outbox: sent count ${sent} is outside the plan's ${plan.cuts.length} pieces`)
    }
    return this.add(chatId, { plan }, sent, opts, retryAfterSec, reply, true)
  }

  private add(chatId: string, planned: { plan: PlanV3; document?: true }, sent: number, opts: SendMessageOpts,
    retryAfterSec: number, reply: OutboxReply | undefined, remask: boolean): string {
    const origin = reply?.origin
    const question = reply?.question
    const brainKey = reply?.brainKey
    const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 0
    const id = randomUUID()
    const { parse_mode: _mode, entities: _entities, ...rest } = opts
    const item: OutboxItem = {
      v: 3,
      id,
      chatId,
      ...planned,
      sent,
      opts: rest,
      notBefore: this.now() + wait * 1000,
      attempts: 0,
      // The snippet is a clip of the reply's text: masked like it, on disk too.
      ...(question ? { question: { ...question, snippet: maskString(question.snippet, this.secrets) } } : {}),
      ...(brainKey ? { brainKey } : {}),
      ...(origin ? { origin: storedOrigin(origin) } : {}),
    }
    // A handed-off plan is masked with the current secrets before it is stored (a fresh one was masked just now).
    if (remask) item.plan = this.remasked(item)
    this.items.push(item)
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
    return id
  }

  // A plan of masked text: messages cut at the message limit, a document as one piece. Text that cannot be cut
  // into messages goes as a document.
  private planned(visible: VisibleText, document: boolean): { plan: PlanV3; document?: true } {
    if (!document) {
      try {
        return { plan: newPlan(visible) }
      } catch (error) {
        if (!(error instanceof PreformattedDocumentError)) throw error
      }
    }
    const text = visible.text
    return { plan: { v: 3, text, entities: [], cuts: text.length > 0 ? [text.length] : [] }, document: true }
  }

  // The item's plan masked with the current secrets and its pending pieces cut again (resume steps 2-4). A pending
  // tail that can no longer be cut into messages goes as one document: the item becomes a document reply.
  private remasked(item: OutboxItem): PlanV3 {
    if (!item.document) {
      try {
        return resumePlan(item.plan, item.sent, this.secrets)
      } catch (error) {
        if (!(error instanceof PreformattedDocumentError)) throw error
        item.document = true
      }
    }
    return resumePlan(item.plan, item.sent, this.secrets, Number.POSITIVE_INFINITY)
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
          let held = false
          for (;;) {
            // An item dropped from the queue while this flush awaited a send (overflow) is never sent.
            if (!this.items.includes(item)) break
            // The plan is masked again before every piece: a value registered while the reply waited, or since
            // its last piece landed, is masked, and a cut inside it moves to the start of its marker.
            const wasDocument = item.document === true
            const plan = this.remasked(item)
            if (JSON.stringify(plan) !== JSON.stringify(item.plan) || (item.document === true) !== wasDocument) {
              item.plan = plan
              changed = true
            }
            const send = item.document ? this.sendDocument : this.sendFn
            if (!send) {
              held = true
              break
            }
            const pieces = planPieces(plan)
            const piece = pieces[item.sent]
            if (piece === undefined) break
            const index = item.sent
            const { reply_to_message_id: _quote, sentBefore: earlier, ...unquoted } = item.opts
            // The shown text sent ahead of this piece: the reply's part before the item, then the item's own pieces.
            const before = (earlier ?? '') + textBefore(plan, index)
            const options: SendMessageOpts = { ...(index === 0 ? item.opts : unquoted),
              ...(item.document ? {} : { entities: piece.entities, ...(before === '' ? {} : { sentBefore: before }) }) }
            try {
              const result = await send(item.chatId, piece.text, options)
              item.sent += 1
              item.attempts = 0
              changed = true
              // A delivered reply leaves the queue now, and every delivered piece is on disk before the next send
              // starts: a restart mid-flush never sends a piece again.
              if (item.sent >= pieces.length) this.items = this.items.filter(it => it !== item)
              this.persist()
              // The reply's question belongs to its first message, its Brain exchange completes with the last.
              const view: OutboxItem = { ...item }
              if (index > 0) delete view.question
              if (item.sent < pieces.length) delete view.brainKey
              try { this.onDelivered?.(view, result.message_id, result) } catch { this.log.warn('Could not record delivered outbox message') }
            } catch (err) {
              held = true
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
                held = false
                this.log.warn('outbox item dropped after max attempts', {
                  chat_id: item.chatId,
                  id: item.id,
                  attempts: item.attempts,
                  error: err instanceof Error ? err.message : String(err),
                })
                break
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
          if (held) break
          // Delivered, or dropped after max attempts: the next same-chat item becomes eligible.
          toRemove.add(item)
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

  // ── upgrade ────────────────────────────────────────────────────────

  // Items saved before v2 were the parts of a deferred reply, rendered and split before redaction and then redacted
  // part by part: a secret cut across two parts, or escaped as `&amp;`, was in no single part. Each run of legacy
  // parts of one reply is joined, redacted as a whole and, only when that masked something, split again. A run
  // starts at an item carrying a quote or an open question (only a reply's first part does) and never spans a v2
  // item or different send options. Every item comes out v2, so a restart never rewrites the queue again.
  private migrateLegacy(items: readonly LegacyItem[]): LegacyItem[] {
    const runs = new Map<string, LegacyItem[]>()
    const groups: LegacyItem[][] = []
    for (const item of items) {
      if (item.v === 2) {
        runs.delete(item.chatId)
        groups.push([item])
        continue
      }
      const run = runs.get(item.chatId)
      const head = run?.[0]
      if (run !== undefined && head !== undefined && run.at(-1)?.brainKey === undefined &&
        item.opts.reply_to_message_id === undefined && item.question === undefined &&
        sameSendOptions(head.opts, item.opts)) {
        run.push(item)
        continue
      }
      const next = [item]
      runs.set(item.chatId, next)
      groups.push(next)
    }
    const out: LegacyItem[] = []
    let rewritten = 0
    for (const group of groups) {
      const head = group[0]!
      if (head.v === 2) {
        out.push(head)
        continue
      }
      const parseMode = head.opts.parse_mode
      const joined = group.map(item => item.text).reduce((left, right) => joinParts(left, right, parseMode === 'HTML'))
      const redacted = this.redact(joined, parseMode)
      if (redacted === joined) {
        for (const item of group) out.push({ ...item, v: 2 })
        continue
      }
      rewritten += 1
      const { reply_to_message_id: _quote, ...restOpts } = head.opts
      const notBefore = Math.max(...group.map(item => item.notBefore))
      const attempts = Math.max(...group.map(item => item.attempts))
      // Only a reply's last part carries its Brain key (a run ends there).
      const brainKey = group[group.length - 1]!.brainKey
      let parts: string[]
      try {
        parts = parseMode === 'HTML' ? splitMessage(redacted) : splitPlainMessage(redacted)
      } catch (error) {
        if (!(error instanceof PreformattedDocumentError)) throw error
        const { parse_mode: _mode, ...opts } = head.opts
        const { brainKey: _key, ...first } = head
        out.push({ ...first, opts, notBefore, attempts, document: true, v: 2,
          text: this.redact(plainTextWithLinks(error.html, Infinity), undefined), ...(brainKey ? { brainKey } : {}) })
        continue
      }
      parts.forEach((text, index) => {
        out.push({
          id: index === 0 ? head.id : randomUUID(), chatId: head.chatId, text,
          opts: index === 0 ? head.opts : restOpts, notBefore, attempts: index === 0 ? attempts : 0,
          ...(index === 0 && head.question ? { question: head.question } : {}),
          ...(index === parts.length - 1 && brainKey ? { brainKey } : {}),
          // Every part of the reply keeps its turn's origin: without one a part reads as a guest's.
          ...(head.origin ? { origin: head.origin } : {}), v: 2,
        })
      })
    }
    if (rewritten > 0) this.log.warn('outbox upgraded legacy replies, redacted across their parts', { replies: rewritten })
    return out
  }

  // ── persistence ────────────────────────────────────────────────────

  // v2 → v3: the parts of one reply become one item. A run is the rule migrateLegacy uses: consecutive same-chat
  // parts with identical send options where only the first carries a quote or a question. Each part is rendered by
  // its own parse_mode, the texts and entities are joined and masked as one text, then cut again; `notBefore` and
  // `attempts` take the run's maximum, the Brain key comes from the last part, question, origin and quote from the
  // first. A document part becomes a one-piece plan of its own.
  private upgrade(items: readonly LegacyItem[]): OutboxItem[] {
    const groups: LegacyItem[][] = []
    let run: LegacyItem[] | undefined
    for (const item of items) {
      const head = run?.[0]
      if (run !== undefined && head !== undefined && !item.document && !head.document && item.chatId === head.chatId &&
          run.at(-1)?.brainKey === undefined && item.opts.reply_to_message_id === undefined &&
          item.question === undefined && samePartOptions(head.opts, item.opts)) {
        run.push(item)
        continue
      }
      run = [item]
      groups.push(run)
    }
    return groups.map<OutboxItem>(group => {
      const head = group[0]!
      const last = group[group.length - 1]!
      let text = ''
      const entities: Entity[] = []
      for (const part of group) {
        const { parse_mode: parseMode, entities: given } = part.opts
        const shown = part.document ? { text: part.text, entities: [] }
          : given !== undefined && parseMode === undefined ? { text: part.text, entities: given } : render(part.text, parseMode)
        for (const entity of shown.entities) entities.push({ ...entity, offset: entity.offset + text.length })
        text += shown.text
      }
      const { parse_mode: _mode, entities: _entities, ...opts } = head.opts
      return {
        v: 3,
        id: head.id,
        chatId: head.chatId,
        ...this.planned(mask({ text, entities }, this.secrets), head.document === true),
        sent: 0,
        opts,
        notBefore: Math.max(...group.map(item => item.notBefore)),
        attempts: Math.max(...group.map(item => item.attempts)),
        ...(head.question ? { question: head.question } : {}),
        ...(last.brainKey ? { brainKey: last.brainKey } : {}),
        ...(head.origin ? { origin: head.origin } : {}),
      }
    })
  }

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
      const current: OutboxItem[] = []
      const legacy: LegacyItem[] = []
      for (const entry of parsed) {
        const item = readItem(entry)
        if (item !== undefined) current.push(item)
        else {
          const part = readLegacyItem(entry)
          if (part !== undefined) legacy.push(part)
        }
      }
      // The parts saved before v2 are redacted across their runs first (migrateLegacy), then every v2 part
      // becomes part of a v3 reply. Order is kept: v0.6 items were queued before any v3 item existed.
      const upgraded = legacy.length === 0 ? [] : this.upgrade(legacy.some(item => item.v !== 2)
        ? this.migrateLegacy(legacy) : legacy)
      if (upgraded.length > 0) this.log.warn('outbox upgraded saved replies to one item per reply', { replies: upgraded.length })
      this.items = [...upgraded, ...current]
      // At rest, every plan holds only text masked with the current secrets.
      let changed = upgraded.length > 0
      for (const item of this.items) {
        // The shown text sent ahead of a deferred rest (its seam context) is masked at rest too.
        const earlier = item.opts.sentBefore
        if (typeof earlier === 'string') {
          const masked = maskString(earlier, this.secrets)
          if (masked !== earlier) {
            item.opts = { ...item.opts, sentBefore: masked }
            changed = true
          }
        }
        if (item.question !== undefined) {
          const snippet = maskString(item.question.snippet, this.secrets)
          if (snippet !== item.question.snippet) {
            item.question = { ...item.question, snippet }
            changed = true
          }
        }
        const wasDocument = item.document === true
        const plan = this.remasked(item)
        if (JSON.stringify(plan) === JSON.stringify(item.plan) && (item.document === true) === wasDocument) continue
        item.plan = plan
        changed = true
      }
      if (changed) this.persist()
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
