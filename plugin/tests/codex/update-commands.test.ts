import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RestartNotices } from '../../src/codex/restart-notice.js'
import { isCodexUpdateRequest, UpdateCommands, type UpdateCommandDeps } from '../../src/codex/update-commands.js'
import { settledWithin } from './fake-telegram-chat.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const plan = { kind: 'plan' as const, from: 'a'.repeat(40), to: 'b'.repeat(40), total: 2, commits: ['bbbbbbb Second', 'ccccccc First'] }
const codexPlan = { kind: 'newer' as const, installed: '0.47.0', latest: '0.48.0', changelog: '## 0.48.0\n- gpt-next', prefix: '/h/.npm' }

function harness(overrides: Partial<UpdateCommandDeps> = {}) {
  const sent: string[] = []
  const events: string[] = []
  const deps: UpdateCommandDeps = {
    send: async text => { sent.push(text); events.push('send') },
    // As RestartNotices.acknowledge: never rejects.
    acknowledge: async text => { await deps.send(text).catch(() => undefined) },
    busy: () => false,
    turnActive: () => false,
    sleep: async () => { events.push('sleep') },
    restart: (kind, ownerMessageId) => { events.push(`restart:${kind}:${ownerMessageId ?? '-'}`); return { ok: true } },
    selfUpdate: {
      check: async () => plan,
      apply: async () => { events.push('apply'); return { ok: true, from: plan.from, to: plan.to } },
      rollback: async () => ({ ok: true, from: plan.to, to: plan.from }),
    },
    codexUpdate: {
      check: async () => codexPlan,
      apply: async () => { events.push('codex-apply'); return { ok: true, from: '0.47.0', to: '0.48.0', models: ['gpt-5', 'gpt-next'] } },
      rollback: () => { events.push('codex-rollback'); return { ok: true, from: '0.48.0', to: '0.47.0' } },
    },
    ...overrides,
  }
  return { commands: new UpdateCommands(deps), sent, events }
}

test('[S6] /restart restarts with the owner message as the intent and sends no fixed time guess', async () => {
  const h = harness()
  expect(await h.commands.handle('restart', '', 42)).toBe(true)
  expect(h.events).toEqual(['restart:restart:42'])
  expect(h.sent).toEqual([])
})

test('[S6] /restart sends exactly one owner message: the measured stop notice of the planned restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-update-restart-'))
  temporary.push(dir)
  writeFileSync(join(dir, 'restart-timings.json'), JSON.stringify({ v: 1, durations: [12_000] }))
  const owner: string[] = []
  const notices = new RestartNotices({ stateDir: dir, send: async text => { owner.push(text) } })
  notices.boot({ crashed: false, safe: false })
  const h = harness({
    send: async text => { owner.push(text) },
    // As server.ts plannedRestart: an admitted restart sends the stop notice.
    restart: () => { void notices.stopping('restart'); return { ok: true } },
  })
  await h.commands.handle('restart', '', 42)
  await notices.stopping('restart')
  expect(owner).toEqual(['Перезапускаю мост. Обычно это занимает около 12 секунд'])
})

test('[S6] a refused restart is explained and nothing restarts', async () => {
  const h = harness({ restart: () => ({ ok: false, reason: 'stale' }) })
  await h.commands.handle('restart', '', 42)
  expect(h.sent.at(-1)).toContain('уже вызывало перезапуск')
})

test('[S9] /update shows the commits to apply, applies them and restarts', async () => {
  const h = harness()
  await h.commands.handle('update', '', 7)
  expect(h.sent[0]).toContain('2')
  expect(h.sent[0]).toContain('Second')
  expect(h.sent[0]).toContain('First')
  expect(h.events).toEqual(['send', 'apply', 'send', 'restart:update:7'])
})

