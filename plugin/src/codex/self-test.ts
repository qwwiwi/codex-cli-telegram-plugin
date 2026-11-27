// R38: `/doctor tests`, a short built-in smoke set. Five checks, each passes or fails on its own and is
// bounded by a timeout: the settings parse, Telegram answers getMe for the expected bot, a Codex App
// Server handshake, the Codex hooks pack, and a writable state directory. The text never carries a
// configured secret: every detail is one bounded line and the whole report goes through redactSecrets.
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { redactSecrets } from '../safety/redact.js'

export interface SelfTestResult { name: string; ok: boolean; detail: string }

export interface SelfTestDeps {
  /** Parses the bridge settings from the environment; throws when they do not parse. */
  config: () => void
  /** Telegram getMe with the configured token. */
  getMe: () => Promise<{ id: number; username?: string | undefined }>
  /** TELEGRAM_EXPECTED_BOT_ID. */
  expectedBotId: string
  /** Starts a separate Codex App Server and completes its initialize handshake; throws on failure. */
  codexHandshake: () => Promise<void>
  /** The Codex hooks pack status (codex-hooks checkHooksPack). */
  hooks: () => Promise<{ ok: boolean; detail: string }>
  /** The bridge state directory: a probe file is written, read back and removed. */
  stateDir: string
  /** The limit for each check (default 15 s). */
  timeoutMs?: number
  /** Configured secret values: masked in a detail before it is cut, so a cut never leaves part of one. */
  secrets?: readonly string[]
}

const detailMax = 200

function oneLine(text: string, secrets: readonly string[]): string {
  const clean = redactSecrets(text, secrets).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return clean.length > detailMax ? clean.slice(0, detailMax - 1) + '…' : clean
}

/** Runs one check: a pass returns its detail, a throw or a timeout is a failure. */
async function check(name: string, timeoutMs: number, secrets: readonly string[], run: () => Promise<string> | string): Promise<SelfTestResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`нет ответа за ${Math.max(1, Math.ceil(timeoutMs / 1000))} с`)), timeoutMs)
  })
  try {
    const detail = await Promise.race([Promise.resolve().then(run), timeout])
    return { name, ok: true, detail: oneLine(detail, secrets) }
  } catch (error) {
    return { name, ok: false, detail: oneLine(error instanceof Error ? error.message : String(error), secrets) }
  } finally {
    clearTimeout(timer)
  }
}

/** Runs the five checks at once; the results keep a fixed order. */
export function runSelfTests(deps: SelfTestDeps): Promise<SelfTestResult[]> {
  const ms = deps.timeoutMs ?? 15_000
  const secrets = deps.secrets ?? []
  return Promise.all([
    check('Настройки', ms, secrets, () => {
      deps.config()
      return 'plugin/.env и переменные окружения разобраны'
    }),
    check('Telegram API', ms, secrets, async () => {
      const bot = await deps.getMe()
      if (String(bot.id) !== deps.expectedBotId.trim()) {
        throw new Error(`токен принадлежит боту id ${bot.id}, а TELEGRAM_EXPECTED_BOT_ID = ${deps.expectedBotId.trim()}`)
      }
      return `бот ${bot.username ? '@' + bot.username + ' ' : ''}(id ${bot.id})`
    }),
    check('Codex App Server', ms, secrets, async () => {
      await deps.codexHandshake()
      return 'handshake прошёл'
    }),
    check('Хуки Codex', ms, secrets, async () => {
      const hooks = await deps.hooks()
      if (!hooks.ok) throw new Error(hooks.detail)
      return hooks.detail
    }),
    check('Каталог состояния', ms, secrets, () => {
      const probe = join(deps.stateDir, `.self-test-${randomUUID()}`)
      try {
        writeFileSync(probe, 'ok', { mode: 0o600 })
        if (readFileSync(probe, 'utf8') !== 'ok') throw new Error('записанный файл читается иначе')
      } finally {
        rmSync(probe, { force: true })
      }
      return 'запись, чтение и удаление файла работают'
    }),
  ])
}

/**
 * The hooks pack as one self-test result, by the doctor script's rule: checked only when KROT_CODEX_HOOKS=1
 * (an install with --no-hooks passes), and a warning (registered but not trusted) fails like an error.
 */
export async function selfTestHooks(enabled: boolean,
  checks: () => Promise<readonly { status: 'ok' | 'info' | 'warning' | 'error'; message: string }[]>): Promise<{ ok: boolean; detail: string }> {
  if (!enabled) return { ok: true, detail: 'пакет хуков выключен (KROT_CODEX_HOOKS не 1)' }
  const list = await checks()
  const bad = list.find(check => check.status === 'warning' || check.status === 'error')
  if (bad) return { ok: false, detail: bad.message }
  const first = list[0]
  return first ? { ok: true, detail: first.message } : { ok: false, detail: 'статус хуков не получен' }
}

/** The chat text: a count line, then one ✅/❌ line per check; secrets are masked. */
export function formatSelfTests(results: readonly SelfTestResult[], secrets: readonly string[]): string {
  const passed = results.filter(result => result.ok).length
  const lines = [`🧪 Тесты моста. Прошло ${passed} из ${results.length}.`,
    ...results.map(result => `${result.ok ? '✅' : '❌'} ${result.name}: ${result.detail}`)]
  return redactSecrets(lines.join('\n'), secrets)
}
