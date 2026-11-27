import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backoffDelayMs, BootLedger, chainLength, emptyLedger, HealthMark, type LedgerState } from '../../src/codex/boot-ledger.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-ledger-'))
  temporary.push(dir)
  return dir
}

const T0 = 1_700_000_000_000
function ledgerOf(...boots: Array<{ at: number; healthyAt?: number }>): LedgerState {
  return { ...emptyLedger(), boots: boots.map((boot, i) => ({ commit: 'c', invocation: 'i' + i, planned: false, ...boot })) }
}

test('[S3] boots 10 s apart without a health mark form a chain', () => {
  expect(chainLength(ledgerOf({ at: T0 }, { at: T0 + 10_000 }, { at: T0 + 20_000 }))).toBe(3)
  expect(chainLength(emptyLedger())).toBe(0)
})

test('[S3] a gap over 300 s breaks the chain, 300 s exactly does not', () => {
  expect(chainLength(ledgerOf({ at: T0 }, { at: T0 + 300_001 }, { at: T0 + 310_000 }))).toBe(2)
  expect(chainLength(ledgerOf({ at: T0 }, { at: T0 + 300_000 }, { at: T0 + 310_000 }))).toBe(3)
})

test('[S3] a healthy boot clears the chain', () => {
  expect(chainLength(ledgerOf({ at: T0 }, { at: T0 + 10_000, healthyAt: T0 + 140_000 }, { at: T0 + 150_000 }))).toBe(1)
})

test('[S3] a backwards clock does not break the chain', () => {
  expect(chainLength(ledgerOf({ at: T0 }, { at: T0 - 3_600_000 }, { at: T0 - 3_590_000 }))).toBe(3)
})

test('[S3] boots before clearedAt do not count', () => {
  expect(chainLength({ ...ledgerOf({ at: T0 }, { at: T0 + 10_000 }, { at: T0 + 30_000 }), clearedAt: T0 + 20_000 })).toBe(1)
})

test('[S3] a corrupt or wrong-version ledger file is treated as empty and then rewritten', () => {
  const dir = stateDir()
  writeFileSync(join(dir, 'boot-ledger.json'), '{not json')
  let now = T0
  const ledger = new BootLedger(dir, { now: () => now })
  expect(ledger.begin({ commit: 'abc', invocation: 'one' }).chain).toBe(1)
  const saved = JSON.parse(readFileSync(join(dir, 'boot-ledger.json'), 'utf8'))
  expect(saved.v).toBe(1)
  expect(saved.boots).toHaveLength(1)
  writeFileSync(join(dir, 'boot-ledger.json'), JSON.stringify({ v: 2, boots: [{ at: 'x' }] }))
  now += 10_000
  expect(new BootLedger(dir, { now: () => now }).begin({ commit: 'abc', invocation: 'two' }).chain).toBe(1)
})

test('[S3] the ledger persists across processes, caps at 50 boots and marks health and exit', () => {
  const dir = stateDir()
  let now = T0
  for (let i = 0; i < 60; i++) {
    now += 400_000
    new BootLedger(dir, { now: () => now }).begin({ commit: 'abc', invocation: 'boot' + i })
  }
  const ledger = new BootLedger(dir, { now: () => now })
  now += 400_000
  ledger.begin({ commit: 'def', invocation: 'last' })
  now += 130_000
  ledger.markHealthy()
  ledger.recordExit(75)
  const saved = JSON.parse(readFileSync(join(dir, 'boot-ledger.json'), 'utf8')) as LedgerState
  expect(saved.boots).toHaveLength(50)
  expect(saved.boots.at(-1)).toMatchObject({ commit: 'def', invocation: 'last', healthyAt: now, exit: 75 })
  // A boot after a planned exit is marked planned.
  now += 10_000
  expect(new BootLedger(dir, { now: () => now }).begin({ commit: 'def', invocation: 'next' }).planned).toBe(true)
})

test('[S3] an unwritable state directory fails open', () => {
  const dir = join(stateDir(), 'ro')
  mkdirSync(dir)
  chmodSync(dir, 0o500)
  try {
    const ledger = new BootLedger(dir, { now: () => T0 })
    expect(ledger.begin({ commit: 'abc', invocation: 'one' }).chain).toBe(1)
    expect(() => ledger.markHealthy()).not.toThrow()
  } finally { chmodSync(dir, 0o700) }
})

