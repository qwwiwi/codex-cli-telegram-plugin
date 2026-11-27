// R29: opt-in automatic update. Staged check of the new commit, idle-only apply, bad commits skipped.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AutoUpdater, autoUpdateConfig, stageUpdate, UpdateAttempts, type AutoUpdaterDeps, type UpdateAttempt } from '../../src/codex/auto-update.js'
import { runCommand, type Runner, type UpdateCheck } from '../../src/codex/self-update.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-auto-'))
  temporary.push(dir)
  return dir
}

const plan = { kind: 'plan' as const, from: 'a'.repeat(40), to: 'b'.repeat(40), total: 1, commits: ['bbbbbbb Fix'] }

test('[R29] automatic update is off unless KROT_AUTO_UPDATE=1; the interval defaults to 6 hours', () => {
  const hour = 3_600_000
  expect(autoUpdateConfig({})).toEqual({ enabled: false, intervalMs: 6 * hour })
  expect(autoUpdateConfig({ KROT_AUTO_UPDATE: 'true' }).enabled).toBe(false)
  expect(autoUpdateConfig({ KROT_AUTO_UPDATE: '1' })).toEqual({ enabled: true, intervalMs: 6 * hour })
  expect(autoUpdateConfig({ KROT_AUTO_UPDATE: '1', KROT_AUTO_UPDATE_HOURS: '2' }).intervalMs).toBe(2 * hour)
  for (const bad of ['0', '-1', 'abc', '', '0.01']) {
    expect(autoUpdateConfig({ KROT_AUTO_UPDATE: '1', KROT_AUTO_UPDATE_HOURS: bad }).intervalMs).toBe(6 * hour)
  }
})

test('[R29] the last update attempt survives a restart; a corrupt record reads as none', () => {
  const state = tempDir()
  const attempts = new UpdateAttempts(state, () => 1234)
  expect(attempts.last()).toBeUndefined()
  attempts.record({ trigger: 'auto', result: 'stage_failed', from: plan.from, to: plan.to, detail: 'tests' })
  expect(new UpdateAttempts(state).last()).toEqual({ at: 1234, trigger: 'auto', result: 'stage_failed', from: plan.from, to: plan.to, detail: 'tests' })
  writeFileSync(join(state, 'update-attempt.json'), '{"at":"x"}')
  expect(new UpdateAttempts(state).last()).toBeUndefined()
})

