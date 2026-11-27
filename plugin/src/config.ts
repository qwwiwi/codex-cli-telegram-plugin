// Config loader with Zod validation and state-directory path resolution.

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { parseReactionPalette } from './codex/reactions.js'
import { BRIDGE_UNIT_NAME } from './codex/unit-contract.js'

// ─────────────────────────────────────────────────────────────────────
// AppConfig — the merged, validated runtime config.
// ─────────────────────────────────────────────────────────────────────

// Multichat config — opt-in fleet of per-chat tmux sessions routed by
// the MultichatRouter. Default OFF: the entire feature is gated behind
// `multichat.enabled = true` so existing deployments keep their legacy
// single-DM behaviour without touching wiring. When enabled, the policy
// file (`chats/policy.yaml`) defines per-chat allowlists, streaming
// modes, persona files, and deny rules — see src/chats/policy-loader.ts.
//
// Path defaults:
//   policy_path  -> `{workspace_dir}/chats/policy.yaml`
//   state_dir    -> `{workspace_dir}/state/multichat`
//   workspace_dir -> $CLAUDE_WORKSPACE_DIR, else `path.resolve(cwd, '..')`
// All three are pure strings here so unit tests can assert what the
// caller passed without invoking server.ts. The resolution itself
// happens inside server.ts where `path` is already imported.
export const MultichatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  policy_path: z.string().optional(),
  state_dir: z.string().optional(),
  workspace_dir: z.string().optional(),
  // Route private DMs through the per-chat router too (2026-06-11). Default
  // OFF preserves the legacy routing topology — "main Telegram → master session,
  // group chats → multichat" (see handlers.ts hybrid-routing gate). When ON,
  // a private DM that has its own entry in policy.chats gets its own per-chat
  // tmux session instead of falling through to the legacy master notify, so
  // the DM is uniform with every other routed chat. A DM with no policy entry
  // still falls through to legacy regardless of this flag. Optional (not
  // `.default(false)`) so it stays absent from the inferred type for existing
  // config literals; an undefined value reads as OFF at the gate.
  route_private: z.boolean().optional(),
})
export type MultichatConfig = z.infer<typeof MultichatConfigSchema>

