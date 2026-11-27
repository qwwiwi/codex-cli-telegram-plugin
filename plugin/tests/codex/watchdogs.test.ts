import { expect, test } from 'bun:test'

import { armShutdownWatchdog, armStartupWatchdog, SHUTDOWN_LEASH_MS, STARTUP_LIMIT_MS } from '../../src/codex/watchdogs.js'

function timers() {
  const pending: { run: () => void; ms: number; cancelled: boolean }[] = []
  const setTimer = (run: () => void, ms: number) => {
    const entry = { run, ms, cancelled: false }
    pending.push(entry)
    return () => { entry.cancelled = true }
  }
  const fire = () => { for (const entry of pending.splice(0)) if (!entry.cancelled) entry.run() }
  return { pending, setTimer, fire }
}

test('[S7] a shutdown that hangs (work.close never resolves) still exits, keeping the planned-restart code 75', () => {
  const t = timers()
  const exits: number[] = []
  let code: number | undefined = 75
  armShutdownWatchdog({ exit: c => exits.push(c), exitCode: () => code, setTimer: t.setTimer })
  expect(t.pending[0]!.ms).toBe(SHUTDOWN_LEASH_MS)
  expect(SHUTDOWN_LEASH_MS).toBeLessThan(90_000)
  void new Promise(() => undefined) // work.close() that never resolves
  t.fire()
  expect(exits).toEqual([75])
  code = undefined
  armShutdownWatchdog({ exit: c => exits.push(c), exitCode: () => code, setTimer: t.setTimer })
  t.fire()
  expect(exits).toEqual([75, 1])
})

test('[S7] a bridge not ready within 180 s exits 75; ready in time clears the timer', () => {
  const t = timers()
  const timeouts: number[] = []
  const late = armStartupWatchdog({ onTimeout: () => timeouts.push(1), setTimer: t.setTimer })
  expect(t.pending[0]!.ms).toBe(STARTUP_LIMIT_MS)
  t.fire()
  expect(timeouts).toEqual([1])
  late.ready()
  const fine = armStartupWatchdog({ onTimeout: () => timeouts.push(2), setTimer: t.setTimer })
  fine.ready()
  t.fire()
  expect(timeouts).toEqual([1])
})
