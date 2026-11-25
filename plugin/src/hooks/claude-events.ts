// Mapping from validated Claude hook payloads to the ActivityStatusEvent
// shape consumed by StatusManager. Keeping this module pure (no I/O) lets
// the webhook server stay thin: parse → guard → map → forward.
//
// We never reach into `tool_result`, `prompt`, or freeform Claude metadata
// from here — those are intentionally dropped before any string reaches
// Telegram or our logs.

import type { ClaudeHookPayload } from '../schemas.js'
import {
  TodoWriteInputSchema,
  TaskCreateInputSchema,
  TaskUpdateInputSchema,
  type TodoItem,
  type TaskCreateInput,
  type TaskUpdateInput,
} from '../schemas.js'
import type { Logger } from '../log.js'

// Tool-call lifecycle pair used by the rolling activity window. PreToolUse
// emits `tool_start`; PostToolUse emits `tool_end`. The renderer collapses
// matching pairs into a single rendered line and uses `tool_use_id` to
// resolve Agent done-summary updates.
//
// Multichat: every variant carries an optional `chatId` so StatusManager
// can route status updates to the correct Telegram chat. The id is sourced
// from the hook payload (`ClaudeHookCommonShape.chatId`) by `toActivityEvent`
// when present; for the legacy single-chat wiring it stays `undefined` and
// StatusManager falls back to its single-chat behaviour.
export interface ToolStartEvent {
  readonly kind: 'tool_start'
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly toolUseId: string
  readonly chatId?: string
  // Streaming thoughts (#1): the session transcript path, so StatusManager can
  // tail-read the agent's latest narration block into the working bubble.
  readonly transcriptPath?: string
}

export interface ToolEndEvent {
  readonly kind: 'tool_end'
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly toolUseId: string
  // Optional masked done-summary; renderer truncates to 30 chars (see
  // gateway.py:1855: dispatch "summary" cap) before display. We carry the
  // raw value so the renderer is the single mask point.
  readonly toolResult?: unknown
  readonly chatId?: string
  readonly transcriptPath?: string
}

// Phase events flip the status to `reasoning…` without recording a tool
// call. SessionStart also opens a status if none is active; Stop closes it.
export interface ReasoningEvent {
  readonly kind: 'reasoning'
  readonly chatId?: string
  readonly transcriptPath?: string
  // True when this UserPromptSubmit is a background-subagent result injection
  // (`<task-notification>` / `…/tasks/<id>.output … completed`), NOT a real
  // user turn. The MAIN session emits exactly one Agent tool event (at
  // dispatch), so the pane-independent continuation window lapses long before
  // the injection storm that respawns the bubble. Marking these injections as
  // subagent activity REFRESHES that window for their whole duration, so the
  // existing swallow + idleTick-refusal keeps a single bubble alive instead of
  // tearing down + respawning every ~20s. The prompt body itself is still
  // dropped — only this boolean classification survives.
  readonly subagentContinuation?: true
  // When subagentContinuation is set, the tool-use-id of the returning Agent
  // dispatch, extracted from the `<tool-use-id>` of the task-notification body.
  // It matches the toolUseId of the original Agent tool_start, so StatusManager
  // can clear EXACTLY this in-flight subagent (idempotent across the repeated
  // injections a single subagent emits). Absent when the body carries no id.
  readonly subagentReturnToolUseId?: string
}

export interface SessionStartEvent {
  readonly kind: 'session_start'
  readonly chatId?: string
  readonly transcriptPath?: string
}

export interface SessionStopEvent {
  readonly kind: 'session_stop'
  // True when this is a service Stop (Claude Code already continuing as a
  // result of a Stop hook). StatusManager treats it as non-terminal and
  // does NOT tear down the status bubble.
  readonly stopHookActive?: boolean
  readonly chatId?: string
}

// PreCompact → arms StatusManager's per-chat compaction guard. The turn
// continues after compaction, so a Stop emitted around it must not be
// mistaken for end-of-turn. Carries no renderable payload.
export interface CompactionStartEvent {
  readonly kind: 'compaction_start'
  readonly chatId?: string
}

export type ActivityStatusEvent =
  | ToolStartEvent
  | ToolEndEvent
  | ReasoningEvent
  | SessionStartEvent
  | SessionStopEvent
  | CompactionStartEvent

