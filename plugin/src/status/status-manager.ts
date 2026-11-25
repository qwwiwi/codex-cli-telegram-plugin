// StatusManager — owns the transient "Печатает.../Думает.../🔧 tool" message
// the bot edits while Claude works on a reply. Mirrors gateway.py:2895-2930
// behaviour: lazy status message, periodic edit while task is in flight, delete
// (or finalize) before the real answer ships.
//
// Design notes:
//   * One active StatusHandle per chatId. Calling start() while another is
//     active silently cancels the previous one (no edit to "canceled" label —
//     the new status starts immediately and is what the user sees).
//   * Timers are injected via setTimer/clearTimer so tests can drive the
//     ticker with fake clocks. We never call global setInterval directly.
//   * Telegram edit failures are SWALLOWED (logged at warn). A flaky edit
//     must never propagate to a 500 in the tool layer — the real reply path
//     is the source of truth.
//   * TTL guard auto-cancels after `config.status.ttl_ms` so a stuck status
//     (e.g. Claude crashed without firing complete()) doesn't haunt the chat
//     forever.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { ChatAction, TelegramApi } from '../channel/tools.js'
import {
  shouldStreamForChat,
  type MultichatPolicy,
} from '../chats/policy-loader.js'
import { escapeHtml } from '../format/html.js'
import type { ActivityStatusEvent } from '../hooks/claude-events.js'
import { readLatestThought } from '../memory/transcript-reader.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'
import type { OrphanStore } from './orphan-store.js'

// Re-export so callers wiring the manager import the store contract from one place.
export type { OrphanStore } from './orphan-store.js'
import {
  buildActivityDetail,
  buildHumanizedActivityLine,
  maskSecrets,
  renderActivityBlock,
  type ActivityCall,
  type ActivitySnapshot,
} from './activity-renderer.js'

/**
 * @deprecated Use {@link shouldStreamForChat} from `chats/policy-loader`
 *   directly. This symbol stays exported for backward compatibility
 *   ONLY — any caller still wired to it would otherwise re-introduce
 *   the fail-OPEN regression CRITICAL #1 / HIGH #9 (codex review
 *   2026-05-27) eliminated: pre-fix this function returned `true` for
 *   chats absent from `policy.chats`, leaking owner streaming into
 *   misconfigured public groups. Re-implemented as a thin shim around
 *   the fail-CLOSED primitive so legacy imports get the correct
 *   semantics automatically (FIX-C bug #4, codex status #4).
 *
 * Signature delta vs. the new primitive: this helper accepts
 * `policy?: MultichatPolicy` (optional) for source-compat with the old
 * call sites. An omitted policy is forwarded as `null`, preserving the
 * "legacy single-DM mode" branch in `shouldStreamForChat`.
 */
export function shouldStream(
  chatId: string,
  policy?: MultichatPolicy,
): boolean {
  return shouldStreamForChat(policy ?? null, chatId)
}

// Telegram's `sendChatAction` indicator expires after 5 s; re-pulse on a 4 s
// timer to keep the header animation continuous without spamming the API.
const CHAT_ACTION_PULSE_MS = 4000

// Fallback liveness-probe defaults. Mirror the zod defaults in
// config.ts `status.heartbeat`; used when that optional block is absent
// from a parsed/hand-built config (legacy configs / tests).
const HEARTBEAT_DEFAULT_PROBE_MS = 30_000
// Deterministic idle-teardown defaults. Mirror the zod defaults in
// config.ts `status.heartbeat`; used when that optional block is absent.
const IDLE_DEFAULT_PROBE_MS = 3000
const IDLE_DEFAULT_CONFIRM = 2
const IDLE_DEFAULT_STARTUP_GRACE_MS = 8000
// Never-active backstop (2026-06-10). A bubble whose turn was NEVER once seen
// 'active' is a phantom over a wedged/never-started turn; tear it down after
// this deadline even if flaky 'unknown' capture keeps defeating the fast idle
// debounce. Mirrors the zod default in config.ts.
const NEVER_ACTIVE_DEFAULT_DEADLINE_MS = 45_000
// Background-subagent continuation window (2026-06-30). The paneStateProbe is an
// unreliable "turn alive" signal while background Task(Agent) subagents run:
// between result injections the main claude loop is blocked on the child and the
// TUI drops the "esc to interrupt" footer, so the pane reads 'idle' mid-turn. A
// Stop / idle-confirm / backstop landing in that gap used to tear the bubble down,
// and the next injection's opener respawned a fresh one — a new bubble every ~12s.
// While within this window of the last Agent tool event we treat the turn as a
// continuation regardless of pane (swallow Stops, refuse idleTick teardown). It
// must comfortably bridge the inter-injection gap; the trade-off is a bubble that
// lingers at most this long after a turn whose final action was a subagent.
const SUBAGENT_CONTINUATION_WINDOW_MS = 30_000

// Background-subagent IN-FLIGHT tracking (2026-07-01, the real spam root). The
// 30s window above only refreshes on Agent EVENTS, but a slow research subagent
// runs for MINUTES with NO events between its dispatch and its result injection.
// During that silent gap the window lapses AND the pane reads 'idle' (main loop
// blocked on the child), so idleTick tears the bubble down — and the next
// injection respawns it. Proven live: bubbles 2857→2858→2859 churned through a
// sleep 70/100/130 storm. Fix: count subagents actually in flight (dispatched
// via an Agent tool_start, not yet injected back) and keep the bubble alive the
// WHOLE time, independent of event gaps and pane. A dispatch timestamp older
// than this cap is treated as a dead/abandoned subagent so a lost injection
// can't pin the bubble forever (safety valve; real subagents finish well under —
// observed dispatch→inject gaps stay ≤180s). Kept BELOW the bubble TTL
// (status.ttl_ms, 300s) on purpose: the idleTick reaper then fires first and
// gives a clean teardown, instead of the TTL turning the bubble into a
// "Остановлено: ttl" cancel when the liveness probe is not wired.
const MAX_SUBAGENT_INFLIGHT_MS = 270_000

// All active StatusStates map to a single `typing` action. Tool-specific
// actions (`upload_document`, etc.) are not used today because Telegram's
// header animation is the same for `typing` and we want to keep the contract
// simple. Extend here if a per-tool icon becomes worth the noise.
function chatActionFor(state: StatusState): ChatAction | null {
  switch (state.kind) {
    case 'typing':
    case 'thinking':
    case 'tool':
    case 'activity':
      return 'typing'
    case 'stopped':
    case 'error':
      return null
  }
}

export type StatusState =
  | { kind: 'typing' }
  | { kind: 'thinking' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'activity'; snapshot: ActivitySnapshot }
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; reason?: string }

// Cap on the in-memory tool-call buffer per active chat. Keep earlier calls
// available for updates while the renderer shows the three most recent.
const ACTIVITY_MAX_BUFFER = 10

// Throttle non-Agent tool edits to once per this many ms. Agent dispatches
// always edit immediately. Mirrors gateway.py:1738 `_last_tool_render` + 5 s
// throttle in `_TaskBoundaryTracker`.
const ACTIVITY_EDIT_THROTTLE_MS = 5000

// Streaming thoughts (#1) defaults — mirror the Zod defaults in config.ts so
// a config built by hand (tests, legacy) without the optional `thoughts` block
// still behaves sensibly.
const THOUGHT_DEFAULT_MAX_CHARS = 280
const THOUGHT_DEFAULT_MAX_LINES = 3
const THOUGHT_DEFAULT_READ_THROTTLE_MS = 2000

// Per-chat 403/forbidden cache. After Telegram returns 401/403 on a
// chat surface (bot kicked, chat 403, user blocked), subsequent
// start() calls within this TTL must short-circuit BEFORE sending —
// otherwise every inbound update pays a fresh sendMessage 403 round-
// trip (MED-A #1). After the TTL elapses we allow one probe in case
// the bot was re-added.
const BLOCKED_CHAT_TTL_MS = 5 * 60 * 1000 // 5 minutes
// Prune the entire blockedChats map of entries older than this so a
// long-running plugin doesn't leak unbounded chatId state. Pruned
// entries are simply re-probed on the next start() — same as if the
// entry had been removed by `firstSeen` ageing out below.
const BLOCKED_CHAT_PRUNE_MS = 60 * 60 * 1000 // 1 hour

// Self-heal grace for the per-chat "turn closed" gate. complete() stamps
// the close time; trailing hooks within this window stay gated (kills the
// post-answer "working" leak — symptom A), but genuine activity AFTER it
// re-opens the bubble (safety net for a mid-turn complete() that would
// otherwise blank the indicator for the rest of a long task — symptom B).
// Short enough that real continued work re-surfaces within seconds; long
// enough to swallow the burst of trailing hooks a single Stop/reply emits.
const CLOSE_GRACE_MS = 4000
// Per-chat compaction guard. A PreCompact hook arms it; any Stop that
// lands inside the window is a SERVICE stop (compaction emits one mid-turn)
// and must NOT tear the bubble down. Generous because auto-compaction of a
// large transcript can take a while before the turn resumes.
const COMPACTION_GUARD_MS = 60_000

export interface StatusHandle {
  readonly chatId: string
  // messageId is `0` while the bubble is suppressed (lazy-create
  // mode); it becomes the real Telegram message id only after
  // ensureBubble() runs. Callers MUST NOT key staleness checks on
  // this field — use `generation` instead (see below).
  readonly messageId: number
  readonly startedAt: number
  // Monotonic per-chat lifecycle token captured at start(). The
  // staleness check in update() compares `handle.generation ===
  // entry.generation` rather than messageId, so a caller that took
  // the handle BEFORE ensureBubble() flipped messageId from 0 to the
  // real id keeps writing successfully (FIX-C bug #2, codex status
  // #2). On complete()/cancel() the manager bumps entry.generation,
  // so any leftover handle from the previous lifecycle is rejected.
  readonly generation: number
}

// Telegram surface the manager actually touches. Pulled out of channel/tools
// TelegramApi so we can extend with deleteMessage without bloating that
// type's import graph elsewhere.
export interface TelegramApiForStatus {
  sendMessage: TelegramApi['sendMessage']
  editMessageText: TelegramApi['editMessageText']
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>
  // Native Telegram `typing` indicator in the chat header. Optional so unit
  // tests can stub a minimal surface. Action expires after 5 s on Telegram's
  // side, so the manager re-pulses on a 4 s timer while a status is active.
  sendChatAction?: TelegramApi['sendChatAction']
}

export interface StatusManagerDeps {
  telegramApi: TelegramApiForStatus
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
  // Multichat policy gate, evaluated per-chat at every public entry
  // point (start / update / cancel / complete / recordActivityByChatId).
  //
  // Semantics (delegated to {@link shouldStreamForChat}):
  //   * `null` / omitted — legacy single-DM mode. Every chat streams
  //     (preserves pre-multichat behaviour where only the owner's
  //     DM existed).
  //   * `MultichatPolicy` loaded — chat must be present with
  //     `streaming: 'progress'`. Missing entries OR `streaming: 'off'`
  //     turn every method into a no-op for that chat (fail-closed).
  //
  // The gate is consulted per call rather than memoised at construction
  // because StatusManager is a singleton across all chats — a
  // construction-time boolean (legacy `streamingEnabled` option) leaked
  // owner DM behaviour into public groups when the chosen anchor
  // chat had `streaming: 'progress'` (codex review 2026-05-27,
  // CRITICAL #1 / HIGH #9).
  policy?: MultichatPolicy | null
  // Dynamic hook routing (2026-06-04). Invoked at the top of every
  // start() with the chatId of the turn now being served. The wiring in
  // server.ts persists it to `statePaths.activeHookChat`, which the
  // post-hook proxy reads so Claude Code hook activity (working / typing /
  // tool blocks) follows whoever sent the message instead of a static
  // TELEGRAM_HOOK_CHAT_ID. Optional — when omitted (tests / legacy
  // wiring) routing falls back to the env chatId, preserving old
  // behaviour. Failures inside the callback must never break a turn:
  // the writer in server.ts swallows its own errors.
  recordActiveChat?: (chatId: string) => void
  // Crash/restart recovery for the transient status bubble (2026-06-07). When
  // present, the manager mirrors each live bubble's (chatId, messageId) so a
  // turn that never completes (TUI wedge → watchdog restart) doesn't leave a
  // frozen "working" message behind. Omitted in tests/legacy wiring → no-op.
  orphanStore?: OrphanStore
  // Liveness probe (2026-06-08). Returns true while the served turn is
  // provably alive (e.g. tmux pane hash changing / claude CPU above
  // cpu_min_pct). When wired AND status.heartbeat.enabled, the idle TTL
  // becomes liveness-aware (see armTtl/livenessTick). Omitted → legacy
  // time-only TTL, preserving existing behaviour. May also be attached
  // post-construction via setLivenessProbe (server.ts wires it after the
  // TmuxMirror instance exists).
  livenessProbe?: (chatId: string) => boolean
  // Pane-state probe (2026-06-08, deterministic idle-teardown). Reads the TUI
  // ground truth — 'active' while a turn runs ("esc to interrupt" present),
  // 'idle' once it is over, 'unknown' when the capture failed or a dialog is
  // up. When wired AND status.heartbeat.enabled, a fast idle ticker tears the
  // bubble down cleanly the instant the turn ends even if the Stop hook is
  // missed (see idleTick). Also consulted by livenessTick to suppress a false
  // "Возможно завис" while a Bash/build child keeps the turn active but
  // claude's CPU flat. Omitted → no idle-teardown, preserving prior behaviour.
  // May be attached post-construction via setPaneStateProbe.
  paneStateProbe?: (chatId: string) => 'active' | 'idle' | 'unknown'
}

