import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BootLedger } from '../../src/codex/boot-ledger.js'
import { BridgeRestart } from '../../src/codex/restart-bridge.js'
import { RESTART_HISTORY, RestartNotices } from '../../src/codex/restart-notice.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-restart-notice-'))
  temporary.push(dir)
  return dir
}

const T0 = 1_700_000_000_000

// One simulated bridge process with its own RestartNotices over a shared state dir.
function harness() {
  const dir = stateDir()
  let now = T0
  const sent: string[] = []
  const process = (boot: { crashed?: boolean; safe?: boolean } = {}) => {
    const notices = new RestartNotices({
      stateDir: dir, now: () => now, send: async text => { sent.push(text) },
    })
    notices.boot({ crashed: boot.crashed ?? false, safe: boot.safe ?? false })
    return notices
  }
  return { dir, sent, process, advance: (ms: number) => { now += ms } }
}

// One planned restart that took `ms` from the stop notice to the back notice.
async function restartCycle(h: ReturnType<typeof harness>, ms: number): Promise<void> {
  await h.process().stopping()
  h.advance(ms)
  await h.process().back()
}

test('a planned stop without restart history says it restarts, without a number', async () => {
  const h = harness()
  await h.process().stopping()
  expect(h.sent).toEqual(['Перезапускаю мост.'])
})

test('a planned stop names the median of the measured restarts', async () => {
  const h = harness()
  await restartCycle(h, 8_000)
  await restartCycle(h, 30_000)
  await restartCycle(h, 12_000)
  h.sent.length = 0
  await h.process().stopping()
  expect(h.sent).toEqual(['Перезапускаю мост. Обычно это занимает около 12 секунд'])
})

test('only the last measured restarts count and they persist in the state dir', async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) await restartCycle(h, 200_000)
  for (let i = 0; i < RESTART_HISTORY; i++) await restartCycle(h, 21_000)
  const saved = JSON.parse(readFileSync(join(h.dir, 'restart-timings.json'), 'utf8')) as { durations: number[] }
  expect(saved.durations).toHaveLength(RESTART_HISTORY)
  h.sent.length = 0
  await h.process().stopping()
  expect(h.sent).toEqual(['Перезапускаю мост. Обычно это занимает около 21 секунды'])
})

// The agent's own restart marker: the bridge delivers the final answer, then restarts with no separate notice.
async function agentRestart(notices: RestartNotices): Promise<void> {
  const bridge = new BridgeRestart({ idle: () => true, restart: () => { void notices.stopping('agent') } })
  bridge.request()
  await bridge.check()
  await notices.stopping('agent')
}

test('an agent-requested restart sends one owner message: the delivered line folded into the stop notice', async () => {
  const h = harness()
  await restartCycle(h, 12_000)
  h.sent.length = 0
  await agentRestart(h.process())
  expect(h.sent).toEqual(['Итоговый ответ доставлен. Перезапускаю мост. Обычно это занимает около 12 секунд'])
})

test('an agent-requested restart without restart history still sends one owner message', async () => {
  const h = harness()
  await agentRestart(h.process())
  expect(h.sent).toEqual(['Итоговый ответ доставлен. Перезапускаю мост.'])
})

test('after a planned stop the next boot reports the measured restart time once', async () => {
  const h = harness()
  await h.process().stopping()
  h.advance(7_400)
  const next = h.process()
  h.advance(600)
  await next.back()
  await next.back()
  expect(h.sent).toEqual(['Перезапускаю мост.', 'Мост снова на связи. Перезапуск занял 8 секунд'])
  // The stop was consumed: a later boot (crash, cold boot) does not report it again.
  h.advance(60_000)
  await h.process().back()
  expect(h.sent).toHaveLength(2)
})

test('a boot that cannot take the recorded stop off disk stays silent, so one stop is reported once', async () => {
  const h = harness()
  await h.process().stopping()
  h.advance(5_000)
  // The state dir refuses the rewrite (the rename of the consumed marker is denied) during this boot.
  chmodSync(h.dir, 0o500)
  let denied: RestartNotices
  try { denied = h.process() } finally { chmodSync(h.dir, 0o700) }
  await denied.back()
  h.advance(5_000)
  await h.process().back()
  expect(h.sent.filter(text => text.startsWith('Мост снова'))).toEqual(['Мост снова на связи. Перезапуск занял 10 секунд'])
})

test('the restart time uses the right Russian plural form', async () => {
  const h = harness()
  await restartCycle(h, 1_000)
  await restartCycle(h, 3_000)
  await restartCycle(h, 21_000)
  expect(h.sent.filter(text => text.startsWith('Мост снова'))).toEqual([
    'Мост снова на связи. Перезапуск занял 1 секунду',
    'Мост снова на связи. Перезапуск занял 3 секунды',
    'Мост снова на связи. Перезапуск занял 21 секунду',
  ])
})