export const AppConfigSchema = z.object({
  bot_id: z.number().int().positive().optional(),
  // `dm_only` predates the multichat router. With `multichat.enabled=false`
  // (default) the legacy gate.ts behaviour is preserved: DM-only with
  // hardcoded drop in the gate. With `multichat.enabled=true` the gate
  // consults the loaded policy instead and this flag is effectively
  // ignored. Kept here for backward compatibility with existing
  // config.json files; do NOT remove without a migration pass.
  dm_only: z.boolean().default(true),
  allowed_user_ids: z.array(z.number().int().positive()).default([]),
  allowed_chat_ids: z.array(z.union([z.number(), z.string()])).default([]),
  // Owner DM chat ids for OWNER-ONLY surfaces (the pinned context HUD + any
  // owner-only command menu). FIX-8: these MUST come from the owner's DM ids,
  // NEVER from `allowed_chat_ids` (which in multichat also lists group ids — a
  // HUD with destructive buttons pinned in a public group is a serious leak).
  // Optional — when omitted, `resolveOwnerChatIds` falls back to
  // `allowed_user_ids` (in a DM the chat id equals the positive user id).
  owner_chat_ids: z.array(z.number().int().positive()).optional(),
  // Model context-window size (tokens) used by /status context usage and the
  // context HUD. Optional — resolved via `resolveContextWindowTokens`, which
  // applies the 200k default in one place.
  context_window_tokens: z.number().int().positive().optional(),
  workspace_root: z.string().optional(),
  // Reminder for a question the agent left OPEN for the owner (2026-11-14).
  // A reply ending on «жду го» parks the turn until he answers; if the answer
  // never comes, nobody is watching — the agent's turn is over. This nudges
  // him. `after_ms: 0` (or TELEGRAM_OPEN_QUESTION_REMINDER_MS=0) disables it.
  open_question_reminder: z.object({
    enabled: z.boolean().default(true),
    // Silence after the question before the first nudge. 25 min: long enough
    // that a reply typed while he reads is never interrupted.
    after_ms: z.number().int().nonnegative().default(1_500_000),
    // Spacing between subsequent nudges.
    repeat_ms: z.number().int().positive().default(3_600_000),
    // Hard cap on nudges per question — after this the record stays (so the
    // state is still inspectable) but the channel goes quiet. Nagging an owner
    // who chose not to answer is worse than staying silent.
    max_reminders: z.number().int().nonnegative().default(2),
  }).default({}),
  status: z.object({
    enabled: z.boolean().default(true),
    // Min spacing between status-bubble edits. Telegram counts edits toward
    // the same ~1 msg/sec per-chat flood limit as sends, so a sub-second
    // default (the old 700) reliably tripped 429 flood bans on busy sessions.
    // 1100 keeps edits just under 1/sec by default; override per-agent via
    // TELEGRAM_STATUS_INTERVAL_MS in channel.env.
    interval_ms: z.number().int().positive().default(1100),
    // Idle timeout for the status bubble, NOT an absolute cap: re-armed on
    // every real activity event (see StatusManager.armTtl), so it only trips
    // after this much continuous silence — i.e. a session that died without a
    // Stop event. 30 min tolerates long silent tool calls (builds, big bash)
    // without ever killing the indicator of an active task.
    ttl_ms: z.number().int().positive().default(1_800_000),
    delete_on_complete: z.boolean().default(true),
    // Owner request 2026-05-27: the bare «Печатает...» bubble is visual
    // noise on top of the TmuxMirror status card. When true, StatusManager
    // skips the initial sendMessage while state is `typing` — the bubble is
    // created lazily on the first thinking/tool/activity transition. Native
    // sendChatAction (header animation) is unaffected.
    suppress_typing_bubble: z.boolean().default(true),
    // Active heartbeat + liveness probe (2026-06-08). The status bubble was
    // REACTIVE — refreshed only on Claude hook events (tool calls). A long
    // pure-Computing turn fires no hooks, so the idle TTL (ttl_ms above) used
    // to cancel a STILL-ALIVE turn into "Остановлено: ttl". With a liveness
    // probe wired (see StatusManager.setLivenessProbe / server.ts), the TTL
    // becomes liveness-aware: while the probe passes (tmux pane changing /
    // claude CPU above cpu_min_pct) the guard re-arms instead of cancelling;
    // after liveness_max_missed consecutive dead probes the bubble flips to
    // "⚠️ Возможно завис" rather than a false "Остановлено". Optional block —
    // when absent the feature defaults ON (only takes effect once a probe is
    // wired), so legacy config.json files need no migration; set
    // `heartbeat.enabled: false` to opt out.
    heartbeat: z.object({
      enabled: z.boolean().default(true),
      // Liveness probe cadence. Independent of the fast animation tick
      // (interval_ms) and the chat-action pulse (4 s) so probing stays cheap.
      liveness_probe_ms: z.number().int().positive().default(30_000),
      // Consecutive dead probes before the bubble shows "Возможно завис".
      liveness_max_missed: z.number().int().min(1).default(3),
      // Reserve liveness signal: min claude-process CPU% (the primary signal
      // is tmux pane-hash change). Consumed by the probe wired in server.ts.
      cpu_min_pct: z.number().min(0).default(2),
      // Deterministic idle-teardown (2026-06-08). A separate, FAST probe that
      // reads the TUI ground truth ("esc to interrupt" present == active turn)
      // via capture-pane — the same signal the prompt-watchdog trusts. When the
      // pane is provably idle (turn over) for idle_confirm consecutive reads
      // AFTER startup_grace_ms, the bubble is torn down cleanly (complete()),
      // not relabelled. This is what makes the bubble vanish the instant the
      // turn ends even when the Stop hook is missed — no blind timer. Only
      // active once a paneStateProbe is wired (server.ts); absent probe = no-op,
      // so existing behaviour and tests are unchanged.
      idle_probe_ms: z.number().int().positive().default(3000),
      // Consecutive idle pane reads required before teardown (debounce against
      // a single transient capture between turns).
      idle_confirm: z.number().int().min(1).default(2),
      // Grace after bubble creation before idle-teardown may fire — lets the
      // TUI actually render "esc to interrupt" so the first reads aren't a
      // false idle on a turn that is just starting.
      startup_grace_ms: z.number().int().positive().default(8000),
      // Never-active backstop (2026-06-10). A phantom bubble whose turn NEVER
      // once showed "esc to interrupt" — e.g. a Telegram message that wedged
      // unsubmitted in the dev-channel input box, so no turn ever started — can
      // outlive the fast idle_confirm path when the pane flickers between
      // idle/unknown and keeps resetting the debounce. After this deadline a
      // bubble that has never been observed 'active' is torn down regardless.
      // A genuine turn paints the active hint within ~1 s, so everActive guards
      // every real turn (including ones paused on a permission dialog).
      never_active_deadline_ms: z.number().int().positive().default(45_000),
    }).optional(),
    // Native Telegram header indicator («печатает…»), driven by sendChatAction
    // on a fixed 4 s pulse (CHAT_ACTION_PULSE_MS in status-manager.ts). It is
    // NOT a message, so it never touches the per-chat message budget — but it
    // is an API call. Typing pulses can account for a large share of daily
    // calls during continuous work.
    // Set `enabled: false` per channel to drop the indicator entirely and keep
    // only the status bubble (which stays configurable via interval_ms).
    // Optional block — absent → indicator ON, legacy configs need no migration.
    chat_action: z.object({
      enabled: z.boolean().default(true),
    }).optional(),
    // Streaming thoughts (#1, 2026-06-08). The working bubble used to show a
    // static `reasoning...` placeholder. With this enabled, StatusManager
    // reads the agent's latest narration `text` block from the transcript
    // (transcript_path on every hook) and streams it — the lines run and
    // update in place, making the bubble look "alive" like the CLI. Off by
    // default: it inverts the deliberate "drop freeform Claude text" privacy
    // policy, so it is opt-in per channel. All text is redacted (paths,
    // tokens, IPs) before render, same as tool lines. Optional block — absent
    // → feature off, legacy configs need no migration. The Codex bridge
    // (codex/work-status.ts) streams the reasoning summary from app-server
    // instead; there read_throttle_ms is the minimum gap between its edits.
    thoughts: z.object({
      enabled: z.boolean().default(false),
      // Tail length of the narration shown in the bubble (chars / lines).
      max_chars: z.number().int().min(40).max(2000).default(280),
      max_lines: z.number().int().min(1).max(8).default(3),
      // Min gap between transcript reads. The read is async and only fires on
      // a rendered hook event; this caps the I/O cadence so a burst of tool
      // hooks can't tail-read the transcript every few ms.
      read_throttle_ms: z.number().int().nonnegative().default(2000),
    }).optional(),
  }).default({}),
  album: z.object({
    flush_ms: z.number().int().positive().default(2000),
  }).default({}),
  voice: z.object({
    provider: z.enum(['groq', 'none']).default('groq'),
    language: z.string().default('ru'),
    model: z.string().default('whisper-large-v3-turbo'),
  }).default({}),
  webhook: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).default(0),
  }).default({}),
  permission_relay: z.object({
    enabled: z.boolean().default(true),
    allowed_user_ids: z.array(z.number().int().positive()).default([]),
    bash_only_proof: z.boolean().default(true),
  }).default({}),
  commands: z.object({
    help: z.boolean().default(true),
    status: z.boolean().default(true),
    stop: z.boolean().default(true),
    reset: z.boolean().default(true),
    new: z.boolean().default(true),
  }).default({}),
  // Phase 8: Memory hooks parity with gateway.py:1938-2035. When a Claude
  // hook (UserPromptSubmit / Stop) fires, the plugin writes a turn entry to
  // <workspace_path>/core/hot/recent.md and a lossless record to
  // <workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl.
  //
  // Deviation from PLAN.md T1: `enabled` defaults to false (plan said true).
  // With default-true, parsing the bare default ({}) trips the superRefine
  // below because workspace_path is required when enabled — that would
  // break every existing test fixture that calls loadConfig() without a
  // memory block. enabled=false off-by-default matches the runtime gate
  // in T7 ("instantiate when enabled=true AND workspace_path set"). The
  // refine still triggers when enabled is explicitly turned on without a
  // workspace, which is the only assertion T1's acceptance demands.
  memory: z.object({
    enabled: z.boolean().default(false),
    workspace_path: z.string().optional(),
    logs_path: z.string().optional(),
    source_tag: z.string().default('tg'),
    agent_label: z.string().optional(),
    max_hot_bytes: z.number().int().positive().default(20480),
    trim_keep_lines: z.number().int().positive().default(600),
    buffer_ttl_ms: z.number().int().positive().default(5 * 60 * 1000),
    buffer_max_entries: z.number().int().positive().default(100),
  }).default({}).superRefine((m, ctx) => {
    if (m.enabled && (m.workspace_path === undefined || m.workspace_path === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memory.workspace_path required when memory.enabled=true',
      })
    }
  }),
  // ProgressReporter (2026-05-18) — persistent Telegram thread that shows
  // tool-by-tool activity in real time. StatusManager owns the transient
  // status bubble; ProgressReporter owns a separate, persistent thread
  // edited via editMessageText. Two surfaces, two concerns. Disable here
  // to fall back to silent-then-final UX.
  //
  // session_ttl_ms guards against stuck entries when a `session_stop`
  // hook is lost (Claude crash, dropped webhook). After this idle period
  // the next event for the chat starts a fresh progress thread instead
  // of editing into the old (now stale) message.
  //
  // recent_buffer aligned with StatusManager.ACTIVITY_MAX_BUFFER (10)
  // so the two surfaces report the same "+N earlier" tail count.
  progress: z.object({
    enabled: z.boolean().default(true),
    edit_throttle_ms: z.number().int().nonnegative().default(3000),
    recent_buffer: z.number().int().positive().default(10),
    session_ttl_ms: z.number().int().positive().default(10 * 60 * 1000),
  }).default({}),
  // TaskMirror (PR-A2, 2026-05-20) — third rolling Telegram message per chat,
  // showing Claude's TodoWrite milestones (in-progress / pending / completed).
  // Coexists with StatusManager bubble and ProgressReporter activity thread —
  // never shares state. Single-slot queue + throttle mirror ProgressReporter.
  //
  // session_ttl_ms is NOT an idle-eviction timer here (unlike ProgressReporter):
  // the mirror is session-scoped, so an idle snapshot of the LIVE session never
  // expires. The TTL only decides what happens to the previous snapshot when the
  // session actually changes — fresh (within TTL) finalizes with the marker,
  // stale is dropped silently as an orphan.
  //
  // collapse_completed_after: keep last N completed items in the rendered
  // list, older ones collapse to «+M завершено ранее» — the owner wants
  // to see the active milestone, not a wall of done items.
  task_mirror: z.object({
    enabled: z.boolean().default(true),
    edit_throttle_ms: z.number().int().nonnegative().default(3000),
    session_ttl_ms: z.number().int().positive().default(10 * 60 * 1000),
    collapse_completed_after: z.number().int().nonnegative().default(5),
  }).default({}),
  // InboundWatcher (PR-A3, 2026-05-20) — auto-reply «Агент занят» when the
  // owner sends plain text while a Claude session is mid-tool. Debounced
  // per chat (debounce_ms = 10s by default) so a burst of messages doesn't
  // bury the conversation in auto-acks. Busy threshold is the ProgressReporter
  // lastActivityMs window — anything more recent than busy_threshold_ms
  // counts as «still working».
  //
  // The watcher NEVER replaces the channel notification — it auto-replies
  // AND lets the original message flow to Claude through the normal path.
  watcher: z.object({
    enabled: z.boolean().default(false),
    debounce_ms: z.number().int().nonnegative().default(10_000),
    busy_threshold_ms: z.number().int().positive().default(30_000),
    // Mid-turn ack text (Level 1, 2026-06-04). When set, the auto-reply uses
    // this verbatim (HTML-escaped) INSTEAD of the legacy «Агент занят,
    // активный инструмент: …» tool-name message. Lets each agent pick a
    // positive tone — e.g. «✋ Принял, добавлю к текущей задаче» — signalling
    // a message that arrived mid-turn was seen and will be folded in.
    // Unset/empty → legacy tool-name message.
    busy_text: z.string().optional(),
  }).default({}),
  // TmuxMirror (2026-05-20) — read-only view of the agent's terminal pane
  // mirrored into one rolling Telegram message via editMessageText. Pulls
  // `tmux capture-pane` on a timer, dedups by hash, and self-heals when
  // the message is deleted (re-sends on next poll).
  //
  // Default-OFF: pane content can include unexpected secrets, and the
  // owner should opt in explicitly. Enable via config.json or env.
  // pane_target follows the `session:window.pane` syntax — empty string
  // means «use the session in $TMUX env at startup».
  tmux_mirror: z.object({
    enabled: z.boolean().default(false),
    pane_target: z.string().default(''),
    poll_interval_ms: z.number().int().min(500).default(5000),
    line_count: z.number().int().min(5).max(500).default(50),
    // Segments to drop from the rendered mirror. Default hides the boot
    // banner (Claude Code splash + email + path), the inbound-injection
    // warning, the footer hints (bypass-perms, auto-update, focus-events,
    // /btw Tip line) AND the input box (the bordered prompt area —
    // ── separators + ❯/> cursor). `inbound_preview` stays visible by
    // default because `latest_inbound_only` mode anchors on it; hiding
    // it would silently turn the mode into a no-op (filter applies mode
    // BEFORE hide, but only `latest_inbound_only` survives that order —
    // see tmux-pane-filter.filterPane). Pass an empty list to mirror
    // raw pane content. Validated against the SegmentType enum to keep
    // typos out of production — bad values fail config load loud.
    hide_segments: z
      .array(
        z.enum([
          'boot_banner',
          'inbound_warning',
          'channel_status',
          'conversation',
          'footer_hints',
          'input_box',
          'inbound_preview',
        ]),
      )
      .default(['boot_banner', 'inbound_warning', 'footer_hints', 'input_box']),
    // Anchor mode for the rolling mirror. `latest_inbound_only` (default,
    // 2026-05-22) drops every pane segment up to and including the last
    // `← <channel>: …` preview Claude Code emitted — only what the agent
    // is doing AFTER the owner's most recent message remains. Falls
    // back to `full_pane` automatically when no preview exists in the
    // current capture (fresh session). Set to `full_pane` to mirror the
    // whole pane (pre-2026-05-22 behaviour).
    mode: z.enum(['full_pane', 'latest_inbound_only']).default('latest_inbound_only'),
    // Max lines kept in the rendered mirror, post-filter. Default 14 —
    // empirically that fits one iPhone-screen worth of Telegram <pre>
    // content (the owner asked for ≤70% screen height on 2026-05-22).
    // Truncation removes from the TOP (oldest), preserving the live
    // tail, and prepends a `… +N lines` marker that counts toward the
    // cap. Set to 0 to disable (uncapped, only the 4096-char body cap
    // in renderBody still applies). Codex review 2026-05-22 [medium]
    // tightened the allowed range to `0` or `4..100` — values 1..3
    // render only the marker plus 0..2 lines, which is degenerate and
    // not useful in production.
    max_lines: z
      .number()
      .int()
      .refine((n) => n === 0 || (n >= 4 && n <= 100), {
        message: 'max_lines must be 0 (disabled) or an integer in 4..100',
      })
      .default(14),
  }).default({}),
  // Multichat router (Phase 3, 2026-05-23). Default OFF. When enabled,
  // server.ts loads `chats/policy.yaml`, instantiates TmuxSessionPool +
  // MultichatRouter, and routes inbound traffic through them. Schema
  // declared above AppConfigSchema so the type can be re-exported.
  multichat: MultichatConfigSchema.default({}),
  // AskUserQuestion relay (Phase ?, 2026-05-27, PRX-1 TASK-6). Bridges
  // Claude Code's native AskUserQuestion tool requests into Telegram so
  // the owner can answer from Telegram while a session runs headless.
  //
  // Default OFF: until a smoke run on staging proves the round-trip,
  // AskUserQuestion still flows through the native Claude Code UI and
  // the relay stays dormant. Flip `enabled=true` once TASK-1..TASK-5
  // are wired and the audit JSONL is healthy.
  //
  // `allowed_user_ids` left undefined means «inherit from permission_relay
  // at runtime» — TASK-1 / TASK-3 must resolve `?? permission_relay
  // .allowed_user_ids` at the moment they need a recipient set. We
  // deliberately do NOT copy the default here: duplicating the owner
  // id would create two sources of truth that can drift. The fallback
  // is enforced in code (see resolveAskUserQuestionAllowedUserIds below)
  // so a single change to permission_relay.allowed_user_ids propagates
  // to AskUserQuestion automatically.
  //
  // `timeout_ms` caps how long the relay waits for a Telegram answer
  // before emitting a `request_timeout` event and letting Claude fall
  // back to its native flow. 5 min matches typical owner response
  // latency without leaving stale callbacks behind.
  //
  // `max_preview_chars` bounds the per-option preview rendered in the
  // Telegram question card. Claude's option.preview can be long; this
  // truncates per-option content before grammy formats the message.
  ask_user_question: z.object({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(300_000),
    allowed_user_ids: z.array(z.number().int().positive()).optional(),
    max_preview_chars: z.number().int().positive().default(1000),
  }).default({}),
  // Permission-gate (PreToolUse hook) confirm-tier relay. `enabled` gates the
  // webhook route + Telegram Allow/Deny card; the hook's built-in hard-deny
  // applies regardless. `timeout_ms` caps how long the relay waits for a tap
  // before fail-closing to deny. `allowed_user_ids` omitted → inherit
  // permission_relay.allowed_user_ids (see resolvePermissionGateAllowedUserIds).
  permission_gate: z.object({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(120_000),
    allowed_user_ids: z.array(z.number().int().positive()).optional(),
  }).default({}),
  // Guest Mode (Bot API 10.0) — @-mention the bot in ANY chat (including
  // chats the bot is not a member of); Telegram delivers a one-shot
  // `guest_message` update and the bot answers exactly once via
  // answerGuestQuery. Requires the owner to flip the Guest Mode toggle in
  // BotFather (getMe.supports_guest_queries turns true).
  //
  // Default OFF: the handler is only registered when enabled, so existing
  // deployments see zero behaviour change until the operator opts in.
  //
  // `allowed_user_ids` omitted → inherit the top-level `allowed_user_ids`
  // (the owner DM allowlist) via resolveGuestModeAllowedUserIds — same
  // single-source-of-truth pattern as permission_relay inheritance. The
  // gate is fail-closed on `guest_bot_caller_user.id`: mentions from
  // anyone else are silently dropped (no answerGuestQuery spent).
  //
  // The whole block is OPTIONAL (no `.default({})`) — same trick as `hud`
  // below — so the many pre-guest test config literals stay valid without
  // adding the field. `resolveGuestModeEnabled` applies the off-by-default
  // fallback in one place.
  guest_mode: z.object({
    enabled: z.boolean().default(false),
    allowed_user_ids: z.array(z.number().int().positive()).optional(),
  }).optional(),
  // Rich Messages (M1, 2026-06-14) — Telegram Bot API 10.1. When enabled, a
  // DM reply whose format is html/rich ships as ONE raw-markdown message that
  // Telegram renders server-side (tables/math/headings/task-lists), with a
  // TRANSPARENT fallback to the HTML path on any rejection. Default ON: the
  // fallback makes it safe to enable everywhere — a build without the method
  // latches off after one call and behaves exactly like before.
  //
  // `perChatOptOut` holds chat_ids (as strings, matching the inbound
  // <channel chat_id="…">) that should NEVER receive rich messages — they
  // always take the HTML path. Kill switch: set env TELEGRAM_RICH_MESSAGES to
  // a falsy value (0/false/no/off) to force enabled=false fleet-wide.
  richMessages: z.object({
    enabled: z.boolean().default(true),
    perChatOptOut: z.array(z.string()).default([]),
  }).default({}),
  // Context HUD (wave 3B) — a single pinned Telegram message in the owner's
  // chat that shows context-window usage (bar + percentage) plus the «Сжать»
  // action button, refreshed after each turn (SessionStart / Stop hooks).
  //
  // FORK DEVIATION from upstream (which defaults ON): this fork stages the HUD
  // OFF. The block is OPTIONAL (no `.default({})`) so `hud` reads as
  // `hud?: { enabled: boolean }` on the inferred type — existing full-config
  // test literals that predate this field stay valid without adding it. The
  // schema default is `false` AND `resolveHudEnabled` falls back to `false`
  // (belt + suspenders): a missing block and a bare `hud: {}` both resolve to
  // OFF; only an explicit `{ enabled: true }` turns the HUD on.
  hud: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  // Persistent outbox (2026-07-07) — on a LONG flood ban the reply tool's
  // fail-fast path throws; the undelivered reply is persisted and a background
  // flusher re-sends it once the ban lifts. DEFAULT-OFF, same optional-block
  // shape as `hud` so existing full-config test literals stay valid; only an
  // explicit `{ enabled: true }` (or TELEGRAM_OUTBOX_ENABLED) turns it on.
  outbox: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  // Ask-guard (autonomy M3, ported from upstream 2026-10-16) — the ENFORCEMENT
  // of owner-granted autonomy mandates on the owner-egress reply path. When the
  // agent holds an ACTIVE lease for a chat and still writes a «жду го / дай
  // добро»-style self-gating permission-ask, the guard intercepts (see
  // safety/ask-guard.ts).
  //
  //   `mode`:
  //     'off'      — never engage (equivalent to the kill-switch);
  //     'advisory' — the reply IS sent, plus an `ask_guard_hint` nudging the
  //                  agent to act-with-veto (the calibration-week default);
  //     'block'    — the reply is REFUSED (isError, not sent); the agent must
  //                  act in-scope and report, or ask via the AskUserQuestion
  //                  card (that path is never guarded).
  //
  // The block is OPTIONAL (no `.default({})`), like `hud`/`outbox` above, so
  // existing full-config test literals stay valid without adding it.
  // `resolveAskGuardMode` applies the 'advisory' default and the env overrides
  // (`ASK_GUARD_MODE`, kill-switch `ASK_GUARD_ENABLED=0`) in one place.
  ask_guard: z.object({
    mode: z.enum(['off', 'advisory', 'block']).default('advisory'),
  }).optional(),
})
export type AppConfig = z.infer<typeof AppConfigSchema>