test('[S9] /update check only shows, /update waits for an idle bridge, a dirty tree refusal is passed on', async () => {
  const check = harness()
  await check.commands.handle('update', 'check', 7)
  expect(check.events).toEqual(['send'])
  expect(check.sent[0]).toContain('/update')
  const busy = harness({ busy: () => true })
  await busy.commands.handle('update', '', 7)
  expect(busy.events).toEqual(['send'])
  expect(busy.sent[0]).toContain('/stop')
  const dirty = harness({ selfUpdate: { ...harness().commands.deps.selfUpdate, check: async () => ({ kind: 'refused', reason: 'dirty', text: 'Не обновляюсь: изменения' }) } })
  await dirty.commands.handle('update', '', 7)
  expect(dirty.sent).toEqual(['Не обновляюсь: изменения'])
})

test('[S9] a failed apply reports the stage and does not restart', async () => {
  const h = harness({ selfUpdate: { ...harness().commands.deps.selfUpdate,
    apply: async () => ({ ok: false, stage: 'tsc', detail: 'TS2322', restored: true }) } })
  await h.commands.handle('update', '', 7)
  expect(h.events.some(event => event.startsWith('restart'))).toBe(false)
  expect(h.sent.at(-1)).toContain('TS2322')
  expect(h.sent.at(-1)).toContain('прежней версии')
})

test('[S9] /update rollback restores the previous commit and restarts', async () => {
  const h = harness()
  await h.commands.handle('update', 'rollback', 8)
  expect(h.events).toEqual(['send', 'restart:rollback:8'])
  expect(h.sent[0]).toContain('aaaaaaaaaaaa')
})

test('[S9c] /update codex shows installed vs latest and the changelog, updates and restarts so new models show', async () => {
  const h = harness()
  await h.commands.handle('update', 'codex', 9)
  expect(h.sent[0]).toContain('0.47.0')
  expect(h.sent[0]).toContain('0.48.0')
  expect(h.sent[0]).toContain('gpt-next')
  expect(h.events).toEqual(['send', 'codex-apply', 'send', 'restart:codex:9'])
  expect(h.sent[1]).toContain('gpt-next')
  expect(h.sent[1]).toContain('/cc')
})

test('[S9c] a Codex update that was rolled back does not restart; behind the root relay it is refused', async () => {
  const h = harness({ codexUpdate: { check: async () => codexPlan,
    apply: async () => ({ ok: false, stage: 'handshake', detail: 'no answer', restored: true }),
    rollback: () => ({ ok: false, text: 'nothing' }) } })
  await h.commands.handle('update', 'codex', 9)
  expect(h.events.some(event => event.startsWith('restart'))).toBe(false)
  expect(h.sent.at(-1)).toContain('0.47.0')
  const relay = harness({ codexUpdate: undefined })
  await relay.commands.handle('update', 'codex', 9)
  expect(relay.sent[0]).toContain('недоступно')
})

test('[S9c] «обнови кодекс» is a request to update Codex; other phrases are not', () => {
  for (const text of ['обнови кодекс', 'Обнови Codex', 'обнови кодекс!', 'update codex', 'обнови, пожалуйста, кодекс']) {
    expect(isCodexUpdateRequest(text)).toBe(true)
  }
  for (const text of ['не обновляй кодекс', 'обнови кодекс и сделай отчёт', 'обнови документацию', 'кодекс']) {
    expect(isCodexUpdateRequest(text)).toBe(false)
  }
})

