// Exit-code contract between the bridge and its systemd unit (see docs/design/self-update-spec.md, S1).
// 0 = operator stop, 1 = crash (restart with spacing), 75 = planned restart (always restarted),
// 78 = fatal configuration (RestartPreventExitStatus: never restarted, the owner must fix it).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import { z, ZodError } from 'zod'

import { PollerFatalError } from '../telegram/poller.js'

export const EXIT = { stop: 0, crash: 1, restart: 75, fatalConfig: 78 } as const

// Startup errors a restart cannot fix: the owner has to change the setup.
const fatalConfig = /^(Run the Codex pilot|The pilot requires|Set absolute|The Codex workspace|Telegram state must|This private pilot|A Codex proxy requires|Configured Telegram token|KROT_CODEX_SANDBOX=danger-full-access cannot|telegram bot_id mismatch|KROT_FORMAT_REMINDER must be)/
// Another process owns the token or the state: it may go away, so a spaced restart is right.
const ownedElsewhere = /^A bot already owns/

/** True when the error message is one of the known startup messages that is safe to print. */
export function isKnownStartupError(error: unknown): error is Error {
  return error instanceof Error && (fatalConfig.test(error.message) || ownedElsewhere.test(error.message))
}

/** Maps an error that ended main() to the process exit code. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof PollerFatalError) return error.kind === 'conflict' ? EXIT.restart : EXIT.fatalConfig
  // A rejected token is never fixed by restarting; a malformed one gets 404 from getMe at startup.
  if (error instanceof GrammyError &&
      (error.error_code === 401 || (error.error_code === 404 && error.method === 'getMe'))) return EXIT.fatalConfig
  // plugin/.env failed validation (missing or empty token, bad values).
  if (error instanceof ZodError) return EXIT.fatalConfig
  if (!(error instanceof Error)) return EXIT.crash
  if (fatalConfig.test(error.message)) return EXIT.fatalConfig
  if (ownedElsewhere.test(error.message)) return EXIT.restart
  return EXIT.crash
}

/** A reason for fatal.json and the owner message that never carries a secret or a config value. */
export function fatalReason(error: unknown): string {
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map(issue => issue.path.join('.')).filter(Boolean))]
    return 'plugin/.env failed validation' + (fields.length ? ': ' + fields.join(', ') : '')
  }
  if (error instanceof GrammyError && error.error_code === 404) {
    return 'Telegram did not recognise the bot token (404 Not Found); copy it from BotFather again'
  }
  if (error instanceof PollerFatalError || error instanceof GrammyError) {
    return 'Telegram rejected the bot token (401 Unauthorized)'
  }
  if (isKnownStartupError(error)) return error.message
  return 'Krot Codex pilot could not start'
}

export interface FatalRecord {
  stateDir: string | undefined
  reason: string
  send: (text: string) => Promise<unknown>
  now?: () => number
  /**
   * Set when this boot is the trial of an /update: the caller exits 1 instead of 78, so systemd starts
   * again and the boot guard rolls back. No fatal.json then (the old version runs fine) and the owner
   * is told it is the update that failed, not the setup.
   */
  update?: { from: string; to: string }
}

/** The exit code for a startup error: 78 becomes 1 during an /update trial, so the guard can roll back. */
export function exitCodeDuringTrial(code: number, trial: boolean): number {
  return trial && code === EXIT.fatalConfig ? EXIT.crash : code
}

const FatalSchema = z.object({ v: z.literal(1), at: z.string(), reason: z.string() })
export type FatalFile = z.infer<typeof FatalSchema>

/**
 * <state>/fatal.json for /doctor: `missing` when there is none, `unreadable` when it exists but cannot
 * be parsed. Never throws.
 */
export function readFatal(stateDir: string): FatalFile | 'missing' | 'unreadable' {
  const path = join(stateDir, 'fatal.json')
  if (!existsSync(path)) return 'missing'
  try {
    const parsed = FatalSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Before exit 78: writes <state>/fatal.json {v:1, at, reason} and tries one owner message. Never throws. */
export async function recordFatal({ stateDir, reason, send, now = Date.now, update }: FatalRecord): Promise<void> {
  if (update) {
    try {
      await send('⚠️ Новая версия ' + update.to.slice(0, 12) + ' после /update не запустилась: ' + reason +
        '.\n\nНастройку не трогай: сейчас верну прежнюю версию ' + update.from.slice(0, 12) + ' и напишу, когда бот снова заработает.')
    } catch {
      console.error('Could not notify the owner about the failed update')
    }
    return
  }
  if (stateDir && existsSync(stateDir)) {
    const path = join(stateDir, 'fatal.json')
    const temp = path + '.' + process.pid + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify({ v: 1, at: new Date(now()).toISOString(), reason }) + '\n', { mode: 0o600 })
      renameSync(temp, path)
    } catch (error) {
      console.error('Could not write fatal.json:', error instanceof Error ? error.message : String(error))
    }
  }
  try {
    await send('Мост остановлен и не будет перезапускаться сам: ошибка настройки.\n\nПричина: ' + reason +
      '\n\nИсправь настройку на сервере и запусти службу снова: systemctl --user restart krotov-telegram.service')
  } catch {
    console.error('Could not notify the owner about the fatal configuration error')
  }
}