// ─────────────────────────────────────────────────────────────────────
// RuntimeEnv — environment variables that can override config.json
// ─────────────────────────────────────────────────────────────────────

export const RuntimeEnvSchema = z.object({
  XDG_STATE_HOME: z.string().optional(),
  KROT_BRAIN_SAVE_NOTICE: z.enum(['on', 'off']).default('off'),
  KROT_BRAIN_REVIEW_BUTTONS: z.enum(['on', 'off']).default('off'),
  KROT_CODEX_AGENT_ID: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_STATE_DIR: z.string().optional(),
  TELEGRAM_CONFIG_FILE: z.string().optional(),
  TELEGRAM_EXPECTED_BOT_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(), // CSV
  // CSV of chat ids; entries may be integers (user/group/channel id, possibly
  // negative for supergroups) or @username strings. In a Telegram DM
  // `chat.id == user.id`, so a DM-only deployment typically sets this to the
  // same value as TELEGRAM_ALLOWED_USER_IDS — without this, gate.ts:
  // chat_not_allowed silently drops every inbound DM.
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  TELEGRAM_WORKSPACE_ROOT: z.string().optional(),
  TELEGRAM_STATUS_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  // Streaming thoughts in the working bubble (status.thoughts.enabled). Same
  // shape as TELEGRAM_HUD_ENABLED: 0/false/no/off forces it off, any other
  // value on. Unset = config.json / schema default (off). A fresh install
  // writes TELEGRAM_STATUS_THOUGHTS=1.
  TELEGRAM_STATUS_THOUGHTS: z
    .string()
    .transform((v) => !/^(0|false|no|off)$/i.test(v.trim()))
    .optional(),
  // Delay before the first open-question reminder. 0 switches the feature off
  // — one knob per channel.env, no second boolean to keep in sync.
  TELEGRAM_OPEN_QUESTION_REMINDER_MS: z.coerce.number().int().nonnegative().optional(),
  TELEGRAM_ALBUM_FLUSH_MS: z.coerce.number().int().positive().optional(),
  GROQ_API_KEY: z.string().optional(),
  KROT_CODEX_SERVICE_NAME: z.string().regex(BRIDGE_UNIT_NAME).or(z.literal('')).optional(),
  // never: no approval cards at all, even with KROT_CODEX_APPROVALS=1 (codex/approval-mode.ts).
  KROT_CODEX_APPROVAL_MODE: z.enum(['standard', 'risky', 'never']).optional(),
  // Codex sandbox (session.ts CodexSandboxMode). Absent means workspace-write.
  // danger-full-access only for a dedicated unprivileged OS user.
  KROT_CODEX_SANDBOX: z.enum(['workspace-write', 'danger-full-access']).optional(),
  // Reactions (codex/reactions.ts). off: no automatic 👀 on inbound owner messages; unset keeps eyes.
  KROT_ACK_REACTION: z.enum(['off', 'eyes']).optional(),
  // The emoji the agent may react with itself, comma-separated; each must be a Telegram reaction.
  KROT_REACTION_PALETTE: z.string().superRefine((value, ctx) => {
    try { parseReactionPalette(value) } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) })
    }
  }).optional(),
  TELEGRAM_WEBHOOK_HOST: z.string().optional(),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().min(0).optional(),
  TELEGRAM_WEBHOOK_TOKEN: z.string().optional(),
  // Phase 8 memory env overrides. ENABLED accepts the usual truthy strings
  // (1/true/yes, case-insensitive); anything else parses as false so a
  // typo doesn't silently turn the feature on.
  TELEGRAM_MEMORY_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_MEMORY_WORKSPACE: z.string().optional(),
  TELEGRAM_MEMORY_LOGS_PATH: z.string().optional(),
  TELEGRAM_MEMORY_SOURCE_TAG: z.string().optional(),
  TELEGRAM_MEMORY_AGENT_LABEL: z.string().optional(),
  // Journal size knobs (2026-09-13). Per-agent tuning belongs in
  // channel.env, not in every checkout's config.ts. `.catch(undefined)`
  // so a typo falls back to the default instead of refusing to boot the
  // channel — an oversized journal beats a dead agent.
  TELEGRAM_MEMORY_MAX_HOT_BYTES: z.coerce.number().int().positive().optional().catch(undefined),
  TELEGRAM_MEMORY_TRIM_KEEP_LINES: z.coerce.number().int().positive().optional().catch(undefined),
  // PLAN.md Scope A only ships static allowlist mode; `pairing` is reserved
  // for Scope B. We accept both values at the schema level so we can emit
  // a clear, scope-aware error message (the bare `z.enum(['static'])` form
  // gave a cryptic "Invalid enum value" that didn't explain why).
  TELEGRAM_ACCESS_MODE: z
    .enum(['static', 'pairing'])
    .refine((v) => v === 'static', {
      message:
        "TELEGRAM_ACCESS_MODE=pairing not supported in this server build (use 'allowlist'); see PLAN.md Scope B",
    })
    .optional(),
  // Multichat (Phase 3, 2026-05-23). ENABLED accepts the same truthy
  // strings as TELEGRAM_MEMORY_ENABLED so the two flags share a mental
  // model. Paths are passed through verbatim — server.ts resolves
  // defaults relative to workspace_dir.
  TELEGRAM_MULTICHAT_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_MULTICHAT_POLICY_PATH: z.string().optional(),
  TELEGRAM_MULTICHAT_STATE_DIR: z.string().optional(),
  TELEGRAM_MULTICHAT_WORKSPACE_DIR: z.string().optional(),
  // AskUserQuestion relay (PRX-1 TASK-6, 2026-05-27). ENABLED follows the
  // same truthy convention as the multichat/memory flags so operators
  // memorise one mental model. ALLOWED_USER_IDS is CSV (parsed below with
  // a stricter parser than z.coerce — negative / non-integer / empty
  // entries must throw clearly, not silently coerce to NaN).
  TELEGRAM_ASK_USER_QUESTION_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS: z.string().optional(), // CSV
  TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS: z.coerce.number().int().positive().optional(),
  // Rich Messages (M1, 2026-06-14). Kill switch: a falsy value
  // (0/false/no/off, case-insensitive) forces richMessages.enabled=false;
  // anything else (1/true/yes/on …) forces it true. Unset = config.json /
  // schema default (true). Parsed to a boolean here; layered onto the
  // richMessages block in loadConfig.
  TELEGRAM_RICH_MESSAGES: z
    .string()
    .transform((v) => !/^(0|false|no|off)$/i.test(v.trim()))
    .optional(),
  // CSV of chat_ids that always take the HTML path (never rich). Mirrors the
  // CSV chat-id parsing used for the allowlist; stored as strings to match
  // the inbound <channel chat_id="…"> form the reply tool compares against.
  TELEGRAM_RICH_MESSAGES_PER_CHAT_OPT_OUT: z.string().optional(), // CSV
  // Context HUD (2026-07-06). Kill switch mirrors TELEGRAM_RICH_MESSAGES: a
  // falsy value (0/false/no/off) forces hud.enabled=false; anything else forces
  // true. Unset = config.json / schema default (false). Layered in loadConfig.
  TELEGRAM_HUD_ENABLED: z
    .string()
    .transform((v) => !/^(0|false|no|off)$/i.test(v.trim()))
    .optional(),
  // Persistent outbox kill switch (2026-07-07). Same shape as HUD: a falsy
  // value (0/false/no/off) forces outbox.enabled=false; anything else true.
  // Unset = config.json / schema default (false). Layered in loadConfig.
  TELEGRAM_OUTBOX_ENABLED: z
    .string()
    .transform((v) => !/^(0|false|no|off)$/i.test(v.trim()))
    .optional(),
  TELEGRAM_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().optional(),
  TELEGRAM_OWNER_CHAT_IDS: z.string().optional(), // CSV; falls back to allowed_user_ids
})
export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>

