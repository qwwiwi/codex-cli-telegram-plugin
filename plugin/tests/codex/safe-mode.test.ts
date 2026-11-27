import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BootLedger } from '../../src/codex/boot-ledger.js'
import {
  bootBridge, pollThroughConflicts, SAFE_MODE_CONFLICT_MAX_MS, SafeMode, SafeModeInbox, safeModeStop, type SafeModeEntry,
} from '../../src/codex/safe-mode.js'
import { settledWithin } from './fake-telegram-chat.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const T0 = 1_700_000_000_000

// One simulated bridge process: records its boot and runs either the normal path (Codex) or safe mode.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-safe-'))
  temporary.push(dir)
  let now = T0
  let boots = 0
  const sent: string[] = []
  const sleeps: number[] = []
  let codexStarts = 0
  async function boot(options: { healthy?: boolean; onSafe?: (mode: SafeMode, ledger: BootLedger) => Promise<void> } = {}) {
    now += 10_000
    const ledger = new BootLedger(dir, { now: () => now })
    let safe: SafeMode | undefined
    const result = await bootBridge({
      ledger, boot: { commit: 'abc', invocation: 'boot' + boots++ },
      sleep: async ms => { sleeps.push(ms) },
      normal: async () => {
        codexStarts++
        if (options.healthy) { now += 130_000; ledger.markHealthy() }
        return 'normal' as const
      },
      safe: async (entry: SafeModeEntry) => {
        safe = new SafeMode({
          ledger, entry, send: async text => { sent.push(text) }, acknowledge: async text => { sent.push(text) },
          restart: () => { restarts++ }, doctor: async () => 'doctor report', inbox: new SafeModeInbox(dir),
        })
        await safe.announce()
        await options.onSafe?.(safe, ledger)
        return 'safe' as const
      },
    })
    return { result, safe }
  }
  let restarts = 0
  return {
    boot, dir, sent, sleeps,
    get codexStarts() { return codexStarts },
    get restarts() { return restarts },
  }
}

test('[S5] two unhealthy boots still start Codex', async () => {
  const h = harness()
  expect((await h.boot()).result).toBe('normal')
  expect((await h.boot()).result).toBe('normal')
  expect(h.codexStarts).toBe(2)
  expect(h.sent).toEqual([])
})

test('[S5] a 3-boot chain does not call the Codex factory and sends one notice with the reason', async () => {
  const h = harness()
  await h.boot()
  await h.boot()
  const third = await h.boot()
  expect(third.result).toBe('safe')
  expect(h.codexStarts).toBe(2)
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]).toContain('Безопасный режим')
  expect(h.sent[0]).toContain('3')
  expect(h.sent[0]).toContain('/restart')
})

test('[S5] a 4th boot of the same chain stays in safe mode without a second notice', async () => {
  const h = harness()
  for (let i = 0; i < 3; i++) await h.boot()
  const fourth = await h.boot()
  expect(fourth.result).toBe('safe')
  expect(h.codexStarts).toBe(2)
  expect(h.sent).toHaveLength(1)
})

test('[S5] /restart leaves safe mode for one trial boot; a failed trial returns straight to safe mode with a new notice', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.boot()
  await h.boot({ onSafe: async safe => { await safe.handle({ text: '/restart', messageId: 7 }) } })
  expect(h.restarts).toBe(1)
  // The trial boot starts Codex but never gets healthy.
  expect((await h.boot()).result).toBe('normal')
  expect(h.codexStarts).toBe(3)
  const after = await h.boot()
  expect(after.result).toBe('safe')
  expect(after.safe?.entry.reason).toBe('trial')
  expect(h.sent).toHaveLength(3)
  expect(h.sent[2]).toContain('/restart')
})

test('[S5] a healthy trial boot ends safe mode for good', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.boot()
  await h.boot({ onSafe: async safe => { await safe.handle({ text: '/restart', messageId: 7 }) } })
  expect((await h.boot({ healthy: true })).result).toBe('normal')
  expect((await h.boot()).result).toBe('normal')
  expect((await h.boot()).result).toBe('normal')
})

test('[S5] in safe mode an ordinary owner message is stored, not run, and /status, /doctor answer', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.boot()
  await h.boot({ onSafe: async safe => {
    await safe.handle({ text: 'сделай отчёт', messageId: 11 })
    await safe.handle({ text: '/status', messageId: 12 })
    await safe.handle({ text: '/doctor', messageId: 13 })
    await safe.handle({ text: '/update rollback', messageId: 14 })
  } })
  expect(h.codexStarts).toBe(2)
  expect(h.restarts).toBe(0)
  const stored = readFileSync(join(h.dir, 'safe-mode-messages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(stored).toMatchObject([{ messageId: 11, text: 'сделай отчёт' }])
  const [, stored1, status, doctor, rollback] = h.sent
  expect(stored1).toContain('Сохранил')
  expect(status).toContain('Безопасный режим')
  expect(doctor).toBe('doctor report')
  expect(rollback).toContain('/update rollback')
})

test('[S4] more than five boots in 120 s sleep before connecting', async () => {
  const h = harness()
  for (let i = 0; i < 6; i++) await h.boot()
  expect(h.sleeps).toEqual([10_000])
})

test('[S5] stopping the service in safe mode does not leave safe mode; only /restart does', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.boot()
  // The third boot is in safe mode and the operator stops it (exit 0).
  await h.boot({ onSafe: async (_safe, ledger) => { ledger.recordExit(0) } })
  expect((await h.boot()).result).toBe('safe')
  expect(h.codexStarts).toBe(2)
  expect(h.sent).toHaveLength(1)
})