test('[S4] backoff: more than 5 boots in 120 s sleeps min(300, 5*2^(n-5)) seconds', () => {
  const table: Array<[number, number]> = [[0, 0], [1, 0], [5, 0], [6, 10], [7, 20], [8, 40], [9, 80], [10, 160], [11, 300], [20, 300]]
  for (const [n, seconds] of table) expect(backoffDelayMs(n), 'n=' + n).toBe(seconds * 1000)
})

test('[S4] begin counts boots in the last 120 s for the backoff', () => {
  const dir = stateDir()
  let now = T0
  const delays: number[] = []
  for (let i = 0; i < 7; i++) {
    now += 15_000
    delays.push(new BootLedger(dir, { now: () => now }).begin({ commit: 'abc', invocation: 'b' + i }).delayMs)
  }
  expect(delays).toEqual([0, 0, 0, 0, 0, 10_000, 20_000])
  now += 600_000
  expect(new BootLedger(dir, { now: () => now }).begin({ commit: 'abc', invocation: 'late' }).delayMs).toBe(0)
})

test('[S3] the health mark waits for the first getUpdates, the Codex handshake and 120 s of uptime', () => {
  let now = T0
  const timers: Array<{ ms: number; run: () => void }> = []
  let marks = 0
  const health = new HealthMark(() => { marks++ }, T0, {
    now: () => now,
    setTimer: (run, ms) => { timers.push({ ms, run }); return () => undefined },
  })
  now += 5_000
  health.polled()
  expect(timers).toHaveLength(0)
  now += 5_000
  health.handshake()
  expect(timers.map(timer => timer.ms)).toEqual([110_000])
  health.polled()
  expect(timers).toHaveLength(1)
  timers[0]!.run()
  expect(marks).toBe(1)
})

test('[S3] a health mark cancelled at shutdown never fires', () => {
  let cancelled = 0
  const health = new HealthMark(() => { throw new Error('must not mark') }, T0, {
    now: () => T0 + 200_000,
    setTimer: () => () => { cancelled++ },
  })
  health.handshake()
  health.polled()
  health.cancel()
  expect(cancelled).toBe(1)
})

test('[S3] a boot the operator stopped cleanly (exit 0) ends the chain', () => {
  const state = ledgerOf({ at: T0 }, { at: T0 + 10_000 }, { at: T0 + 20_000 })
  state.boots[1]!.exit = 0
  expect(chainLength(state)).toBe(1)
  state.boots[1]!.exit = 1
  expect(chainLength(state)).toBe(3)
})

test('[S5] a clean stop of a safe-mode boot keeps the chain', () => {
  const state = ledgerOf({ at: T0 }, { at: T0 + 10_000 }, { at: T0 + 20_000 }, { at: T0 + 30_000 })
  state.boots[2]!.safe = true
  state.boots[2]!.exit = 0
  expect(chainLength(state)).toBe(4)
})

test('[S5] a backwards clock past clearedAt after a failed trial does not crash', () => {
  const dir = stateDir()
  let now = T0
  const at = () => now
  new BootLedger(dir, { now: at }).begin({ commit: 'c', invocation: 'a' })
  const safe = new BootLedger(dir, { now: at })
  now += 10_000
  safe.begin({ commit: 'c', invocation: 'b' })
  now += 10_000
  safe.clearForTrial()
  now += 10_000
  new BootLedger(dir, { now: at }).begin({ commit: 'c', invocation: 'trial' })
  now = T0 - 3_600_000
  const back = new BootLedger(dir, { now: at })
  back.begin({ commit: 'c', invocation: 'after' })
  expect(() => back.safeMode()).not.toThrow()
  expect(back.safeMode()?.reason).toBe('trial')
})

test('[S5] a trial boot the operator stopped cleanly does not send the bridge back to safe mode', () => {
  const dir = stateDir()
  let now = T0
  const at = () => now
  const first = new BootLedger(dir, { now: at })
  first.begin({ commit: 'c', invocation: 'a' })
  now += 10_000
  first.clearForTrial()
  now += 10_000
  const trial = new BootLedger(dir, { now: at })
  trial.begin({ commit: 'c', invocation: 'trial' })
  trial.recordExit(0)
  now += 10_000
  const next = new BootLedger(dir, { now: at })
  next.begin({ commit: 'c', invocation: 'next' })
  expect(next.safeMode()).toBeUndefined()
})
