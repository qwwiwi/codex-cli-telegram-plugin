import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'

import { EXIT, exitCodeDuringTrial, exitCodeFor, fatalReason, recordFatal } from '../../src/codex/exit-codes.js'
import { RuntimeEnvSchema } from '../../src/config.js'
import { PollerFatalError } from '../../src/telegram/poller.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('exit codes: operator stop 0, crash 1, planned restart 75, fatal config 78', () => {
  expect(EXIT).toEqual({ stop: 0, crash: 1, restart: 75, fatalConfig: 78 })
})

test('every known startup configuration error exits 78', () => {
  for (const message of [
    'Run the Codex pilot as a dedicated non-root user',
    'The pilot requires exactly one owner and that owner’s private chat',
    'Set absolute TELEGRAM_STATE_DIR and TELEGRAM_WORKSPACE_ROOT and set TELEGRAM_EXPECTED_BOT_ID',
    'The Codex workspace must be a directory',
    'Telegram state must be outside the Codex workspace',
    'This private pilot ...',
    'A Codex proxy requires an absolute path and Telegram approval handling',
    'Configured Telegram token does not match the expected bot',
    'KROT_CODEX_SANDBOX=danger-full-access cannot be used with KROT_CODEX_PROXY',
  ]) expect(exitCodeFor(new Error(message)), message).toBe(78)
})

test('a token-lock conflict and 409 exhaustion exit 75', () => {
  expect(exitCodeFor(new Error('A bot already owns this state directory'))).toBe(75)
  expect(exitCodeFor(new PollerFatalError('conflict', '409 Conflict persisted', 8))).toBe(75)
})

test('a bad token never produces a restartable code', () => {
  const unauthorized = new GrammyError('Call to getMe failed', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {})
  for (const error of [
    new PollerFatalError('unauthorized', '401 Unauthorized after 3 attempts', 3),
    unauthorized,
    new Error('telegram bot_id mismatch: token belongs to 1, config expects 2'),
    new Error('Configured Telegram token does not match the expected bot'),
  ]) {
    const code = exitCodeFor(error)
    expect(code).toBe(78)
    expect([1, 75]).not.toContain(code)
  }
})

test('an unknown error is a crash', () => {
  expect(exitCodeFor(new Error('ECONNRESET'))).toBe(1)
  expect(exitCodeFor('weird')).toBe(1)
})

test('recordFatal writes state/fatal.json and tries exactly one owner message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-fatal-'))
  temporary.push(dir)
  const sent: string[] = []
  await recordFatal({ stateDir: dir, reason: 'The Codex workspace must be a directory', now: () => 1_700_000_000_000,
    send: async text => { sent.push(text) } })
  const saved = JSON.parse(readFileSync(join(dir, 'fatal.json'), 'utf8'))
  expect(saved).toEqual({ v: 1, at: new Date(1_700_000_000_000).toISOString(), reason: 'The Codex workspace must be a directory' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('The Codex workspace must be a directory')
})

test('recordFatal survives a failed send and a missing state directory', async () => {
  let calls = 0
  await recordFatal({ stateDir: undefined, reason: 'x', send: async () => { calls++; throw new Error('offline') } })
  expect(calls).toBe(1)
  const dir = join(tmpdir(), 'krotov-fatal-missing-' + process.pid, 'nested')
  await recordFatal({ stateDir: dir, reason: 'x', send: async () => undefined })
  expect(existsSync(join(dir, 'fatal.json'))).toBe(false)
})

test('[S1] an invalid environment and a malformed token exit 78, not a restart loop', () => {
  const env = RuntimeEnvSchema.safeParse({ TELEGRAM_BOT_TOKEN: '' })
  expect(env.success).toBe(false)
  if (!env.success) expect(exitCodeFor(env.error)).toBe(78)
  const notFound = new GrammyError('Call to getMe failed', { ok: false, error_code: 404, description: 'Not Found' }, 'getMe', {})
  expect(exitCodeFor(notFound)).toBe(78)
  // A 404 from another method is not a token problem.
  const other = new GrammyError('Call to sendMessage failed', { ok: false, error_code: 404, description: 'Not Found' }, 'sendMessage', {})
  expect(exitCodeFor(other)).toBe(1)
})

test('[S1] the fatal reason names the bad .env fields without their values', () => {
  const env = RuntimeEnvSchema.safeParse({ TELEGRAM_BOT_TOKEN: '' })
  if (env.success) throw new Error('expected a validation error')
  expect(fatalReason(env.error)).toContain('TELEGRAM_BOT_TOKEN')
  expect(fatalReason(new PollerFatalError('unauthorized', '401', 3))).toContain('401')
  expect(fatalReason(new GrammyError('x', { ok: false, error_code: 404, description: 'Not Found' }, 'getMe', {}))).toContain('BotFather')
  expect(fatalReason(new Error('The Codex workspace must be a directory'))).toBe('The Codex workspace must be a directory')
})

test('[S1] an invalid KROT_FORMAT_REMINDER is a fatal configuration error (78), not a crash loop', () => {
  expect(exitCodeFor(new Error('KROT_FORMAT_REMINDER must be on or off'))).toBe(EXIT.fatalConfig)
})

test('[S9] exit 78 on the trial boot of an /update becomes 1, so systemd starts again and the guard rolls back', () => {
  expect(exitCodeDuringTrial(EXIT.fatalConfig, true)).toBe(EXIT.crash)
  expect(exitCodeDuringTrial(EXIT.fatalConfig, false)).toBe(EXIT.fatalConfig)
  expect(exitCodeDuringTrial(EXIT.restart, true)).toBe(EXIT.restart)
})

test('[S9] a fatal error on a trial boot names the update to the owner and writes no fatal.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-fatal-trial-'))
  const sent: string[] = []
  try {
    await recordFatal({ stateDir: dir, reason: 'plugin/.env failed validation: NEW_FIELD',
      update: { from: 'a'.repeat(40), to: 'b'.repeat(40) }, send: async text => { sent.push(text) } })
    expect(existsSync(join(dir, 'fatal.json'))).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('bbbbbbbbbbbb')
    expect(sent[0]).toContain('/update')
    expect(sent[0]).toContain('aaaaaaaaaaaa')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
