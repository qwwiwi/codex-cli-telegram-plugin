// Outbound rate-limit wrapper around TelegramApi.
//
// Goal: make Telegram's per-chat / per-bot rate limits invisible to callers.
// A burst of replies (e.g. a multi-part report) used to surface as a 429
// from Bot API with retry_after ≈ 300s — long enough that the warchief lost
// sight of what the agent was doing. This wrapper enforces pacing BEFORE
// the request leaves the process and transparently retries on 429.
//
// Layers (independent, all consulted on every text-send AND every edit):
//   1. Per-chat token bucket (default: 1 msg/sec sustained, burst 3).
//      Same-chat ordering is preserved via a FIFO tail-promise chain — a
//      second sendMessage to the same chat awaits the first before checking
//      its bucket. Different chats run in parallel.
//   2. Global token bucket (default: 25 msg/sec, burst 25). Caps total
//      throughput across all chats under Telegram's 30/sec bot-wide limit.
//   3. 429 retry: on a grammY-shaped 429 (`error_code: 429`, optional
//      `parameters.retry_after`), sleep the requested seconds + a small
//      jitter and retry the SAME call. Bounded by `maxRetries` (default 3).
//   4. Heavy-upload pacing (default: ≥5 MB, one per chat per 90s). The
//      buckets above pace message COUNT; Telegram also prices uploaded
//      BYTES. On 2026-08-31 a channel was flood-banned for 1.5h about two
//      minutes after shipping a 13.8 MB video, having sent only FOUR
//      messages all evening — no count-based limit was anywhere near.
//      A heavy upload waits out the window, then sends itself. It is never
//      refused: the outbox stores text only, and `reply` sends its text
//      BEFORE its files, so a rejected attachment would be destroyed with
//      no way to recover it. The wait sits on a SEPARATE per-chat chain,
//      so text, edits, status and small files are never delayed behind a
//      video — an agent that cannot speak while a render uploads is worse
//      than one that is banned.
//
// editMessageText shares the per-chat send bucket: Telegram counts edits
// toward the same ~1 msg/sec per-chat flood limit as fresh sends, so a busy
// status bubble being edited while replies are sent could otherwise trip a
// 429 (the original "edits are lenient" assumption was wrong in practice).
// sendChatAction does NOT touch the send bucket or the message window: a
// typing pulse is not a message and Telegram's per-chat flood limit does not
// count it. It has its own per-chat minute quota and never waits — a pulse is
// worthless once late, so it is sent if its quota has room and dropped if not.
// Methods that DON'T consume the bucket: setMessageReaction, deleteMessage,
// downloadFile. They still get the 429 retry wrapper so a stray 429 can
// recover without the caller seeing it. A deleteMessage also drops every edit
// still queued for that message — those could only fail.
//
// Test seams: `opts.now` and `opts.sleep` replace the real clock and
// setTimeout-based sleep, so tests can run instantly with deterministic
// virtual time.

import { appendFileSync, statSync } from 'node:fs'

import { redactToken } from '../config.js'
import type { Logger } from '../log.js'
import type {
  AnswerGuestQueryOpts,
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendFileResult,
  SendMessageOpts,
  SendRichMessageOpts,
  SendRichMessageResult,
  TelegramApi,
} from '../channel/tools.js'

interface TokenBucket {
  tokens: number
  capacity: number
  refillPerMs: number
  lastRefill: number
}

function makeBucket(capacity: number, refillPerSec: number, now: number): TokenBucket {
  return {
    tokens: capacity,
    capacity,
    refillPerMs: refillPerSec / 1000,
    lastRefill: now,
  }
}

function refill(b: TokenBucket, now: number): void {
  const dt = now - b.lastRefill
  if (dt <= 0) return
  b.tokens = Math.min(b.capacity, b.tokens + dt * b.refillPerMs)
  b.lastRefill = now
}

// ms to wait before consuming one token; 0 means available now.
function waitMs(b: TokenBucket, now: number): number {
  refill(b, now)
  if (b.tokens >= 1) return 0
  return Math.ceil((1 - b.tokens) / b.refillPerMs)
}

function consume(b: TokenBucket): void {
  b.tokens -= 1
}

// Sliding-window length for the per-chat minute budget.
const WINDOW_MS = 60_000

