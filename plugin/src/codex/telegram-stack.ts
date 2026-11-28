// The bridge's outbound Telegram stack, in one place so tests run the exact production layering:
// raw grammY transport → rate limiter → redaction/HTML safety → reliable retries and dead letters.
import type { Bot } from 'grammy'

import { createTelegramApi, type TelegramApi } from '../channel/tools.js'
import type { Logger } from '../log.js'
import { createRateLimitedTelegramApi } from '../safety/rate-limited-telegram-api.js'
import { createReliableTelegramApi, type OutboundDeadLetter } from '../safety/reliable-telegram-api.js'
import { maskPiece, type VisibleText } from '../format/visible.js'
import { redactSecrets } from '../safety/redact.js'
import { createSafeTelegramApi } from '../safety/safe-telegram-api.js'

export interface TelegramStack {
  /** Rate-limited and redacted; no retries (the outbox owns its own). */
  safeTelegram: TelegramApi
  /** safeTelegram plus transient-error retries and dead letters. */
  reliableTelegram: TelegramApi
}

export function createTelegramStack(options: {
  bot: Bot
  token: string
  log: Logger
  secrets: ReadonlyArray<string>
  deadLetter: (record: OutboundDeadLetter) => void
}): TelegramStack {
  const { bot, token, log, secrets, deadLetter } = options
  // The wire guard masks every text payload once more right before HTTP: the rate limiter may sleep and
  // retry a captured payload, and `secrets` is a live list that grows at run time. No rich latch: rich
  // messages have no text + entities form, so the safe wrapper answers `{ fallback }` and callers send text.
  // A reply piece carries the shown text sent before it: the seam is checked again on every attempt.
  const guard = (visible: VisibleText, before?: string): VisibleText => maskPiece(visible, secrets, before)
  const safeTelegram = createSafeTelegramApi(
    createRateLimitedTelegramApi(createTelegramApi(bot, token, guard), log),
    log,
    secrets,
  )
  const reliableTelegram = createReliableTelegramApi(safeTelegram, log, { deadLetter })
  return { safeTelegram, reliableTelegram }
}

// The owner-chat send of the restart notices: redacted; `signal` cancels it wherever it is (queued,
// waiting for rate capacity, in a 429 backoff or on the wire), so nothing it started outlives the abort.
export function ownerNoticeSender(api: TelegramApi, ownerChat: string, secrets: ReadonlyArray<string>):
  (text: string, signal: AbortSignal) => Promise<unknown> {
  return (text, signal) => api.sendMessage(ownerChat, redactSecrets(text, secrets), { signal, abortInFlight: true })
}
