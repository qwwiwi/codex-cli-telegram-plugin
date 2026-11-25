// Out-of-band (OOB) commands handled by the plugin BEFORE a channel
// notification is sent to Claude. Mirrors gateway.py:_OOB_COMMANDS +
// _handle_oob_command + handle_command (status/help/reset/new branches).
//
// Scope A commands: /help, /status, /stop, /reset, /new.
// Explicitly NOT included: /compact, /halt (Scope B per PLAN.md T10).
//
// Parsing rules (gateway.py:3037-3046 + 3366-3370):
//   - Must start with `/`.
//   - Optional `@botname` suffix is stripped when it matches our bot's
//     username (case-insensitive).
//   - Command word is lowercased.
//   - Trailing `force` token in args sets hasForceFlag (for /reset force,
//     /new force).
//
// Handling notes:
//   - /help and /status reply directly to Telegram and DO NOT wake Claude
//     (no channel notification). Status is a snapshot of plugin-side state
//     only — Claude session lives in the host process and we don't poke it.
//   - /stop and /reset force ack the user AND emit a channel notification
//     with meta.command=<name>. The plugin can't truly interrupt Claude
//     (no public API for that yet); /help documents this limitation.
//   - /reset without `force` returns a short reply asking for the flag, no
//     channel notification.
//   - /new (force optional, ignored) is the ONE command that acts on the pane
//     itself: owner-only, it presses `/clear` via the reliable sender and
//     emits NO channel notification — forwarding its own text was the 2026-09-30
//     bug that grew the very context the command promised to wipe.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi, InlineKeyboardLike } from '../channel/tools.js'
import { sendChannelNotification, type ChannelEvent } from '../channel/notify.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  parseCcCommand,
  sendControlCommand,
  sendSlashCommand,
  type KeysCaptureExec,
  type KeysExec,
  type TmuxKeysTarget,
} from './keys.js'
import { controlFailureMessage } from '../telegram/control-result.js'
import { isOwnerDmChat, type ControlSender } from '../telegram/newq-confirm-ui.js'
import { buildKeysKeyboard, KEYS_PANEL_HEADER } from '../telegram/keys-panel-ui.js'
import {
  activeLeases,
  humanizeDurationMs,
  loadAutonomyState,
  type AutonomyPaths,
} from '../autonomy/store.js'
import { grantLease, parseLeaseCommandArgs } from '../autonomy/grant.js'
// cc-panel-ui: panel builder/header intentionally NOT imported — the /cc button
// panel was removed 2026-07-15 (owner request). handleCcmdCallback stays wired in
// server.ts only to make stale pinned panels inert.

export type OobCommandName =
  | 'help' | 'status' | 'stop' | 'reset' | 'new' | 'mirror' | 'keys' | 'cc' | 'lease'

const KNOWN_COMMANDS = new Set<OobCommandName>([
  'help',
  'status',
  'stop',
  'reset',
  'new',
  'mirror',
  'keys',
  'cc',
  'lease',
])

// Sub-actions for /mirror. We accept the bare command (= same as `status`),
// plus on/off/status explicit args. Unknown sub-actions render the help line.
export type MirrorAction = 'on' | 'off' | 'status'

export interface ParsedOobCommand {
  name: OobCommandName
  rawText: string
  args: string
  hasForceFlag: boolean
}