// ─────────────────────────────────────────────────────────────────────
// TodoWrite events — consumed by TaskMirror (separate rolling Telegram
// message showing Claude's milestone list). Deliberately NOT folded into
// ActivityStatusEvent: StatusManager / ProgressReporter must stay unaware
// of TodoWrite so the three rolling messages (status bubble, activity
// thread, todo list) keep independent lifecycles.
// ─────────────────────────────────────────────────────────────────────

// Every task event carries the `sessionId` it belongs to. Harness task
// numbering restarts at #1 on every new session, so a surface that keeps a
// snapshot MUST namespace it by session — a task event whose sessionId differs
// from the current snapshot's is a new session, not a continuation. Sourced
// from the hook payload's `session_id` (always present per
// ClaudeHookCommonShape). Consumed by the session-aware TaskMirror, which keys
// its snapshot + persisted epoch on it.
export interface TodoWriteEvent {
  readonly kind: 'todo_write'
  readonly sessionId: string
  readonly todos: ReadonlyArray<TodoItem>
  readonly chatId?: string
}

// TaskCreate / TaskUpdate hooks emitted by the newer Claude Code harness.
// Unlike TodoWrite (which carries the full list per call), these are
// incremental — TaskMirror accumulates them in an internal Map<taskId, TodoItem>
// and renders the synthesised snapshot. PreToolUse of TaskCreate fires before
// the harness assigns a real numeric id, so we pass `toolUseId` as the
// provisional handle and reconcile with the real id in the PostToolUse pass
// (Phase 2 — for now the provisional id stays).
export interface TaskCreateEvent {
  readonly kind: 'task_create'
  readonly sessionId: string
  readonly toolUseId: string
  readonly input: TaskCreateInput
  // Populated on PostToolUse when the harness has materialised the task.
  // Format: usually `Task #<n> created` — TaskMirror runs the same regex
  // extract as the owner's terminal renderer. We map ONLY the PostToolUse
  // pass (see toTodoWriteEvent): a provisional PreToolUse create would race the
  // permission gate on the same event and, if rejected, leave a phantom task.
  readonly toolResult?: unknown
  readonly chatId?: string
}

export interface TaskUpdateEvent {
  readonly kind: 'task_update'
  readonly sessionId: string
  readonly toolUseId: string
  readonly input: TaskUpdateInput
  readonly chatId?: string
}

// Session-stop signal for TaskMirror specifically. Renamed from the
// ActivityStatusEvent variant so the TaskMirror dispatcher does not
// accidentally consume a non-todo Stop hook.
//
// NO LONGER a finalization signal: TaskMirror finalizes on `session_end`, and
// treats this kind as a deliberate no-op (the Stop hook fires at the end of
// EVERY turn, which used to evict the card after every answer). The kind stays
// in the union because the hook still produces it — fork deviation from
// upstream, which deleted it outright.
export interface TodoSessionStopEvent {
  readonly kind: 'todo_session_stop'
  readonly chatId?: string
}

// Session lifecycle signals for the task surfaces. SessionStart lets a surface
// reset its snapshot when the session id changes (a genuine new session) and
// preserve it otherwise (compact / resume keep the same id). SessionEnd is a
// REAL Claude Code hook, unlike Stop which is turn-end.
//
// Both are consumed by TaskMirror: `session_start` resets (new id) or preserves
// (same id) the snapshot, `session_end` finalizes it and tombstones the id.
export interface TaskSessionStartEvent {
  readonly kind: 'session_start'
  readonly sessionId: string
  // SessionStart fires for startup / resume / clear / compact. A surface keys
  // its reset on `sessionId`, not on source; source rides along for display.
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact'
  readonly chatId?: string
}

export interface TaskSessionEndEvent {
  readonly kind: 'session_end'
  readonly sessionId: string
  readonly reason?: string
  readonly chatId?: string
}

export type TaskMirrorEvent =
  | TodoWriteEvent
  | TaskCreateEvent
  | TaskUpdateEvent
  | TodoSessionStopEvent
  | TaskSessionStartEvent
  | TaskSessionEndEvent

// The subset of TaskMirrorEvent that mutates the task snapshot, as opposed to
// the session lifecycle signals. Surfaces that only care about the list
// (TaskMirror.recordEvent, ContextHud.onTodoEvent) gate on this: a lifecycle
// event fed to them would bump the entry and schedule a pointless message edit
// while changing nothing a reader can see.
export type TaskMutationEvent = TodoWriteEvent | TaskCreateEvent | TaskUpdateEvent

