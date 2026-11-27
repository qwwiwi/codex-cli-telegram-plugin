// Store fixes from the Opus review of S0: lock budget, directory fsync on create, home-level lock
// for config.json, pid namespaces in the lock holder, reserved scope names, intents directory.

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBrainConfig, writeBrainConfig } from '../../../codex-brain/src/config.js'
import { HOOK_STEP_BUDGET_MS } from '../../../codex-brain/src/contract.js'
import { appendLine } from '../../../codex-brain/src/store/atomic.js'
import { LOCK_MAX_HOLD_MS, LOCK_TIMEOUT_MS, LockTimeoutError, withLock } from '../../../codex-brain/src/store/lock.js'
import { ensureScope, homePaths, scopePaths } from '../../../codex-brain/src/store/paths.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brain-freeze-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ownPidNamespace = (): string => readlinkSync('/proc/self/ns/pid')

async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

test('a lock wait gives up inside the hook step budget', () => {
  expect(LOCK_TIMEOUT_MS).toBeLessThan(HOOK_STEP_BUDGET_MS)
})

test('appendLine fsyncs the directory when it creates the file, and only then', () => {
  const target = join(dir, 'j.jsonl')
  const open = spyOn(fs, 'openSync')
  try {
    appendLine(target, '{"n":1}')
    expect(open.mock.calls.filter(call => call[0] === dir).length).toBe(1)
    appendLine(target, '{"n":2}')
    expect(open.mock.calls.filter(call => call[0] === dir).length).toBe(1)
  } finally {
    open.mockRestore()
  }
  expect(readFileSync(target, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
})

test('writeBrainConfig waits for the brain_home lock and writes nothing while another process holds it', async () => {
  const home = join(dir, 'brain')
  const h = homePaths(home)
  expect(h.lockDir).toBe(join(home, 'lock'))
  mkdirSync(h.lockDir, { recursive: true })
  writeFileSync(join(h.lockDir, 'held'), JSON.stringify({ pid: process.pid, pidns: ownPidNamespace(), acquired: new Date().toISOString() }))
  await expect(writeBrainConfig(home, { enabled: false }, { timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
  expect(existsSync(h.config)).toBe(false)
  rmSync(join(h.lockDir, 'held'))
  await Promise.all([writeBrainConfig(home, { enabled: false }), writeBrainConfig(home, { resume_reemit: true })])
  expect(readBrainConfig(home)).toMatchObject({ enabled: false, resume_reemit: true })
  expect(existsSync(join(h.lockDir, 'held'))).toBe(false)
})

test('the lock holder records its pid namespace', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const holder = await withLock(lockDir, async () => JSON.parse(readFileSync(join(lockDir, 'held'), 'utf8')) as Record<string, unknown>)
  expect(holder.pid).toBe(process.pid)
  expect(holder.pidns).toBe(ownPidNamespace())
})

test('a holder from another pid namespace is judged by age only: kept while young even if its pid looks dead here', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const held = join(lockDir, 'held')
  const pid = await deadPid()
  writeFileSync(held, JSON.stringify({ pid, pidns: 'pid:[1]', acquired: new Date().toISOString() }))
  await expect(withLock(lockDir, async () => 'stolen', { timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
  expect(existsSync(held)).toBe(true)

  writeFileSync(held, JSON.stringify({ pid: process.pid, pidns: 'pid:[1]', acquired: new Date(Date.now() - LOCK_MAX_HOLD_MS - 1000).toISOString() }))
  expect(await withLock(lockDir, async () => 'took over', { timeoutMs: 500 })).toBe('took over')
})

test('a dead holder from this pid namespace is still broken at once', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'held'), JSON.stringify({ pid: await deadPid(), pidns: ownPidNamespace(), acquired: new Date().toISOString() }))
  expect(await withLock(lockDir, async () => 'took over', { timeoutMs: 500 })).toBe('took over')
})

test('brain_home has an intents directory and a lock; no scope can shadow them', () => {
  const home = join(dir, 'brain')
  ensureScope(home, 'local')
  const h = homePaths(home)
  expect(h.intentsDir).toBe(join(home, 'intents'))
  expect(h.intent('../x').startsWith(join(home, 'intents') + '/')).toBe(true)
  for (const d of [h.intentsDir, h.lockDir]) expect(statSync(d).mode & 0o777).toBe(0o700)
  for (const reserved of ['sessions', 'intents', 'lock']) expect(() => scopePaths(home, reserved)).toThrow()
})