// Parse a leading `/cmd[@botname] args...` token. Returns null if the text
// is not an OOB command (plain text, unknown command, no leading slash).
export function parseOobCommand(
  text: string,
  botUsername?: string,
): ParsedOobCommand | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return null

  // Split on first whitespace run. parts[0] = "/word[@bot]", rest = args.
  const wsIdx = trimmed.search(/\s/)
  const head = wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx)
  const args = wsIdx === -1 ? '' : trimmed.slice(wsIdx + 1).trim()

  // Strip leading slash, optional @botname suffix.
  let word = head.slice(1)
  const atIdx = word.indexOf('@')
  if (atIdx !== -1) {
    const suffix = word.slice(atIdx + 1)
    word = word.slice(0, atIdx)
    // gateway.py strips ANY @suffix without verifying the bot identity, so we
    // mirror that here. botUsername is accepted for future tightening, but
    // not enforced — stripping any suffix matches gateway.py:3044-3045.
    void suffix
    void botUsername
  }

  const lower = word.toLowerCase() as OobCommandName
  if (!KNOWN_COMMANDS.has(lower)) return null

  const hasForceFlag = /^\s*force\s*$/i.test(args)

  return {
    name: lower,
    rawText: text,
    args,
    hasForceFlag,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Handler context and result shape.
// ─────────────────────────────────────────────────────────────────────

// Minimal surface of TmuxMirror that the OOB layer needs. Decoupled from
// the concrete class so tests don't need to spin up the full mirror.
//
// `bump` is optional because it's used by the inbound-message handler
// (not by /mirror commands) — keeping it optional avoids forcing every
// OOB unit test to stub a method it never exercises.
export interface TmuxMirrorControl {
  start(): Promise<void>
  stop(): Promise<void>
  bump?(): Promise<void>
  // MED-A #2: recovery from a permanent Telegram error (403 / parse)
  // that flipped `disabled=true`. /mirror on calls reset() before
  // start() so the owner never has to restart the plugin.
  // Optional for source-compat with existing test stubs.
  reset?(): void
  status(): {
    enabled: boolean
    messageId?: number
    lastError?: string
    lastPollAt?: number
  }
}

export interface OobContext {
  chatId: string
  senderId: string
  config: AppConfig
  telegramApi: TelegramApi
  log: Logger
  // For /status, pulled lazily so handler stays decoupled from the
  // status manager (T11) and poller/webhook plumbing (T13).
  pollerStatus?: () => { offset: number | undefined; lastError?: string }
  statusManager?: {
    isActive: (chatId: string) => boolean
    cancel: (chatId: string, reason: string) => Promise<void>
  }
  webhookStatus?: () => { enabled: boolean; port: number }
  // /mirror control — undefined when tmux_mirror.enabled=false at startup.
  // The handler then replies «mirror disabled in config».
  tmuxMirror?: TmuxMirrorControl
  // Identity bits surfaced by /status.
  botId?: number
  stateDir?: string
  // Pre-emptive interrupt of the running turn, used by /stop. Wired in
  // production (handlers.ts) to send Escape to the agent's tmux pane; left
  // undefined in unit tests so /stop stays a pure, side-effect-free call.
  interruptTurn?: () => Promise<void>
  // /keys + /cc target — the pane of the agent's Claude session. Undefined
  // when the plugin can't resolve a pane (no tmux config); the handler then
  // explains the pane is unavailable. `exec` is injected in tests.
  // `captureExec` matters only for the control path (`/new` → `/clear`), which
  // must PROBE the pane before typing: injecting a fake `exec` without a
  // matching `captureExec` would send into a fake while reading the REAL pane.
  // Keep the pair together or inject `sendControl` wholesale (what tests do).
  tmuxKeys?: { target: TmuxKeysTarget; exec?: KeysExec; captureExec?: KeysCaptureExec }
  // Injectable reliable control-command sender used by `/new` to press
  // `/clear` in the pane. Defaults to the real `sendControlCommand`; tests
  // pass a fake so they assert the EFFECT without touching tmux.
  sendControl?: ControlSender
  // Owner DM chat ids (`resolveOwnerChatIds`). `/new` wipes the ONE global
  // pane, so — exactly like the `newq:confirm` button — it is owner-only:
  // `allowed_user_ids`/`allowed_chat_ids` may legitimately contain OTHER
  // people's DMs in a multichat setup. Omitted → check skipped (legacy/tests).
  ownerChatIds?: readonly (number | string)[]
  // Inbound Telegram message id — the idempotency key source for `/lease`
  // (`cmd:<chatId>:<messageId>`), so a replayed command grants ONE lease.
  // Omitted → the grant falls back to a wall-clock key (tests, legacy callers).
  messageId?: number
}

export interface OobResult {
  handled: true
  command: OobCommandName
  notifyChannel?: { content: string; meta: Record<string, string> }
  // `inlineKeyboard` (optional, additive) attaches a reply_markup keypad to
  // the Telegram reply — used by /keys and /cc to render the tap panel.
  // Existing replies omit it and Telegram sends a plain message.
  replyToTelegram?: { text: string; parseMode?: 'HTML'; inlineKeyboard?: InlineKeyboardLike }
}

// ─────────────────────────────────────────────────────────────────────
// /help text. Lists ONLY Scope A commands. Do not add /compact, /halt
// here — they belong to Scope B and grep checks enforce their absence.
// ─────────────────────────────────────────────────────────────────────

function helpText(): string {
  return (
    '<b>команды</b>\n\n'
    + '<code>/help</code> — эта справка\n'
    + '<code>/status</code> — снимок плагина и сессии\n'
    + '<code>/stop</code> — прервать текущую задачу (Escape в pane)\n'
    + '<code>/reset force</code> — сбросить состояние сессии (подтверди флагом <code>force</code>)\n'
    + '<code>/new</code> — начать новую сессию\n'
    + '<code>/mirror on|off|status</code> — управлять зеркалом терминала (tmux, обновляется в реальном времени)\n'
    + '<code>/keys</code> — панель кнопок: тап = нажатие в сессии (ответить на нативный диалог Claude Code; есть ⌫ backspace и 🧹 clear)\n'
    + '<code>/cc</code> — панель команд Claude Code (тап = выполнить); либо <code>/cc &lt;команда&gt;</code>: <code>/cc compact</code>, <code>/cc model opus</code>\n'
    + '<code>/lease &lt;scope&gt;[; ttl=48h]</code> — выдать мандат автономии на задачу (без аргументов — список активных)\n\n'
    + '<i>примечание: /stop шлёт реальное прерывание (Escape) в pane агента и '
    + 'дополнительно передаёт сигнал через канал; в редких случаях намертво '
    + 'зависшего хода добивает watchdog.</i>'
  )
}

// Public so server.ts can feed the SAME list to bot.api.setMyCommands and
// Telegram autocomplete stays in sync with what the parser actually accepts.
export interface BotCommandSpec {
  command: string
  description: string
}
export const BOT_COMMANDS: ReadonlyArray<BotCommandSpec> = [
  { command: 'help', description: 'справка по командам' },
  { command: 'status', description: 'снимок плагина и сессии' },
  { command: 'stop', description: 'прервать текущую задачу' },
  { command: 'reset', description: 'сбросить сессию (нужен force)' },
  { command: 'new', description: 'начать новую сессию' },
  { command: 'mirror', description: 'зеркало терминала: on | off | status' },
  { command: 'keys', description: 'панель кнопок для подтверждений (нажатия в сессию)' },
  { command: 'cc', description: 'панель команд Claude Code (тап) или /cc <команда>' },
  { command: 'lease', description: 'выдать мандат автономии: /lease <scope>[; ttl=48h]' },
]

function statusText(ctx: OobContext): string {
  const lines: string[] = ['<b>статус</b>']
  if (ctx.botId !== undefined) {
    lines.push(`bot_id: <code>${escapeHtml(String(ctx.botId))}</code>`)
  }
  if (ctx.stateDir) {
    lines.push(`state_dir: <code>${escapeHtml(ctx.stateDir)}</code>`)
  }
  lines.push(`allowed_user: <code>${escapeHtml(ctx.senderId)}</code>`)

  if (ctx.pollerStatus) {
    const ps = ctx.pollerStatus()
    const off = ps.offset === undefined ? '—' : String(ps.offset)
    lines.push(`update_offset: <code>${escapeHtml(off)}</code>`)
    if (ps.lastError) {
      lines.push(`poller_error: <code>${escapeHtml(ps.lastError)}</code>`)
    }
  }

  if (ctx.statusManager) {
    const active = ctx.statusManager.isActive(ctx.chatId) ? 'active' : 'idle'
    lines.push(`status_manager: <code>${active}</code>`)
  }

  if (ctx.webhookStatus) {
    const ws = ctx.webhookStatus()
    const w = ws.enabled ? `on:${ws.port}` : 'off'
    lines.push(`webhook: <code>${w}</code>`)
  }

  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// ─────────────────────────────────────────────────────────────────────
// /lease — autonomy M2 owner command (ported from upstream 2026-10-16).
// Grants a lease (or lists active ones on a bare command). The store write
// happens HERE (async side effect), then the confirmation is returned as a
// normal replyToTelegram. The message is NOT forwarded to the agent session
// (OOB commands are swallowed in handlers.ts) — it is a control command, not
// conversation.
// ─────────────────────────────────────────────────────────────────────

async function handleLeaseCommand(
  parsed: ParsedOobCommand,
  ctx: OobContext,
): Promise<OobResult> {
  if (ctx.stateDir === undefined) {
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: '<b>/lease</b> — недоступно: не сконфигурирован каталог состояния.',
        parseMode: 'HTML',
      },
    }
  }
  const paths: AutonomyPaths = { root: ctx.stateDir }
  const cmd = parseLeaseCommandArgs(parsed.args)

  if (cmd.kind === 'bare') {
    // No scope → list active leases + usage hint, grant nothing.
    const state = loadAutonomyState(paths, ctx.chatId, ctx.log)
    const leases = activeLeases(state, Date.now())
    const lines: string[] = ['<b>активные мандаты</b>']
    if (leases.length === 0) {
      lines.push('нет активных мандатов.')
    } else {
      for (const l of leases) {
        const left = humanizeDurationMs(l.expiresAtMs - Date.now())
        lines.push(`<code>${escapeHtml(l.id)}</code> — «${escapeHtml(l.scope)}» (ещё ${escapeHtml(left)})`)
      }
    }
    lines.push('', '<i>usage: /lease &lt;scope&gt;[; ttl=48h]</i>')
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: { text: lines.join('\n'), parseMode: 'HTML' },
    }
  }

  // Fail-closed grammar errors: a present-but-malformed trailing ttl option or
  // an over-long scope is a USAGE ERROR — nothing is granted, nothing is
  // silently defaulted or truncated.
  if (cmd.kind === 'invalid') {
    const reason = cmd.reason === 'ttl'
      ? 'некорректный ttl — допустимо целое 1..72 в форме <code>ttl=48h</code> (строго строчными)'
      : cmd.reason === 'scope_charset'
        ? 'scope содержит управляющие/форматирующие символы (перенос строки, bidi) — недопустимо'
        : 'scope длиннее 400 символов — сократи формулировку'
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: `<b>/lease</b> — ${reason}.\n<i>usage: /lease &lt;scope&gt;[; ttl=48h]</i>`,
        parseMode: 'HTML',
      },
    }
  }

  // Grant. Idempotency key ties a replayed /lease command to one lease.
  const grantSourceId = `cmd:${ctx.chatId}:${ctx.messageId ?? Date.now()}`
  const res = await grantLease(
    paths,
    ctx.chatId,
    {
      scope: cmd.scope,
      ttlHours: cmd.ttlHours,
      source: 'owner_cmd',
      grantSourceId,
    },
    ctx.log,
  )

  if (res.kind === 'writer_conflict') {
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: '<b>/lease</b> — реестр занят другим процессом, попробуй ещё раз.',
        parseMode: 'HTML',
      },
    }
  }
  if (res.kind === 'version_unsupported') {
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: '<b>/lease</b> — реестр новее этой версии плагина (только чтение). Обнови плагин.',
        parseMode: 'HTML',
      },
    }
  }

  const lease = res.lease
  ctx.log.info('oob /lease grant', {
    chat_id: ctx.chatId,
    outcome: res.outcome,
    lease_id: lease?.id,
  })

  // Honest refusal on a source-id collision with a DIFFERENT scope: never
  // silently swallow a legit grant.
  if (res.outcome === 'source_conflict') {
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: '<b>мандат НЕ выдан</b> — этот запрос уже обрабатывался с ДРУГИМ scope (source_conflict). Отправь команду новым сообщением.',
        parseMode: 'HTML',
      },
    }
  }

  if (lease === undefined) {
    // duplicate_source whose lease tombstone was already pruned — the ledger
    // still remembers the grant. Honest report, no re-mint.
    if (res.outcome === 'duplicate_source') {
      return {
        handled: true,
        command: 'lease',
        replyToTelegram: {
          text: '<b>мандат не выдан повторно</b> — этот грант уже был обработан ранее (запись мандата уже удалена ротацией).',
          parseMode: 'HTML',
        },
      }
    }
    return {
      handled: true,
      command: 'lease',
      replyToTelegram: {
        text: '<b>/lease</b> — не удалось выдать мандат.',
        parseMode: 'HTML',
      },
    }
  }

  // Heading states the REAL status: a duplicate against a TERMINAL lease must
  // not claim «уже активен».
  const now = Date.now()
  let heading: string
  if (res.outcome === 'duplicate_source' || res.outcome === 'duplicate_scope') {
    if (lease.revokedAtMs !== undefined) heading = 'мандат по этому гранту был ОТОЗВАН — новый не выдан'
    else if (lease.consumedAtMs !== undefined && lease.consumedAtMs !== null) heading = 'мандат по этому гранту уже ИСПОЛЬЗОВАН — новый не выдан'
    else if (lease.expiresAtMs <= now) heading = 'мандат по этому гранту ИСТЁК — новый не выдан'
    else heading = 'мандат уже активен'
  } else {
    heading = 'мандат выдан'
  }
  const left = humanizeDurationMs(lease.expiresAtMs - now)
  const text =
    `<b>${heading}</b>\n`
    + `<code>${escapeHtml(lease.id)}</code>\n`
    + `scope: «${escapeHtml(lease.scope)}»\n`
    + (lease.expiresAtMs > now ? `истекает через ${escapeHtml(left)}` : 'без остатка действия')
  return {
    handled: true,
    command: 'lease',
    replyToTelegram: { text, parseMode: 'HTML' },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main dispatcher. Pure data — caller actually issues sendMessage and
// channel notification calls based on the OobResult. This keeps the
// function trivially testable.
// ─────────────────────────────────────────────────────────────────────

export async function handleOobCommand(
  parsed: ParsedOobCommand,
  ctx: OobContext,
): Promise<OobResult> {
  const baseMeta: Record<string, string> = {
    source: 'telegram',
    chat_id: ctx.chatId,
    user_id: ctx.senderId,
    ts: new Date().toISOString(),
    command: parsed.name,
  }

  switch (parsed.name) {
    case 'lease': {
      ctx.log.info('oob /lease', { chat_id: ctx.chatId })
      return await handleLeaseCommand(parsed, ctx)
    }
    case 'help': {
      ctx.log.info('oob /help', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'help',
        replyToTelegram: { text: helpText(), parseMode: 'HTML' },
      }
    }

    case 'status': {
      ctx.log.info('oob /status', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'status',
        replyToTelegram: { text: statusText(ctx), parseMode: 'HTML' },
      }
    }

    case 'stop': {
      ctx.log.info('oob /stop', { chat_id: ctx.chatId })
      // Cancel any active status — the user explicitly asked to halt, so
      // leaving "Печатает..." pulsing while we wait for Claude to notice
      // the channel event would be confusing. Best-effort: errors in cancel
      // are swallowed inside the manager.
      if (ctx.statusManager && ctx.statusManager.isActive(ctx.chatId)) {
        try {
          await ctx.statusManager.cancel(ctx.chatId, 'user stop')
        } catch (err) {
          ctx.log.warn('oob /stop status cancel failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Pre-emptive halt: actually interrupt the running turn (Escape -> tmux
      // pane) instead of only enqueueing the cooperative /stop below, which a
      // mid-tool turn would not see until it yields. Best-effort and isolated
      // from the rest of /stop: a failed interrupt must not drop the ack or the
      // channel notification. Undefined in tests -> no-op (pure handler).
      if (ctx.interruptTurn) {
        try {
          await ctx.interruptTurn()
        } catch (err) {
          ctx.log.warn('oob /stop interrupt failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        handled: true,
        command: 'stop',
        replyToTelegram: {
          text: '<b>stop</b> — прерываю текущую задачу.',
          parseMode: 'HTML',
        },
        // Still delivered so Claude sees, on its next read, that it was stopped
        // on purpose (the Escape interrupts; this explains why).
        notifyChannel: {
          content: '/stop',
          meta: baseMeta,
        },
      }
    }

    case 'reset': {
      if (!parsed.hasForceFlag) {
        return {
          handled: true,
          command: 'reset',
          replyToTelegram: {
            text: 'Для подтверждения добавь <code>force</code>: <code>/reset force</code>',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /reset force', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'reset',
        replyToTelegram: {
          text: '<b>сессия сброшена (force)</b>\n\nследующее сообщение начнёт новую сессию',
          parseMode: 'HTML',
        },
        notifyChannel: { content: '/reset force', meta: baseMeta },
      }
    }

    case 'new': {
      // `/new` RESETS the session for real: it presses `/clear` in the agent's
      // pane through the reliable sender (probe → interrupt-if-busy → send →
      // confirm) — the SAME path the `newq:confirm` button and the HUD «new»
      // button drive. `/new force` is accepted as an alias (flag ignored).
      //
      // 2026-09-30 regression fixed here: this branch used to only reply
      // «новая сессия» and emit `notifyChannel: '/new'`, i.e. it FORWARDED the
      // literal text into the live session. Repeating the command grew the
      // context it claimed to wipe. Never emit a
      // channel notification here: after a successful clear there is no
      // context to notify, and on failure the text would be plain noise.
      //
      // Owner-only, same as the button: the pane is the owner's single global
      // session, while the OOB allowlists may hold other people's DMs.
      if (!isOwnerDmChat(ctx.chatId, ctx.ownerChatIds)) {
        ctx.log.warn('oob /new refused: not the owner DM', { chat_id: ctx.chatId })
        return {
          handled: true,
          command: 'new',
          replyToTelegram: {
            text: '<b>/new</b> — недоступно: сброс сессии доступен только владельцу.',
            parseMode: 'HTML',
          },
        }
      }
      if (!ctx.tmuxKeys) {
        return {
          handled: true,
          command: 'new',
          replyToTelegram: {
            text: '<b>/new</b> — недоступно: плагин не знает tmux-pane сессии.',
            parseMode: 'HTML',
          },
        }
      }
      const send = ctx.sendControl ?? sendControlCommand
      const cleared = await send(ctx.tmuxKeys.target, 'clear', {
        interruptIfBusy: true,
        ...(ctx.tmuxKeys.exec !== undefined ? { exec: ctx.tmuxKeys.exec } : {}),
        ...(ctx.tmuxKeys.captureExec !== undefined
          ? { captureExec: ctx.tmuxKeys.captureExec }
          : {}),
      })
      ctx.log.info('oob /new', {
        chat_id: ctx.chatId,
        force: parsed.hasForceFlag,
        ok: cleared.ok,
        ...(cleared.ok ? {} : { reason: cleared.reason }),
      })
      return {
        handled: true,
        command: 'new',
        replyToTelegram: {
          text: cleared.ok
            ? '<b>новая сессия</b> — контекст очищен.'
            : controlFailureMessage(cleared.reason),
          parseMode: 'HTML',
        },
      }
    }

    case 'mirror': {
      // Sub-action lives in `args`. Empty args → behave like `status`.
      const action = parsed.args.trim().toLowerCase()
      const mirror = ctx.tmuxMirror
      if (!mirror) {
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text:
              '<b>зеркало терминала</b> — отключено в конфиге\n\n'
              + 'Установи <code>tmux_mirror.enabled = true</code> и перезапусти плагин.',
            parseMode: 'HTML',
          },
        }
      }
      if (action === 'on') {
        ctx.log.info('oob /mirror on', { chat_id: ctx.chatId })
        try {
          // MED-A #2: a permanent error (403 / parse) flips the
          // mirror's `disabled` flag and the polling loop becomes a
          // no-op forever — `/mirror off; /mirror on` alone never
          // cleared the flag because start() short-circuits on a
          // disabled mirror. Call reset() first so /mirror on
          // unconditionally re-arms the mirror after a permanent
          // error. Idempotent when the mirror is healthy. Optional
          // on the control interface for source-compat with test
          // stubs that don't implement it.
          if (mirror.reset) mirror.reset()
          await mirror.start()
        } catch (err) {
          ctx.log.warn('oob /mirror on start failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text: '<b>зеркало терминала</b> — <code>on</code>',
            parseMode: 'HTML',
          },
        }
      }
      if (action === 'off') {
        ctx.log.info('oob /mirror off', { chat_id: ctx.chatId })
        try {
          await mirror.stop()
        } catch (err) {
          ctx.log.warn('oob /mirror off stop failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text: '<b>зеркало терминала</b> — <code>off</code>',
            parseMode: 'HTML',
          },
        }
      }
      // Default / explicit `status` — read-only snapshot.
      const s = mirror.status()
      const lines = [
        '<b>зеркало терминала — статус</b>',
        `enabled: <code>${s.enabled ? 'on' : 'off'}</code>`,
      ]
      if (s.messageId !== undefined) lines.push(`message_id: <code>${s.messageId}</code>`)
      if (s.lastPollAt !== undefined) {
        const age = Math.max(0, Math.floor((Date.now() - s.lastPollAt) / 1000))
        lines.push(`last poll: <code>${age}s ago</code>`)
      }
      if (s.lastError) lines.push(`last error: <code>${s.lastError.slice(0, 200)}</code>`)
      if (action !== '' && action !== 'status') {
        lines.push('', '<i>usage: /mirror on | off | status</i>')
      }
      return {
        handled: true,
        command: 'mirror',
        replyToTelegram: {
          text: lines.join('\n'),
          parseMode: 'HTML',
        },
      }
    }

    case 'keys': {
      // Render the one-tap keypad. Each button injects one whitelisted
      // keystroke — their `kkey:` callbacks are dispatched in server.ts with
      // the same fail-closed allowlist auth. We only need a resolvable pane to
      // make the panel useful; if none, explain that the pane is unavailable.
      if (!ctx.tmuxKeys) {
        return {
          handled: true,
          command: 'keys',
          replyToTelegram: {
            text: '<b>/keys</b> — недоступно: плагин не знает tmux-pane сессии (нет tmux-конфига).',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /keys', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'keys',
        replyToTelegram: {
          text: KEYS_PANEL_HEADER,
          parseMode: 'HTML',
          inlineKeyboard: buildKeysKeyboard(),
        },
      }
    }

    case 'cc': {
      // Passthrough to Claude Code's OWN slash commands (/compact, /model,
      // /context, custom skills…) by typing them into the agent pane.
      if (!ctx.tmuxKeys) {
        return {
          handled: true,
          command: 'cc',
          replyToTelegram: {
            text: '<b>/cc</b> — недоступно: плагин не знает tmux-pane сессии.',
            parseMode: 'HTML',
          },
        }
      }
      // Bare `/cc` panel REMOVED (owner request 2026-07-15). The one-tap keypad
      // exposed a 🧹 clear button that ran `/clear` on a single stray tap and
      // silently wiped a session's context. Bare `/cc` now
      // renders NO inline keyboard — only the text passthrough `/cc <command>`
      // survives (an explicit, non-accidental action). The `ccmd:` callbacks are
      // disabled in server.ts so any panel still pinned in chat history is inert.
      if (parsed.args.trim() === '') {
        ctx.log.info('oob /cc panel disabled', { chat_id: ctx.chatId })
        return {
          handled: true,
          command: 'cc',
          replyToTelegram: {
            text:
              '<b>/cc</b> — панель кнопок отключена. '
              + 'Используй команду текстом: <code>/cc &lt;команда&gt;</code> '
              + '(например <code>/cc compact</code>).',
            parseMode: 'HTML',
          },
        }
      }
      const cc = parseCcCommand(parsed.args)
      if ('error' in cc) {
        return {
          handled: true,
          command: 'cc',
          replyToTelegram: { text: escapeHtml(cc.error), parseMode: 'HTML' },
        }
      }
      ctx.log.info('oob /cc', { chat_id: ctx.chatId, name: cc.name })
      const sent = await sendSlashCommand(ctx.tmuxKeys.target, cc, ctx.tmuxKeys.exec)
      const shown = cc.rest ? `/${cc.name} ${cc.rest}` : `/${cc.name}`
      return {
        handled: true,
        command: 'cc',
        replyToTelegram: {
          text: sent.ok
            ? `<b>отправлено в сессию:</b> <code>${escapeHtml(shown)}</code>`
            : `<b>/cc</b> — tmux ошибка: <code>${escapeHtml(sent.error)}</code>`,
          parseMode: 'HTML',
        },
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience side-effect runner used by handlers.ts. Keeps the wiring
// in one place: send the Telegram reply (if any) and emit the channel
// notification (if any). Errors during the Telegram send are logged but
// never thrown — a /help send-failure must not crash the update loop.
// ─────────────────────────────────────────────────────────────────────

export async function executeOobResult(
  result: OobResult,
  ctx: OobContext,
  server: Server,
): Promise<void> {
  if (result.replyToTelegram) {
    try {
      await ctx.telegramApi.sendMessage(ctx.chatId, result.replyToTelegram.text, {
        ...(result.replyToTelegram.parseMode !== undefined
          ? { parse_mode: result.replyToTelegram.parseMode }
          : {}),
        ...(result.replyToTelegram.inlineKeyboard !== undefined
          ? { reply_markup: result.replyToTelegram.inlineKeyboard }
          : {}),
      })
    } catch (err) {
      ctx.log.warn('oob reply send failed', {
        command: result.command,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (result.notifyChannel) {
    const event: ChannelEvent = {
      content: result.notifyChannel.content,
      meta: result.notifyChannel.meta,
    }
    await sendChannelNotification(server, event, ctx.log)
  }
}