// ─────────────────────────────────────────────────────────────────────
// Secret redaction. Thin wrapper over the unified `redactSecrets` (see
// src/safety/redact.ts). Kept here for back-compat with src/log.ts and
// src/server.ts — those still import `redactToken` by name. Anything
// new should import `redactSecrets` directly.
// ─────────────────────────────────────────────────────────────────────

import { redactSecrets } from './safety/redact.js'

export function redactToken(message: string, extraSecrets: ReadonlyArray<string> = []): string {
  return redactSecrets(message, extraSecrets)
}

// ─────────────────────────────────────────────────────────────────────
// loadConfig — merges env + config.json into validated AppConfig.
// Order of precedence: env > config.json > schema defaults.
// Errors are re-thrown with the bot token redacted.
// ─────────────────────────────────────────────────────────────────────

function pickEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Filter to only known keys so Zod's `unknownKeys` (default strip) is irrelevant
  // and we don't accidentally pipe unrelated env into validation.
  const keys = Object.keys(RuntimeEnvSchema.shape)
  const out: NodeJS.ProcessEnv = {}
  for (const k of keys) {
    if (env[k] !== undefined) out[k] = env[k]
  }
  return out
}

function parseCsvUserIds(csv: string): number[] {
  const ids: number[] = []
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid user id in CSV: ${JSON.stringify(trimmed)}`)
    }
    ids.push(n)
  }
  return ids
}

// Chat ids are heterogeneous: groups/supergroups are negative ints, users
// are positive ints, channels can be referenced as @username strings. We
// keep @-prefixed entries as strings and require everything else to be a
// non-zero integer.
function parseCsvChatIds(csv: string): Array<number | string> {
  const ids: Array<number | string> = []
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('@')) {
      ids.push(trimmed)
      continue
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n === 0) {
      throw new Error(`invalid chat id in CSV: ${JSON.stringify(trimmed)}`)
    }
    ids.push(n)
  }
  return ids
}

function resolveStateRoot(env: RuntimeEnv): string {
  return env.TELEGRAM_STATE_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'krotov-plugin')
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  let parsedEnv: RuntimeEnv
  try {
    parsedEnv = RuntimeEnvSchema.parse(pickEnv(env))
  } catch (err) {
    throw new Error(redactToken(`invalid env: ${err instanceof Error ? err.message : String(err)}`))
  }

  // Resolve state dir (we need it to find default config.json path).
  const stateRoot = resolveStateRoot(parsedEnv)
  const configPath = parsedEnv.TELEGRAM_CONFIG_FILE ?? join(stateRoot, 'config.json')

  // Read config.json if it exists. Missing file is fine — defaults apply.
  let fileConfig: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileConfig = parsed as Record<string, unknown>
      } else {
        throw new Error(`config.json must be a JSON object`)
      }
    } catch (err) {
      throw new Error(redactToken(
        `failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      ))
    }
  }

  // Apply env overrides on top of file config. Env wins.
  const merged: Record<string, unknown> = { ...fileConfig }

  if (parsedEnv.TELEGRAM_EXPECTED_BOT_ID !== undefined) {
    merged.bot_id = parsedEnv.TELEGRAM_EXPECTED_BOT_ID
  }
  if (parsedEnv.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    merged.allowed_user_ids = parseCsvUserIds(parsedEnv.TELEGRAM_ALLOWED_USER_IDS)
  }
  if (parsedEnv.TELEGRAM_ALLOWED_CHAT_IDS !== undefined) {
    merged.allowed_chat_ids = parseCsvChatIds(parsedEnv.TELEGRAM_ALLOWED_CHAT_IDS)
  }
  if (parsedEnv.TELEGRAM_WORKSPACE_ROOT !== undefined) {
    merged.workspace_root = parsedEnv.TELEGRAM_WORKSPACE_ROOT
  }

  // Nested overrides: status.interval_ms, album.flush_ms, webhook.{host,port}
  const status = (merged.status && typeof merged.status === 'object' ? merged.status : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_STATUS_INTERVAL_MS !== undefined) {
    status.interval_ms = parsedEnv.TELEGRAM_STATUS_INTERVAL_MS
  }
  if (parsedEnv.TELEGRAM_STATUS_THOUGHTS !== undefined) {
    const thoughts = status.thoughts && typeof status.thoughts === 'object' ? status.thoughts : {}
    status.thoughts = { ...thoughts, enabled: parsedEnv.TELEGRAM_STATUS_THOUGHTS }
  }
  if (Object.keys(status).length > 0) merged.status = status

  const openQuestion = (
    merged.open_question_reminder && typeof merged.open_question_reminder === 'object'
      ? merged.open_question_reminder
      : {}
  ) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_OPEN_QUESTION_REMINDER_MS !== undefined) {
    const ms = parsedEnv.TELEGRAM_OPEN_QUESTION_REMINDER_MS
    openQuestion.after_ms = ms
    // 0 means "off", not "remind immediately" — `after_ms` alone would arm a
    // nudge on every single question with no delay at all.
    if (ms === 0) openQuestion.enabled = false
  }
  if (Object.keys(openQuestion).length > 0) merged.open_question_reminder = openQuestion

  const album = (merged.album && typeof merged.album === 'object' ? merged.album : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_ALBUM_FLUSH_MS !== undefined) {
    album.flush_ms = parsedEnv.TELEGRAM_ALBUM_FLUSH_MS
  }
  if (Object.keys(album).length > 0) merged.album = album

  const webhook = (merged.webhook && typeof merged.webhook === 'object' ? merged.webhook : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_WEBHOOK_HOST !== undefined) webhook.host = parsedEnv.TELEGRAM_WEBHOOK_HOST
  if (parsedEnv.TELEGRAM_WEBHOOK_PORT !== undefined) webhook.port = parsedEnv.TELEGRAM_WEBHOOK_PORT
  if (Object.keys(webhook).length > 0) merged.webhook = webhook

  // Phase 8 memory env overrides.
  const memory = (merged.memory && typeof merged.memory === 'object' ? merged.memory : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_MEMORY_ENABLED !== undefined) memory.enabled = parsedEnv.TELEGRAM_MEMORY_ENABLED
  if (parsedEnv.TELEGRAM_MEMORY_WORKSPACE !== undefined) memory.workspace_path = parsedEnv.TELEGRAM_MEMORY_WORKSPACE
  if (parsedEnv.TELEGRAM_MEMORY_LOGS_PATH !== undefined) memory.logs_path = parsedEnv.TELEGRAM_MEMORY_LOGS_PATH
  if (parsedEnv.TELEGRAM_MEMORY_SOURCE_TAG !== undefined) memory.source_tag = parsedEnv.TELEGRAM_MEMORY_SOURCE_TAG
  if (parsedEnv.TELEGRAM_MEMORY_AGENT_LABEL !== undefined) memory.agent_label = parsedEnv.TELEGRAM_MEMORY_AGENT_LABEL
  if (parsedEnv.TELEGRAM_MEMORY_MAX_HOT_BYTES !== undefined) memory.max_hot_bytes = parsedEnv.TELEGRAM_MEMORY_MAX_HOT_BYTES
  if (parsedEnv.TELEGRAM_MEMORY_TRIM_KEEP_LINES !== undefined) memory.trim_keep_lines = parsedEnv.TELEGRAM_MEMORY_TRIM_KEEP_LINES
  if (Object.keys(memory).length > 0) merged.memory = memory

  // Multichat env overrides (Phase 3, 2026-05-23). Same pattern as the
  // memory block: take an existing config.json sub-object if present,
  // layer env on top, and only emit the sub-object when something is set
  // — leaving it undefined lets Zod apply schema defaults cleanly.
  const multichat = (merged.multichat && typeof merged.multichat === 'object' ? merged.multichat : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_MULTICHAT_ENABLED !== undefined) multichat.enabled = parsedEnv.TELEGRAM_MULTICHAT_ENABLED
  if (parsedEnv.TELEGRAM_MULTICHAT_POLICY_PATH !== undefined) multichat.policy_path = parsedEnv.TELEGRAM_MULTICHAT_POLICY_PATH
  if (parsedEnv.TELEGRAM_MULTICHAT_STATE_DIR !== undefined) multichat.state_dir = parsedEnv.TELEGRAM_MULTICHAT_STATE_DIR
  if (parsedEnv.TELEGRAM_MULTICHAT_WORKSPACE_DIR !== undefined) multichat.workspace_dir = parsedEnv.TELEGRAM_MULTICHAT_WORKSPACE_DIR
  if (Object.keys(multichat).length > 0) merged.multichat = multichat

  // AskUserQuestion env overrides (PRX-1 TASK-6, 2026-05-27). Same layering
  // pattern as the multichat block above.
  const askUserQuestion = (merged.ask_user_question && typeof merged.ask_user_question === 'object'
    ? merged.ask_user_question
    : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_ENABLED !== undefined) {
    askUserQuestion.enabled = parsedEnv.TELEGRAM_ASK_USER_QUESTION_ENABLED
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS !== undefined) {
    askUserQuestion.timeout_ms = parsedEnv.TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS !== undefined) {
    askUserQuestion.allowed_user_ids = parseCsvUserIds(parsedEnv.TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS)
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS !== undefined) {
    askUserQuestion.max_preview_chars = parsedEnv.TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS
  }
  if (Object.keys(askUserQuestion).length > 0) merged.ask_user_question = askUserQuestion

  // Rich Messages env overrides (M1, 2026-06-14). Same layering pattern as the
  // blocks above. The perChatOptOut CSV reuses parseCsvChatIds for validation,
  // then stringifies each entry to match the string form the reply tool
  // compares the inbound chat_id against.
  const richMessages = (merged.richMessages && typeof merged.richMessages === 'object'
    ? merged.richMessages
    : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_RICH_MESSAGES !== undefined) {
    richMessages.enabled = parsedEnv.TELEGRAM_RICH_MESSAGES
  }
  if (parsedEnv.TELEGRAM_RICH_MESSAGES_PER_CHAT_OPT_OUT !== undefined) {
    richMessages.perChatOptOut = parseCsvChatIds(parsedEnv.TELEGRAM_RICH_MESSAGES_PER_CHAT_OPT_OUT).map(String)
  }
  if (Object.keys(richMessages).length > 0) merged.richMessages = richMessages

  // Context HUD env overrides (2026-07-06). Same layering pattern as rich above.
  const hud = (merged.hud && typeof merged.hud === 'object'
    ? merged.hud
    : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_HUD_ENABLED !== undefined) {
    hud.enabled = parsedEnv.TELEGRAM_HUD_ENABLED
  }
  if (Object.keys(hud).length > 0) merged.hud = hud

  // Persistent outbox env override (2026-07-07). Same layering as hud above.
  const outbox = (merged.outbox && typeof merged.outbox === 'object'
    ? merged.outbox
    : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_OUTBOX_ENABLED !== undefined) {
    outbox.enabled = parsedEnv.TELEGRAM_OUTBOX_ENABLED
  }
  if (Object.keys(outbox).length > 0) merged.outbox = outbox
  if (parsedEnv.TELEGRAM_CONTEXT_WINDOW_TOKENS !== undefined) {
    merged.context_window_tokens = parsedEnv.TELEGRAM_CONTEXT_WINDOW_TOKENS
  }
  if (parsedEnv.TELEGRAM_OWNER_CHAT_IDS !== undefined) {
    merged.owner_chat_ids = parseCsvChatIds(parsedEnv.TELEGRAM_OWNER_CHAT_IDS)
      .map((x) => (typeof x === 'number' ? x : Number(x)))
      .filter((n) => Number.isFinite(n))
  }

  try {
    return AppConfigSchema.parse(merged)
  } catch (err) {
    throw new Error(redactToken(
      `invalid config: ${err instanceof Error ? err.message : String(err)}`,
    ))
  }
}