// Internal mirror of StatusHandle without the `readonly` modifiers — we
// mutate messageId lazily when the bubble is created after a typing-only
// start. The public StatusHandle (returned to callers) stays readonly.
//
// `generation` lives on BOTH the entry (canonical) and the mirrored
// handle. The mirror stays in sync with `entry.generation` for as long
// as the entry is alive, so `updateByChatId` can pass `entry.handle`
// straight to `update(handle, …)` and the staleness check still
// passes. The public StatusHandle copy returned to callers takes its
// own snapshot of `entry.generation` at start(); after a lifecycle
// flip the public copy diverges and `update` rejects the stale handle.
interface MutableHandle {
  chatId: string
  messageId: number
  startedAt: number
  generation: number
}

interface InternalEntry {
  handle: MutableHandle
  state: StatusState
  // Cycle index used to advance the dot animation on each tick.
  tick: number
  lastText: string
  intervalHandle: NodeJS.Timeout | null
  ttlHandle: NodeJS.Timeout | null
  // Separate cadence from the message edit ticker — see CHAT_ACTION_PULSE_MS.
  chatActionHandle: NodeJS.Timeout | null
  // Original reply target captured from start(). Re-used when the bubble is
  // created lazily on the first non-typing transition so it threads under
  // the same inbound message the user originally sent.
  replyToMessageId: number | undefined
  // Forum-topic thread id captured from start(). Applied to the bubble's
  // sendMessage (both eager and lazy creation) so the "Печатает…/🔧 tool"
  // status lands in the same topic the inbound message came from, not General.
  threadId: number | undefined
  // True when sendMessage has not been called yet because state is still
  // typing and suppress_typing_bubble is on. Lazy-create path flips this on
  // first non-typing transition.
  bubbleSuppressed: boolean
  // Idempotency guard for ensureBubble — multiple concurrent non-typing
  // events used to each fire their own sendMessage, leaking message_ids.
  // The first caller sets this promise; subsequent callers await it and
  // return. Reset to `null` after success/failure so a failed creation
  // can retry on the next event.
  bubbleCreationPromise: Promise<void> | null
  // Set true by complete()/cancel() the moment they detach this entry, BEFORE
  // they await an in-flight bubbleCreationPromise (FIX-C). It tells a parked
  // createBubble "a teardown handler owns neutralizing my just-sent message —
  // commit the id so it can act with its own semantics (delete vs «Остановлено»
  // edit), but do NOT neutralize it yourself". A supersede (startInternal)
  // detaches WITHOUT setting this, so createBubble's detached-entry guard knows
  // to neutralize the orphaned send itself (frozen working bubble).
  teardownClaimed: boolean
  // Monotonic generation counter — incremented on every lifecycle
  // transition (start replaces an existing entry, complete, cancel).
  // Timer callbacks capture the generation at scheduling time; on fire
  // they check entry.generation against the captured value and drop the
  // edit when they mismatch. Without this, a tick scheduled against the
  // previous lifecycle would mutate the new entry mid-flight.
  generation: number
  // Rolling activity state — kept on the entry even while state.kind!=
  // 'activity' so a Stop after a non-tool reasoning phase still has the
  // recorded history. Last-tool-render timestamp throttles non-Agent edits.
  activityCalls: ActivityCall[]
  activityPhase: 'reasoning' | 'tool'
  activityStartedAt: number
  lastToolRenderAt: number
  // Map tool_use_id → call buffer index, so PostToolUse Agent can update
  // the recorded line with a short done summary.
  toolUseIndex: Map<string, number>
  // Edit-error classifier outputs map here:
  //   • disabled — set when a 401/403 from Telegram terminates the chat
  //     surface. editSafely / ensureBubble bail without an attempt. The
  //     entry stays in `entries` so isActive() stays truthful, but no
  //     Telegram I/O ever fires for this entry again.
  //   • messageGoneRecoveryDone — flip to true the first time we
  //     recreate the bubble after a "message to edit not found". A
  //     second occurrence simply drops the messageId without recreate,
  //     preventing a permanent recreate loop on a chat where Telegram
  //     keeps GC'ing the message.
  //   • parseDowngraded — flip to true after a parse-error retry. Next
  //     parse error in the same entry surfaces as a normal transient
  //     drop (we don't have a third downgrade path).
  disabled: boolean
  messageGoneRecoveryDone: boolean
  parseDowngraded: boolean
  // MED-A #4: 429 backoff. When Telegram's rate-limit wrapper exhausts
  // its retries and surfaces the `flood` classifier kind, we capture
  // `now + retryAfterSec*1000` here. Subsequent timer ticks (interval
  // + chat_action pulse + TTL) check `now() < pausedUntil` and bail
  // BEFORE issuing any Telegram I/O — without this the next tick
  // fired immediately and hit 429 again. `0` (or any past value)
  // means no active pause.
  pausedUntil: number
  // Heartbeat liveness probe (2026-06-08). Consecutive dead-probe count;
  // reset to 0 on every real activity event (armTtl) and on any live probe.
  missedLiveness: number
  // True once missedLiveness reached liveness_max_missed and the bubble was
  // flipped to "Возможно завис". While set, the animation tick and the
  // chat-action pulse stand down so they don't overwrite the warning; cleared
  // when a probe (or real activity) proves the turn is alive again.
  suspectedHung: boolean
  // Deterministic idle-teardown (2026-06-08). Separate fast ticker (idle_probe_ms,
  // ~3 s) from the liveness probe (30 s). Holds its own timer and a debounce
  // counter of consecutive 'idle' pane reads; at idle_confirm it tears the
  // bubble down via complete(). Cleared in stopTimers. Null when no
  // paneStateProbe is wired (idle-teardown disabled).
  idleHandle: NodeJS.Timeout | null
  idleConfirmations: number
  // Never-active backstop (2026-06-10). Latched true the first time the idle
  // probe reads the pane as 'active' (TUI showed "esc to interrupt"). A genuine
  // turn paints that hint within ~1 s, so any bubble still false past the
  // never-active deadline never hosted a real turn → torn down as a phantom.
  // A turn that reached a permission dialog was active first, so its flag is
  // already set and the backstop leaves it alone.
  everActive: boolean
  // Active-then-gone backstop (2026-06-21). Timestamp of the last idle-probe
  // read that saw the pane 'active'; initialised to creation time. The
  // after-active backstop tears the bubble down when the pane has not been
  // 'active' for never_active_deadline_ms AND a Stop was already seen (sawStop)
  // — i.e. the turn genuinely ended but a swallowed/lost Stop plus flaky
  // 'unknown' capture defeated the idle debounce. A live turn refreshes this on
  // every 'active' read (incl. long Bash/build children), so it is never caught.
  lastActiveAt: number
  // True once any session_stop (genuine OR swallowed service Stop) was seen for
  // this entry. Gates the after-active backstop so a turn merely PARKED on a
  // permission dialog — which emits no Stop and reads pane 'unknown' — keeps its
  // bubble, while a finished-but-swallowed turn is reclaimed.
  sawStop: boolean
  // Streaming thoughts (#1). `latestThought` is the last shaped narration
  // block we read from the transcript; rendered in the working bubble in place
  // of the static «reasoning...» line. `lastThoughtReadAt` throttles the
  // transcript tail-read to read_throttle_ms so a burst of hook events doesn't
  // re-open the file every time. Kept on the entry so the animation tick (which
  // does no I/O) re-renders the stored thought. Sentinel −∞ → first read fires.
  latestThought?: string
  lastThoughtReadAt: number
}

function renderState(state: StatusState, tick: number, nowMs: number): string {
  // Ellipsis animation for typing/thinking: 1→2→3 dots.
  const dotCount = (tick % 3) + 1
  const dots = '.'.repeat(dotCount)
  switch (state.kind) {
    case 'typing':
      return `<i>Печатает${dots}</i>`
    case 'thinking':
      return `<i>Думает${dots}</i>`
    case 'tool':
      return `<i>🔧 ${escapeHtml(state.toolName)}</i>`
    case 'activity':
      return renderActivityBlock(state.snapshot, nowMs)
    case 'stopped': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Остановлено${tail}</i>`
    }
    case 'error': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Ошибка${tail}</i>`
    }
  }
}

export class StatusManager {
  private readonly telegramApi: TelegramApiForStatus
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly entries: Map<string, InternalEntry>
  // Per-chat lifecycle FIFO. Every start/complete/cancel chains onto
  // the chat's tail-promise so two concurrent operations cannot race
  // on the entries map. We replace the tail with the new operation's
  // promise; errors are swallowed via `.catch(() => {})` on the await
  // so one failed op cannot permanently break the chain for a chat.
  //
  // Without this, two concurrent start() calls could each pass the
  // `entries.has(chatId)` check, both fire sendMessage, then race on
  // `entries.set(chatId, …)` — one Telegram message becomes orphaned
  // (no entry tracks it) and its timer-driven edits chase a stale
  // message_id (HIGH #3, codex review 2026-05-27).
  private readonly lifecycleLocks: Map<string, Promise<void>>
  // Per-chat 403 cache (MED-A #1). When Telegram returns forbidden
  // (401/403) on send / edit / chat_action, we record the chatId here
  // with a wall-clock timestamp. Subsequent start() calls within
  // BLOCKED_CHAT_TTL_MS short-circuit to a sentinel handle BEFORE the
  // sendMessage attempt — otherwise every inbound message on a
  // permanently-blocked chat (bot kicked, user blocked, chat 403)
  // paid a fresh 403 round-trip.
  //
  // After BLOCKED_CHAT_TTL_MS elapses we allow one probe — the bot
  // may have been re-added or the user unblocked. The cache is
  // periodically pruned via maybePruneBlockedChats() on entry-points
  // (cheap call site amortisation; no separate timer needed).
  private readonly blockedChats: Map<
    string,
    { firstSeen: number; lastSeen: number; reason: string }
  >
  private lastBlockedPruneAt: number
  // Per-chat "turn closed" gate (dup-working race fix, 2026-06-04;
  // time-bounded self-heal 2026-06-07).
  //
  // complete() (called by the reply tool AND by the Stop hook) stamps the
  // chatId here with the close timestamp. While a chat is "closed" (within
  // CLOSE_GRACE_MS of that stamp — see isClosed), the lazy-open path in
  // recordActivityByChatId refuses to resurrect a status bubble for
  // trailing tool hooks (PostToolUse of the reply tool itself, or any
  // post-answer reasoning that fires before Stop).
  //
  // Why this matters: lazy-open's startInternal `await sendMessage`s
  // BEFORE inserting the entry into `entries`. If the Stop hook's
  // complete() runs during that send window it reads an empty map,
  // no-ops, and the freshly-sent bubble lands untracked — lingering in
  // the chat forever as a duplicate "working — Ns / reasoning…". The
  // gate stops the reopen from ever happening, which removes the race.
  //
  // The grace is the SELF-HEAL safety net (NOT the primary mechanism — the
  // compaction guard below is what keeps the bubble alive across a service
  // Stop): if a single mid-turn complete() ever closes the chat during a
  // long task, genuine activity past the grace re-opens it instead of
  // leaving the indicator dark until the next user message.
  //
  // Cleared eagerly by a genuine new-turn opener (SessionStart /
  // UserPromptSubmit) in recordActivityByChatId AND by any successful
  // startInternal, so a live entry always implies "not closed".
  private readonly closedChats: Map<string, number>
  // Per-chat compaction guard (2026-06-07). A PreCompact hook stamps the
  // arm time here; any Stop inside COMPACTION_GUARD_MS is a service stop
  // and is swallowed without teardown so the bubble survives auto-compaction.
  private readonly compactionGuards: Map<string, number>
  // Multichat policy reference (or `null` for legacy single-DM mode).
  // Every public mutation re-evaluates `shouldStreamForChat(policy,
  // chatId)` against the TARGET chat — we never memoise the answer at
  // construction time, because the manager is shared across all chats.
  private readonly policy: MultichatPolicy | null
  // See StatusManagerDeps.recordActiveChat. Called at the top of start().
  private readonly recordActiveChat: ((chatId: string) => void) | undefined
  // See StatusManagerDeps.orphanStore. Mirrors the live bubble id for restart
  // recovery; undefined → no-op.
  private readonly orphanStore: OrphanStore | undefined
  // See StatusManagerDeps.livenessProbe. Mutable: server.ts attaches it after
  // construction via setLivenessProbe once the TmuxMirror exists.
  private livenessProbe: ((chatId: string) => boolean) | undefined
  // See StatusManagerDeps.paneStateProbe. Mutable: server.ts attaches it after
  // construction via setPaneStateProbe.
  private paneStateProbe: ((chatId: string) => 'active' | 'idle' | 'unknown') | undefined

