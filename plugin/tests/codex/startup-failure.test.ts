import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeEnvSchema } from '../../src/config.js'
import type { PendingUpdate, TrialOutcome } from '../../src/codex/self-update.js'
import { startupFailureExit } from '../../src/codex/startup-failure.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function invalidEnvError(): unknown {
  const env = RuntimeEnvSchema.safeParse({ TELEGRAM_BOT_TOKEN: '' })
  if (env.success) throw new Error('expected a validation error')
  return env.error
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-startup-failure-'))
  temporary.push(dir)
  return dir
}

const trial: PendingUpdate = { phase: 'trial', from: 'a'.repeat(40), to: 'b'.repeat(40), boots: 1, at: 1 }

test('[S9] a fatal configuration error on the trial boot of an /update exits 1 and records a crash, so the guard rolls back', async () => {
  const outcomes: TrialOutcome[] = []
  const sent: string[] = []
  const dir = stateDir()
  const code = await startupFailureExit({
    error: invalidEnvError(), watchdog: false, stateDir: dir,
    recordTrial: outcome => { outcomes.push(outcome); return trial },
    send: async text => { sent.push(text) },
  })
  expect(code).toBe(1)
  expect(outcomes).toEqual(['crash'])
  expect(existsSync(join(dir, 'fatal.json'))).toBe(false)
  expect(sent[0]).toContain('/update')
})

test('[S1] the same error outside a trial exits 78 and writes fatal.json', async () => {
  const dir = stateDir()
  const code = await startupFailureExit({
    error: invalidEnvError(), watchdog: false, stateDir: dir,
    recordTrial: () => undefined, send: async () => undefined,
  })
  expect(code).toBe(78)
  expect(existsSync(join(dir, 'fatal.json'))).toBe(true)
})

test('an unknown startup error is a crash; the startup watchdog is recorded as such', async () => {
  const outcomes: TrialOutcome[] = []
  const code = await startupFailureExit({
    error: new Error('boom'), watchdog: true, stateDir: stateDir(),
    recordTrial: outcome => { outcomes.push(outcome); return trial }, send: async () => undefined,
  })
  expect(code).toBe(1)
  expect(outcomes).toEqual(['watchdog'])
})
