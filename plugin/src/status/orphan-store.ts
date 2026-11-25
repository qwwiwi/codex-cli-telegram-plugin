// Orphaned-status-bubble recovery.
//
// THE BUG: StatusManager's active bubble — the transient "Печатает…/🔧 tool"
// Telegram message — and its 30-min auto-cancel TTL live ONLY in process
// memory. A turn that never reaches complete()/cancel() (the TUI input wedge
// the prompt-watchdog now restarts) followed by that restart loses the
// (chatId, messageId) handle. The Telegram message then lingers forever frozen
// on its last "working" render — the phantom indicator.
//
// THE FIX: mirror every live bubble's (chatId, messageId) to a tiny JSON file
// while it is active and drop it on every terminal transition. On the next
// process start, sweepOrphanBubbles() reads any survivors and neutralizes the
// Telegram messages BEFORE the bot resumes serving turns.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

import type { Logger } from '../log.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'

// Terminal label written onto an orphan when we can't delete it (delete
// disabled / unavailable). Mirrors renderState({kind:'stopped',reason}) output
// without importing the private renderer — keeps this module dependency-light.
const ORPHAN_TERMINAL_TEXT = '<i>Остановлено: прервано</i>'

// Persisted shape on disk: { "<chatId>": <messageId>, … }. Plain object so the
// file is trivially inspectable and forward-compatible.
type OrphanFile = Record<string, number>

// Injected into StatusManager. Production wiring passes a FileOrphanStore;
// tests pass an in-memory spy; legacy/omitted wiring leaves it undefined
// (no-op), so existing behaviour is unchanged.
export interface OrphanStore {
  // Remember a live bubble. A zero/falsy messageId means "no Telegram message
  // exists yet" (suppressed typing bubble) and is ignored.
  record(chatId: string, messageId: number): void
  // Forget a bubble once its turn terminates (complete / cancel / supersede).
  clear(chatId: string): void
}

// File-backed OrphanStore. Writes are tiny and infrequent (one per turn
// start/end), so synchronous atomic writes (temp + rename) are cheap and
// avoid a torn file if the process dies mid-write.
export class FileOrphanStore implements OrphanStore {
  private readonly filePath: string
  private readonly log: Logger
  private readonly active = new Map<string, number>()

  constructor(filePath: string, log: Logger) {
    this.filePath = filePath
    this.log = log
  }

  record(chatId: string, messageId: number): void {
    if (!messageId) return // no live Telegram message — nothing to recover
    if (this.active.get(chatId) === messageId) return
    this.active.set(chatId, messageId)
    this.persist()
  }

  clear(chatId: string): void {
    if (this.active.delete(chatId)) this.persist()
  }

  private persist(): void {
    const payload: OrphanFile = Object.fromEntries(this.active)
    const tmp = `${this.filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      // Best-effort: a failed persist must never break a live turn. Worst case
      // is a missed recovery, not a crash.
      this.log.debug('orphan-store persist failed (ignored)', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// Minimal Telegram surface the sweep needs — a subset of TelegramApiForStatus.
interface SweepTelegramApi {
  editMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    opts: { parse_mode: 'HTML' },
  ) => Promise<unknown>
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>
}

export interface SweepDeps {
  filePath: string
  telegramApi: SweepTelegramApi
  log: Logger
  // Mirror StatusManager's complete() policy: delete when possible, else edit
  // to a terminal state.
  deleteOnComplete: boolean
}

// Startup recovery. Reads the orphan file, neutralizes each surviving bubble
// (delete, or terminal edit as fallback), then truncates the file. Returns the
// number of records processed. Never throws — a missing/corrupt file or a
// per-message failure is swallowed so boot is never blocked.
export async function sweepOrphanBubbles(deps: SweepDeps): Promise<number> {
  const { filePath, telegramApi, log, deleteOnComplete } = deps
  const records = readOrphanFile(filePath, log)
  const entries = Object.entries(records)
  if (entries.length === 0) {
    if (existsSync(filePath)) truncate(filePath, log)
    return 0
  }

  const canDelete = deleteOnComplete && telegramApi.deleteMessage !== undefined
  for (const [chatId, messageId] of entries) {
    try {
      if (canDelete) {
        await telegramApi.deleteMessage!(chatId, messageId)
      } else {
        await telegramApi.editMessageText(chatId, messageId, ORPHAN_TERMINAL_TEXT, {
          parse_mode: 'HTML',
        })
      }
    } catch (err) {
      // Already deleted, scrolled past the edit window, or a transient error —
      // none of which should block the remaining records or boot.
      const cls = classifyEditError(err)
      if (cls.kind !== 'benign' && cls.kind !== 'message_gone') {
        log.debug('orphan sweep neutralize failed (ignored)', {
          chat_id: chatId,
          message_id: messageId,
          kind: cls.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  log.info('orphan status bubbles swept on startup', { count: entries.length })
  truncate(filePath, log)
  return entries.length
}

function readOrphanFile(filePath: string, log: Logger): OrphanFile {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: OrphanFile = {}
    for (const [chatId, messageId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof messageId === 'number' && Number.isFinite(messageId) && messageId > 0) {
        out[chatId] = messageId
      }
    }
    return out
  } catch (err) {
    log.debug('orphan-store read failed, ignoring file', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

function truncate(filePath: string, log: Logger): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
    writeFileSync(filePath, JSON.stringify({}), { mode: 0o600 })
  } catch (err) {
    log.debug('orphan-store truncate failed (ignored)', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
