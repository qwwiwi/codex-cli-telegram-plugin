// R38: the /doctor tests smoke set. Each check passes or fails on its own; a hanging one times out.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatSelfTests, runSelfTests, selfTestHooks, type SelfTestDeps } from '../../src/codex/self-test.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function deps(overrides: Partial<SelfTestDeps> = {}): SelfTestDeps {
  const stateDir = mkdtempSync(join(tmpdir(), 'krot-selftest-'))
  temporary.push(stateDir)
  return {
    config: () => undefined,
    getMe: async () => ({ id: 42, username: 'example_bot' }),
    expectedBotId: '42',
    codexHandshake: async () => undefined,
    hooks: async () => ({ ok: true, detail: 'хуки Codex зарегистрированы' }),
    stateDir,
    ...overrides,
  }
}

test('[R38] a healthy bridge passes all five self-test checks in a fixed order', async () => {
  const input = deps()
  const results = await runSelfTests(input)
  expect(results.map(result => [result.name, result.ok])).toEqual([
    ['Настройки', true], ['Telegram API', true], ['Codex App Server', true], ['Хуки Codex', true], ['Каталог состояния', true],
  ])
  expect(results[1]?.detail).toBe('бот @example_bot (id 42)')
  // The writability probe leaves nothing behind.
  expect(readdirSync(input.stateDir)).toEqual([])
  expect(formatSelfTests(results, [])).toContain('Прошло 5 из 5')
})

test('[R38] each failing check fails on its own: config, another bot, handshake, hooks, a read-only state dir, a hang', async () => {
  const input = deps({
    config: () => { throw new Error('TELEGRAM_ALLOWED_CHAT_IDS: Required') },
    getMe: async () => ({ id: 7, username: 'other_bot' }),
    codexHandshake: () => new Promise(() => undefined),
    hooks: async () => ({ ok: false, detail: 'не установлены. Запустите ./install.sh --hooks.' }),
    timeoutMs: 20,
  })
  chmodSync(input.stateDir, 0o500)
  const results = await runSelfTests(input)
  expect(results.map(result => result.ok)).toEqual([false, false, false, false, process.getuid?.() === 0])
  expect(results[0]?.detail).toContain('TELEGRAM_ALLOWED_CHAT_IDS')
  expect(results[1]?.detail).toBe('токен принадлежит боту id 7, а TELEGRAM_EXPECTED_BOT_ID = 42')
  expect(results[2]?.detail).toBe('нет ответа за 1 с')
  expect(results[3]?.detail).toContain('./install.sh --hooks')
})

test('[R38] a failure text never carries a configured secret', async () => {
  const token = '42:AAA-secret-value'
  const results = await runSelfTests(deps({ getMe: async () => { throw new Error('GET https://api.telegram.org/bot' + token + '/getMe failed') } }))
  const text = formatSelfTests(results, [token])
  expect(text).toContain('❌ Telegram API')
  expect(text).not.toContain('AAA-secret-value')
})

test('[R38] the hooks check passes when the pack is off by configuration and fails on a warning or an error', async () => {
  const never = async () => { throw new Error('must not list hooks when the pack is off') }
  expect(await selfTestHooks(false, never)).toEqual({ ok: true, detail: 'пакет хуков выключен (KROT_CODEX_HOOKS не 1)' })
  expect(await selfTestHooks(true, async () => [{ status: 'ok', message: 'Хуки зарегистрированы.' }, { status: 'info', message: 'Brain выключен.' }]))
    .toEqual({ ok: true, detail: 'Хуки зарегистрированы.' })
  expect(await selfTestHooks(true, async () => [{ status: 'ok', message: 'Хуки зарегистрированы.' }, { status: 'warning', message: 'Codex ещё не доверяет им.' }]))
    .toEqual({ ok: false, detail: 'Codex ещё не доверяет им.' })
  expect(await selfTestHooks(true, async () => [])).toEqual({ ok: false, detail: 'статус хуков не получен' })
})
