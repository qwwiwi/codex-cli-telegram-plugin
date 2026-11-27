// R29: opt-in automatic self-update (KROT_AUTO_UPDATE=1, every KROT_AUTO_UPDATE_HOURS, default 6).
//
// A run fetches the tracked branch (SelfUpdate.check). Only a new fast-forward commit that the boot guard
// has not marked bad is checked further, the way update.sh does it: a copy of that commit in
// <state>/update-stage gets its locked dependencies, runs its tests, then the doctor with the saved
// plugin/.env. Only after that passes, and only while the bridge is idle, UpdateCommands.applyWhenIdle
// fast-forwards the checkout and restarts (exit 75). The trial boot, the probation and the rollback of
// a commit that does not work are the boot guard's (plugin/scripts/boot-guard.sh); a rolled-back commit
// lands in <git-dir>/krotov-update-bad and is never tried again automatically.
// Every file this module writes is in the bridge state directory, and so is every file the staged steps
// write: their TMPDIR and caches point into the staged copy (stageEnv).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { INSTALL_ARGS, type Runner, type UpdateCheck } from './self-update.js'

const hourMs = 3_600_000
const defaultHours = 6
/** The shortest allowed check interval: a smaller KROT_AUTO_UPDATE_HOURS falls back to the default. */
const minimumHours = 1

export interface AutoUpdateConfig { enabled: boolean; intervalMs: number }

/** KROT_AUTO_UPDATE=1 turns the timer on (off by default); KROT_AUTO_UPDATE_HOURS sets its interval. */
export function autoUpdateConfig(env: Record<string, string | undefined>): AutoUpdateConfig {
  const hours = Number(env.KROT_AUTO_UPDATE_HOURS)
  const valid = env.KROT_AUTO_UPDATE_HOURS?.trim() && Number.isFinite(hours) && hours >= minimumHours
  return { enabled: env.KROT_AUTO_UPDATE === '1', intervalMs: (valid ? hours : defaultHours) * hourMs }
}

const AttemptSchema = z.object({
  at: z.number(),
  /** auto = the timer, owner = /cc update, manual = /update. */
  trigger: z.enum(['auto', 'owner', 'manual']),
  result: z.enum(['current', 'refused', 'bad', 'stage_failed', 'busy', 'apply_failed', 'applied']),
  from: z.string().optional(),
  to: z.string().optional(),
  detail: z.string().optional(),
})
export type UpdateAttempt = z.infer<typeof AttemptSchema>
export type AttemptInput = Omit<UpdateAttempt, 'at'>

/** <state>/update-attempt.json: the last update attempt for /doctor. A corrupt file reads as none. */
export class UpdateAttempts {
  private readonly path: string

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.path = join(stateDir, 'update-attempt.json')
  }

  last(): UpdateAttempt | undefined {
    try {
      const parsed = AttemptSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /** Throws when the record cannot be written; the caller logs it. */
  record(attempt: AttemptInput): void {
    const temp = this.path + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify({ ...attempt, at: this.now() }) + '\n', { mode: 0o600 })
    renameSync(temp, this.path)
  }
}

export type StageResult = { ok: true } | { ok: false; stage: 'archive' | 'install' | 'test' | 'build' | 'doctor'; detail: string }

export interface StageOptions {
  /** The bridge checkout (repository root); its plugin/.env is what the staged doctor reads. */
  repo: string
  /** The bridge state directory: the staged copy lives in <state>/update-stage and is removed afterwards. */
  stateDir: string
  run: Runner
  bun: string
  /** The commit to check. */
  to: string
}

/**
 * The extra environment of the staged steps: temporary files and caches (the bun install cache too) stay
 * inside the staged copy and go with it. HOME is left as it is: Codex and the doctor read the real one.
 */
export function stageEnv(stage: string): Record<string, string> {
  const tmp = join(stage, '.stage-tmp')
  const cache = join(stage, '.stage-cache')
  return { TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, BUN_INSTALL_CACHE_DIR: join(cache, 'bun') }
}

function tail(text: string, chars = 300): string {
  const clean = text.trim()
  return clean.length > chars ? '…' + clean.slice(-chars) : clean
}

