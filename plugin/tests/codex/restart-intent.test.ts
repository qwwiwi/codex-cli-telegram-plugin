import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RestartIntents } from '../../src/codex/restart-intent.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-intent-'))
  temporary.push(dir)
  return dir
}
const boot = { invocation: 'inv-1', fromCommit: 'aaa' }

test('[S6] the same owner message restarts the bridge only once', () => {
  const dir = stateDir()
  let now = 1_000_000
  const intents = new RestartIntents(dir, () => now)
  expect(intents.admit({ ...boot, kind: 'restart', ownerMessageId: 10 })).toEqual({ ok: true })
  now += 20_000
  // A fresh process reads the honoured id from disk.
  const after = new RestartIntents(dir, () => now)
  expect(after.admit({ ...boot, kind: 'restart', ownerMessageId: 10 })).toEqual({ ok: false, reason: 'stale' })
  expect(after.admit({ ...boot, kind: 'restart', ownerMessageId: 9 })).toEqual({ ok: false, reason: 'stale' })
  expect(after.admit({ ...boot, kind: 'restart', ownerMessageId: 11 })).toEqual({ ok: true })
  const saved = JSON.parse(readFileSync(join(dir, 'restart-intent.json'), 'utf8')) as { v: number; last: { kind: string; ownerMessageId: number } }
  expect(saved.v).toBe(1)
  expect(saved.last).toMatchObject({ kind: 'restart', ownerMessageId: 11, fromCommit: 'aaa', invocation: 'inv-1' })
})

test('[S6] a third planned restart chained within 300 s without a new owner message is refused', () => {
  const dir = stateDir()
  let now = 1_000_000
  const at = () => new RestartIntents(dir, () => now)
  expect(at().admit({ ...boot, kind: 'agent' })).toEqual({ ok: true })
  now += 100_000
  expect(at().admit({ ...boot, kind: 'agent' })).toEqual({ ok: true })
  now += 100_000
  expect(at().admit({ ...boot, kind: 'agent' })).toEqual({ ok: false, reason: 'loop' })
  // A new owner message breaks the chain.
  expect(at().admit({ ...boot, kind: 'restart', ownerMessageId: 50 })).toEqual({ ok: true })
  now += 10_000
  expect(at().admit({ ...boot, kind: 'agent' })).toEqual({ ok: true })
})

test('[S6] a gap over 300 s breaks the chain and a corrupt file reads as empty', () => {
  const dir = stateDir()
  let now = 1_000_000
  const at = () => new RestartIntents(dir, () => now)
  at().admit({ ...boot, kind: 'agent' })
  now += 100_000
  at().admit({ ...boot, kind: 'agent' })
  now += 301_000
  expect(at().admit({ ...boot, kind: 'agent' })).toEqual({ ok: true })
  writeFileSync(join(dir, 'restart-intent.json'), '{nope')
  expect(at().admit({ ...boot, kind: 'restart', ownerMessageId: 1 })).toEqual({ ok: true })
})