// Drop timestamps that have fallen out of the trailing 60s window.
function pruneWindow(times: number[], now: number): void {
  const cutoff = now - WINDOW_MS
  let drop = 0
  while (drop < times.length && (times[drop] as number) <= cutoff) drop += 1
  if (drop > 0) times.splice(0, drop)
}

// ms to wait until the window has room for one more call; 0 means now.
function windowWaitMs(times: number[], limit: number, now: number): number {
  if (limit <= 0) return 0
  pruneWindow(times, now)
  if (times.length < limit) return 0
  // The call that must age out is the one `limit` places from the end.
  const oldestBlocking = times[times.length - limit] as number
  return Math.max(1, oldestBlocking + WINDOW_MS - now)
}

interface ChatState {
  bucket: TokenBucket
  // Timestamps of every bucket-consuming call to this chat in the last 60s
  // (sends AND edits), plus the edits-only subset. The token bucket paces
  // per-SECOND; Telegram bans per-MINUTE, and its practical per-chat ceiling
  // (~20/min) sits far below the bucket's 60/min. Two channels were flood-
  // banned for hours in 2026-08/09 while every bucket check passed.
  windowTimes: number[]
  editWindowTimes: number[]
  // Typing pulses live in their OWN window and touch neither of the above:
  // sendChatAction is not a message and does not count toward Telegram's
  // per-chat message flood limit. Sharing the budget killed the indicator
  // exactly while a turn ran (see sendChatAction).
  typingWindowTimes: number[]
  // FIFO tail for status-bubble edits. Deliberately SEPARATE from `tail`:
  // an edit parked on the minute budget must never delay a real reply.
  editTail: Promise<void>
  // FIFO tail: every enqueued op awaits this before checking the bucket.
  // Replaced with a fresh deferred at each enqueue. Errors do NOT propagate
  // (we use `.catch(() => {})` on the await) so one failed send cannot
  // permanently break the chain for a chat.
  //
  // HEAD-OF-LINE BLOCKING: a slow op (e.g. a 429 retry holding the lock)
  // delays all subsequent sends to the SAME chat. That's intentional —
  // ordering matters more than throughput for a conversational channel.
  // Different chats run in parallel (separate ChatState entries) so a stuck
  // chat does not affect others. Worst-case per-chat stall is bounded by
  // `maxRetries * MAX_RETRY_AFTER_S`.
  tail: Promise<void>
}