/**
 * Checks a commit in a separate copy before it touches the checkout, as update.sh does: locked install,
 * the test suite without plugin/.env, then the doctor with the saved plugin/.env. Never throws.
 */
export async function stageUpdate(options: StageOptions): Promise<StageResult> {
  const stage = join(options.stateDir, 'update-stage')
  const archive = join(options.stateDir, 'update-stage.tar')
  const plugin = join(stage, 'plugin')
  const failed = (step: Exclude<StageResult, { ok: true }>['stage'], output: { stdout: string; stderr: string }): StageResult =>
    ({ ok: false, stage: step, detail: tail(output.stderr || output.stdout) || 'без вывода' })
  try {
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true, mode: 0o700 })
    const env = stageEnv(stage)
    for (const dir of [env.TMPDIR, env.XDG_CACHE_HOME, env.BUN_INSTALL_CACHE_DIR]) {
      if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const packed = await options.run('git', ['archive', '--format=tar', '-o', archive, options.to], { cwd: options.repo, timeoutMs: 120_000 })
    if (packed.code !== 0) return failed('archive', packed)
    const unpacked = await options.run('tar', ['-xf', archive, '-C', stage], { cwd: options.stateDir, timeoutMs: 120_000 })
    if (unpacked.code !== 0) return failed('archive', unpacked)
    const install = await options.run(options.bun, INSTALL_ARGS, { cwd: plugin, timeoutMs: 600_000, env })
    if (install.code !== 0) return failed('install', install)
    const configuredTimeout = process.env.KROT_UPDATE_TEST_TIMEOUT_MS ?? ''
    const testTimeout = /^[1-9][0-9]{0,9}$/.test(configuredTimeout) && Number(configuredTimeout) <= 2_147_483_647
      ? configuredTimeout : '60000'
    const tests = await options.run(options.bun, ['--no-env-file', 'test', `--timeout=${testTimeout}`],
      { cwd: plugin, timeoutMs: 1_800_000, env })
    if (tests.code !== 0) return failed('test', tests)
    // As update.sh: the bridge entry point must bundle. The bundle goes into the staged copy, not to stdout.
    const build = await options.run(options.bun, ['--no-env-file', 'build', 'src/codex/server.ts', '--target=bun', '--outdir', join(stage, 'build')],
      { cwd: plugin, timeoutMs: 300_000, env })
    if (build.code !== 0) return failed('build', build)
    // Like update.sh: the doctor reads the production settings only after the tests finished.
    const doctor = await options.run(options.bun, [`--env-file=${join(options.repo, 'plugin', '.env')}`, 'run', 'doctor'],
      { cwd: plugin, timeoutMs: 300_000, env })
    if (doctor.code !== 0) return failed('doctor', doctor)
    return { ok: true }
  } catch (error) {
    return { ok: false, stage: 'archive', detail: error instanceof Error ? tail(error.message) : 'не удалось подготовить копию' }
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
}

/**
 * UpdateCommands.applyWhenIdle: busy = something runs, try later; restarting = the process is ending;
 * installed = the checkout is on the new commit but the restart was refused; failed = not applied,
 * `restored` false when the old version could not be put back either.
 */
export type IdleApply = { kind: 'busy' } | { kind: 'restarting' } | { kind: 'installed' } | { kind: 'failed'; detail: string; restored: boolean }

export interface AutoUpdaterDeps {
  config: AutoUpdateConfig
  check: () => Promise<UpdateCheck>
  badCommits: () => Promise<string[]>
  stage: (to: string) => Promise<StageResult>
  applyWhenIdle: (plan: Extract<UpdateCheck, { kind: 'plan' }>, trigger: 'auto' | 'owner') => Promise<IdleApply>
  /** A message to the owner. */
  send: (text: string) => Promise<unknown>
  attempts: { last(): UpdateAttempt | undefined; record(attempt: AttemptInput): void }
  sleep: (ms: number) => Promise<void>
  /** How long a verified update waits for the bridge to become idle (default one hour). */
  maxWaitMs?: number
  /** The pause between two idle checks (default one minute). */
  retryMs?: number
}

const short = (sha: string) => sha.slice(0, 12)
const stageNames: Record<string, string> = { archive: 'подготовка копии', install: 'установка зависимостей', test: 'тесты', build: 'сборка', doctor: 'doctor' }