test('[S9] /update rollback in safe mode rolls back, leaves safe mode for a trial and restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-safe-'))
  temporary.push(dir)
  const ledger = new BootLedger(dir, { now: () => T0 })
  ledger.begin({ commit: 'abc', invocation: 'one' })
  const sent: string[] = []
  let restarts = 0
  let rollbacks = 0
  const safe = new SafeMode({
    ledger, entry: { reason: 'chain', chain: 3, notify: false }, send: async text => { sent.push(text) },
    acknowledge: async text => { sent.push(text) },
    restart: () => { restarts++ }, doctor: async () => '', inbox: new SafeModeInbox(dir),
    rollback: async () => { rollbacks++; return { ok: true, text: 'Вернул версию abc.' } },
  })
  await safe.handle({ text: '/update rollback', messageId: 5 })
  expect(rollbacks).toBe(1)
  expect(restarts).toBe(1)
  expect(sent).toEqual(['Вернул версию abc. Перезапускаюсь.'])
  const saved = JSON.parse(readFileSync(join(dir, 'boot-ledger.json'), 'utf8')) as { trialNext?: boolean }
  expect(saved.trialNext).toBe(true)
  // A failed rollback says why and stays in safe mode.
  const failing = new SafeMode({
    ledger, entry: { reason: 'chain', chain: 3, notify: false }, send: async text => { sent.push(text) },
    acknowledge: async text => { sent.push(text) },
    restart: () => { restarts++ }, doctor: async () => '', inbox: new SafeModeInbox(dir),
    rollback: async () => ({ ok: false, text: 'Нечего откатывать.' }),
  })
  await failing.handle({ text: '/update rollback', messageId: 6 })
  expect(restarts).toBe(1)
  expect(sent.at(-1)).toBe('Нечего откатывать.')
})

class Conflict extends Error {}

test('[S5] safe mode outlasts a persistent 409: it backs off in-process and polls again instead of exiting', async () => {
  let starts = 0
  const delays: number[] = []
  const control = new AbortController()
  await pollThroughConflicts({
    start: async () => { if (++starts <= 12) throw new Conflict('409 Conflict persisted') },
    sleep: async ms => { delays.push(ms) },
    signal: control.signal,
    isConflict: error => error instanceof Conflict,
  })
  expect(starts).toBe(13)
  expect(delays.slice(0, 3)).toEqual([30_000, 60_000, 120_000])
  expect(Math.max(...delays)).toBe(SAFE_MODE_CONFLICT_MAX_MS)
})

test('[S5] safe mode still ends on a polling error other than 409, and a stop during the back-off ends the loop', async () => {
  const control = new AbortController()
  await expect(pollThroughConflicts({
    start: async () => { throw new Error('401 Unauthorized') },
    sleep: async () => undefined, signal: control.signal, isConflict: error => error instanceof Conflict,
  })).rejects.toThrow()
  let starts = 0
  await pollThroughConflicts({
    start: async () => { starts++; throw new Conflict('409') },
    sleep: async () => { control.abort() },
    signal: control.signal, isConflict: error => error instanceof Conflict,
  })
  expect(starts).toBe(1)
})

test('[S7] a safe-mode restart command restarts even when Telegram never answers its acknowledgement', async () => {
  for (const command of ['/restart', '/update rollback', '/update codex rollback']) {
    const dir = mkdtempSync(join(tmpdir(), 'krotov-safe-'))
    temporary.push(dir)
    const ledger = new BootLedger(dir, { now: () => T0 })
    ledger.begin({ commit: 'abc', invocation: 'one' })
    const acks: string[] = []
    let restarts = 0
    const safe = new SafeMode({
      ledger, entry: { reason: 'chain', chain: 3, notify: false },
      // A plain send that Telegram never answers; acknowledgements take the bounded path.
      send: () => new Promise(() => undefined),
      acknowledge: async text => { acks.push(text) },
      restart: () => { restarts++ }, doctor: async () => '', inbox: new SafeModeInbox(dir),
      rollback: async () => ({ ok: true, text: 'Вернул версию abc.' }),
      codexRollback: () => ({ ok: true, text: 'Вернул Codex 0.47.0 (был 0.48.0).' }),
    })
    expect(await settledWithin(safe.handle({ text: command, messageId: 5 }), 200)).toBe('resolved')
    expect(restarts).toBe(1)
    expect(acks).toHaveLength(1)
  }
})

test('[S7] ending safe mode arms the shutdown watchdog once, before it stops polling', () => {
  const events: string[] = []
  const stop = safeModeStop({
    armWatchdog: () => { events.push('watchdog') },
    abort: () => { events.push('abort') },
    stopPoller: () => { events.push('poller') },
  })
  stop()
  stop()
  expect(events).toEqual(['watchdog', 'abort', 'poller'])
})
