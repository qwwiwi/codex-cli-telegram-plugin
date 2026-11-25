// The open-question sweep — the tick that nudges the owner about a question he
// never answered.
//
// WHY A SWEEP AND NOT A PER-QUESTION TIMER: the record has to survive a
// `systemctl restart` (the whole point is that nobody is watching), and a timer
// does not. One cheap interval re-derives everything from the store, so a
// restart mid-wait resumes instead of forgetting.
//
// Owns no timer and takes `nowMs` explicitly — scheduling lives in server.ts,
// which already has the teardown discipline for intervals. That also makes
// every schedule case an ordinary function call in tests.
//
// SILENCE IS THE DEFAULT FAILURE MODE. The sweep never throws into its
// interval callback, never retries in-tick, and never sleeps (the 429 rule: a
// retry only prolongs a flood ban). A reminder that could not be delivered
// stays OWED — the counter advances only after the send resolves — so the next
// tick tries again rather than silently eating it.

import type { Logger } from '../log.js'
import type { OpenQuestionRecord, OpenQuestionStore } from '../state/open-question-store.js'

// The slice of AppConfig this sweep needs, structurally identical to
// `config.open_question_reminder`. Narrow on purpose: a test builds four
// numbers, not a whole AppConfig.
export interface OpenQuestionConfig {
  enabled: boolean
  after_ms: number
  repeat_ms: number
  max_reminders: number
}

export interface OpenQuestionSweepDeps {
  store: OpenQuestionStore
  config: OpenQuestionConfig
  log: Logger
  // Same shape as safeTelegramApi.sendMessage — chatId, text, options.
  sendMessage: (
    chatId: string,
    text: string,
    opts?: { reply_to_message_id?: number; message_thread_id?: number },
  ) => Promise<{ message_id: number }>
}

// First reminder at askedAtMs + after_ms; each next at lastRemindedAtMs +
// repeat_ms; nothing once the cap is reached. Pure.
function due(rec: OpenQuestionRecord, nowMs: number, cfg: OpenQuestionConfig): boolean {
  if (rec.remindersSent >= cfg.max_reminders) return false
  if (rec.remindersSent === 0) return nowMs >= rec.askedAtMs + cfg.after_ms
  // A record written before the first reminder landed has no lastRemindedAtMs;
  // fall back to askedAtMs so it stays on a defined schedule instead of firing
  // every tick.
  const last = rec.lastRemindedAtMs ?? rec.askedAtMs
  return nowMs >= last + cfg.repeat_ms
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.round(minutes / 60)
  return `${hours} ч`
}

// Deliberately tiny: the reminder quote-replies to the original question, so
// repeating its text would just duplicate what the owner can already see one
// tap away. Only the stored snippet goes out.
function reminderText(rec: OpenQuestionRecord, nowMs: number): string {
  return `⏳ Вопрос без ответа ${formatAge(nowMs - rec.askedAtMs)}: «${rec.snippet}»`
}

export async function sweepOpenQuestions(
  deps: OpenQuestionSweepDeps,
  nowMs: number,
): Promise<void> {
  const { store, config, log } = deps
  // after_ms === 0 is the "off" encoding of the single env knob, not "remind
  // immediately" — see config.ts.
  if (!config.enabled || config.after_ms === 0) return

  for (const rec of store.all()) {
    try {
      if (!due(rec, nowMs, config)) continue
      const opts: { reply_to_message_id?: number; message_thread_id?: number } = {
        reply_to_message_id: rec.messageId,
      }
      if (rec.threadId !== undefined) opts.message_thread_id = rec.threadId
      await deps.sendMessage(rec.chatId, reminderText(rec, nowMs), opts)
      // Only now is the reminder spent. Re-read through the store so a reply
      // that cleared the record mid-send is not resurrected.
      const current = store.get(rec.chatId)
      if (current === undefined || current.messageId !== rec.messageId) continue
      store.set({ ...current, remindersSent: current.remindersSent + 1, lastRemindedAtMs: nowMs })
      log.info('open question reminder sent', {
        chat_id: rec.chatId,
        code: rec.code,
        reminders_sent: current.remindersSent + 1,
      })
    } catch (err) {
      // Includes a flood ban: stay quiet, leave the reminder owed, let the
      // next tick decide. Never throw into the interval callback.
      log.debug('open question reminder failed (ignored)', {
        chat_id: rec.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// The scheduled form of the sweep: one closure per process, handed to
// setInterval by server.ts.
//
// WHY A GUARD FLAG: setInterval does not wait for its previous callback, and
// `remindersSent` only advances AFTER the send resolves. So a sweep that
// outlives the interval — which a rate-limited sendMessage will, since it can
// wait out a 429 — leaves the record still `due()` when the next tick starts,
// and the owner gets the SAME reminder twice while burning two of his
// max_reminders. Skipping an overlapping tick costs nothing: the next one
// re-derives everything from the store.
//
// It also swallows faults. server.ts calls this as `void tick(now)`, so an
// escaping rejection would be an unhandled one — and `store.all()` throwing
// sits outside the sweep's per-record catch.
export function createOpenQuestionTick(
  deps: OpenQuestionSweepDeps,
): (nowMs: number) => Promise<void> {
  let running = false
  return async (nowMs: number): Promise<void> => {
    if (running) {
      deps.log.debug('open question sweep still running, tick skipped')
      return
    }
    running = true
    try {
      await sweepOpenQuestions(deps, nowMs)
    } catch (err) {
      deps.log.debug('open question sweep failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
    }
  }
}