// ─────────────────────────────────────────────────────────────────────
// StatePaths — all on-disk locations relative to state root.
// ─────────────────────────────────────────────────────────────────────

export type StatePaths = {
  root: string
  env: string
  config: string
  allowlist: string
  pid: string
  lock: string
  updateOffset: string
  inbox: string
  sessionIds: string
  // Single-line file holding the chatId of the turn currently being served.
  // Written by StatusManager.start() on every inbound turn; read by the
  // post-hook proxy so Claude Code hook activity (working/typing/tool blocks)
  // routes to whoever sent the message, not a static env chatId.
  activeHookChat: string
  // Restart-recovery file for orphaned status bubbles (2026-06-07). Holds
  // { chatId: messageId } for every live status bubble; swept + truncated on
  // boot so a wedge→restart can't leave a frozen "working" message behind.
  statusOrphans: string
  // Per-chat forum-topic memory (2026-06-09). Holds { chatId: threadId } for
  // the last inbound topic of each chat so a reply defaults into the topic the
  // message came from instead of the supergroup's General. See thread-store.ts.
  chatThreads: string
  // Open questions awaiting the owner's answer (reminder sweep, 2026-11-14).
  // One record per chat; cleared by an inbound text or a question-free reply.
  // See open-question-store.ts.
  openQuestions: string
  deadLetterUpdates: string
  deadLetterWebhook: string
  // Quarantine bucket for OUTBOUND Telegram sends that failed after the
  // reliable wrapper's bounded retry policy (network / 5xx). Distinct from the
  // inbound `updates`/`webhook` buckets so delivery failures triage separately.
  // A flood ban (429) does NOT land here — the outbox re-sends those.
  deadLetterOutbound: string
  logs: {
    server: string
    telegram: string
    permissions: string
    webhook: string
    /**
     * AskUserQuestion relay audit JSONL (PRX-1 TASK-6, 2026-05-27).
     * Event types written by TASK-1: `request_created`, `request_answered`,
     * `request_timeout`, `request_unauthorized`, `request_duplicate`.
     * Path is exposed here; TASK-1 is the only writer.
     */
    ask_user_question: string
    /**
     * Permission-gate relay audit JSONL (2026-06-09). Event types:
     * `request_created`, `request_resolved`. Written by the webhook route.
     */
    permission_gate: string
    /**
     * Control-command journal JSONL (2026-10-03). One line per /clear, /compact
     * … injected into the agent's pane: outcome, the stage it ended at, the
     * pane state seen at the probe, and the poll counts. Added after a failed
     * /new could only be diagnosed by cross-referencing Telegram send
     * timestamps, because this path wrote nothing anywhere.
     */
    control_command: string
  }
}