  // Per-chat timestamp of the last background-subagent (Agent) tool event.
  // Drives the pane-independent continuation window — see
  // SUBAGENT_CONTINUATION_WINDOW_MS and withinSubagentWindow.
  private subagentActivityAt = new Map<string, number>()

  // Background subagents currently in flight, keyed by chat → (tool_use_id →
  // dispatch timestamp). An Agent tool_start adds its toolUseId; a
  // task-notification injection carrying that same tool-use-id removes it
  // (idempotent — a subagent may inject its notification MORE THAN ONCE, proven
  // live, so a plain counter would over-decrement). Entries older than
  // MAX_SUBAGENT_INFLIGHT_MS are reaped as dead. See subagentInFlight.
  private subagentDispatchAt = new Map<string, Map<string, number>>()

  constructor(deps: StatusManagerDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    // Bind to global timers as a default so production code doesn't need to
    // pass anything. Tests inject deterministic fake timers.
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.entries = new Map()
    this.lifecycleLocks = new Map()
    this.blockedChats = new Map()
    this.lastBlockedPruneAt = 0
    this.closedChats = new Map()
    this.compactionGuards = new Map()
    this.policy = deps.policy ?? null
    this.recordActiveChat = deps.recordActiveChat
    this.orphanStore = deps.orphanStore
    this.livenessProbe = deps.livenessProbe
    this.paneStateProbe = deps.paneStateProbe
  }

  // Attach (or replace) the liveness probe after construction. server.ts
  // wires this once the TmuxMirror instance exists, since the mirror is
  // created after the StatusManager. Safe to call at any time — only future
  // armTtl/livenessTick cycles consult it.
  setLivenessProbe(probe: (chatId: string) => boolean): void {
    this.livenessProbe = probe
  }

  // Attach (or replace) the pane-state probe after construction. Safe to call
  // at any time — only future idleTick/livenessTick cycles consult it.
  setPaneStateProbe(probe: (chatId: string) => 'active' | 'idle' | 'unknown'): void {
    this.paneStateProbe = probe
  }

  // Idle-teardown mode is active only when the feature is enabled AND a
  // pane-state probe is wired. Same default-ON semantics as livenessEnabled().
  private idleTeardownEnabled(): boolean {
    if (this.paneStateProbe === undefined) return false
    return this.config.status.heartbeat?.enabled ?? true
  }

  private idleProbeMs(): number {
    return this.config.status.heartbeat?.idle_probe_ms ?? IDLE_DEFAULT_PROBE_MS
  }

  private idleConfirm(): number {
    return this.config.status.heartbeat?.idle_confirm ?? IDLE_DEFAULT_CONFIRM
  }

  private startupGraceMs(): number {
    return this.config.status.heartbeat?.startup_grace_ms ?? IDLE_DEFAULT_STARTUP_GRACE_MS
  }

  private neverActiveDeadlineMs(): number {
    return this.config.status.heartbeat?.never_active_deadline_ms ?? NEVER_ACTIVE_DEFAULT_DEADLINE_MS
  }

  // Liveness mode is active only when the feature is enabled AND a probe is
  // wired. With the optional heartbeat block absent we treat it as ON
  // (default), so the only off-switches are an explicit `enabled: false` or
  // simply not wiring a probe (tests / legacy).
  private livenessEnabled(): boolean {
    if (this.livenessProbe === undefined) return false
    return this.config.status.heartbeat?.enabled ?? true
  }

  // Native «печатает…» header indicator. Default ON — the block is opt-OUT per
  // channel, so a channel that never heard of it keeps today's behaviour. Off
  // means the 4 s sendChatAction pulse is never armed and never fires; the
  // status bubble is a separate surface and keeps running on interval_ms.
  private chatActionEnabled(): boolean {
    return this.config.status.chat_action?.enabled ?? true
  }

  // Streaming thoughts (#1). Default OFF — the block is opt-in per channel so
  // the privacy default (freeform Claude text never reaches Telegram) is kept
  // unless a channel explicitly turns it on.
  private thoughtsEnabled(): boolean {
    return this.config.status.thoughts?.enabled ?? false
  }

  private thoughtMaxChars(): number {
    return this.config.status.thoughts?.max_chars ?? THOUGHT_DEFAULT_MAX_CHARS
  }

  private thoughtMaxLines(): number {
    return this.config.status.thoughts?.max_lines ?? THOUGHT_DEFAULT_MAX_LINES
  }

  private thoughtReadThrottleMs(): number {
    return this.config.status.thoughts?.read_throttle_ms ?? THOUGHT_DEFAULT_READ_THROTTLE_MS
  }

  // Record a 403/forbidden Telegram failure for a chat. Future start()
  // calls within BLOCKED_CHAT_TTL_MS will short-circuit without trying
  // sendMessage. Idempotent — repeated calls just refresh `lastSeen`.
  private markChatBlocked(chatId: string, reason: string): void {
    const t = this.now()
    const prev = this.blockedChats.get(chatId)
    if (prev) {
      prev.lastSeen = t
      prev.reason = reason
    } else {
      this.blockedChats.set(chatId, { firstSeen: t, lastSeen: t, reason })
    }
  }

  // Returns true when the chat is in the blocked cache AND the most
  // recent 403 happened within BLOCKED_CHAT_TTL_MS. Re-probes after
  // the window allow recovery if the bot was re-added.
  private isChatBlocked(chatId: string): boolean {
    const rec = this.blockedChats.get(chatId)
    if (!rec) return false
    const t = this.now()
    if (t - rec.lastSeen >= BLOCKED_CHAT_TTL_MS) {
      // TTL elapsed — drop the entry so the next start() probes fresh.
      // If Telegram still returns 403, mark it again immediately.
      this.blockedChats.delete(chatId)
      return false
    }
    return true
  }

  // Periodically drop entries older than BLOCKED_CHAT_PRUNE_MS so a
  // long-running plugin doesn't accumulate dead chatIds. Runs at most
  // once per BLOCKED_CHAT_TTL_MS to keep amortised cost negligible.
  private maybePruneBlockedChats(): void {
    const t = this.now()
    if (t - this.lastBlockedPruneAt < BLOCKED_CHAT_TTL_MS) return
    this.lastBlockedPruneAt = t
    for (const [id, rec] of this.blockedChats.entries()) {
      if (t - rec.firstSeen >= BLOCKED_CHAT_PRUNE_MS) {
        this.blockedChats.delete(id)
      }
    }
  }

