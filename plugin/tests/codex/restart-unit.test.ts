import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BOOT_GUARD_LINE, unitDrift } from '../../src/codex/unit-contract.js'
import { runDoctor } from '../../scripts/doctor.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const script = resolve(import.meta.dir, '../../scripts/notify-failed.sh')
const example = resolve(import.meta.dir, '../../../examples/krotov-telegram.service')

function sandbox(envText: string) {
  const root = mkdtempSync(join(tmpdir(), 'krotov-notify-'))
  temporary.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const envFile = join(root, '.env')
  writeFileSync(envFile, envText, { mode: 0o600 })
  // Fake curl: records its argv and the config it read on stdin.
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CALLS"\ncat >> "$CALLS"\n', { mode: 0o700 })
  const calls = join(root, 'calls')
  const run = () => Bun.spawnSync(['bash', script, envFile], {
    env: { PATH: bin + ':/usr/bin:/bin', CALLS: calls }, stdout: 'pipe', stderr: 'pipe' })
  return { run, calls }
}

test('[S2] the failure notifier sends one Telegram message with the token kept out of argv', () => {
  const { run, calls } = sandbox('TELEGRAM_BOT_TOKEN=123:abc_DEF-1\nTELEGRAM_ALLOWED_CHAT_IDS=987654321\n')
  const result = run()
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const text = readFileSync(calls, 'utf8')
  const argv = text.split('\n')[0]!
  expect(argv).not.toContain('123:abc_DEF-1')
  expect(argv).toContain('chat_id=987654321')
  expect(text).toContain('https://api.telegram.org/bot123:abc_DEF-1/sendMessage')
  expect(text.match(/sendMessage/g)).toHaveLength(1)
})

test('[S2] the failure notifier exits non-zero without a token and sends nothing', () => {
  const { run, calls } = sandbox('TELEGRAM_ALLOWED_CHAT_IDS=987654321\n')
  expect(run().exitCode).not.toBe(0)
  expect(existsSync(calls)).toBe(false)
})

test('[S2] the example unit carries the restart-loop contract', () => {
  expect(unitDrift(readFileSync(example, 'utf8'))).toEqual([])
})

test('[S2] unit drift lists each missing restart-loop line of an older unit', () => {
  const old = '[Unit]\nDescription=x\n[Service]\nType=simple\nRestart=on-failure\nRestartSec=10s\n'
  expect(unitDrift(old)).toContain('RestartPreventExitStatus=78')
  expect(unitDrift(old)).toContain('StartLimitBurst=6')
  expect(unitDrift(old)).not.toContain('Restart=on-failure')
})

test('[S9] unit drift reports a unit that does not run the boot guard before each start', () => {
  const unit = readFileSync(example, 'utf8')
  expect(unitDrift(unit)).toEqual([])
  const without = unit.split('\n').filter(line => !line.startsWith('ExecStartPre=')).join('\n')
  expect(unitDrift(without)).toEqual([BOOT_GUARD_LINE])
  // A guard whose failure would block the start does not count: it must carry the "-" prefix.
  expect(unitDrift(without + '\nExecStartPre=/bin/bash "/my state/boot-guard.sh"\n')).toEqual([BOOT_GUARD_LINE])
  expect(unitDrift(without + '\nExecStartPre=-/bin/bash "/my state/boot-guard.sh"\n')).toEqual([])
  // The guard inside the checkout can be deleted or broken by the update it should roll back.
  expect(unitDrift(without + '\nExecStartPre=-/bin/bash "/my dir/plugin/scripts/boot-guard.sh"\n')).toEqual([BOOT_GUARD_LINE])
})

test('[S2] doctor warns about drift in an existing unit and stays quiet without one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-doctor-unit-'))
  temporary.push(root)
  const env = { HOME: root }
  const ownerInstructionChecks = mock((_home: string) => [])
  const probes = {
    checkCodex: () => ({ status: 'ok' as const, message: 'codex' }),
    ownerInstructionChecks,
    telegram: async () => null,
  }
  const old = '[Unit]\n[Service]\nRestart=on-failure\nRestartSec=10s\n'
  const drift = await runDoctor(env, { ...probes, unitFile: () => old })
  const warning = drift.find(check => check.message.includes('RestartPreventExitStatus=78'))
  expect(warning?.status).toBe('warning')
  const none = await runDoctor(env, { ...probes, unitFile: () => undefined })
  expect(none.some(check => check.message.includes('Служба'))).toBe(false)
  const current = await runDoctor(env, { ...probes, unitFile: () => readFileSync(example, 'utf8') })
  expect(current.find(check => check.message.includes('перезапуск'))?.status).toBe('ok')
  expect(ownerInstructionChecks.mock.calls).toEqual(Array.from({ length: 3 }, () => [join(root, '.codex')]))
})

test('[S2] the failure notifier stays silent after exit 78, which the bridge already reported', () => {
  const { calls } = sandbox('TELEGRAM_BOT_TOKEN=123:abc_DEF-1\nTELEGRAM_ALLOWED_CHAT_IDS=987654321\n')
  const envFile = join(calls, '..', '.env')
  const result = Bun.spawnSync(['bash', script, envFile], {
    env: { PATH: join(calls, '..', 'bin') + ':/usr/bin:/bin', CALLS: calls, MONITOR_EXIT_STATUS: '78' }, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(existsSync(calls)).toBe(false)
})