test('a cold boot without a recorded stop sends nothing', async () => {
  const h = harness()
  await h.process().back()
  expect(h.sent).toEqual([])
})

test('a boot after an unplanned exit says the bridge restarted after a failure', async () => {
  const h = harness()
  const notices = h.process({ crashed: true })
  await notices.back()
  await notices.back()
  expect(h.sent).toEqual(['Мост перезапустился после сбоя'])
})

test('a safe-mode boot sends no back notice and consumes the stop', async () => {
  const h = harness()
  await h.process().stopping()
  h.advance(10_000)
  await h.process({ safe: true, crashed: true }).back()
  h.advance(10_000)
  await h.process().back()
  expect(h.sent).toEqual(['Перезапускаю мост.'])
})

test('the stop notice is sent once per process and waits for Telegram only a bounded time', async () => {
  const dir = stateDir()
  const signals: AbortSignal[] = []
  let sends = 0
  const notices = new RestartNotices({
    stateDir: dir, waitMs: 30,
    send: (_text, signal) => { sends++; signals.push(signal); return new Promise(() => undefined) },
  })
  notices.boot({ crashed: false, safe: false })
  const started = Date.now()
  await Promise.all([notices.stopping(), notices.stopping()])
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(sends).toBe(1)
  expect(signals[0]?.aborted).toBe(true)
  // The stop time is on disk before the send, so the next boot can measure the restart.
  const saved = JSON.parse(readFileSync(join(dir, 'restart-timings.json'), 'utf8')) as { stoppedAt?: number }
  expect(typeof saved.stoppedAt).toBe('number')
})

test('a failed send or an unreadable timings file never stops the restart', async () => {
  const dir = stateDir()
  writeFileSync(join(dir, 'restart-timings.json'), '{broken')
  const errors: string[] = []
  const notices = new RestartNotices({
    stateDir: dir, send: async () => { throw new Error('telegram down') }, onError: (_error, action) => errors.push(action),
  })
  notices.boot({ crashed: false, safe: false })
  await notices.stopping()
  expect(errors).toContain('send')
})

test('the ledger reports a crash only when a healthy boot ended with an unplanned exit code', () => {
  const dir = stateDir()
  let now = T0
  const boot = (end: { healthy: boolean; exit?: number }) => {
    now += 400_000
    const ledger = new BootLedger(dir, { now: () => now })
    ledger.begin({ commit: 'c', invocation: 'i' + now })
    const crashed = ledger.previousCrashed()
    now += 130_000
    if (end.healthy) ledger.markHealthy()
    if (end.exit !== undefined) ledger.recordExit(end.exit)
    return crashed
  }
  expect(boot({ healthy: true, exit: 1 })).toBe(false) // first boot ever
  expect(boot({ healthy: true, exit: 0 })).toBe(true) // after a healthy run that exited 1
  expect(boot({ healthy: true, exit: 75 })).toBe(false) // after a clean stop
  expect(boot({ healthy: true })).toBe(false) // after a planned restart
  expect(boot({ healthy: false, exit: 1 })).toBe(false) // after a kill or a host reboot: no exit recorded
  // The boot after an unhealthy crash is part of a restart loop: the loop guard speaks, not this notice.
  expect(boot({ healthy: false })).toBe(false)
})

test('an acknowledgement before a committed restart waits for Telegram only a bounded time and cancels the send', async () => {
  const signals: AbortSignal[] = []
  const texts: string[] = []
  const notices = new RestartNotices({
    stateDir: stateDir(), waitMs: 30,
    send: (text, signal) => { texts.push(text); signals.push(signal); return new Promise(() => undefined) },
  })
  notices.boot({ crashed: false, safe: false })
  const started = Date.now()
  await notices.acknowledge('Обновление установлено, перезапускаюсь.')
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(texts).toEqual(['Обновление установлено, перезапускаюсь.'])
  expect(signals[0]?.aborted).toBe(true)
  // An acknowledgement is not the stop notice: the stop notice still goes out once.
  await notices.stopping()
  expect(texts).toEqual(['Обновление установлено, перезапускаюсь.', 'Перезапускаю мост.'])
})

test('a failed acknowledgement never rejects', async () => {
  const errors: string[] = []
  const notices = new RestartNotices({
    stateDir: stateDir(), send: async () => { throw new Error('telegram down') }, onError: (_error, action) => errors.push(action),
  })
  await notices.acknowledge('Перезапускаюсь.')
  expect(errors).toEqual(['send'])
})