  // Per-chat lifecycle serialization. Caller's `op` runs only after
  // any pending lifecycle work on the same chat finishes. Errors are
  // returned to the caller verbatim — the chain itself swallows
  // upstream errors so a single failure doesn't strand later callers.
  private async runLifecycle<T>(chatId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLocks.get(chatId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((r) => {
      release = r
    })
    this.lifecycleLocks.set(chatId, next)
    try {
      await prev.catch(() => {})
      return await op()
    } finally {
      release()
      // GC the lock when the FIFO drains. `lifecycleLocks.get(chatId)`
      // may already point to a later op's promise; only delete when we
      // own the tail.
      if (this.lifecycleLocks.get(chatId) === next) {
        this.lifecycleLocks.delete(chatId)
      }
    }
  }

  // Per-chat fail-closed gate. Returns `false` when the chat is not
  // allowed to receive interim status edits — every public method
  // bails out on this signal so a misconfigured public group never
  // sees rolling progress, tool calls, or `sendChatAction` pulses.
  private isStreamingAllowed(chatId: string): boolean {
    return shouldStreamForChat(this.policy, chatId)
  }

  isActive(chatId: string): boolean {
    return this.entries.has(chatId)
  }

  activeMessageId(chatId: string): number {
    // The returned start() handle can still have id 0 after a lazy send.
    return this.entries.get(chatId)?.handle.messageId ?? 0
  }

  // Time-bounded "turn closed" check. Returns true only while a chat is
  // within CLOSE_GRACE_MS of its complete() stamp. Past the grace the stamp
  // is dropped (lazy cleanup) and the chat is treated as open again — the
  // self-heal safety net. Side-effecting delete is harmless: an expired
  // stamp would never gate anything anyway.
  private isClosed(chatId: string): boolean {
    const closedAt = this.closedChats.get(chatId)
    if (closedAt === undefined) return false
    if (this.now() - closedAt >= CLOSE_GRACE_MS) {
      this.closedChats.delete(chatId)
      return false
    }
    return true
  }

  // True while a PreCompact-armed guard is still live for this chat. Used to
  // distinguish a service Stop (emitted around auto-compaction, turn
  // continues) from a genuine end-of-turn Stop.
  private withinCompactionGuard(chatId: string): boolean {
    const armedAt = this.compactionGuards.get(chatId)
    if (armedAt === undefined) return false
    if (this.now() - armedAt >= COMPACTION_GUARD_MS) {
      this.compactionGuards.delete(chatId)
      return false
    }
    return true
  }

  // List of active chat ids — used by shutdown to flush all status messages.
  activeChatIds(): string[] {
    return Array.from(this.entries.keys())
  }

  async start(
    chatId: string,
    replyToMessageId: number | undefined,
    initialState: StatusState = { kind: 'typing' },
    threadId?: number,
  ): Promise<StatusHandle> {
    // Dynamic hook routing: record the active turn's chat BEFORE any gate.
    // Even when the bubble is suppressed (policy off / 403), Claude Code's
    // hook activity must still be attributed to whoever sent the message,
    // so the post-hook proxy reads this and routes there. The writer
    // swallows its own errors — this can never block a turn.
    this.recordActiveChat?.(chatId)
    if (!this.isStreamingAllowed(chatId)) {
      // Per-chat fail-closed gate: chat is absent from policy or its
      // `streaming` setting is `off`. Return a sentinel handle that
      // does not correspond to any real Telegram message — update()
      // / cancel() / complete() bail out because we never insert this
      // chat into `entries`. Final replies still arrive via the
      // router's outbox loop, which is the only legitimate egress
      // path for non-streaming chats.
      return {
        chatId,
        messageId: 0,
        startedAt: this.now(),
        // Generation `0` is the sentinel for "no real entry exists".
        // Live entries start at `generation: 1` (see startInternal),
        // so a staleness check `handle.generation === entry.generation`
        // against this sentinel can never spuriously match a real
        // entry that landed on the same chatId after a policy change.
        generation: 0,
      }
    }
    // MED-A #1: short-circuit start() when a recent 403/forbidden was
    // recorded for this chat. Without this, every inbound message on
    // a permanently-blocked chat (bot kicked / user blocked / chat
    // 403) paid a fresh sendMessage round-trip just to learn Telegram
    // still refuses. Re-probe is allowed after BLOCKED_CHAT_TTL_MS so
    // the bot can recover if re-added to the chat. Return the same
    // sentinel shape the policy-gate uses so downstream tools see a
    // consistent "no active surface" signal.
    this.maybePruneBlockedChats()
    if (this.isChatBlocked(chatId)) {
      return {
        chatId,
        messageId: 0,
        startedAt: this.now(),
        generation: 0,
      }
    }
    // Serialize per-chat lifecycle ops so two concurrent start() calls
    // can't both pass the `entries.has` check, both fire sendMessage,
    // then race on entries.set — one Telegram message ended up orphaned
    // with a ghost timer chasing it (codex HIGH #3).
    return this.runLifecycle(chatId, () =>
      this.startInternal(chatId, replyToMessageId, initialState, threadId),
    )
  }

  private async startInternal(
    chatId: string,
    replyToMessageId: number | undefined,
    initialState: StatusState,
    threadId?: number,
  ): Promise<StatusHandle> {
    // Snapshot the "closed" flag BEFORE the initial send. The lazy-open
    // gate in recordActivityByChatId only guards the read side: a
    // non-opener event whose closedChats check passed (turn still open)
    // proceeds here and parks on the sendMessage below. If Stop's
    // complete() fires during that send window it runs its synchronous
    // head, finds no entry yet (we have not entries.set), flips the chat
    // to "closed", and returns a no-op. Without this snapshot we would
    // then register a fully-tracked bubble that nothing ever closes — the
    // stuck "working" block after /new. A false→true transition
    // across the send means "the turn closed under us" → tear down.
    const closedBefore = this.isClosed(chatId)

    // Only one active status per chat at a time: finalise the previous one
    // (edit the old message to "Остановлено: superseded" and clear timers)
    // so we don't leak a stale "Печатает…" message on top of the new one.
    // Album-path callers in handlers.ts call start() once per album item;
    // without this terminate step the first item's pulse stays forever.
    //
    // Inline cancel: we're already inside the lifecycle lock, so we
    // do the bookkeeping + edit directly. Going through `cancel()`
    // would re-acquire the lock and deadlock.
    const prev = this.entries.get(chatId)
    if (prev) {
      // Mid-turn second message (the owner sends a follow-up while the agent is still
      // working on msg1): start() fires again on the new inbound. Claude Code
      // QUEUES msg2 and folds it into the SAME turn at the next step, so there
      // is exactly one ongoing piece of work — and we must keep showing exactly
      // one bubble for it. The old supersede path deleted the live bubble and
      // recreated a fresh one, which reset the elapsed-seconds counter to 0 and
      // made the "working" block flicker or vanish. Keep the
      // existing live bubble running untouched — its timers, generation and
      // seconds carry on — and return its handle. The InboundWatcher fires the
      // «✋ Принял, добавлю к текущей задаче» ack separately, so the user sees
      // msg2 was registered and will fold into the current task.
      if (!prev.disabled) {
        return prev.handle
      }
      // The previous bubble was DISABLED by a Telegram 401/403 earlier — it can
      // no longer be edited or deleted meaningfully. Retire its bookkeeping
      // (bump both the canonical counter and the entry.handle mirror together,
      // stop timers, drop the entry + its orphan-recovery record) and fall
      // through to start a fresh bubble below; the chat may have recovered
      // (bot re-added).
      prev.generation += 1
      prev.handle.generation = prev.generation
      this.stopTimers(prev)
      this.entries.delete(chatId)
      this.orphanStore?.clear(chatId)
    }

    const suppressBubble =
      this.config.status.suppress_typing_bubble && initialState.kind === 'typing'

    const text = renderState(initialState, 0, this.now())
    let messageId = 0
    if (!suppressBubble) {
      const sendOpts: {
        parse_mode: 'HTML'
        reply_to_message_id?: number
        message_thread_id?: number
        disable_notification: boolean
      } = {
        parse_mode: 'HTML',
        // Telegram pushes a notification for every send unless disabled.
        // Keep the initial status bubble silent. Edits never push.
        disable_notification: true,
      }
      if (replyToMessageId !== undefined) sendOpts.reply_to_message_id = replyToMessageId
      if (threadId !== undefined) sendOpts.message_thread_id = threadId

      let sent: { message_id: number }
      try {
        sent = await this.telegramApi.sendMessage(chatId, text, sendOpts)
      } catch (err) {
        // MED-A #1: classify the failure. A 403/forbidden on the
        // initial send means the bot has no access to the chat — mark
        // it blocked so the next start() short-circuits without
        // another sendMessage round-trip. Other error kinds rethrow
        // (handlers.ts treats status as best-effort and catches).
        const cls = classifyEditError(err)
        if (cls.kind === 'forbidden') {
          this.markChatBlocked(chatId, `start ${cls.code}: ${cls.description}`)
          this.log.warn('status start forbidden, chat marked blocked', {
            chat_id: chatId,
            code: cls.code,
          })
        } else {
          this.log.warn('status start failed', {
            chat_id: chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        throw err
      }
      messageId = sent.message_id
    }

    // TOCTOU teardown: if the turn was completed (Stop / reply) while our
    // initial send was in flight, complete() already ran — it found no
    // entry and just marked the chat closed. Registering this entry now
    // would orphan the bubble forever (the dup-working leak after /new).
    // Detect the false→true transition and abort WITHOUT entries.set /
    // closedChats.delete, leaving the chat correctly closed. Tear down the
    // bubble we just created so nothing lingers.
    if (!closedBefore && this.isClosed(chatId)) {
      if (!suppressBubble && messageId) {
        const canDelete =
          this.config.status.delete_on_complete &&
          this.telegramApi.deleteMessage !== undefined
        try {
          if (canDelete) {
            await this.telegramApi.deleteMessage!(chatId, messageId)
          } else {
            const stoppedText = renderState(
              { kind: 'stopped', reason: 'done' },
              0,
              this.now(),
            )
            await this.telegramApi.editMessageText(chatId, messageId, stoppedText, {
              parse_mode: 'HTML',
            })
          }
        } catch (err) {
          const cls = classifyEditError(err)
          if (cls.kind !== 'benign' && cls.kind !== 'message_gone') {
            this.log.debug('status start torn down after concurrent complete (ignored)', {
              chat_id: chatId,
              message_id: messageId,
              kind: cls.kind,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      // Inert handle: generation 0 never matches a live entry, so any
      // stray update() routed through it no-ops cleanly.
      return { chatId, messageId, startedAt: this.now(), generation: 0 }
    }

    const handle: MutableHandle = {
      chatId,
      messageId,
      startedAt: this.now(),
      // Mirror of `entry.generation`. Initialised to 1 — must match
      // the entry.generation: 1 below so updateByChatId(chat, …),
      // which routes through update(entry.handle, …), passes the
      // staleness check. Kept in sync on every bump (see
      // complete/cancel/supersede).
      generation: 1,
    }
    const entry: InternalEntry = {
      handle,
      state: initialState,
      tick: 0,
      lastText: suppressBubble ? '' : text,
      intervalHandle: null,
      ttlHandle: null,
      chatActionHandle: null,
      replyToMessageId,
      threadId,
      bubbleSuppressed: suppressBubble,
      bubbleCreationPromise: null,
      teardownClaimed: false,
      generation: 1,
      activityCalls: [],
      activityPhase: 'reasoning',
      activityStartedAt: this.now(),
      // Sentinel — first non-Agent tool call always renders. Throttle only
      // applies AFTER a render has actually occurred.
      lastToolRenderAt: Number.NEGATIVE_INFINITY,
      toolUseIndex: new Map(),
      disabled: false,
      messageGoneRecoveryDone: false,
      parseDowngraded: false,
      pausedUntil: 0,
      missedLiveness: 0,
      suspectedHung: false,
      idleHandle: null,
      idleConfirmations: 0,
      everActive: false,
      lastActiveAt: this.now(),
      sawStop: false,
      // −∞ so the first rendered hook event always reads the transcript.
      lastThoughtReadAt: Number.NEGATIVE_INFINITY,
    }
    this.entries.set(chatId, entry)
    // A live entry means the chat is no longer "closed" — a fresh status
    // surface exists, so future events should update it, not be gated.
    this.closedChats.delete(chatId)
    // Persist the live bubble for restart recovery. Skip when messageId is 0
    // (suppressed typing bubble) — createBubble records it on lazy creation.
    if (messageId) this.orphanStore?.record(chatId, messageId)
    const generation = entry.generation

    // Fire-and-forget initial chat action so the Telegram header shows
    // `typing…` immediately, not on the first pulse 4 s in. Keeps firing
    // even when the message bubble is suppressed — the native indicator
    // is what the owner still wants to see.
    if (this.chatActionEnabled()) {
      void this.pulseChatAction(entry)
      entry.chatActionHandle = this.setTimer(
        () => this.chatActionTick(chatId, generation),
        CHAT_ACTION_PULSE_MS,
      )
    }

    // Periodic tick — re-edit with advanced ellipsis (typing/thinking only)
    // or keep the same text for tool/stopped/error states. Same-text edits
    // collapse via the "message is not modified" swallow path below.
    //
    // While the bubble is suppressed we still advance the tick counter so
    // animation timing stays continuous when the bubble eventually appears,
    // but `editSafely` short-circuits because messageId is 0.
    //
    // Generation guard: a tick scheduled against the previous lifecycle
    // entry (e.g. after a rapid cancel-then-start) would otherwise mutate
    // the new entry's tick/state. Compare against the captured generation
    // at scheduling time and drop the callback when they diverge.
    const tick = (): void => {
      const live = this.entries.get(chatId)
      if (!live || live.generation !== generation) return
      // MED-A #4: if Telegram returned 429 and pausedUntil is in the
      // future, skip ALL work this tick — including the tick counter
      // and the edit — but keep the interval re-armed so we resume
      // automatically once the pause window expires. Re-arming with a
      // smaller delay so the resume isn't gated on a full interval.
      if (this.now() < live.pausedUntil) {
        const remaining = Math.max(50, live.pausedUntil - this.now())
        live.intervalHandle = this.setTimer(
          tick,
          Math.min(remaining, this.config.status.interval_ms),
        )
        return
      }
      live.tick += 1
      // Stand down while the liveness probe has flagged a hang — the
      // "Возможно завис" warning (livenessTick) must not be overwritten by
      // the working animation. The counter still advances so animation timing
      // stays continuous if the turn recovers.
      if (!live.bubbleSuppressed && !live.suspectedHung) {
        const next = renderState(live.state, live.tick, this.now())
        void this.editSafely(live, next)
      }
      // Re-arm next tick.
      live.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)
    }
    entry.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)

    // Idle TTL guard. On expiry we cancel with reason='ttl' so the message
    // turns into "Остановлено: ttl" rather than vanishing silently. When the
    // bubble was suppressed end-to-end (pure typing session that timed
    // out) cancel() turns into a quiet cleanup with no Telegram edit. The
    // guard is re-armed on every real activity event (see armTtl) so it
    // only trips on genuine silence, never on a long-but-active task.
    this.armTtl(entry)

    // Deterministic idle-teardown. A fast ticker (idle_probe_ms) reads the TUI
    // ground truth and tears the bubble down cleanly the instant the turn is
    // provably over — the fix for phantom bubbles that outlive a missed Stop
    // hook. Only armed when a pane-state probe is wired AND heartbeat enabled;
    // absent → no-op, so legacy/test wiring is unaffected.
    if (this.idleTeardownEnabled()) {
      entry.idleHandle = this.setTimer(
        () => this.idleTick(chatId, generation),
        this.idleProbeMs(),
      )
    }

    return {
      chatId: handle.chatId,
      messageId: handle.messageId,
      startedAt: handle.startedAt,
      // Snapshot the entry's generation at handle-creation time. The
      // entry's generation will be bumped on each future complete/
      // cancel/supersede, so a leftover handle from this lifecycle
      // will be rejected by update() once the lifecycle ends. Within
      // the same lifecycle the value is stable — even after
      // ensureBubble() flips messageId from 0 to the real id, the
      // generation captured here still matches entry.generation,
      // so subsequent update(handle, …) calls remain valid
      // (FIX-C bug #2, codex status #2).
      generation: entry.generation,
    }
  }

  // Lazy-create the Telegram message bubble when state advances from typing
  // to anything else (thinking/tool/activity/stopped/error). No-op when the
  // bubble already exists. Used by update() and recordActivityByChatId().
  //
  // Idempotency: multiple concurrent non-typing events used to each fire
  // their own sendMessage (the awaits between rendering and `entries.set`
  // gave plenty of room to race). Now the first caller installs a
  // `bubbleCreationPromise`; subsequent callers await it and return. The
  // promise is cleared on resolve/reject so a failed create can retry on
  // the next event (codex HIGH #4).
  private async ensureBubble(entry: InternalEntry, state: StatusState): Promise<void> {
    if (entry.disabled) return
    if (!entry.bubbleSuppressed) return
    if (state.kind === 'typing') return
    if (entry.bubbleCreationPromise !== null) {
      // Another caller is creating the bubble right now — wait for them.
      // After the await we re-enter the suppress check: if the first
      // caller flipped bubbleSuppressed=false, we're done.
      await entry.bubbleCreationPromise
      return
    }
    const creation = this.createBubble(entry, state)
    entry.bubbleCreationPromise = creation
    try {
      await creation
    } finally {
      // Clear the lock regardless of outcome so a failed create can
      // retry on the next event (network blip, transient 5xx).
      if (entry.bubbleCreationPromise === creation) {
        entry.bubbleCreationPromise = null
      }
    }
  }

  // Single-flight body for ensureBubble. Splits out the actual
  // sendMessage so ensureBubble can install + await the shared promise
  // exactly once per chat per concurrent burst.
  private async createBubble(entry: InternalEntry, state: StatusState): Promise<void> {
    const text = renderState(state, 0, this.now())
    const sendOpts: {
      parse_mode?: 'HTML'
      reply_to_message_id?: number
      message_thread_id?: number
      disable_notification: boolean
    } = { disable_notification: true } // silent indicator — see startInternal
    // Skip parse_mode when we've previously had a parse downgrade so
    // the broken HTML can't trip Telegram a second time.
    if (!entry.parseDowngraded) sendOpts.parse_mode = 'HTML'
    if (entry.replyToMessageId !== undefined) {
      sendOpts.reply_to_message_id = entry.replyToMessageId
    }
    if (entry.threadId !== undefined) sendOpts.message_thread_id = entry.threadId
    try {
      const sent = await this.telegramApi.sendMessage(
        entry.handle.chatId,
        text,
        sendOpts,
      )
      // Commit the real id onto the handle. A teardown handler awaiting this
      // creation (complete/cancel, FIX-C) needs it to neutralize with its own
      // semantics, so we set it even when the entry was detached meanwhile.
      entry.handle.messageId = sent.message_id
      entry.lastText = text
      entry.bubbleSuppressed = false
      // Detached-entry guard (frozen working bubble). The
      // await above yielded the event loop; a teardown may have detached this
      // entry from `entries`. If a supersede did it (NOT teardownClaimed), no
      // handler will ever close this bubble — tear it down here. complete/
      // cancel set teardownClaimed and own the neutralization themselves, so
      // leave it for them. When still live, persist for restart recovery.
      if (this.entries.get(entry.handle.chatId) === entry) {
        this.orphanStore?.record(entry.handle.chatId, sent.message_id)
      } else if (!entry.teardownClaimed) {
        await this.neutralizeLeakedBubble(entry.handle.chatId, sent.message_id)
      }
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind === 'forbidden') {
        entry.disabled = true
        // MED-A #1: also mark the chat in the per-chat blocked cache
        // so the NEXT start() (after this entry is gone via complete
        // / cancel) short-circuits without another sendMessage 403.
        this.markChatBlocked(
          entry.handle.chatId,
          `lazy-send ${cls.code}: ${cls.description}`,
        )
        this.log.warn('status lazy-send forbidden, entry disabled', {
          chat_id: entry.handle.chatId,
          code: cls.code,
        })
        return
      }
      if (cls.kind === 'parse' && !entry.parseDowngraded) {
        entry.parseDowngraded = true
        this.log.warn('status lazy-send parse failure, retrying without parse_mode', {
          chat_id: entry.handle.chatId,
          description: cls.description,
        })
        // MED-A #6 (Codex status #5): retry must preserve
        // `reply_to_message_id` so the recovered bubble stays in the
        // same reply thread the owner expects. Pre-fix retried
        // with `{}`, dropping the entire sendOpts including the
        // reply target — the rolling status then appeared at the
        // bottom of the chat unconnected to the originating message.
        // We drop only `parse_mode`, keeping every other option
        // (including reply_to_message_id) intact.
        const retryOpts: {
          reply_to_message_id?: number
          message_thread_id?: number
          disable_notification: boolean
        } = { disable_notification: true }
        if (entry.replyToMessageId !== undefined) {
          retryOpts.reply_to_message_id = entry.replyToMessageId
        }
        if (entry.threadId !== undefined) retryOpts.message_thread_id = entry.threadId
        try {
          const sent = await this.telegramApi.sendMessage(
            entry.handle.chatId,
            text,
            retryOpts,
          )
          entry.handle.messageId = sent.message_id
          entry.lastText = text
          entry.bubbleSuppressed = false
          // Same detached-entry guard as the primary send above — the retry
          // await is another TOCTOU window. Supersede orphans get neutralized
          // here; complete/cancel (teardownClaimed) own theirs.
          if (this.entries.get(entry.handle.chatId) === entry) {
            this.orphanStore?.record(entry.handle.chatId, sent.message_id)
          } else if (!entry.teardownClaimed) {
            await this.neutralizeLeakedBubble(entry.handle.chatId, sent.message_id)
          }
          return
        } catch (err2) {
          this.log.warn('status lazy-send retry without parse_mode failed', {
            chat_id: entry.handle.chatId,
            error: err2 instanceof Error ? err2.message : String(err2),
          })
          return
        }
      }
      // Best-effort — log and leave bubble suppressed. Next non-typing
      // event will retry the send.
      this.log.warn('status lazy-send failed (ignored)', {
        chat_id: entry.handle.chatId,
        kind: cls.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Best-effort teardown of a Telegram message that was created for an entry
  // which got DETACHED (superseded / completed / cancelled) while its send was
  // still in flight. createBubble runs outside the lifecycle lock, so its
  // `await sendMessage` opens a TOCTOU window: by the time the send resolves
  // the entry may no longer be the live one for its chat. Committing the id
  // then would adopt a bubble nothing owns — a frozen "working" bubble under the final answer. Mirrors complete()'s policy: delete
  // when possible, else terminal edit. Swallows benign / message-gone errors —
  // a failed neutralize must never back-pressure the hook path. Deliberately
  // does NOT touch orphanStore: the guarded caller returns BEFORE recording,
  // and the chat's record now belongs to whatever entry is currently live.
  private async neutralizeLeakedBubble(chatId: string, messageId: number): Promise<void> {
    if (!messageId) return
    const canDelete =
      this.config.status.delete_on_complete && this.telegramApi.deleteMessage !== undefined
    try {
      if (canDelete) {
        await this.telegramApi.deleteMessage!(chatId, messageId)
      } else {
        const stoppedText = renderState({ kind: 'stopped', reason: 'done' }, 0, this.now())
        await this.telegramApi.editMessageText(chatId, messageId, stoppedText, {
          parse_mode: 'HTML',
        })
      }
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind !== 'benign' && cls.kind !== 'message_gone') {
        this.log.debug('leaked status bubble neutralize failed (ignored)', {
          chat_id: chatId,
          message_id: messageId,
          kind: cls.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async update(handle: StatusHandle, state: StatusState): Promise<void> {
    const entry = this.entries.get(handle.chatId)
    if (!entry) return
    if (entry.disabled) return
    // Staleness check is GENERATION-based (FIX-C bug #2, codex status #2).
    //
    // The previous messageId-based check broke after lazy-bubble creation:
    // start() returned a handle with messageId=0 (suppressed bubble),
    // ensureBubble() later flipped entry.handle.messageId to the real id,
    // and subsequent update(handle, …) calls hit
    // `entry.handle.messageId !== handle.messageId` (real id vs the
    // caller's stale `0`) and silently dropped — leaving the status
    // frozen at whatever ensureBubble's first send rendered.
    //
    // Generation is captured into the handle at start() and bumped on
    // every lifecycle transition (complete / cancel / supersede). It
    // stays stable across lazy-bubble creation, so the caller's handle
    // remains valid for the entire lifecycle yet is rejected the moment
    // a new lifecycle takes over the chat.
    if (handle.generation !== entry.generation) {
      // Stale handle — caller is editing something already completed.
      return
    }
    // Real activity — push the idle TTL deadline back so a long but active
    // session is never auto-cancelled mid-flight.
    this.armTtl(entry)
    entry.state = state
    // Reset tick on state change so the ellipsis animation restarts at 1.
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      await this.ensureBubble(entry, state)
      // ensureBubble already wrote the rendered text for non-typing states
      // and flipped bubbleSuppressed off. Nothing else to edit on this turn.
      return
    }
    const text = renderState(state, 0, this.now())
    await this.editSafely(entry, text)
  }

  // Convenience for the MCP `status` tool: the agent only has the chat_id,
  // not a StatusHandle (which is internal to the gateAndNotify caller). This
  // lets the tool re-target whichever status is currently active for the chat.
  async updateByChatId(chatId: string, state: StatusState): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    await this.update(entry.handle, state)
  }

  /**
   * Apply a Claude Code hook event to the chat's status. Opens a new status
   * with no `reply_to_message_id` if none is active (SessionStart /
   * UserPromptSubmit / PreToolUse all act as openers — gateway parity).
   * Stop completes via `complete()` so existing delete_on_complete behaviour
   * holds.
   *
   * Non-Agent PreToolUse calls are recorded immediately but the on-Telegram
   * edit is throttled to once per 5 s; the next reasoning/Agent/Stop event
   * flushes the buffer (mirrors gateway.py:1738 `_last_tool_render`).
   */

  /**
   * True when a session_stop should be treated as a CONTINUATION (turn not
   * really over) rather than a real end-of-turn. The turn is still running when:
   *   - Claude Code is already continuing via a Stop hook (`stop_hook_active`); or
   *   - the chat is inside the compaction guard (a service Stop fires mid-
   *     compaction); or
   *   - the TUI pane still reads 'active' — the turn is genuinely running. The
   *     common case is background Task subagents whose every completion is
   *     injected as a fresh mini-turn that fires a Stop between injections.
   *
   * Used by recordActivityByChatId (to keep THIS bubble alive) AND by the
   * webhook (to suppress the same session_stop reaching ProgressReporter /
   * TaskMirror, which otherwise finalize+evict and respawn a new message per
   * mini-turn — repeated status bubbles).
   * Pure read; safe to call from any surface.
   */
  isContinuationStop(chatId: string, stopHookActive: boolean): boolean {
    if (stopHookActive) return true
    if (this.withinCompactionGuard(chatId)) return true
    // Pane-independent: a background Task(Agent) subagent injecting results
    // mid-turn keeps the turn alive even when the pane momentarily reads 'idle'.
    if (this.withinSubagentWindow(chatId)) return true
    // The decisive signal for SLOW subagents: one is still in flight (dispatched,
    // result not yet injected). Bridges minute-long silent gaps the 30s window
    // and the flaky pane both miss.
    if (this.subagentInFlight(chatId)) return true
    return this.paneStateProbe !== undefined && this.paneStateProbe(chatId) === 'active'
  }

  /** Record that a background-subagent (Agent) tool event just fired. */
  private markSubagentActivity(chatId: string): void {
    this.subagentActivityAt.set(chatId, this.now())
  }

  /**
   * A background subagent was dispatched (Agent tool_start) — now in flight.
   * Keyed by the dispatch's toolUseId so the matching return can clear EXACTLY
   * this subagent. Without a toolUseId we cannot track it (fall back to the
   * 30s window), so skip rather than store an unkillable phantom.
   */
  private pushSubagentDispatch(chatId: string, toolUseId: string | undefined): void {
    if (!toolUseId) return
    const inflight = this.subagentDispatchAt.get(chatId) ?? new Map<string, number>()
    inflight.set(toolUseId, this.now())
    this.subagentDispatchAt.set(chatId, inflight)
  }

  /**
   * A background subagent returned its result (task-notification injection).
   * Idempotent: a subagent may inject its notification more than once (proven
   * live — a preview frame then an output-file frame), and deleting an already
   * cleared toolUseId is a harmless no-op. This is why we key by id, not count.
   */
  private popSubagentDispatch(chatId: string, toolUseId: string | undefined): void {
    if (!toolUseId) return
    const inflight = this.subagentDispatchAt.get(chatId)
    if (!inflight) return
    if (inflight.delete(toolUseId)) {
      if (inflight.size === 0) this.subagentDispatchAt.delete(chatId)
    }
  }

  /**
   * True while at least one background subagent is still in flight (dispatched,
   * result not yet injected, dispatch not older than MAX_SUBAGENT_INFLIGHT_MS).
   * Reaps stale dispatches so a lost/abandoned injection can't pin the bubble
   * forever. This is the pane- and gap-independent "turn is still alive" signal
   * the 30s window could not provide for slow subagents.
   */
  private subagentInFlight(chatId: string): boolean {
    const inflight = this.subagentDispatchAt.get(chatId)
    if (!inflight || inflight.size === 0) return false
    const cutoff = this.now() - MAX_SUBAGENT_INFLIGHT_MS
    for (const [id, ts] of inflight) {
      if (ts < cutoff) inflight.delete(id)
    }
    if (inflight.size === 0) {
      this.subagentDispatchAt.delete(chatId)
      return false
    }
    return true
  }

  /**
   * True while within SUBAGENT_CONTINUATION_WINDOW_MS of the last Agent tool
   * event for this chat — the turn is still injecting subagent results, so it
   * must be treated as a continuation regardless of the (flaky) pane state.
   */
  private withinSubagentWindow(chatId: string): boolean {
    const at = this.subagentActivityAt.get(chatId)
    return at !== undefined && this.now() - at < SUBAGENT_CONTINUATION_WINDOW_MS
  }

  async recordActivityByChatId(chatId: string, event: ActivityStatusEvent): Promise<void> {
    if (!this.isStreamingAllowed(chatId)) {
      // Per-chat fail-closed gate: chat is absent from policy or its
      // `streaming` setting is `off`. Hook events arrive whether or
      // not we want to surface them — drop silently. Final reply
      // ships via the router outbox loop, not here.
      return
    }
    // PreCompact arms the compaction guard and does nothing else — the turn
    // continues after compaction, so no render and no teardown.
    if (event.kind === 'compaction_start') {
      this.compactionGuards.set(chatId, this.now())
      return
    }

    // Stop closes the session. Use existing complete() so delete_on_complete
    // semantics + timer cleanup stay in one place. BUT distinguish a genuine
    // end-of-turn Stop from a SERVICE Stop: `stop_hook_active` (Claude Code
    // is already continuing via a Stop hook) or a Stop landing inside the
    // compaction guard means the turn is not really over — swallow it so the
    // indicator survives auto-compaction instead of blinking out mid-task.
    if (event.kind === 'session_stop') {
      // Stamp sawStop before any swallow: the after-active backstop uses it to
      // tell a finished-but-swallowed turn (Stop seen) from a turn parked on a
      // permission dialog (no Stop). Genuine Stops complete() below, so the flag
      // is moot for them; only the swallowed-Stop path relies on it.
      const stopEntry = this.entries.get(chatId)
      if (stopEntry) stopEntry.sawStop = true
      // A Stop that lands while the turn is genuinely still running is NOT the
      // real end — keep the bubble alive and let idleTick tear it down once the
      // pane finally goes idle (sawStop latched above arms the active-then-gone
      // backstop; the idle-confirm path covers a clean idle). The common case is
      // background Task subagents: Claude Code injects each completion as a fresh
      // mini-turn that fires a Stop between injections while "esc to interrupt"
      // is still painted. Tearing down + respawning per injection spammed a new
      // bubble every few seconds. See isContinuationStop —
      // the SAME predicate gates the webhook's ProgressReporter/TaskMirror
      // dispatch so all three surfaces stay coalesced.
      if (this.isContinuationStop(chatId, event.stopHookActive === true)) {
        this.log.debug('service Stop swallowed — bubble kept alive', {
          chat_id: chatId,
          stop_hook_active: event.stopHookActive === true,
          within_compaction_guard: this.withinCompactionGuard(chatId),
          pane_active:
            this.paneStateProbe !== undefined && this.paneStateProbe(chatId) === 'active',
        })
        return
      }
      await this.complete(chatId)
      return
    }

    // A genuine new-turn opener reopens a chat that a prior reply()/Stop
    // closed. SessionStart and UserPromptSubmit (→ 'reasoning') are the
    // only openers; trailing tool hooks are NOT, so they stay gated.
    if (event.kind === 'session_start' || event.kind === 'reasoning') {
      this.closedChats.delete(chatId)
    }
    // UserPromptSubmit is the ONLY signal that a brand-new user turn began,
    // so it's the safe point to drop a stale compaction guard. We do NOT
    // clear on session_start: a SessionStart with source=compact fires as
    // part of the SAME turn's compaction and may precede the service Stop —
    // clearing here would un-guard it. Otherwise the guard self-expires.
    if (event.kind === 'reasoning') {
      this.compactionGuards.delete(chatId)
      // A background-subagent result injection (task-notification) is NOT a new
      // user turn — it's the turn continuing. Refresh the continuation window so
      // the Stop that follows this mini-turn is swallowed and idleTick refuses
      // teardown. Without this the window (armed only at Agent dispatch) lapses
      // and every injection respawns a fresh bubble (~20s spam). See
      // ReasoningEvent.subagentContinuation / isSubagentNotification.
      if (event.subagentContinuation) {
        this.markSubagentActivity(chatId)
        // This injection IS a subagent returning its result — clear the matching
        // in-flight slot by toolUseId. When the last one clears, the 30s window
        // handles the tail.
        this.popSubagentDispatch(chatId, event.subagentReturnToolUseId)
      }
    }

    // Lazy-open: hook events can arrive before any inbound Telegram message.
    // In that case we open a status with no reply target so the rendering
    // surface exists. Initial state is `activity` so the first edit shows
    // the working block, not "Печатает…".
    let entry = this.entries.get(chatId)
    if (!entry) {
      // dup-working race fix (2026-06-04): the turn was already closed by
      // a reply() or Stop in this same turn. A trailing tool_start/
      // tool_end hook (e.g. PostToolUse of the reply tool itself) must
      // NOT resurrect the status bubble — doing so races the Stop's
      // complete() and leaks an untracked "working — Ns" bubble that
      // lingers below the answer. Openers cleared the flag above, so
      // only non-opener events land here while closed.
      if (this.isClosed(chatId)) return
      // Late background-subagent return (2026-07-21): isClosed() self-expires
      // after CLOSE_GRACE_MS (4s), so a Task subagent finishing MORE than 4s
      // after the reply slips past the gate above and lazy-opens a fresh
      // "working" bubble beneath the delivered answer. A subagent continuation
      // reaching lazy-open means NO live bubble exists — the turn already ended
      // (reply/Stop deleted it) — so this is a trailing result, never new work
      // to visualize. Genuine in-flight subagents keep the bubble alive and
      // never hit this branch. Time-independent, unlike the isClosed() window.
      if ('subagentContinuation' in event && event.subagentContinuation === true) return
      const initial: StatusState = {
        kind: 'activity',
        snapshot: this.buildSnapshot([], 'reasoning', this.now()),
      }
      try {
        await this.start(chatId, undefined, initial)
      } catch {
        // Telegram send failed — already logged inside start(). Visibility
        // failure must not back-pressure Claude hooks; bail silently.
        return
      }
      entry = this.entries.get(chatId)
      if (!entry) return
    }
    if (entry.disabled) return

    // Re-arm the idle TTL on every real hook event, even when the render is
    // throttled below — a throttled tool_start is still genuine activity and
    // must keep the guard from tripping.
    this.armTtl(entry)

    const now = this.now()
    let shouldRender = false
    let isAgentEvent = false

    switch (event.kind) {
      case 'session_start':
      case 'reasoning': {
        entry.activityPhase = 'reasoning'
        shouldRender = true
        break
      }
      case 'tool_start': {
        // Record every call up to the buffer cap so PostToolUse can pair.
        const detail = buildActivityDetail(event.toolName, event.toolInput)
        const humanized = buildHumanizedActivityLine(event.toolName, event.toolInput)
        const call: ActivityCall = { toolName: event.toolName, detail, humanized }
        entry.activityCalls.push(call)
        if (entry.activityCalls.length > ACTIVITY_MAX_BUFFER) {
          entry.activityCalls.shift()
          // After shifting, indexes in toolUseIndex are stale; rebuild
          // lazily — only PostToolUse readers touch them.
          const rebuilt = new Map<string, number>()
          for (const [k, v] of entry.toolUseIndex.entries()) {
            if (v > 0) rebuilt.set(k, v - 1)
          }
          entry.toolUseIndex = rebuilt
        }
        entry.toolUseIndex.set(event.toolUseId, entry.activityCalls.length - 1)
        entry.activityPhase = 'tool'

        isAgentEvent = event.toolName === 'Agent'
        if (isAgentEvent) {
          // Arm the pane-independent continuation window — see
          // withinSubagentWindow / SUBAGENT_CONTINUATION_WINDOW_MS.
          this.markSubagentActivity(chatId)
          // …and count it as in flight (keyed by toolUseId) until its result
          // injects back. This is what keeps the bubble alive across a slow
          // subagent's silent minutes.
          this.pushSubagentDispatch(chatId, event.toolUseId)
          shouldRender = true
        } else if (now - entry.lastToolRenderAt >= ACTIVITY_EDIT_THROTTLE_MS) {
          shouldRender = true
        } else {
          // Throttled — buffer remains; next render flush will surface it.
          shouldRender = false
        }
        break
      }
      case 'tool_end': {
        entry.activityPhase = 'reasoning'
        // A finishing Agent subagent re-arms the continuation window: its result
        // injects as a fresh mini-turn whose Stop must NOT tear the bubble down.
        if (event.toolName === 'Agent') {
          this.markSubagentActivity(chatId)
        }
        // For Agent PostToolUse, attach a short done summary to the matching
        // line — capped at 30 chars + masked AT STORE TIME (review §7).
        // Pre-fix the raw tool_result lived in the buffer until render; an
        // in-memory leak (debug dump, future log sink, serializer) would
        // surface raw tokens. Masking here means the buffer never holds an
        // unmasked secret-shaped string.
        if (event.toolName === 'Agent' && event.toolResult !== undefined) {
          const idx = entry.toolUseIndex.get(event.toolUseId)
          if (idx !== undefined && idx >= 0 && idx < entry.activityCalls.length) {
            const rawSummary =
              typeof event.toolResult === 'string'
                ? event.toolResult.slice(0, 30)
                : ''
            const summary = rawSummary ? maskSecrets(rawSummary) : ''
            if (summary) {
              const prev = entry.activityCalls[idx]
              if (prev) {
                entry.activityCalls[idx] = {
                  toolName: prev.toolName,
                  detail: `${prev.detail} — ${summary}`,
                  humanized:
                    prev.humanized !== null
                      ? `${prev.humanized} — ${escapeHtml(summary)}`
                      : null,
                }
              }
            }
          }
        }
        shouldRender = true
        break
      }
    }

    if (!shouldRender) return

    if (event.kind === 'tool_start' && !isAgentEvent) {
      entry.lastToolRenderAt = now
    } else if (event.kind === 'tool_start' && isAgentEvent) {
      entry.lastToolRenderAt = now
    }

    // Streaming thoughts (#1): when enabled and the event carries a transcript
    // path, tail-read the agent's latest narration block — throttled so a burst
    // of hook events doesn't re-open the file each time. A null read (no
    // narration yet / code-only) keeps the prior thought to avoid flicker back
    // to «reasoning...». The read is the only I/O here; the animation tick
    // re-renders the stored value with no I/O.
    if (
      this.thoughtsEnabled() &&
      'transcriptPath' in event &&
      typeof event.transcriptPath === 'string' &&
      now - entry.lastThoughtReadAt >= this.thoughtReadThrottleMs()
    ) {
      entry.lastThoughtReadAt = now
      const thought = await readLatestThought(event.transcriptPath, {
        maxChars: this.thoughtMaxChars(),
        maxLines: this.thoughtMaxLines(),
      })
      if (thought !== null) entry.latestThought = thought
    }

    // Async-gap guard (frozen working bubble). The
    // streaming-thoughts transcript read above (and any future await on
    // this path) yields the event loop. If complete()/cancel() tore the
    // turn down meanwhile — removing this entry from `entries` and
    // neutralizing its bubble — the continuation below must NOT resurrect
    // it: editSafely would re-edit the bubble back into a live "working"
    // render, and the bubbleSuppressed branch would send a fresh bubble
    // and re-record an orphan that nothing will ever clear. Bail if this
    // entry is no longer the active one for its chat, or the chat closed.
    if (this.entries.get(chatId) !== entry || this.isClosed(chatId)) return

    const snapshot = this.buildSnapshot(
      entry.activityCalls,
      entry.activityPhase,
      entry.activityStartedAt,
      entry.latestThought,
    )
    entry.state = { kind: 'activity', snapshot }
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      // First non-typing event creates the bubble with the activity render
      // directly — no «Печатает.» preamble.
      await this.ensureBubble(entry, entry.state)
      return
    }
    const text = renderState(entry.state, 0, now)
    await this.editSafely(entry, text)
  }

  private buildSnapshot(
    calls: ReadonlyArray<ActivityCall>,
    phase: 'reasoning' | 'tool',
    startedAtMs: number,
    thought?: string,
  ): ActivitySnapshot {
    return {
      startedAtMs,
      // Defensive copy so consumers don't see future mutations.
      calls: calls.slice(),
      phase,
      // exactOptionalPropertyTypes: attach only when present.
      ...(thought !== undefined && thought.length > 0 ? { thought } : {}),
    }
  }

  async complete(chatId: string, discardBubble = false): Promise<void> {
    // Mark the turn closed BEFORE any early-return so the lazy-open gate
    // in recordActivityByChatId blocks trailing tool hooks (PostToolUse
    // of the reply tool, post-answer reasoning) from resurrecting a
    // bubble. Set unconditionally — even a no-op complete() (no live
    // entry) must close the turn so a reopen can't slip through after a
    // double-complete. Cleared by the next opener / startInternal.
    this.closedChats.set(chatId, this.now())
    // Drop the subagent continuation window: the turn is over, so the next
    // turn's bubble must not inherit a stale Agent timestamp.
    this.subagentActivityAt.delete(chatId)
    // Turn over — any leftover in-flight dispatch records are stale; clear them
    // so the next turn starts from zero.
    this.subagentDispatchAt.delete(chatId)
    // Synchronous bookkeeping FIRST so isActive() flips immediately and
    // any pending timer ticks are invalidated before we yield to the
    // event loop. The Telegram delete (network I/O) runs inside the
    // lifecycle lock to serialize with concurrent start() calls.
    const entry = this.entries.get(chatId)
    if (!entry) {
      // No live entry, but an orphan record may survive — e.g. a bubble
      // sent by a stale async continuation after this turn already ended,
      // or a double-complete. Drop it here so the boot sweep can't later
      // "recover" a long-dead message id. Safe: a no-op complete() means
      // no active bubble exists for this chat to protect (frozen-working
      // bubble).
      this.orphanStore?.clear(chatId)
      return
    }
    entry.generation += 1
    // Keep handle mirror in sync (see startInternal supersede branch).
    entry.handle.generation = entry.generation
    this.stopTimers(entry)
    this.entries.delete(chatId)
    // Claim ownership of any in-flight bubble: createBubble's detached-entry
    // guard must NOT neutralize a send we're about to await + handle below.
    entry.teardownClaimed = true
    // Turn terminated — drop the restart-recovery record (the Telegram message
    // is deleted/neutralized just below, so it must not be swept on next boot).
    this.orphanStore?.clear(chatId)

    // FIX-C bug #1 (codex status #2) — ensureBubble vs complete race.
    //
    // Pre-fix: with `suppress_typing_bubble: true` (production
    // default), ensureBubble() runs OUTSIDE the lifecycle lock. If
    // complete() fires while ensureBubble is mid-await on sendMessage,
    // `entry.bubbleSuppressed` is still `true` (the flip happens
    // AFTER the await resolves), so complete() bailed early — yet
    // sendMessage went on to succeed and entry.handle.messageId was
    // set to the real Telegram message id with nobody tracking it.
    // Result: a ghost bubble forever stuck in the chat.
    //
    // Approach (b) from FIX-C: await the in-flight creation promise
    // before reading bubbleSuppressed. After the await, if the bubble
    // was actually created (bubbleSuppressed === false now), the real
    // messageId is on entry.handle and we delete it like any other
    // completed bubble. If creation failed (bubbleSuppressed still
    // true) there is nothing to delete and we exit cleanly.
    if (entry.bubbleSuppressed && entry.bubbleCreationPromise !== null) {
      try {
        await entry.bubbleCreationPromise
      } catch {
        // ensureBubble swallows its own errors and leaves
        // bubbleSuppressed=true on failure. Nothing more to do.
      }
    }
    // Suppressed bubble = never sent a Telegram message, nothing to delete.
    if (entry.bubbleSuppressed) return
    if (entry.disabled) return
    const messageId = entry.handle.messageId
    // Preferred path: delete the bubble outright. But a tracked bubble must
    // NEVER survive complete() still reading "working" — that is the
    // frozen working bubble: the entry is gone
    // from our map yet the Telegram message lingers in its last
    // "working/<tool>" render. The delete is skipped or can fail for several
    // reasons (delete_on_complete off, no deleteMessage surface, or a
    // transient/permission error on the delete call), and complete() used to
    // just return / swallow the error in those cases. So whenever the delete
    // is not performed OR fails, fall back to a terminal edit — exactly what
    // cancel() does — so the bubble can't stay alive showing activity.
    // Moving the bubble discards the old copy even if normal completion
    // retains a terminal status.
    const deleteMessage = this.telegramApi.deleteMessage
    return this.runLifecycle(chatId, async () => {
      if (deleteMessage && (discardBubble || this.config.status.delete_on_complete)) {
        try {
          await deleteMessage(chatId, messageId)
          return
        } catch (err) {
          // Stale message, deleted by user, rate limit, or transient error.
          // Not fatal — but we must still neutralize the visible bubble
          // below instead of leaving it frozen in "working".
          this.log.debug('status delete failed — falling back to terminal edit', {
            chat_id: chatId,
            message_id: messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Fallback: edit to a terminal state so the bubble can't read
      // "working". Mirrors cancel()'s edit + error classification.
      const stoppedText = renderState({ kind: 'stopped' }, 0, this.now())
      try {
        await this.telegramApi.editMessageText(chatId, messageId, stoppedText, {
          parse_mode: 'HTML',
        })
      } catch (err) {
        const cls = classifyEditError(err)
        if (cls.kind !== 'benign' && cls.kind !== 'message_gone') {
          this.log.debug('status terminal edit on complete failed (ignored)', {
            chat_id: chatId,
            message_id: messageId,
            kind: cls.kind,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })
  }

  async cancel(chatId: string, reason: string): Promise<void> {
    // Synchronous bookkeeping FIRST (see complete()). The "Остановлено"
    // edit runs inside the lifecycle lock to serialize against starts.
    const entry = this.entries.get(chatId)
    if (!entry) return
    entry.generation += 1
    // Keep handle mirror in sync (see startInternal supersede branch).
    entry.handle.generation = entry.generation
    this.stopTimers(entry)
    this.entries.delete(chatId)
    // Claim ownership of any in-flight bubble (see complete()).
    entry.teardownClaimed = true
    // Turn terminated — drop the restart-recovery record (see complete()).
    this.orphanStore?.clear(chatId)

    // FIX-C bug #1 (codex status #2) — mirror complete(): if
    // ensureBubble is mid-flight we must wait for it before deciding
    // whether to edit "Остановлено" into the message. Without this,
    // cancel sees bubbleSuppressed=true, bails, then ensureBubble's
    // sendMessage resolves and leaves an untracked ghost in the chat.
    if (entry.bubbleSuppressed && entry.bubbleCreationPromise !== null) {
      try {
        await entry.bubbleCreationPromise
      } catch {
        // Creation failed; bubbleSuppressed stays true; nothing to edit.
      }
    }
    // Pure typing session that ended without ever transitioning — no bubble
    // exists on Telegram, so there is nothing to mark as «Остановлено».
    if (entry.bubbleSuppressed) return
    if (entry.disabled) return
    const messageId = entry.handle.messageId
    const text = renderState({ kind: 'stopped', reason }, 0, this.now())
    return this.runLifecycle(chatId, async () => {
      try {
        await this.telegramApi.editMessageText(
          chatId,
          messageId,
          text,
          { parse_mode: 'HTML' },
        )
      } catch (err) {
        const cls = classifyEditError(err)
        if (cls.kind === 'benign') return
        if (cls.kind === 'message_gone') {
          // Cancel race: message already deleted (owner tapped delete,
          // or it scrolled past Telegram's 48h edit window). Nothing to
          // do — the entry is already gone from our map.
          this.log.debug('status cancel target missing (ignored)', {
            chat_id: chatId,
            message_id: messageId,
          })
          return
        }
        this.log.warn('status cancel edit failed', {
          chat_id: chatId,
          message_id: messageId,
          kind: cls.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // ───── internals ─────

  private async editSafely(entry: InternalEntry, text: string): Promise<void> {
    // Bubble suppressed — no Telegram message to edit. Caller is expected to
    // go through ensureBubble() instead. Guard defends timer-driven ticks
    // that fire before the first non-typing transition.
    if (entry.disabled) return
    if (entry.bubbleSuppressed || entry.handle.messageId === 0) return
    // Stale-entry guard (frozen working bubble). A caller may
    // reach us across an await (streaming-thoughts transcript read, timer
    // tick) after complete()/cancel()/supersede already removed this entry
    // from `entries`. Editing now would revive a neutralized bubble back into
    // "working". If this entry is no longer the live one for its chat, bail.
    if (this.entries.get(entry.handle.chatId) !== entry) return
    if (text === entry.lastText) {
      // Skip the network roundtrip; Telegram would respond with "message is
      // not modified" anyway and we'd swallow it.
      return
    }
    const parseMode: 'HTML' | undefined = entry.parseDowngraded ? undefined : 'HTML'
    const opts: { parse_mode?: 'HTML' } = {}
    if (parseMode !== undefined) opts.parse_mode = parseMode
    try {
      await this.telegramApi.editMessageText(
        entry.handle.chatId,
        entry.handle.messageId,
        text,
        opts as { parse_mode: 'HTML' },
      )
      entry.lastText = text
      return
    } catch (err) {
      const cls = classifyEditError(err)
      switch (cls.kind) {
        case 'benign':
          // Telegram says "message is not modified" — sync our local
          // cache so the next tick doesn't repeat the same edit.
          entry.lastText = text
          return
        case 'forbidden':
          // Bot was kicked / blocked. Mark the entry disabled so timers
          // and update() / ensureBubble() all bail without further I/O.
          // We deliberately do NOT remove the entry — isActive() must
          // still return true so the outer pipeline knows there is a
          // live session, just one that we can't write to.
          entry.disabled = true
          // MED-A #1: per-chat blocked cache so the next start() also
          // short-circuits before sendMessage.
          this.markChatBlocked(
            entry.handle.chatId,
            `edit ${cls.code}: ${cls.description}`,
          )
          this.log.warn('status edit forbidden, entry disabled', {
            chat_id: entry.handle.chatId,
            code: cls.code,
            description: cls.description,
          })
          return
        case 'message_gone':
          // Target message was deleted (user / Telegram GC / 48h cap).
          // Drop the messageId so we stop chasing it. On the FIRST
          // occurrence we attempt a single recreate via ensureBubble —
          // the bubble flips back to suppressed and the next event
          // will lazy-recreate. On subsequent gone-errors we just
          // drop and rely on the next tick / cancel to surface state.
          this.log.info('status edit target missing', {
            chat_id: entry.handle.chatId,
            message_id: entry.handle.messageId,
            recovery_done: entry.messageGoneRecoveryDone,
          })
          entry.handle.messageId = 0
          entry.lastText = ''
          // A tick in flight when the turn ends learns its target is gone
          // only AFTER the teardown that deleted it — the error is our own
          // deleteMessage coming back to us, not the user removing the
          // bubble. Recreating there leaves a bubble nobody will ever tear
          // down: the turn is already over, so no complete()/cancel() will
          // follow. A successful delete can precede a MESSAGE_ID_INVALID
          // edit error. Avoid creating a replacement bubble in that case.
          // Detached covers EVERY way this entry can be dead: complete() and
          // cancel() both `entries.delete(chatId)` before the network delete,
          // and a supersede swaps the map value for a new entry. A dead
          // entry has no owner left to tear down whatever it recreates.
          const detached = this.entries.get(entry.handle.chatId) !== entry
          if (!entry.messageGoneRecoveryDone && !detached) {
            entry.messageGoneRecoveryDone = true
            entry.bubbleSuppressed = true
            // ensureBubble bails on suppressBubble && state.kind ===
            // 'typing'; for non-typing states it will fire sendMessage
            // and the rolling tick continues against the fresh id.
            await this.ensureBubble(entry, entry.state)
          }
          return
        case 'parse':
          // Broken HTML / Markdown in the rendered payload. Strip
          // parse_mode for this entry and retry the same text once.
          // Future edits on this entry stay parse_mode-less; the
          // downside (literal `<i>` rendering) is far preferable to an
          // edit storm that never recovers.
          if (!entry.parseDowngraded) {
            entry.parseDowngraded = true
            this.log.warn('status edit parse failure, retrying without parse_mode', {
              chat_id: entry.handle.chatId,
              description: cls.description,
            })
            try {
              await this.telegramApi.editMessageText(
                entry.handle.chatId,
                entry.handle.messageId,
                text,
                {} as { parse_mode: 'HTML' },
              )
              entry.lastText = text
              return
            } catch (err2) {
              this.log.warn('status edit parse retry failed (ignored)', {
                chat_id: entry.handle.chatId,
                error: err2 instanceof Error ? err2.message : String(err2),
              })
              return
            }
          }
          // Already downgraded once — second parse error means the
          // rendered text is genuinely broken. Log and drop.
          this.log.warn('status edit parse failure post-downgrade (ignored)', {
            chat_id: entry.handle.chatId,
            description: cls.description,
          })
          return
        case 'flood': {
          // MED-A #4: pause the chat's tick handlers for retryAfterSec
          // before any more I/O lands. Without this, the next interval
          // tick fired immediately and hit 429 again, generating an
          // edit storm that the rate-limit wrapper had already given
          // up on. Default to 5s when Telegram omitted retry_after.
          const pauseSec = cls.retryAfterSec ?? 5
          entry.pausedUntil = this.now() + pauseSec * 1000
          this.log.warn('status edit 429 post-retry, pausing chat ticks', {
            chat_id: entry.handle.chatId,
            retry_after_s: cls.retryAfterSec,
            paused_for_ms: pauseSec * 1000,
          })
          return
        }
        case 'transient':
          // Network glitch, 5xx, unknown 4xx. Drop and let the next
          // tick retry. lastText is intentionally NOT mutated — the
          // text we tried to send is still pending.
          this.log.warn('status edit failed (ignored)', {
            chat_id: entry.handle.chatId,
            message_id: entry.handle.messageId,
            description: cls.description,
          })
          return
      }
    }
  }

  // Arm (or re-arm) the idle TTL guard. The TTL is an IDLE timeout, not an
  // absolute wall-clock cap: it fires only after `ttl_ms` of NO real
  // activity. Every update() / recordActivityByChatId() call re-arms it, so
  // a session that keeps emitting events (reasoning, tool use) is never
  // killed mid-flight — the guard exists purely to clean up a status whose
  // session genuinely died without a Stop event, at which point the bubble
  // turns into "Остановлено: ttl". Animation ticks deliberately do NOT
  // re-arm: they fire regardless of real progress and would defeat the
  // stuck-detection. Captures `entry.generation` at arm time so a leftover
  // timer from a superseded lifecycle is dropped on fire.
  private armTtl(entry: InternalEntry): void {
    if (entry.ttlHandle !== null) {
      this.clearTimer(entry.ttlHandle)
      entry.ttlHandle = null
    }
    const generation = entry.generation
    const chatId = entry.handle.chatId
    // Liveness-aware path (2026-06-08). When a probe is wired we replace the
    // blunt time-only cancel with a periodic liveness check: a long
    // tool-less Computing turn fires no hook activity, so the legacy TTL used
    // to cancel a still-alive turn into "Остановлено: ttl". This call is also
    // the re-arm point for every real activity event, so reaching it proves
    // the turn is alive — reset the dead-probe counter and clear any standing
    // "Возможно завис" warning here.
    if (this.livenessEnabled()) {
      entry.missedLiveness = 0
      entry.suspectedHung = false
      entry.ttlHandle = this.setTimer(
        () => this.livenessTick(chatId, generation),
        this.heartbeatProbeMs(),
      )
      return
    }
    entry.ttlHandle = this.setTimer(() => {
      const live = this.entries.get(chatId)
      if (!live || live.generation !== generation) return
      void this.cancel(chatId, 'ttl')
    }, this.config.status.ttl_ms)
  }

  private heartbeatProbeMs(): number {
    return this.config.status.heartbeat?.liveness_probe_ms ?? HEARTBEAT_DEFAULT_PROBE_MS
  }

  // Periodic liveness check (reuses entry.ttlHandle as the guard timer). While
  // the probe passes, re-arm and keep the bubble alive — a genuine long turn
  // never trips the idle cancel. After heartbeatMaxMissed consecutive dead
  // probes, flip the bubble to "⚠️ Возможно завис" (NOT cancel — the turn is
  // still tracked; recovery is the interactive-prompt watchdog's job). A later
  // live probe clears the warning and repaints the working state.
  private livenessTick(chatId: string, generation: number): void {
    const live = this.entries.get(chatId)
    if (!live || live.generation !== generation) return
    if (live.disabled) return
    // Respect the 429 backoff window (shared per-chat rate-limit bucket): do
    // no Telegram I/O, just re-arm soon so we resume once the pause clears.
    if (this.now() < live.pausedUntil) {
      const remaining = Math.max(50, live.pausedUntil - this.now())
      live.ttlHandle = this.setTimer(
        () => this.livenessTick(chatId, generation),
        Math.min(remaining, this.heartbeatProbeMs()),
      )
      return
    }
    // Pane-state is authoritative over the CPU liveness signal: during a long
    // Bash/build tool call claude's CPU goes flat (blocked on the child) but
    // the TUI still shows "esc to interrupt" — a real, active turn. An 'idle'
    // pane means the turn is over and the dedicated idleTick owns teardown, so
    // we must NOT escalate it to a "Возможно завис" warning here — just re-arm
    // and let idleTick complete() the bubble. Only fall back to the CPU signal
    // when the pane state is 'unknown' (capture failed / dialog up).
    const pane = this.paneStateProbe ? this.paneStateProbe(chatId) : 'unknown'
    if (pane === 'idle') {
      live.ttlHandle = this.setTimer(
        () => this.livenessTick(chatId, generation),
        this.heartbeatProbeMs(),
      )
      return
    }
    // Variant A (2026-06-10): the pane probe ("esc to interrupt" footer) is the
    // SOLE liveness authority. 'idle' returned above; here pane is 'active' or
    // 'unknown', and we treat BOTH as alive. We deliberately NO LONGER fall back
    // to the CPU-jiffies livenessProbe to escalate a hang: that signal reads flat
    // during model streaming / network I/O, so a transient 'unknown' pane
    // (capture timeout under load) used to flip a healthy working turn to a
    // frozen "⚠️ Возможно завис" bubble — animation seconds stop, "печатает"
    // drops — while the agent was fine. Genuine hangs are caught by
    // channel-prompt-watchdog (pane-fingerprint, ~10 min) which alerts the owner
    // in Telegram and Escapes/restarts, so no real signal is lost. The CPU probe
    // stays wired only as the on-switch for this liveness path (livenessEnabled).
    // suspectedHung is kept and cleared-on-recovery so the animation / chat-action
    // gates behave correctly in the (now unreachable) event it was ever set.
    live.missedLiveness = 0
    if (live.suspectedHung) {
      live.suspectedHung = false
      if (!live.bubbleSuppressed) {
        void this.editSafely(live, renderState(live.state, live.tick, this.now()))
      }
    }
    live.ttlHandle = this.setTimer(
      () => this.livenessTick(chatId, generation),
      this.heartbeatProbeMs(),
    )
  }

  // Deterministic idle-teardown (2026-06-08). Fast ticker (idle_probe_ms) that
  // reads the TUI ground truth and tears the bubble down the instant the turn
  // is provably over — the fix for a phantom bubble outliving a missed Stop
  // hook. Reuses entry.idleHandle as its guard timer.
  //
  // Rules:
  //   • 'active'  → turn running; latch everActive, reset the debounce, re-arm.
  //   • 'unknown' → capture failed / dialog up; never tear down via the idle
  //                 path, reset the debounce, re-arm.
  //   • 'idle'    → BUT only after the startup grace (so the first reads on a
  //                 just-started turn, before the TUI paints "esc to interrupt",
  //                 don't count). Increment the debounce; at idle_confirm
  //                 consecutive idle reads call complete() — a clean delete,
  //                 NOT a "Остановлено" cancel — and stop (no re-arm; complete()
  //                 already tore the timers down via stopTimers).
  //   • never-active backstop → independent of the above: a bubble never once
  //                 seen 'active' past never_active_deadline_ms is a phantom
  //                 over a wedged/never-started turn (flaky 'unknown' capture
  //                 can keep resetting the idle debounce forever). Tear it down.
  private idleTick(chatId: string, generation: number): void {
    const live = this.entries.get(chatId)
    if (!live || live.generation !== generation) return
    if (live.disabled) return
    // Respect the 429 backoff window: do no work, just re-arm soon.
    if (this.now() < live.pausedUntil) {
      const remaining = Math.max(50, live.pausedUntil - this.now())
      live.idleHandle = this.setTimer(
        () => this.idleTick(chatId, generation),
        Math.min(remaining, this.idleProbeMs()),
      )
      return
    }
    const pane = this.paneStateProbe ? this.paneStateProbe(chatId) : 'unknown'
    if (pane === 'active') {
      live.everActive = true
      live.lastActiveAt = this.now()
    }
    const elapsed = this.now() - live.handle.startedAt
    const grace = elapsed >= this.startupGraceMs()
    // While a background-subagent continuation window is open, the pane reads
    // 'idle' between result injections even though the turn is alive — refuse
    // every teardown path below and reset the debounce so we don't tear-then-
    // respawn (spam).
    const inSubagentWindow = this.withinSubagentWindow(chatId) || this.subagentInFlight(chatId)
    if (pane === 'idle' && grace && !inSubagentWindow) {
      live.idleConfirmations += 1
      if (live.idleConfirmations >= this.idleConfirm()) {
        // Turn is provably over — clean teardown. complete() clears all timers
        // (stopTimers) and deletes the bubble, so do NOT re-arm.
        void this.complete(chatId)
        return
      }
    } else {
      // active / unknown / idle-within-grace / subagent-window → not a confirmed
      // idle; reset.
      live.idleConfirmations = 0
    }
    // Never-active backstop: a bubble that has NEVER been observed 'active' past
    // the deadline never hosted a real turn (a genuine turn paints "esc to
    // interrupt" within ~1 s). Tear it down regardless of idle/unknown flicker
    // that defeats the debounce above. everActive guards every real turn,
    // including ones currently parked on a permission dialog.
    if (
      !live.everActive &&
      pane !== 'active' &&
      !inSubagentWindow &&
      elapsed >= this.neverActiveDeadlineMs()
    ) {
      void this.complete(chatId)
      return
    }
    // Active-then-gone backstop (2026-06-21): the bubble WAS active and a Stop
    // has been seen (the turn genuinely ended — a turn parked on a permission
    // dialog emits no Stop), yet a swallowed/lost Stop plus flaky 'unknown'
    // capture defeated the idle debounce above. Tear it down once the pane has
    // not been 'active' for the deadline. lastActiveAt refreshes on every
    // 'active' read, so a live turn (including one compacting then resuming) is
    // never caught here; if capture later recovers a fresh bubble re-opens.
    if (
      live.everActive &&
      live.sawStop &&
      pane !== 'active' &&
      !inSubagentWindow &&
      this.now() - live.lastActiveAt >= this.neverActiveDeadlineMs()
    ) {
      void this.complete(chatId)
      return
    }
    live.idleHandle = this.setTimer(
      () => this.idleTick(chatId, generation),
      this.idleProbeMs(),
    )
  }

  private stopTimers(entry: InternalEntry): void {
    if (entry.intervalHandle !== null) {
      this.clearTimer(entry.intervalHandle)
      entry.intervalHandle = null
    }
    if (entry.ttlHandle !== null) {
      this.clearTimer(entry.ttlHandle)
      entry.ttlHandle = null
    }
    if (entry.chatActionHandle !== null) {
      this.clearTimer(entry.chatActionHandle)
      entry.chatActionHandle = null
    }
    if (entry.idleHandle !== null) {
      this.clearTimer(entry.idleHandle)
      entry.idleHandle = null
    }
  }

  // Send a single chat action for the entry's current state. Swallows
  // errors — the header indicator is best-effort and a flaky call must
  // not derail the message edit path or surface to the agent. On a 401/
  // 403 we additionally disable the entry so further pulses / edits also
  // bail out.
  private async pulseChatAction(entry: InternalEntry): Promise<void> {
    if (entry.disabled) return
    // Belt to the arming brace above: any other path that reaches a pulse
    // (restart recovery, a re-armed ticker) stays silent when opted out.
    if (!this.chatActionEnabled()) return
    if (!this.telegramApi.sendChatAction) return
    const action = chatActionFor(entry.state)
    if (action === null) return
    try {
      await this.telegramApi.sendChatAction(entry.handle.chatId, action)
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind === 'forbidden') {
        entry.disabled = true
        // MED-A #1: per-chat blocked cache so the next start() also
        // short-circuits before sendMessage.
        this.markChatBlocked(
          entry.handle.chatId,
          `chat_action ${cls.code}: ${cls.description}`,
        )
        this.log.warn('sendChatAction forbidden, entry disabled', {
          chat_id: entry.handle.chatId,
          code: cls.code,
        })
        return
      }
      this.log.debug('sendChatAction failed (ignored)', {
        chat_id: entry.handle.chatId,
        action,
        kind: cls.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private chatActionTick(chatId: string, generation: number): void {
    const live = this.entries.get(chatId)
    if (!live || live.generation !== generation) return
    if (live.disabled) return
    // Suspected hang — stop claiming "typing" in the header. Keep the timer
    // re-armed so the pulse resumes once the turn recovers (suspectedHung
    // cleared by livenessTick / armTtl).
    if (live.suspectedHung) {
      live.chatActionHandle = this.setTimer(
        () => this.chatActionTick(chatId, generation),
        CHAT_ACTION_PULSE_MS,
      )
      return
    }
    // MED-A #4: respect the 429 pause window — sendChatAction shares
    // the same per-chat rate-limit bucket as editMessageText, so a
    // pulse during a 429 hold would just re-trigger the flood.
    if (this.now() < live.pausedUntil) {
      const remaining = Math.max(50, live.pausedUntil - this.now())
      live.chatActionHandle = this.setTimer(
        () => this.chatActionTick(chatId, generation),
        Math.min(remaining, CHAT_ACTION_PULSE_MS),
      )
      return
    }
    void this.pulseChatAction(live)
    live.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId, generation),
      CHAT_ACTION_PULSE_MS,
    )
  }
}
