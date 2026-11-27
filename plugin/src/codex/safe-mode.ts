// Safe mode (docs/design/self-update-spec.md, S5): after a chain of unhealthy boots the bridge stays
// up with the Telegram poller and owner commands only. It does not start Codex, recover the inbox,
// verify the restart handoff or resume goals. The owner is told once per chain; only the owner's
// /restart leaves safe mode, for one trial boot.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BootLedger, SafeModeEntry } from './boot-ledger.js'
import { bridgeUnitName } from './unit-contract.js'

export type { SafeModeEntry } from './boot-ledger.js'

export interface BootBridgeDeps<T> {
  ledger: BootLedger
  boot: { commit: string; invocation: string }
  sleep: (ms: number) => Promise<void>
  /** The full bridge: Codex, inbox recovery, handoff, goals. */
  normal: () => Promise<T>
  /** The poller and owner commands only. */
  safe: (entry: SafeModeEntry) => Promise<T>
  onBackoff?: (ms: number, chain: number) => void
}

/** Records the boot, applies the S4 backoff, then runs either the normal bridge or safe mode. */
export async function bootBridge<T>(deps: BootBridgeDeps<T>): Promise<T> {
  const start = deps.ledger.begin(deps.boot)
  if (start.delayMs > 0) {
    deps.onBackoff?.(start.delayMs, start.chain)
    await deps.sleep(start.delayMs)
  }
  const entry = deps.ledger.safeMode()
  if (!entry) return deps.normal()
  deps.ledger.markSafe()
  return deps.safe(entry)
}

/** The longest pause between polling attempts in safe mode while another poller holds the token. */
export const SAFE_MODE_CONFLICT_MAX_MS = 600_000

export interface PollThroughConflictsDeps {
  /** The poller's start(): resolves when polling stops, rejects on a fatal polling error. */
  start: () => Promise<void>
  /** Waits ms; resolves early once signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Aborted when safe mode ends (owner /restart, SIGTERM). */
  signal: AbortSignal
  /** True for a persistent 409 Conflict (another poller owns the token). */
  isConflict: (error: unknown) => boolean
  onConflict?: (delayMs: number, attempt: number) => void
}

/**
 * Safe mode must stay up: a persistent 409 makes the poller give up, and exiting 75 on that would
 * restart the bridge forever (starts more than 100 s apart never trip the systemd start limit).
 * So safe mode backs off in-process (30 s doubling, at most 10 min) and polls again.
 * Any other polling error still ends the process.
 */
export async function pollThroughConflicts(deps: PollThroughConflictsDeps): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.start()
      return
    } catch (error) {
      if (deps.signal.aborted) return
      if (!deps.isConflict(error)) throw error
      const delay = Math.min(SAFE_MODE_CONFLICT_MAX_MS, 30_000 * 2 ** Math.min(attempt - 1, 10))
      deps.onConflict?.(delay, attempt)
      await deps.sleep(delay, deps.signal)
      if (deps.signal.aborted) return
    }
  }
}

/** Owner messages received in safe mode: kept in <state>/safe-mode-messages.jsonl, never run. */
export class SafeModeInbox {
  private readonly path: string
  constructor(stateDir: string) {
    this.path = join(stateDir, 'safe-mode-messages.jsonl')
  }