export class AutoUpdater {
  private running = false

  constructor(private readonly deps: AutoUpdaterDeps) {}

  /** Arms the periodic check when KROT_AUTO_UPDATE=1; false when automatic update is off. */
  start(schedule: (tick: () => void, ms: number) => void = (tick, ms) => { setInterval(tick, ms).unref() }): boolean {
    if (!this.deps.config.enabled) return false
    schedule(() => { void this.run('auto') }, this.deps.config.intervalMs)
    return true
  }

  /** One check: the timer (auto) reports only what the owner must know; /cc update (owner) always answers. */
  async run(trigger: 'auto' | 'owner'): Promise<void> {
    const owner = trigger === 'owner'
    if (this.running) {
      if (owner) await this.deps.send('Проверка обновлений уже идёт.')
      return
    }
    this.running = true
    try {
      await this.cycle(trigger, owner)
    } finally {
      this.running = false
    }
  }

  private async cycle(trigger: 'auto' | 'owner', owner: boolean): Promise<void> {
    const plan = await this.deps.check()
    if (plan.kind === 'refused') {
      this.deps.attempts.record({ trigger, result: 'refused', detail: tail(plan.text) })
      if (owner) await this.deps.send(plan.text)
      return
    }
    if (plan.kind === 'current') {
      this.deps.attempts.record({ trigger, result: 'current', from: plan.head })
      if (owner) await this.deps.send('Мост уже последней версии (' + short(plan.head) + ').')
      return
    }
    const range = { from: plan.from, to: plan.to }
    if ((await this.deps.badCommits()).includes(plan.to)) {
      this.deps.attempts.record({ trigger, result: 'bad', ...range })
      if (owner) {
        await this.deps.send(`Новая версия ${short(plan.to)} уже откатывалась после неудачного запуска и помечена плохой: ` +
          'автоматически её не ставлю. Дождись следующего исправления или установи вручную командой /update.')
      }
      return
    }
    if (owner) {
      await this.deps.send(`Нашёл новую версию ${short(plan.from)} → ${short(plan.to)} (коммитов: ${plan.total}). ` +
        'Проверяю её в отдельной копии: тесты и doctor. Это займёт несколько минут.')
    }
    const previous = this.deps.attempts.last()
    const staged = await this.deps.stage(plan.to)
    if (!staged.ok) {
      const detail = `${stageNames[staged.stage] ?? staged.stage}: ${staged.detail}`
      this.deps.attempts.record({ trigger, result: 'stage_failed', ...range, detail })
      // The timer tells the owner once per failing target, not every few hours.
      if (owner || previous?.result !== 'stage_failed' || previous.to !== plan.to) {
        await this.deps.send(`Автообновление: версия ${short(plan.to)} не прошла проверку в отдельной копии (${detail}). ` +
          'Остаюсь на текущей версии.')
      }
      return
    }
    const maxWait = this.deps.maxWaitMs ?? hourMs
    const retry = this.deps.retryMs ?? 60_000
    let applied = await this.deps.applyWhenIdle(plan, trigger)
    for (let waited = 0; applied.kind === 'busy' && waited < maxWait; waited += retry) {
      await this.deps.sleep(retry)
      applied = await this.deps.applyWhenIdle(plan, trigger)
    }
    if (applied.kind === 'busy') {
      this.deps.attempts.record({ trigger, result: 'busy', ...range })
      if (owner) await this.deps.send('Новая версия проверена, но бот так и не освободился. Попробую при следующей проверке или отправь /cc update позже.')
      return
    }
    // applyWhenIdle recorded the result itself; a restart needs no further word.
    if (applied.kind === 'installed') {
      await this.deps.send(`Автообновление: новая версия ${short(plan.to)} установлена, но перезапуск сейчас отклонён. ` +
        'Она заработает после следующего перезапуска (/restart).')
    } else if (applied.kind === 'failed') {
      await this.deps.send('Автообновление не установилось: ' + applied.detail + '. ' + (applied.restored
        ? 'Бот работает на прежней версии.'
        : '⚠️ Вернуть прежнюю версию автоматически не получилось. Проверь на сервере git status и bun install.'))
    }
  }
}
