// InboundWatcher — auto-reply «Агент занят» when the owner sends plain
// text while a Claude session is mid-tool. Sits between OOB resolution and
// the gate/notify call in `handleInboundText` — OOB always takes priority,
// and the watcher NEVER replaces the channel notification (auto-reply AND
// gate-and-notify both fire on a busy chat).
//
// Behaviour:
//   * Disabled (`config.watcher.enabled === false`) → no-op, reason='disabled'.
//   * Not busy (per ProgressReporter.isBusy) → no-op, reason='not-busy'.
//   * Debounced — within `config.watcher.debounce_ms` of the last successful
//     auto-reply for THIS chat → no-op, reason='debounced'.
//   * Send fails — caught, reason='send-failed', lastReplyMs NOT updated so
//     the next message can retry.
//   * Otherwise — `sendMessage` quote-replies the owner's message via
//     `reply_to_message_id`, lastReplyMs updates, return `{ replied: true }`.
//
// The auto-reply uses «🔧» to indicate tool activity. The tool name is
// HTML-escaped and the Telegram wrapper validates HTML before sending.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import { escapeHtml } from '../format/html.js'

// Narrow read-only view of ProgressReporter — watcher must not mutate
// reporter state. Both methods are implemented in `progress-reporter.ts`
// as plain accessors over `chats: Map<string, ChatProgressEntry>`.
// `thresholdMs` on isBusy is REQUIRED: ProgressReporter never reads
// `config.watcher` (dependency direction is one-way), so the watcher
// owns the threshold and passes it in every call.
export interface ProgressReporterForWatcher {
  isBusy(chatId: string, thresholdMs: number): boolean
  getActiveToolName(chatId: string): string | undefined
}

export interface WatcherDeps {
  telegramApi: TelegramApi
  config: AppConfig
  log: Logger
  progressReporter: ProgressReporterForWatcher
  now?: () => number
}

export interface AutoReplyInput {
  readonly chatId: string
  readonly messageId: number
}

export type AutoReplyResult =
  | { readonly replied: true }
  | { readonly replied: false; readonly reason: AutoReplyReason }

export type AutoReplyReason =
  | 'disabled'
  | 'not-busy'
  | 'debounced'
  | 'send-failed'

export class InboundWatcher {
  private readonly telegramApi: TelegramApi
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly progressReporter: ProgressReporterForWatcher
  private readonly now: () => number
  private readonly lastReplyMs: Map<string, number>

  constructor(deps: WatcherDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.progressReporter = deps.progressReporter
    this.now = deps.now ?? (() => Date.now())
    this.lastReplyMs = new Map()
  }