export function getStatePaths(_config: AppConfig, env: RuntimeEnv): StatePaths {
  const root = resolveStateRoot(env)
  return {
    root,
    env: join(root, '.env'),
    config: env.TELEGRAM_CONFIG_FILE ?? join(root, 'config.json'),
    // M4 (PLAN.md alignment): the persisted allowlist file is `allowlist.json`.
    // Earlier code used `access.json` (inherited from the official plugin).
    // The boot path in server.ts performs a one-shot migration of any stale
    // `access.json` → `allowlist.json` so existing deployments don't lose state.
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    activeHookChat: join(root, 'active-hook-chat'),
    statusOrphans: join(root, 'status-orphans.json'),
    chatThreads: join(root, 'chat-threads.json'),
    openQuestions: join(root, 'open-questions.json'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    deadLetterOutbound: join(root, 'dead-letter', 'outbound'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      // L3 (PLAN.md alignment): the audit log is JSONL, not plain log lines.
      // Renamed so log shippers configured for *.jsonl pick it up correctly.
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
      ask_user_question: join(root, 'logs', 'ask-user-question.jsonl'),
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
      control_command: join(root, 'logs', 'control-command.jsonl'),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// resolveAskUserQuestionAllowedUserIds — single source of truth for the
// AskUserQuestion recipient set. When the operator omits
// `ask_user_question.allowed_user_ids` in config.json / env, the relay
// inherits `permission_relay.allowed_user_ids`. Callers (TASK-1 state
// machine, TASK-3 HTTP routes) MUST go through this helper rather than
// reading the raw field, so a single change to permission_relay
// propagates automatically and the two lists can never drift.
//
// The optional `log` argument lets boot code emit a single line noting
// whether the fallback fired — useful in tests (spy on the logger) and
// in prod (operator sees the resolved set in server.log on startup).
// ─────────────────────────────────────────────────────────────────────

export interface AllowedUserIdsLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void
}

export function resolveAskUserQuestionAllowedUserIds(
  config: AppConfig,
  log?: AllowedUserIdsLogger,
): readonly number[] {
  const explicit = config.ask_user_question.allowed_user_ids
  if (explicit !== undefined) {
    if (log) {
      log.info('ask_user_question: using explicit allowed_user_ids', {
        count: explicit.length,
        fallback: false,
      })
    }
    return explicit
  }
  const inherited = config.permission_relay.allowed_user_ids
  if (log) {
    log.info('ask_user_question: allowed_user_ids unset, inheriting from permission_relay', {
      count: inherited.length,
      fallback: true,
    })
  }
  return inherited
}

// ─────────────────────────────────────────────────────────────────────
// resolvePermissionGateAllowedUserIds — single source of truth for the
// permission-gate Allow/Deny answerer set. Same inheritance contract as
// AskUserQuestion: explicit `permission_gate.allowed_user_ids` wins,
// otherwise inherit `permission_relay.allowed_user_ids`. This set
// authorizes both who the prompt is sent to (DM chat == first id) and who
// may resolve it.
// ─────────────────────────────────────────────────────────────────────

export function resolvePermissionGateAllowedUserIds(
  config: AppConfig,
  log?: AllowedUserIdsLogger,
): readonly number[] {
  const explicit = config.permission_gate.allowed_user_ids
  if (explicit !== undefined) {
    if (log) log.info('permission_gate: using explicit allowed_user_ids', { count: explicit.length, fallback: false })
    return explicit
  }
  const inherited = config.permission_relay.allowed_user_ids
  if (log) log.info('permission_gate: allowed_user_ids unset, inheriting from permission_relay', { count: inherited.length, fallback: true })
  return inherited
}

// ─────────────────────────────────────────────────────────────────────
// resolveGuestModeAllowedUserIds — single source of truth for who may
// summon the bot via a guest @-mention. Explicit `guest_mode
// .allowed_user_ids` wins; otherwise inherit the top-level
// `allowed_user_ids` (the owner DM allowlist). Callers MUST go through
// this helper so the fallback lives in exactly one place.
// ─────────────────────────────────────────────────────────────────────

// resolveGuestModeEnabled — whether Guest Mode handling is active. The
// `guest_mode` block is optional; a missing block means OFF (unlike `hud`,
// which defaults ON — guest handling must be a deliberate opt-in).
export function resolveGuestModeEnabled(config: AppConfig): boolean {
  return config.guest_mode?.enabled ?? false
}

export function resolveGuestModeAllowedUserIds(
  config: AppConfig,
  log?: AllowedUserIdsLogger,
): readonly number[] {
  const explicit = config.guest_mode?.allowed_user_ids
  if (explicit !== undefined) {
    if (log) log.info('guest_mode: using explicit allowed_user_ids', { count: explicit.length, fallback: false })
    return explicit
  }
  const inherited = config.allowed_user_ids
  if (log) log.info('guest_mode: allowed_user_ids unset, inheriting from allowed_user_ids', { count: inherited.length, fallback: true })
  return inherited
}

// ─────────────────────────────────────────────────────────────────────
// resolveContextWindowTokens — the model context-window size used by
// /status (context usage) and the context HUD. Callers MUST go through this
// helper rather than reading the raw field so the 200k default is applied in
// exactly one place. Default matches the Claude 200k-token window.
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

export function resolveContextWindowTokens(config: AppConfig): number {
  return config.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

// ─────────────────────────────────────────────────────────────────────
// resolveHudEnabled — whether the pinned context HUD (wave 3B) is active.
// The `hud` config block is optional, so callers MUST go through this helper
// rather than reading `config.hud?.enabled` directly.
//
// FORK DEVIATION: upstream defaults ON (`?? true`); this fork stages the HUD
// OFF, so the fallback is `?? false`. A missing block, a bare `hud: {}` (schema
// default false), and an explicit `{ enabled: false }` all resolve to OFF; only
// an explicit `{ enabled: true }` enables it.
// ─────────────────────────────────────────────────────────────────────

export function resolveHudEnabled(config: AppConfig): boolean {
  return config.hud?.enabled ?? false
}

// ─────────────────────────────────────────────────────────────────────
// resolveOutboxEnabled — whether the persistent outbox + background flusher
// (2026-07-07) is active. Same DEFAULT-OFF discipline as resolveHudEnabled:
// a missing block, a bare `outbox: {}`, and `{ enabled: false }` all resolve
// to OFF; only `{ enabled: true }` (or TELEGRAM_OUTBOX_ENABLED) turns it on.
// When OFF, the reply tool does not enqueue and server.ts starts no interval —
// runtime behaviour is byte-identical to before this feature.
// ─────────────────────────────────────────────────────────────────────

export function resolveOutboxEnabled(config: AppConfig): boolean {
  return config.outbox?.enabled ?? false
}

// ─────────────────────────────────────────────────────────────────────
// resolveAskGuardMode — the single resolution point for the ask-guard mode,
// in priority order:
//   1. `ASK_GUARD_ENABLED=0|false|no|off` env kill-switch → 'off';
//   2. `ASK_GUARD_MODE` env (off|advisory|block, case-insensitive);
//   3. `config.ask_guard.mode`;
//   4. 'advisory' (the calibration-week default).
//
// These two env vars are read from process.env directly (NOT via the
// TELEGRAM_-prefixed RuntimeEnvSchema) — the same pattern as the context-window
// override reading JARVIS_CONTEXT_WINDOW.
// ─────────────────────────────────────────────────────────────────────

export type AskGuardMode = 'off' | 'advisory' | 'block'

// Minimal structural logger (avoids importing the full Logger type here and a
// config.ts ↔ log.ts cycle). Matches Logger.warn's shape.
export interface AskGuardModeLogger {
  warn: (msg: string, ctx?: Record<string, unknown>) => void
}

export function resolveAskGuardMode(
  config: AppConfig,
  log?: AskGuardModeLogger,
): AskGuardMode {
  const enabled = process.env.ASK_GUARD_ENABLED
  if (enabled !== undefined && /^(0|false|no|off)$/i.test(enabled.trim())) {
    return 'off'
  }
  const envMode = process.env.ASK_GUARD_MODE
  if (envMode !== undefined && envMode.trim() !== '') {
    const m = envMode.trim().toLowerCase()
    if (m === 'off' || m === 'advisory' || m === 'block') return m
    // A SET-but-INVALID env value (e.g. «of», a typo of «off») must NOT silently
    // fall through to a configured `block` — that would surprise-enable
    // enforcement from a typo. Fail to the calibration default (advisory) and
    // warn, so the misconfiguration is visible.
    if (log) {
      log.warn('ASK_GUARD_MODE set to an invalid value — defaulting to advisory', {
        code: 'ask_guard_mode_invalid',
        value: envMode.trim().slice(0, 32),
      })
    }
    return 'advisory'
  }
  return config.ask_guard?.mode ?? 'advisory'
}

// ─────────────────────────────────────────────────────────────────────
// resolveOwnerChatIds — the OWNER DM chat ids for owner-only surfaces (the
// pinned context HUD + any owner command menu). FIX-8 (both reviews): these
// MUST come from the owner's DM ids, NEVER from `allowed_chat_ids` (which in
// multichat also lists group ids — a HUD with destructive buttons pinned in a
// public group is a serious leak). Explicit `owner_chat_ids` wins; otherwise we
// fall back to `allowed_user_ids` (in a DM the chat id equals the positive user
// id). Positive ids only — a group id can never be an owner DM.
// ─────────────────────────────────────────────────────────────────────

export function resolveOwnerChatIds(config: AppConfig): readonly number[] {
  const explicit = config.owner_chat_ids
  if (explicit !== undefined && explicit.length > 0) {
    const positive = explicit.filter((n) => Number.isInteger(n) && n > 0)
    if (positive.length > 0) return positive
  }
  return config.allowed_user_ids
}