test('[S9] /restart is refused while an update runs or while the new version is still on trial', async () => {
  let release: () => void = () => undefined
  const slow = harness({ selfUpdate: { ...harness().commands.deps.selfUpdate,
    apply: () => new Promise(resolve => { release = () => resolve({ ok: true, from: plan.from, to: plan.to }) }) } })
  const running = slow.commands.handle('update', '', 7)
  await new Promise(resolve => setTimeout(resolve, 0))
  await slow.commands.handle('restart', '', 8)
  expect(slow.events.filter(event => event.startsWith('restart'))).toEqual([])
  expect(slow.sent.at(-1)).toContain('обновление')
  release()
  await running
  expect(slow.events.filter(event => event.startsWith('restart'))).toEqual(['restart:update:7'])
  const trial = harness({ trialPending: () => true })
  await trial.commands.handle('restart', '', 9)
  expect(trial.events).toEqual(['send'])
  expect(trial.sent[0]).toContain('проверяется')
})

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('[S9] /update holds one maintenance reservation from its check on: no owner turn, /restart or second update gets in', async () => {
  let release: () => void = () => undefined
  const h = harness()
  // Replace only check: apply must stay this harness's own, so its event lands in h.events.
  h.commands.deps.selfUpdate.check = () => new Promise(resolve => { release = () => resolve(plan) })
  expect(h.commands.maintenance()).toBe(false)
  const running = h.commands.handle('update', '', 7)
  // Taken before the first await: the bridge already refuses to start a turn.
  expect(h.commands.maintenance()).toBe(true)
  await tick()
  await h.commands.handle('update', 'whatever', 8)
  expect(h.commands.maintenance()).toBe(true)
  await h.commands.handle('update', '', 9)
  expect(h.sent.at(-1)).toBe('Обновление уже идёт.')
  release()
  await running
  expect(h.events.filter(event => event.startsWith('restart') || event === 'apply')).toEqual(['apply', 'restart:update:7'])
  // An admitted restart keeps the reservation until the process is gone.
  expect(h.commands.maintenance()).toBe(true)
})

test('[S9] an /update after an admitted /restart cannot start; the /restart goes ahead alone', async () => {
  const h = harness()
  await h.commands.handle('restart', '', 10)
  await h.commands.handle('update', '', 11)
  expect(h.events).toEqual(['restart:restart:10', 'send'])
  expect(h.sent).toEqual(['Уже перезапускаюсь.'])
})

test('[S9] the restart after an update waits for a turn that is still running, then restarts', async () => {
  // Busy on the first check and on two polls, idle on the third poll.
  let active = 3
  const h = harness({ turnActive: () => active-- > 0 })
  await h.commands.handle('update', '', 7)
  expect(h.events.slice(-3)).toEqual(['sleep', 'sleep', 'restart:update:7'])
  expect(h.sent.some(text => text.includes('Жду'))).toBe(true)
})

test('[S9] a failed Telegram send after the update is committed does not stop the restart', async () => {
  const h = harness({ send: async text => {
    if (text.startsWith('Обновление установлено')) throw new Error('Telegram is down')
  } })
  await h.commands.handle('update', '', 7)
  expect(h.events).toEqual(['apply', 'restart:update:7'])
})

test('[S9] a failed update releases the reservation and lets the queued turns start', async () => {
  let idle = 0
  const h = harness({ onIdle: () => { idle++ }, selfUpdate: { ...harness().commands.deps.selfUpdate,
    apply: async () => ({ ok: false, stage: 'tsc', detail: 'TS2322', restored: true }) } })
  await h.commands.handle('update', '', 7)
  expect(h.commands.maintenance()).toBe(false)
  expect(idle).toBe(1)
})

test('[S9c] /update codex rollback puts the kept Codex back and restarts', async () => {
  const h = harness()
  await h.commands.handle('update', 'codex rollback', 12)
  expect(h.events).toEqual(['codex-rollback', 'send', 'restart:codex:12'])
  expect(h.sent[0]).toContain('0.47.0')
})

test('[S9] a committed restart command restarts even when Telegram never answers its acknowledgement', async () => {
  for (const args of ['', 'rollback', 'codex', 'codex rollback']) {
    const acks: string[] = []
    const h = harness({
      // A plain send of the acknowledgement would never be answered; it must take the bounded path.
      send: text => /перезапускаюсь/i.test(text) ? new Promise(() => undefined) : Promise.resolve(),
      acknowledge: async text => { acks.push(text) },
    })
    expect(await settledWithin(h.commands.handle('update', args, 7), 200)).toBe('resolved')
    expect(h.events.at(-1)).toMatch(/^restart:/)
    expect(acks).toHaveLength(1)
  }
})