  /**
   * Fire-and-forget entry point — caller MUST schedule via `void` so
   * channel-notification latency never depends on Telegram round-trips.
   * The method itself never throws: send failures are caught and logged.
   *
   * Race-safe debounce: lastReplyMs is set BEFORE the await on sendMessage,
   * so a second invocation arriving in the same event-loop turn observes the
   * marker and short-circuits as `debounced`. On send failure we roll the
   * marker back to its previous value, so the next retry can still proceed
   * iff the prior successful send (if any) is now out of window.
   */
  async maybeAutoReply(input: AutoReplyInput): Promise<AutoReplyResult> {
    try {
      if (!this.config.watcher.enabled) {
        return { replied: false, reason: 'disabled' }
      }
      if (!this.progressReporter.isBusy(input.chatId, this.config.watcher.busy_threshold_ms)) {
        return { replied: false, reason: 'not-busy' }
      }
      const now = this.now()
      const prev = this.lastReplyMs.get(input.chatId)
      if (prev !== undefined && now - prev < this.config.watcher.debounce_ms) {
        return { replied: false, reason: 'debounced' }
      }

      // Set the marker FIRST so a concurrent invocation (same event-loop
      // turn) sees the debounce window and returns reason='debounced' before
      // it even reaches the Telegram round-trip. Without this, two messages
      // arriving in the same tick could both pass the debounce guard and
      // both call sendMessage — duplicate auto-replies on bursts.
      this.lastReplyMs.set(input.chatId, now)

      const toolName = this.progressReporter.getActiveToolName(input.chatId)
      const text = composeAutoReply(toolName, this.config.watcher.busy_text)

      try {
        await this.telegramApi.sendMessage(input.chatId, text, {
          parse_mode: 'HTML',
          reply_to_message_id: input.messageId,
        })
      } catch (err) {
        // Rollback the optimistic marker so the next message can retry. If
        // there was no prior successful send for this chat, remove the entry
        // entirely (the next call will be a true first-send).
        if (prev === undefined) {
          this.lastReplyMs.delete(input.chatId)
        } else {
          this.lastReplyMs.set(input.chatId, prev)
        }
        this.log.warn('watcher sendMessage failed (ignored)', {
          chat_id: input.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { replied: false, reason: 'send-failed' }
      }

      return { replied: true }
    } catch (err) {
      // Outer safety net — never escape recordEvent-style guard.
      this.log.warn('watcher maybeAutoReply failed (ignored)', {
        chat_id: input.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { replied: false, reason: 'send-failed' }
    }
  }

  /**
   * Clear the debounce marker for a chat. Used by the webhook server when a
   * `session_stop` hook fires for the chat: a fresh session should be able
   * to receive the first auto-reply immediately, without waiting for the
   * debounce window of the previous session to expire.
   *
   * Idempotent — no-op if no marker exists.
   */
  clearDebounce(chatId: string): void {
    this.lastReplyMs.delete(chatId)
  }
}

/**
 * Compose the auto-reply body. Exposed for tests so the HTML shape is
 * pinned without invoking the full class.
 *
 * When `busyText` is a non-empty string (config.watcher.busy_text), it
 * REPLACES the legacy tool-name message verbatim (HTML-escaped) — this is
 * the Level 1 mid-turn ack («✋ Принял, добавлю к текущей задаче»), a positive
 * "saw it, will fold it in" signal instead of the technical «Агент занят,
 * активный инструмент: …». Empty/undefined falls back to the legacy body.
 *
 * @param toolName Active tool name (legacy message only); undefined → «…».
 * @param busyText Optional override text; non-empty wins.
 * @returns HTML-safe Telegram message body.
 */
export function composeAutoReply(toolName: string | undefined, busyText?: string): string {
  if (busyText !== undefined && busyText.length > 0) {
    return escapeHtml(busyText)
  }
  const tool = toolName ?? '…'
  return `🔧 Агент занят, активный инструмент: <code>${escapeHtml(tool)}</code>. Жди или /stop.`
}

/**
 * Build a `ProgressReporterForWatcher` whose `isBusy` is the OR of two
 * "mid-turn busy" sources:
 *   1. the real ProgressReporter (active when `config.progress.enabled`), and
 *   2. an optional StatusManager-backed signal (`isActive(chatId)` — true
 *      while a status bubble is open, i.e. a turn is in flight).
 *
 * Why: the dup-working fix disables `progress`, which makes
 * ProgressReporter.isBusy always false (recordEvent early-returns) and leaves
 * the watcher DEAD. StatusManager stays enabled, so ORing in its `isActive`
 * revives the mid-turn detection without re-enabling the duplicate "working"
 * surface. `getActiveToolName` is delegated to the ProgressReporter (the
 * StatusManager has no tool name); with the busy_text override the tool name
 * is unused anyway.
 *
 * @param progressReporter Underlying reporter (threshold-aware busy source).
 * @param statusBusy Optional status signal; ORed into isBusy when present.
 * @returns A reporter view suitable for `WatcherDeps.progressReporter`.
 */
export function makeBusyProvider(
  progressReporter: ProgressReporterForWatcher,
  statusBusy?: { isActive(chatId: string): boolean },
): ProgressReporterForWatcher {
  return {
    isBusy: (chatId, thresholdMs) =>
      progressReporter.isBusy(chatId, thresholdMs) || (statusBusy?.isActive(chatId) ?? false),
    getActiveToolName: (chatId) => progressReporter.getActiveToolName(chatId),
  }
}