  store(record: { messageId: number; text: string; at: number }): boolean {
    try {
      appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * Ends safe mode once (a /restart, a rollback, SIGTERM): arms the shutdown watchdog first, so a poller
 * stop that waits on a hanging handler or send cannot keep a deaf bridge alive, then stops polling.
 */
export function safeModeStop(steps: { armWatchdog: () => void; abort: () => void; stopPoller: () => void }): () => void {
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    steps.armWatchdog()
    steps.abort()
    steps.stopPoller()
  }
}

export interface SafeModeDeps {
  ledger: BootLedger
  entry: SafeModeEntry
  send: (text: string) => Promise<unknown>
  /** The acknowledgement of a committed restart: bounded and never rejects (RestartNotices.acknowledge). */
  acknowledge: (text: string) => Promise<void>
  /** Ends the process with exit 75 (planned restart). */
  restart: () => void
  /** The /doctor report as chat text. */
  doctor: () => Promise<string>
  inbox: SafeModeInbox
  /** /update rollback (S9): returns the checkout to the commit before the last /update. */
  rollback?: () => Promise<{ ok: boolean; text: string }>
  /** /update codex rollback: puts back the Codex the last /update codex replaced. */
  codexRollback?: () => { ok: boolean; text: string }
  now?: () => number
}

const commandsHelp = [
  'Что можно сделать:',
  '/status — что случилось',
  '/doctor — самопроверка',
  '/restart — попробовать запуститься снова (если снова не получится, я вернусь в безопасный режим)',
  '/update rollback — вернуть версию до последнего /update',
  '/update codex rollback — вернуть Codex до последнего /update codex',
].join('\n')

function reasonText(entry: SafeModeEntry): string {
  return entry.reason === 'trial'
    ? 'Пробный запуск после /restart не заработал нормально.'
    : `Мост запускался ${entry.chain} раза подряд и ни разу не заработал нормально.`
}

export class SafeMode {
  readonly entry: SafeModeEntry
  private restarting = false

  constructor(private readonly deps: SafeModeDeps) {
    this.entry = deps.entry
  }

  /** The single owner notice for this chain; the ledger remembers it was sent. */
  async announce(): Promise<void> {
    if (!this.entry.notify) return
    await this.deps.send([
      '⚠️ Безопасный режим.',
      reasonText(this.entry) + ' Поэтому агент не запущен и задачи не выполняются, но бот на связи.',
      '',
      commandsHelp,
      '',
      `Причину падений видно на сервере: journalctl --user -u ${bridgeUnitName(process.env.KROT_CODEX_SERVICE_NAME)} -n 50`,
    ].join('\n'))
    this.deps.ledger.noticeSent()
  }

  /** One owner message in safe mode. */
  async handle(message: { text: string; messageId: number }): Promise<void> {
    const command = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(message.text.trim())
    const name = command?.[1]?.toLowerCase()
    const args = command?.[2]?.trim().toLowerCase() ?? ''
    if (name === 'restart') {
      if (this.restarting) return
      this.restarting = true
      this.deps.ledger.clearForTrial()
      await this.deps.acknowledge('Перезапускаюсь и пробую запустить агента. Если не получится, вернусь в безопасный режим и напишу.')
      this.deps.restart()
      return
    }
    if (name === 'status') {
      await this.deps.send('⚠️ Безопасный режим. ' + reasonText(this.entry) + '\n\n' + commandsHelp)
      return
    }
    if (name === 'doctor') {
      await this.deps.send(await this.deps.doctor())
      return
    }
    if (name === 'update' && args === 'codex rollback' && this.deps.codexRollback) {
      if (this.restarting) return
      const result = this.deps.codexRollback()
      if (!result.ok) {
        await this.deps.send(result.text)
        return
      }
      this.restarting = true
      this.deps.ledger.clearForTrial()
      await this.deps.acknowledge(result.text + ' Перезапускаюсь.')
      this.deps.restart()
      return
    }
    if (name === 'update' && args === 'rollback' && this.deps.rollback) {
      if (this.restarting) return
      this.restarting = true
      const result = await this.deps.rollback()
      if (!result.ok) {
        this.restarting = false
        await this.deps.send(result.text)
        return
      }
      this.deps.ledger.clearForTrial()
      await this.deps.acknowledge(result.text + ' Перезапускаюсь.')
      this.deps.restart()
      return
    }
    if (name === 'update' && args === 'rollback') {
      await this.deps.send('Команда /update rollback пока не поддерживается: откат обновлений ещё не встроен в мост. ' +
        'Откатить вручную можно на сервере через git. Чтобы просто попробовать снова, отправь /restart.')
      return
    }
    const stored = this.deps.inbox.store({ messageId: message.messageId, text: message.text, at: (this.deps.now ?? Date.now)() })
    await this.deps.send((stored ? 'Сохранил сообщение, но не выполняю его' : 'Не выполняю сообщение') +
      ': мост в безопасном режиме, агент не запущен.\n\n' + commandsHelp)
  }
}