export interface RateLimitOptions {
  perChatRefillPerSec?: number
  perChatBurstCapacity?: number
  globalRefillPerSec?: number
  globalBurstCapacity?: number
  maxRetries?: number
  jitterMaxMs?: number
  /**
   * retry_after (seconds) above which a 429 is treated as a real flood-ban and
   * surfaced IMMEDIATELY instead of slept-through-and-retried. Prevents the
   * turn from freezing for up to maxRetries × MAX_RETRY_AFTER_S (was 3 min,
   * which hung the agent). Brief burst-429s at or below it are still retried
   * transparently. Default 3.
   */
  failFastRetryAfterS?: number
  /**
   * Size (bytes) at or above which an attachment counts as a "heavy" upload
   * and is paced. Default 5 MB — above a contact sheet or a screenshot,
   * below any real video block.
   */
  heavyUploadMinBytes?: number
  /**
   * Minimum gap between two heavy uploads to the SAME chat. A heavy upload
   * arriving sooner WAITS this out and then sends itself; it is never
   * dropped. Default 90s. Set to 0 to disable pacing entirely.
   */
  heavyUploadMinIntervalMs?: number
  /**
   * Hard per-chat ceiling over a sliding 60s window, counting every
   * bucket-consuming call (sends, rich sends, edits, uploads). Telegram's
   * practical per-chat limit is ~20/min — far below what the 1/sec token
   * bucket allows (60/min). Default 18. Set to 0 to disable.
   */
  perChatMaxPerMinute?: number
  /**
   * Share of the minute budget editMessageText may consume. Default 0 =
   * disabled: coalescing already collapses ~60% of bubble frames and keeps at
   * most ONE edit per message pending, so a second ceiling on top of the
   * shared one only built minute-long queues (observed waits of 47s, after
   * which the bubble had already been deleted and the edit failed).
   */
  perChatEditsMaxPerMinute?: number
  /**
   * Ceiling for sendChatAction over a sliding 60s window, per chat. Typing
   * has its OWN budget: it is not a message, so it must never be starved by
   * the message/edit allowance (a status bubble alone fills that). Default 20
   * — the pulse cadence is one per 4s (15/min), so this only caps a runaway
   * caller. Set to 0 to disable.
   */
  perChatTypingMaxPerMinute?: number
  /**
   * JSONL file recording every outbound call (method, chat, wait, verdict,
   * retry_after). The structured logger writes to stderr, which on these
   * channels lands in a tmux pane and is lost — so every past flood-ban
   * post-mortem was guesswork. Unset = disabled (tests, embedders).
   */
  sendLogPath?: string
  /** Test seam: replace Date.now() for deterministic virtual time. */
  now?: () => number
  /** Test seam: replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
}

interface Grammy429 {
  error_code: 429
  parameters?: { retry_after?: number }
}

// Cap retry_after so one giant value from Telegram (or a hostile-shaped
// error) can't lock a chat's FIFO queue for minutes on end. The per-chat
// tail-promise chain blocks all subsequent sends to the same chat until the
// in-flight op finishes, so worst-case stall = maxRetries × MAX_RETRY_AFTER_S.
// With defaults (3 × 60s) that's a 3-minute ceiling; if Telegram really
// needs longer, the bounded retries exhaust and the caller sees the 429.
const MAX_RETRY_AFTER_S = 60

export function parse429(err: unknown): { retryAfter: number } | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Grammy429
  if (e.error_code !== 429) return null
  const after = e.parameters?.retry_after
  // Telegram's retry_after is in seconds. Coerce to a sane positive integer
  // and clamp into [1, MAX_RETRY_AFTER_S].
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 1) {
    return { retryAfter: 1 }
  }
  return { retryAfter: Math.min(MAX_RETRY_AFTER_S, Math.ceil(after)) }
}

// Unclamped retry_after as Telegram sent it — for the send log only, where a
// 5-hour ban and a 60-second one must not look identical.
function rawRetryAfter(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const after = (err as Grammy429).parameters?.retry_after
  return typeof after === 'number' && Number.isFinite(after) ? after : undefined
}

export function createRateLimitedTelegramApi(
  raw: TelegramApi,
  log: Logger,
  opts: RateLimitOptions = {},
): TelegramApi {
  const cfg = {
    perChatRefillPerSec: opts.perChatRefillPerSec ?? 1,
    perChatBurstCapacity: opts.perChatBurstCapacity ?? 3,
    globalRefillPerSec: opts.globalRefillPerSec ?? 25,
    globalBurstCapacity: opts.globalBurstCapacity ?? 25,
    maxRetries: opts.maxRetries ?? 3,
    jitterMaxMs: opts.jitterMaxMs ?? 150,
    failFastRetryAfterS: opts.failFastRetryAfterS ?? 3,
    heavyUploadMinBytes: opts.heavyUploadMinBytes ?? 5 * 1024 * 1024,
    heavyUploadMinIntervalMs: opts.heavyUploadMinIntervalMs ?? 90 * 1000,
    perChatMaxPerMinute: opts.perChatMaxPerMinute ?? 18,
    perChatEditsMaxPerMinute: opts.perChatEditsMaxPerMinute ?? 0,
    perChatTypingMaxPerMinute: opts.perChatTypingMaxPerMinute ?? 20,
    sendLogPath: opts.sendLogPath,
  }
  const now = opts.now ?? ((): number => Date.now())
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

  // One JSON line per outbound call. Append-only, best-effort: a logging
  // failure must never break delivery, so every error is swallowed. Written
  // synchronously — the volume is tens of lines a minute, and a crash must
  // not lose the lines that explain it.
  function sendLog(entry: Record<string, unknown>): void {
    if (cfg.sendLogPath === undefined) return
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
      appendFileSync(cfg.sendLogPath, `${redactToken(line)}\n`)
    } catch {
      // Disk full, bad path, unserializable ctx — never surface to the caller.
    }
  }

  const globalBucket = makeBucket(cfg.globalBurstCapacity, cfg.globalRefillPerSec, now())
  const chatState = new Map<string, ChatState>()

  function getChatState(chatId: string): ChatState {
    let s = chatState.get(chatId)
    if (!s) {
      s = {
        bucket: makeBucket(cfg.perChatBurstCapacity, cfg.perChatRefillPerSec, now()),
        tail: Promise.resolve(),
        windowTimes: [],
        editWindowTimes: [],
        typingWindowTimes: [],
        editTail: Promise.resolve(),
      }
      chatState.set(chatId, s)
    }
    return s
  }

  // Wait until the per-chat bucket, the global bucket AND the per-chat
  // minute window all have room, then consume from each. Caller is
  // responsible for holding a FIFO lock so two enqueues for the same chat
  // can't race this check. Returns how long it waited (for the send log).
  // Typing pulses are metered SEPARATELY from everything else: their own
  // sliding minute window, no token bucket, no message window. Rationale:
  // sendChatAction is not a message, so Telegram's per-chat message flood
  // limit does not count it — and charging it to the message budget meant the
  // status bubble (a frame every ~2.5s) filled that budget and the "typing"
  // indicator died exactly during a turn, the only time it means anything
  // (2026-09-05: 5246 pulses dropped vs 202 sent on example-agent).
  // Non-blocking by design: a pulse that arrives late says nothing, so it is
  // dropped rather than queued.
  function tryConsumeTypingQuota(state: ChatState): boolean {
    const t = now()
    if (windowWaitMs(state.typingWindowTimes, cfg.perChatTypingMaxPerMinute, t) > 0) return false
    state.typingWindowTimes.push(t)
    return true
  }

  // Give back a slot taken by waitForCapacity when the call it was taken for
  // never happened (the message was deleted while the edit waited).
  function refundCapacity(state: ChatState, kind: 'send' | 'edit'): void {
    state.bucket.tokens = Math.min(state.bucket.capacity, state.bucket.tokens + 1)
    globalBucket.tokens = Math.min(globalBucket.capacity, globalBucket.tokens + 1)
    state.windowTimes.pop()
    if (kind === 'edit' && cfg.perChatEditsMaxPerMinute > 0) state.editWindowTimes.pop()
  }

  async function waitForCapacity(state: ChatState, kind: 'send' | 'edit'): Promise<number> {
    const startedAt = now()
    // Loop because after waking from sleep, another global consumer may
    // have stolen the token we expected. Recompute and re-sleep if so.
    // In single-threaded JS this is rare but the loop keeps invariants
    // robust against future async interleaving.
    for (;;) {
      const t = now()
      const chatWait = waitMs(state.bucket, t)
      const globalWait = waitMs(globalBucket, t)
      const minuteWait = windowWaitMs(state.windowTimes, cfg.perChatMaxPerMinute, t)
      const editWait =
        kind === 'edit'
          ? windowWaitMs(state.editWindowTimes, cfg.perChatEditsMaxPerMinute, t)
          : 0
      const w = Math.max(chatWait, globalWait, minuteWait, editWait)
      if (w === 0) {
        consume(state.bucket)
        consume(globalBucket)
        state.windowTimes.push(t)
        // Only track edit timestamps when the edits-only cap is on; with the
        // default (off) nothing ever prunes this array.
        if (kind === 'edit' && cfg.perChatEditsMaxPerMinute > 0) {
          state.editWindowTimes.push(t)
        }
        return t - startedAt
      }
      await sleep(w)
    }
  }

  // `maxRetries` is the MAX NUMBER OF ATTEMPTS including the initial call.
  // Semantically: budget of how many times we hit Telegram for this op.
  // maxRetries=3 → up to 3 attempts (2 retries after the first failure).
  // `minRetryWaitMs` floors the backoff between attempts. Ordinary sends pass
  // 0 and obey Telegram's retry_after exactly; a heavy upload passes its
  // pacing window, because re-streaming megabytes on a 1s retry_after is the
  // worst possible answer to "too many requests".
  async function withRetry<T>(
    method: string,
    op: () => Promise<T>,
    minRetryWaitMs = 0,
    chatId?: string,
    waitedMs = 0,
  ): Promise<T> {
    let attempt = 0
    let lastErr: unknown
    while (true) {
      attempt += 1
      try {
        const out = await op()
        sendLog({
          method,
          chat_id: chatId,
          result: 'ok',
          attempt,
          wait_ms: waitedMs,
        })
        return out
      } catch (err) {
        const r = parse429(err)
        if (r === null) {
          sendLog({
            method,
            chat_id: chatId,
            result: 'error',
            attempt,
            wait_ms: waitedMs,
            error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
          })
          throw err
        }
        lastErr = err
        sendLog({
          method,
          chat_id: chatId,
          result: r.retryAfter > cfg.failFastRetryAfterS ? 'flood_ban' : 'retry',
          attempt,
          wait_ms: waitedMs,
          // The RAW value Telegram sent, not the clamped one — a 5h ban and a
          // 60s one must be distinguishable in the post-mortem.
          retry_after: rawRetryAfter(err) ?? r.retryAfter,
        })
        // Real flood-ban (long cooldown): do NOT sleep+retry for minutes and
        // freeze the turn. Surface the 429 now so the caller tells the agent
        // "not delivered, end your turn". Only brief burst-429s are retried.
        if (r.retryAfter > cfg.failFastRetryAfterS) throw err
        if (attempt >= cfg.maxRetries) break
        const jitter =
          cfg.jitterMaxMs > 0 ? Math.floor(Math.random() * cfg.jitterMaxMs) : 0
        const waitTotalMs = Math.max(r.retryAfter * 1000, minRetryWaitMs) + jitter
        log.warn('telegram 429, backing off', {
          method,
          retry_after_s: r.retryAfter,
          attempt,
          wait_ms: waitTotalMs,
        })
        await sleep(waitTotalMs)
      }
    }
    throw lastErr
  }

  // Serialize per-chat outbound work: each new op awaits the previous op
  // (without inheriting its error), then runs under the rate-limit gate.
  async function enqueueSend<T>(
    chatId: string,
    op: () => Promise<T>,
    label = 'send',
    minRetryWaitMs = 0,
  ): Promise<T> {
    const state = getChatState(chatId)
    const prev = state.tail
    let release!: () => void
    state.tail = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev.catch(() => {})
      const waited = await waitForCapacity(state, 'send')
      return await withRetry(label, op, minRetryWaitMs, chatId, waited)
    } finally {
      release()
    }
  }

  // Pending (not yet sent) status-bubble edit per chat+message. A second edit
  // arriving while the first still waits for budget REPLACES its text instead
  // of queueing: an intermediate progress frame that has not shipped yet has
  // no value, and shipping it would spend a slot the newest frame needs.
  interface PendingEdit {
    text: string
    editOpts: EditOpts
    waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>
  }
  const pendingEdits = new Map<string, PendingEdit>()

  // Messages this process has deleted. An edit for a deleted message can only
  // come back as "message to edit not found" (15 such errors in one night once
  // the bubble's delete started overtaking its queued edits), so it is dropped
  // instead of spending a slot on a call Telegram will reject. Bounded FIFO —
  // the bubble is deleted about once per turn, so this never grows large.
  const DELETED_IDS_MAX = 500
  const deletedMessages = new Set<string>()

  // Key for both `pendingEdits` and `deletedMessages`. NUL separator so a chat
  // id containing the separator can't collide with another chat's message.
  function editKey(chatId: string, messageId: number): string {
    return `${chatId}\0${messageId}`
  }

  function markDeleted(key: string): void {
    deletedMessages.add(key)
    if (deletedMessages.size > DELETED_IDS_MAX) {
      const oldest = deletedMessages.values().next().value
      if (oldest !== undefined) deletedMessages.delete(oldest)
    }
  }

  // Edits run on their own per-chat FIFO (`state.editTail`): a status bubble
  // refreshing every 2.5s produces 24 edits/min on its own, and on the shared
  // `tail` a parked edit would hold every reply behind it. They share the
  // chat's minute budget; the separate edits-only cap is off by default
  // (`perChatEditsMaxPerMinute`) because coalescing already does that job.
  async function enqueueEdit(
    chatId: string,
    messageId: number,
    text: string,
    editOpts: EditOpts,
  ): Promise<void> {
    const key = editKey(chatId, messageId)
    if (deletedMessages.has(key)) {
      sendLog({ method: 'editMessageText', chat_id: chatId, result: 'dropped-deleted' })
      return
    }
    const existing = pendingEdits.get(key)
    if (existing !== undefined) {
      existing.text = text
      existing.editOpts = editOpts
      sendLog({ method: 'editMessageText', chat_id: chatId, result: 'coalesced' })
      return new Promise<void>((resolve, reject) => {
        existing.waiters.push({ resolve, reject })
      })
    }

    const pending: PendingEdit = { text, editOpts, waiters: [] }
    pendingEdits.set(key, pending)

    const state = getChatState(chatId)
    const prev = state.editTail
    let release!: () => void
    state.editTail = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev.catch(() => {})
      const waited = await waitForCapacity(state, 'edit')
      // Stop coalescing into this entry: from here the text is committed and
      // a newer edit must start its own wait rather than mutate one in flight.
      pendingEdits.delete(key)
      // The bubble may have been deleted while this edit waited for budget —
      // the delete does not queue behind edits, so it overtakes them.
      if (deletedMessages.has(key)) {
        // Hand the slot back — the reply that follows the teardown must not
        // pay for a call that never left the process.
        refundCapacity(state, 'edit')
        sendLog({
          method: 'editMessageText',
          chat_id: chatId,
          result: 'dropped-deleted',
          wait_ms: waited,
        })
        for (const w of pending.waiters) w.resolve()
        return
      }
      try {
        await withRetry(
          'editMessageText',
          () => raw.editMessageText(chatId, messageId, pending.text, pending.editOpts),
          0,
          chatId,
          waited,
        )
        for (const w of pending.waiters) w.resolve()
      } catch (err) {
        // Coalesced callers get the SAME verdict as the one that carried the
        // call — reporting success for a send that never happened is worse
        // than a rejection the caller already knows how to handle.
        for (const w of pending.waiters) w.reject(err)
        throw err
      }
    } finally {
      // Only clear OUR entry: a 429 retry can sleep long enough for a newer
      // edit to register its own pending entry, and dropping that one would
      // silently disable coalescing exactly when the chat is busiest.
      if (pendingEdits.get(key) === pending) pendingEdits.delete(key)
      release()
    }
  }

  // Last heavy-upload ATTEMPT per chat, and the FIFO tail that serializes
  // heavy-upload pacing. This chain is deliberately separate from
  // ChatState.tail, and only heavy files ever join it: a paced upload holds
  // only THIS lock while it waits, so text, edits and small attachments to
  // the same chat keep flowing past it.
  // One entry per chat, never pruned — bounded by the allowlist in practice,
  // same as `chatState` above.
  const lastHeavyUploadAt = new Map<string, number>()
  const uploadTail = new Map<string, Promise<void>>()

  // null when the file can't be stat'ed — an unreadable path is left to the
  // real API, which reports it far better than a guess here would.
  function fileSizeBytes(filePath: string): number | null {
    try {
      return statSync(filePath).size
    } catch {
      return null
    }
  }

  async function enqueueUpload(
    chatId: string,
    filePath: string,
    label: string,
    op: () => Promise<SendFileResult>,
  ): Promise<SendFileResult> {
    const size = fileSizeBytes(filePath)
    const isHeavy =
      cfg.heavyUploadMinIntervalMs > 0 &&
      size !== null &&
      size >= cfg.heavyUploadMinBytes

    // Size FIRST, queue second. A light file must never join the upload
    // chain: the contact sheet that explains a render would otherwise
    // inherit the video's 90s wait, and the agent goes silent exactly when
    // it has something to show.
    if (!isHeavy) return enqueueSend(chatId, op, label)

    const prev = uploadTail.get(chatId) ?? Promise.resolve()
    let release!: () => void
    uploadTail.set(
      chatId,
      new Promise<void>((r) => {
        release = r
      }),
    )
    try {
      await prev.catch(() => {})

      // Loop rather than sleep once: the clock can be virtual (tests) and a
      // single wake is not proof the window actually elapsed.
      for (;;) {
        const last = lastHeavyUploadAt.get(chatId)
        if (last === undefined) break
        const remainingMs = cfg.heavyUploadMinIntervalMs - (now() - last)
        if (remainingMs <= 0) break
        log.info('pacing heavy upload', {
          chat_id: chatId,
          method: label,
          size_bytes: size,
          wait_ms: remainingMs,
        })
        await sleep(remainingMs)
      }

      try {
        // A 429 here means Telegram answered AFTER the whole multipart body
        // went up the wire — the megabytes are spent whatever verb comes
        // back. Retry no sooner than a full window: obeying a 1s retry_after
        // literally would re-stream the video three times in ten seconds,
        // into the very ban it is reporting.
        return await enqueueSend(chatId, op, label, cfg.heavyUploadMinIntervalMs)
      } finally {
        // Stamp on ANY completed attempt, not just success. Over-stamping
        // costs one extra window; under-stamping costs the 1.5h ban this
        // whole gate exists to prevent.
        lastHeavyUploadAt.set(chatId, now())
      }
    } finally {
      release()
    }
  }

  return {
    async sendMessage(
      chatId: string,
      text: string,
      sendOpts: SendMessageOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, () => raw.sendMessage(chatId, text, sendOpts), 'sendMessage')
    },

    async sendRichMessage(
      chatId: string,
      rawMarkdown: string,
      richOpts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      // Route through the SAME per-chat FIFO + token-bucket path as
      // sendMessage: a rich message counts toward the identical per-chat
      // flood limit, and same-chat ordering must be preserved.
      return enqueueSend(
        chatId,
        () => raw.sendRichMessage(chatId, rawMarkdown, richOpts),
        'sendRichMessage',
      )
    },

    async editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      editOpts: EditOpts,
    ): Promise<void> {
      // Edits count toward the same per-chat flood limit as fresh sends, but
      // run on their own FIFO with their own sub-budget and coalescing —
      // see enqueueEdit. A status bubble must never park a reply behind it.
      return enqueueEdit(chatId, messageId, text, editOpts)
    },

    async setMessageReaction(
      chatId: string,
      messageId: number,
      emoji: string,
    ): Promise<void> {
      return withRetry(
        'setMessageReaction',
        () => raw.setMessageReaction(chatId, messageId, emoji),
        0,
        chatId,
      )
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      // Typing pulses are the highest-volume call the channel makes (1202 in a
      // single night), so they are metered — but against their OWN minute
      // quota, never the message budget (see tryConsumeTypingQuota). A pulse
      // that arrives a second late says nothing: drop it, never queue it.
      if (!tryConsumeTypingQuota(getChatState(chatId))) {
        sendLog({ method: 'sendChatAction', chat_id: chatId, result: 'dropped-no-budget' })
        return
      }
      return withRetry('sendChatAction', () => raw.sendChatAction(chatId, action), 0, chatId)
    },

    async sendDocument(
      chatId: string,
      filePath: string,
      docOpts: SendDocumentOpts,
    ): Promise<SendFileResult> {
      return enqueueUpload(chatId, filePath, 'sendDocument', () =>
        raw.sendDocument(chatId, filePath, docOpts),
      )
    },

    async sendPhoto(
      chatId: string,
      filePath: string,
      photoOpts: SendDocumentOpts,
    ): Promise<SendFileResult> {
      return enqueueUpload(chatId, filePath, 'sendPhoto', () =>
        raw.sendPhoto(chatId, filePath, photoOpts),
      )
    },

    async downloadFile(fileId: string, destDir: string): Promise<DownloadResult> {
      return raw.downloadFile(fileId, destDir)
    },

    async deleteMessage(chatId: string, messageId: number): Promise<void> {
      // Mark BEFORE the call: an edit already waiting for budget must be
      // dropped even while the delete itself is still in flight. Deletes do not
      // queue behind edits — a bubble teardown must never wait on a frame.
      const key = editKey(chatId, messageId)
      markDeleted(key)
      try {
        return await withRetry('deleteMessage', () => raw.deleteMessage(chatId, messageId), 0, chatId)
      } catch (err) {
        // The delete failed, so the message is still in the chat and must stay
        // editable — otherwise every later frame is dropped and it freezes.
        deletedMessages.delete(key)
        throw err
      }
    },

    async answerGuestQuery(
      guestQueryId: string,
      text: string,
      guestOpts: AnswerGuestQueryOpts,
    ): Promise<void> {
      // No per-chat FIFO: guest queries have no allowlisted chat id and are
      // one-shot by contract — there is never a second send to order after.
      // The 429-retry wrapper still applies (a retry of a FAILED call does
      // not double-answer; Telegram only consumes the query on success).
      return withRetry('answerGuestQuery', () =>
        raw.answerGuestQuery(guestQueryId, text, guestOpts),
      )
    },
  }
}