export function isTaskMutationEvent(event: TaskMirrorEvent): event is TaskMutationEvent {
  return (
    event.kind === 'todo_write' || event.kind === 'task_create' || event.kind === 'task_update'
  )
}

/**
 * Convert a validated Claude hook payload to an ActivityStatusEvent.
 *
 * `UserPromptSubmit` carries the user prompt text — we deliberately drop it
 * here so the prompt never reaches StatusManager (and through it Telegram).
 * The phase change to `reasoning` is the only signal that survives.
 *
 * Multichat: `payload.chatId` (required by `ClaudeHookCommonShape`) is
 * propagated to every emitted event so StatusManager can route updates to
 * the correct chat. The plugin's webhook handler also surfaces
 * `process.env.CHAT_ID` upstream when a hook fires inside a tmux session
 * that the master process spawned — but propagation from the payload is
 * the source of truth here. `exactOptionalPropertyTypes` requires the
 * property to be absent rather than `undefined`; the helper below
 * conditionally spreads it.
 */
/**
 * Detect a background-subagent result injection. Claude Code injects each
 * finished Task(Agent) into the MAIN session as a UserPromptSubmit whose body
 * is either the `<task-notification>` XML block or the bare
 * `<task-id> <tool-use-id> …/tasks/<id>.output … completed` line. Neither shape
 * occurs in a genuine human prompt, so a positive match safely means "this is a
 * subagent continuation, not a new turn". We classify the body here and discard
 * it — only the boolean reaches StatusManager (the prompt text never leaves).
 */
export function isSubagentNotification(prompt: string): boolean {
  if (/^\s*<task-notification>/.test(prompt)) return true
  // Bare form: a tasks/<id>.output path reported as completed. Require both the
  // output path and the "completed" marker so an unrelated prompt that merely
  // mentions "completed" can't trip it.
  return /\btasks\/[A-Za-z0-9._-]+\.output\b/.test(prompt) && /\bcompleted\b/.test(prompt)
}

/**
 * Pull the returning subagent's tool-use-id out of a task-notification body.
 * Present in the `<tool-use-id>toolu_…</tool-use-id>` of the XML form and as the
 * second token of the bare form (`<task-id> toolu_… …/tasks/<id>.output`). Some
 * follow-up injections (the output-file frame) carry no id — returns undefined
 * then, and the matching pop is simply skipped (the first frame already cleared
 * it). The `toolu_` prefix is unique to tool-use ids, so a bare scan is safe.
 */
export function extractSubagentReturnToolUseId(prompt: string): string | undefined {
  const m = /\btoolu_[A-Za-z0-9]+/.exec(prompt)
  return m ? m[0] : undefined
}

export function toActivityEvent(payload: ClaudeHookPayload): ActivityStatusEvent {
  const chatIdProp =
    payload.chatId !== undefined && payload.chatId !== ''
      ? { chatId: payload.chatId }
      : {}
  // Streaming thoughts (#1): carry the transcript path on the renderable
  // events so StatusManager can tail-read the latest narration block. Absent
  // (rather than `undefined`) when empty, per exactOptionalPropertyTypes.
  const transcriptPathProp =
    typeof payload.transcript_path === 'string' && payload.transcript_path !== ''
      ? { transcriptPath: payload.transcript_path }
      : {}
  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return {
        kind: 'tool_start',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
        ...chatIdProp,
        ...transcriptPathProp,
      }
    case 'PostToolUse': {
      const event: ToolEndEvent = {
        kind: 'tool_end',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
        ...chatIdProp,
        ...transcriptPathProp,
      }
      // exactOptionalPropertyTypes: only attach `toolResult` if defined,
      // otherwise the property must be absent — `undefined` is not allowed.
      return payload.tool_result !== undefined
        ? { ...event, toolResult: payload.tool_result }
        : event
    }
    case 'Stop':
      // exactOptionalPropertyTypes: attach stopHookActive only when true so
      // the property stays absent otherwise.
      return payload.stop_hook_active === true
        ? { kind: 'session_stop', stopHookActive: true, ...chatIdProp }
        : { kind: 'session_stop', ...chatIdProp }
    case 'UserPromptSubmit': {
      if (!isSubagentNotification(payload.prompt)) {
        return { kind: 'reasoning', ...chatIdProp, ...transcriptPathProp }
      }
      const returnId = extractSubagentReturnToolUseId(payload.prompt)
      return {
        kind: 'reasoning',
        subagentContinuation: true,
        ...(returnId !== undefined ? { subagentReturnToolUseId: returnId } : {}),
        ...chatIdProp,
        ...transcriptPathProp,
      }
    }
    case 'SessionStart':
      return { kind: 'session_start', ...chatIdProp, ...transcriptPathProp }
    case 'SessionEnd':
      // The real session end also closes the transient status bubble — same
      // outcome as Stop, reached by a different hook. No stopHookActive here:
      // a SessionEnd is never a service stop that the turn continues past.
      return { kind: 'session_stop', ...chatIdProp }
    case 'PreCompact':
      return { kind: 'compaction_start', ...chatIdProp }
  }
}