/** Records the staged steps; `fail` makes the named step exit 1. */
function stageRunner(fail?: string) {
  const calls: string[] = []
  /** The extra environment of each bun step and whether its TMPDIR existed when the step ran. */
  const envs: { env: Readonly<Record<string, string>> | undefined; tmpExists: boolean }[] = []
  const run: Runner = async (command, args, { cwd, env }) => {
    const line = `${command} ${args.join(' ')} @${cwd}`
    calls.push(line)
    if (command === 'bun-bin') envs.push({ env, tmpExists: existsSync(env?.TMPDIR ?? '') })
    if (command === 'tar') mkdirSync(join(cwd, 'update-stage', 'plugin'), { recursive: true })
    const step = command === 'git' ? 'archive' : command === 'tar' ? 'extract' : args.includes('install') ? 'install'
      : args.includes('test') ? 'test' : 'doctor'
    return step === fail ? { code: 1, stdout: '', stderr: step + ' failed' } : { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, envs }
}

test('[R29] the new commit is checked in a staged copy inside the state directory: install, tests, then doctor with the saved .env', async () => {
  const state = tempDir()
  const { run, calls } = stageRunner()
  expect(await stageUpdate({ repo: '/repo', stateDir: state, run, bun: 'bun-bin', to: plan.to })).toEqual({ ok: true })
  const stage = join(state, 'update-stage')
  expect(calls).toEqual([
    `git archive --format=tar -o ${join(state, 'update-stage.tar')} ${plan.to} @/repo`,
    `tar -xf ${join(state, 'update-stage.tar')} -C ${stage} @${state}`,
    `bun-bin install --frozen-lockfile --ignore-scripts @${join(stage, 'plugin')}`,
    `bun-bin --no-env-file test --timeout=60000 @${join(stage, 'plugin')}`,
    `bun-bin --no-env-file build src/codex/server.ts --target=bun --outdir ${join(stage, 'build')} @${join(stage, 'plugin')}`,
    `bun-bin --env-file=/repo/plugin/.env run doctor @${join(stage, 'plugin')}`,
  ])
  // Nothing of the staged copy is left behind.
  expect(existsSync(stage)).toBe(false)
  expect(existsSync(join(state, 'update-stage.tar'))).toBe(false)
})

test('the staged auto-update command uses KROT_UPDATE_TEST_TIMEOUT_MS when set', async () => {
  const previous = process.env.KROT_UPDATE_TEST_TIMEOUT_MS
  process.env.KROT_UPDATE_TEST_TIMEOUT_MS = '90000'
  try {
    const state = tempDir()
    const { run, calls } = stageRunner()
    expect(await stageUpdate({ repo: '/repo', stateDir: state, run, bun: 'bun-bin', to: plan.to })).toEqual({ ok: true })
    expect(calls).toContain(`bun-bin --no-env-file test --timeout=90000 @${join(state, 'update-stage', 'plugin')}`)
  } finally {
    if (previous === undefined) delete process.env.KROT_UPDATE_TEST_TIMEOUT_MS
    else process.env.KROT_UPDATE_TEST_TIMEOUT_MS = previous
  }
})

test('[R29] a failing staged step stops the check there and names it', async () => {
  const state = tempDir()
  const { run, calls } = stageRunner('test')
  expect(await stageUpdate({ repo: '/repo', stateDir: state, run, bun: 'bun-bin', to: plan.to }))
    .toEqual({ ok: false, stage: 'test', detail: 'test failed' })
  expect(calls.some(call => call.includes('run doctor'))).toBe(false)
  expect(existsSync(join(state, 'update-stage'))).toBe(false)
})

function auto(overrides: Partial<AutoUpdaterDeps> = {}) {
  const events: string[] = []
  const sent: string[] = []
  const recorded: Omit<UpdateAttempt, 'at'>[] = []
  let last: UpdateAttempt | undefined
  const deps: AutoUpdaterDeps = {
    config: { enabled: true, intervalMs: 1000 },
    check: async (): Promise<UpdateCheck> => plan,
    badCommits: async () => [],
    stage: async to => { events.push('stage:' + to.slice(0, 1)); return { ok: true } },
    applyWhenIdle: async (_plan, trigger) => { events.push('apply:' + trigger); return { kind: 'restarting' } },
    send: async text => { sent.push(text) },
    attempts: {
      last: () => last,
      record: attempt => { recorded.push(attempt); last = { ...attempt, at: 1 } },
    },
    sleep: async () => { events.push('sleep') },
    ...overrides,
  }
  return { updater: new AutoUpdater(deps), events, sent, recorded }
}

test('[R29] a new fast-forward commit is staged first and applied only after the staged check passed', async () => {
  const a = auto()
  await a.updater.run('auto')
  expect(a.events).toEqual(['stage:b', 'apply:auto'])
  // The apply records its own result (UpdateCommands.applyWhenIdle); a timer run says nothing before it.
  expect(a.recorded).toEqual([])
  expect(a.sent).toEqual([])
})

test('[R29] up to date: nothing staged; the timer stays silent, /cc update answers', async () => {
  const a = auto({ check: async () => ({ kind: 'current', head: plan.from }) })
  await a.updater.run('auto')
  expect(a.events).toEqual([])
  expect(a.sent).toEqual([])
  expect(a.recorded).toEqual([{ trigger: 'auto', result: 'current', from: plan.from }])
  await a.updater.run('owner')
  expect(a.sent).toEqual(['Мост уже последней версии (aaaaaaaaaaaa).'])
})

test('[R29] a commit marked bad after a failed launch is never installed automatically', async () => {
  const a = auto({ badCommits: async () => [plan.to] })
  await a.updater.run('auto')
  expect(a.events).toEqual([])
  expect(a.recorded).toEqual([{ trigger: 'auto', result: 'bad', from: plan.from, to: plan.to }])
  await a.updater.run('owner')
  expect(a.events).toEqual([])
  expect(a.sent[0]).toContain('bbbbbbbbbbbb')
})

test('[R29] a failed staged check keeps the old version and tells the owner once per target', async () => {
  const a = auto({ stage: async () => ({ ok: false, stage: 'test', detail: '3 tests failed' }) })
  await a.updater.run('auto')
  await a.updater.run('auto')
  expect(a.events).toEqual([])
  expect(a.recorded.map(attempt => attempt.result)).toEqual(['stage_failed', 'stage_failed'])
  expect(a.sent).toHaveLength(1)
  expect(a.sent[0]).toContain('3 tests failed')
})

test('[R29] while a turn runs the update waits and retries, and gives up after the wait limit without applying', async () => {
  let busy = 2
  const applied: string[] = []
  const a = auto({ applyWhenIdle: async () => {
    if (busy-- > 0) return { kind: 'busy' }
    applied.push('apply')
    return { kind: 'restarting' }
  } })
  await a.updater.run('auto')
  expect(a.events).toEqual(['stage:b', 'sleep', 'sleep'])
  expect(applied).toEqual(['apply'])

  const never = auto({ applyWhenIdle: async () => ({ kind: 'busy' }), maxWaitMs: 180_000 })
  await never.updater.run('auto')
  expect(never.events.filter(event => event === 'sleep')).toHaveLength(3)
  expect(never.recorded).toEqual([{ trigger: 'auto', result: 'busy', from: plan.from, to: plan.to }])
})

test('[R29] the timer is armed only when automatic update is on', () => {
  const armed: number[] = []
  expect(auto({ config: { enabled: false, intervalMs: 1000 } }).updater.start((_tick, ms) => { armed.push(ms) })).toBe(false)
  expect(armed).toEqual([])
  expect(auto().updater.start((_tick, ms) => { armed.push(ms) })).toBe(true)
  expect(armed).toEqual([1000])
})

test('[R29] a second run while one is in progress does nothing', async () => {
  let release: () => void = () => undefined
  const a = auto({ check: () => new Promise(resolve => { release = () => resolve({ kind: 'current', head: plan.from }) }) })
  const first = a.updater.run('auto')
  await a.updater.run('owner')
  expect(a.sent).toEqual(['Проверка обновлений уже идёт.'])
  release()
  await first
})

test('[R29] a failed apply that could not restore the old version warns the owner instead of reassuring', async () => {
  const lost = auto({ applyWhenIdle: async () => ({ kind: 'failed', detail: 'установка зависимостей: x', restored: false }) })
  await lost.updater.run('auto')
  expect(lost.sent[0]).toContain('⚠️')
  expect(lost.sent[0]).toContain('git status')
  expect(lost.sent[0]).not.toContain('прежней версии.')
  const kept = auto({ applyWhenIdle: async () => ({ kind: 'failed', detail: 'проверка типов (tsc): x', restored: true }) })
  await kept.updater.run('auto')
  expect(kept.sent[0]).toContain('Бот работает на прежней версии.')
})

test('[R29] an installed update whose restart was refused says it starts with the next restart', async () => {
  const a = auto({ applyWhenIdle: async () => ({ kind: 'installed' }) })
  await a.updater.run('auto')
  expect(a.sent).toEqual(['Автообновление: новая версия bbbbbbbbbbbb установлена, но перезапуск сейчас отклонён. ' +
    'Она заработает после следующего перезапуска (/restart).'])
})

test('[R29] the staged install, tests, build and doctor keep temporary files and caches inside the stage; HOME is untouched', async () => {
  const state = tempDir()
  const { run, envs } = stageRunner()
  expect(await stageUpdate({ repo: '/repo', stateDir: state, run, bun: 'bun-bin', to: plan.to })).toEqual({ ok: true })
  const stage = join(state, 'update-stage')
  expect(envs).toHaveLength(4)
  for (const { env, tmpExists } of envs) {
    for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'BUN_INSTALL_CACHE_DIR']) {
      expect(env?.[key]?.startsWith(stage + '/')).toBe(true)
    }
    expect(tmpExists).toBe(true)
    expect(env && 'HOME' in env).toBe(false)
  }
  // The stage, its temporary files and caches included, is gone afterwards.
  expect(existsSync(stage)).toBe(false)
})

test('[R29] a command run for an update gets the extra environment on top of the filtered one', async () => {
  const state = tempDir()
  const result = await runCommand('sh', ['-c', 'printf %s "$TMPDIR|$HOME"'], { cwd: state, env: { TMPDIR: join(state, 'tmp') } })
  expect(result).toMatchObject({ code: 0, stdout: `${join(state, 'tmp')}|${process.env.HOME ?? ''}` })
})