/**
 * Convert a validated Claude hook payload to a TaskMirrorEvent.
 *
 * Returns non-null ONLY for events TaskMirror cares about:
 *   - PostToolUse with tool_name === 'TodoWrite' → parses tool_input via
 *     TodoWriteInputSchema. On parse failure, logs a warning and returns
 *     null (graceful degradation — the rolling activity thread still
 *     renders correctly because toActivityEvent handles the same payload
 *     independently).
 *   - Stop → returns `{ kind: 'todo_session_stop' }`. Kept for the hook's
 *     sake only: TaskMirror treats it as a no-op (Stop is turn-end, not
 *     session-end).
 *   - SessionStart / SessionEnd → lifecycle signals (`session_start` /
 *     `session_end`) that drive the mirror's session reset / finalization.
 *
 * Every other hook event returns null so the caller can short-circuit
 * before touching TaskMirror.
 */
export function toTodoWriteEvent(
  payload: ClaudeHookPayload,
  log?: Logger,
): TaskMirrorEvent | null {
  // Same chatId propagation rule as toActivityEvent — the master
  // session's dispatcher passes the event to the right per-chat
  // TaskMirror instance.
  const chatIdProp =
    payload.chatId !== undefined && payload.chatId !== ''
      ? { chatId: payload.chatId }
      : {}

  // session_id is required on every hook payload (ClaudeHookCommonShape); the
  // task events carry it so a surface can namespace its snapshot by session.
  const sessionId = payload.session_id

  if (payload.hook_event_name === 'Stop') {
    return { kind: 'todo_session_stop', ...chatIdProp }
  }

  if (payload.hook_event_name === 'SessionStart') {
    const event: TaskSessionStartEvent = {
      kind: 'session_start',
      sessionId,
      ...(payload.source !== undefined ? { source: payload.source } : {}),
      ...chatIdProp,
    }
    return event
  }

  if (payload.hook_event_name === 'SessionEnd') {
    const event: TaskSessionEndEvent = {
      kind: 'session_end',
      sessionId,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      ...chatIdProp,
    }
    return event
  }

  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TodoWrite') {
    const parsed = TodoWriteInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TodoWrite tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    return { kind: 'todo_write', sessionId, todos: parsed.data.todos, ...chatIdProp }
  }

  // TaskCreate -- PostToolUse ONLY. The harness has assigned the real id by
  // then (carried in `tool_result`) and the create has cleared the permission
  // gate, so we never record a task that a rejected PreToolUse would orphan.
  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TaskCreate') {
    const parsed = TaskCreateInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TaskCreate tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    const event: TaskCreateEvent = {
      kind: 'task_create',
      sessionId,
      toolUseId: payload.tool_use_id,
      input: parsed.data,
      ...chatIdProp,
    }
    return payload.tool_result !== undefined
      ? { ...event, toolResult: payload.tool_result }
      : event
  }

  // TaskUpdate -- mutations carry the real taskId in tool_input. We fire on
  // PostToolUse only: PreToolUse status is what the call WANTS to set, the
  // harness can still reject, so we wait for the post-call confirmation.
  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TaskUpdate') {
    const parsed = TaskUpdateInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TaskUpdate tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    return {
      kind: 'task_update',
      sessionId,
      toolUseId: payload.tool_use_id,
      input: parsed.data,
      ...chatIdProp,
    }
  }

  return null
}
