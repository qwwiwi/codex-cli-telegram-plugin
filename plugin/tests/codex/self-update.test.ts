import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INSTALL_ARGS, recordTrialOutcome, runCommand, SelfUpdate, trialOutcomeFor, type Runner } from '../../src/codex/self-update.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** An origin with one commit, a clone that tracks it, and a second checkout that publishes new commits. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'krot-update-'))
  temporary.push(root)
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const author = join(root, 'author')
  git(root, 'clone', '-q', origin, author)
  git(author, 'checkout', '-q', '-b', 'main')
  const base = commit(author, 'a.txt', '1\n', 'First version')
  git(author, 'push', '-q', 'origin', 'main')
  const repo = join(root, 'bridge')
  git(root, 'clone', '-q', origin, repo)
  return { root, origin, author, repo, base }
}

/** Real git; bun install and tsc are recorded and answer with the given exit codes. */
function runner(codes: { install?: number[]; tsc?: number } = {}) {
  const calls: string[] = []
  const installs = [...(codes.install ?? [])]
  const run: Runner = async (command, args, options) => {
    if (command === 'bun-bin') {
      const line = args.join(' ')
      calls.push('bun ' + line)
      if (args[0] === 'install') return { code: installs.shift() ?? 0, stdout: '', stderr: 'install failed' }
      return { code: codes.tsc ?? 0, stdout: 'src/x.ts(1,1): error TS2322', stderr: '' }
    }
    if (command === 'git' && ['merge', 'reset'].includes(args[0]!)) calls.push('git ' + args.join(' '))
    return runCommand(command, args, options)
  }
  return { run, calls }
}

function updater(repo: string, run: Runner, extra: Partial<ConstructorParameters<typeof SelfUpdate>[0]> = {}) {
  return new SelfUpdate({ repo, run, bun: 'bun-bin', guardInstalled: async () => true, now: () => 5000, ...extra })
}

test('[S9] /update lists the new commits, fast-forwards, installs, type-checks and leaves a trial record', async () => {
  const { author, repo, base } = repos()
  commit(author, 'b.txt', '2\n', 'Second version')
  const target = commit(author, 'c.txt', '3\n', 'Third version')
  git(author, 'push', '-q', 'origin', 'main')
  const { run, calls } = runner()
  const update = updater(repo, run)
  const plan = await update.check()
  expect(plan).toMatchObject({ kind: 'plan', from: base, to: target, total: 2 })
  if (plan.kind !== 'plan') throw new Error('no plan')
  expect(plan.commits.map(line => line.slice(8))).toEqual(['Third version', 'Second version'])
  const result = await update.apply(plan)
  expect(result).toEqual({ ok: true, from: base, to: target })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(target)
  expect(calls).toEqual(['git merge --ff-only --no-overwrite-ignore ' + target, 'bun install --frozen-lockfile --ignore-scripts',
    'bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p .'])
  const pending = readFileSync(join(repo, '.git', 'krotov-update-pending'), 'utf8')
  expect(pending).toBe(`v=1\nphase=trial\nfrom=${base}\nto=${target}\nboots=0\nat=5000\nfails=0\n`)
})

test('[S9] the configured branch KROT_UPDATE_BRANCH is fetched instead of the upstream', async () => {
  const { author, repo, base } = repos()
  git(author, 'checkout', '-q', '-b', 'beta')
  const beta = commit(author, 'beta.txt', 'b\n', 'Beta change')
  git(author, 'push', '-q', 'origin', 'beta')
  const plan = await updater(repo, runner().run, { branch: 'beta' }).check()
  expect(plan).toMatchObject({ kind: 'plan', from: base, to: beta, total: 1 })
})

test('[S9] /update refuses a dirty tree and names the files, touching nothing', async () => {
  const { author, repo, base } = repos()
  commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  writeFileSync(join(repo, 'a.txt'), 'local edit\n')
  writeFileSync(join(repo, 'new.txt'), 'x\n')
  const { run, calls } = runner()
  const plan = await updater(repo, run).check()
  expect(plan.kind).toBe('refused')
  if (plan.kind !== 'refused') throw new Error('not refused')
  expect(plan.reason).toBe('dirty')
  expect(plan.text).toContain('a.txt')
  expect(plan.text).toContain('new.txt')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(calls).toEqual([])
})

test('[S9] an up-to-date copy and a diverged copy are reported without changes', async () => {
  const { author, repo } = repos()
  expect((await updater(repo, runner().run).check()).kind).toBe('current')
  commit(author, 'b.txt', '2\n', 'Upstream change')
  git(author, 'push', '-q', 'origin', 'main')
  commit(repo, 'local.txt', 'l\n', 'Local change')
  const plan = await updater(repo, runner().run).check()
  expect(plan).toMatchObject({ kind: 'refused', reason: 'diverged' })
})

test('[S9] /update refuses when the unit has no boot guard, since a broken version could not be rolled back', async () => {
  const { author, repo } = repos()
  commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const plan = await updater(repo, runner().run, { guardInstalled: async () => false }).check()
  expect(plan).toMatchObject({ kind: 'refused', reason: 'no-guard' })
})

test('[S9] a failed type check rolls the copy back to the recorded commit and reinstalls its dependencies', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Broken version')
  git(author, 'push', '-q', 'origin', 'main')
  const { run, calls } = runner({ tsc: 2 })
  const update = updater(repo, run)
  const plan = await update.check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  const result = await update.apply(plan)
  expect(result).toMatchObject({ ok: false, stage: 'tsc', restored: true })
  if (result.ok) throw new Error('applied')
  expect(result.detail).toContain('TS2322')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(calls).toEqual(['git merge --ff-only --no-overwrite-ignore ' + target, 'bun install --frozen-lockfile --ignore-scripts',
    'bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p .', 'git reset --keep ' + base, 'bun install --frozen-lockfile --ignore-scripts'])
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
})

test('[S9] the trial boot reaching the health mark completes the update; /update rollback then restores the old commit', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const { run, calls } = runner()
  const update = updater(repo, run)
  const plan = await update.check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  await update.apply(plan)
  // The next process: the trial boot of the new commit.
  const next = updater(repo, run)
  expect(await next.bootReport(target)).toEqual({ kind: 'trial', from: base, to: target })
  expect(await next.markHealthy(target)).toEqual({ from: base, to: target })
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
  expect(await next.markHealthy(target)).toBeUndefined()
  calls.length = 0
  const rollback = await next.rollback()
  expect(rollback).toEqual({ ok: true, from: target, to: base })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(calls).toEqual(['git reset --keep ' + base, 'bun install --frozen-lockfile --ignore-scripts'])
  // Nothing left to roll back.
  expect(await next.rollback()).toMatchObject({ ok: false, reason: 'nothing' })
})

test('[S9] a boot after an automatic rollback reports it once', async () => {
  const { repo, base } = repos()
  const target = 'f'.repeat(40)
  writeFileSync(join(repo, '.git', 'krotov-update-pending'), `v=1\nphase=rolled_back\nfrom=${base}\nto=${target}\nboots=1\nat=1\n`)
  const update = updater(repo, runner().run)
  expect(await update.bootReport(base)).toEqual({ kind: 'rolled_back', from: base, to: target })
  expect(await update.bootReport(base)).toBeUndefined()
})

test('[S9] commands run by /update never see the bridge secrets', async () => {
  const saved = process.env.TELEGRAM_BOT_TOKEN
  process.env.TELEGRAM_BOT_TOKEN = '123:secret-token'
  try {
    const result = await runCommand('/usr/bin/env', [], { cwd: tmpdir() })
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('secret-token')
    expect(result.stdout).toContain('PATH=')
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = saved
  }
})

test('[S9] a trial record left behind after HEAD was moved by hand does not block /update', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  writeFileSync(join(repo, '.git', 'krotov-update-pending'), `v=1\nphase=trial\nfrom=${'c'.repeat(40)}\nto=${'d'.repeat(40)}\nboots=1\nat=1\n`)
  const plan = await updater(repo, runner().run).check()
  expect(plan).toMatchObject({ kind: 'plan', from: base, to: target })
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
})

test('[S9] the fast-forward never overwrites an ignored local file that the target starts tracking', async () => {
  const { author, repo, base } = repos()
  commit(author, '.gitignore', 'local.env\n', 'Ignore local.env')
  git(author, 'push', '-q', 'origin', 'main')
  git(repo, 'pull', '-q', '--ff-only')
  const ignoredBase = git(repo, 'rev-parse', 'HEAD')
  expect(ignoredBase).not.toBe(base)
  writeFileSync(join(repo, 'local.env'), 'MINE=1\n')
  // Delete .gitignore from the work tree too: a file left on disk would keep ignoring local.env and
  // `git add .` would stage it back, so the next commit would have nothing to commit.
  git(author, 'rm', '-q', '.gitignore')
  commit(author, 'local.env', 'THEIRS=1\n', 'Start tracking local.env')
  git(author, 'push', '-q', 'origin', 'main')
  const { run } = runner()
  const update = updater(repo, run)
  const plan = await update.check()
  if (plan.kind !== 'plan') throw new Error('no plan: ' + JSON.stringify(plan))
  const result = await update.apply(plan)
  expect(result).toMatchObject({ ok: false, stage: 'merge', restored: true })
  expect(readFileSync(join(repo, 'local.env'), 'utf8')).toBe('MINE=1\n')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(ignoredBase)
})

test('[S9] /update children get neither GBRAIN_BEARER nor the bot token', async () => {
  const saved = { bearer: process.env.GBRAIN_BEARER, token: process.env.TELEGRAM_BOT_TOKEN }
  process.env.GBRAIN_BEARER = 'bearer-placeholder-value'
  process.env.TELEGRAM_BOT_TOKEN = '123:secret-token'
  try {
    const result = await runCommand('/usr/bin/env', [], { cwd: tmpdir() })
    expect(result.stdout).not.toContain('bearer-placeholder-value')
    expect(result.stdout).not.toContain('GBRAIN_BEARER')
    expect(result.stdout).not.toContain('secret-token')
  } finally {
    for (const [name, value] of [['GBRAIN_BEARER', saved.bearer], ['TELEGRAM_BOT_TOKEN', saved.token]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('[S9] the install /update runs never lets a dependency script see the token bun loads from plugin/.env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-postinstall-'))
  temporary.push(dir)
  const probe = 'require("fs").writeFileSync("marker", process.env.TELEGRAM_BOT_TOKEN ? "present" : "absent")'
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { postinstall: 'node -e ' + JSON.stringify(probe) } }))
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=probe-not-a-real-token\n')
  await runCommand(process.execPath, INSTALL_ARGS, { cwd: dir })
  expect(existsSync(join(dir, 'marker')) ? readFileSync(join(dir, 'marker'), 'utf8') : 'not run').toBe('not run')
})

test('[S9] /update rollback works on a live trial: back to the recorded commit, record removed', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const { run, calls } = runner()
  const plan = await updater(repo, run).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  await updater(repo, run).apply(plan)
  calls.length = 0
  const trial = updater(repo, run)
  expect(await trial.bootReport(target)).toMatchObject({ kind: 'trial' })
  expect(await trial.rollback()).toEqual({ ok: true, from: target, to: base })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(calls).toEqual(['git reset --keep ' + base, 'bun install --frozen-lockfile --ignore-scripts'])
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
})

test('[S9] a trial record whose rollback was cut off (HEAD back on from) does not refuse /update forever', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  writeFileSync(join(repo, '.git', 'krotov-update-pending'), `v=1\nphase=trial\nfrom=${base}\nto=${target}\nboots=2\nat=1\nfails=2\n`)
  expect(await updater(repo, runner().run).check()).toMatchObject({ kind: 'plan', from: base, to: target })
})

test('[S9.5] the end of a trial boot is written into the record for the guard; outside a trial nothing is written', () => {
  const { repo, base } = repos()
  const pending = join(repo, '.git', 'krotov-update-pending')
  expect(recordTrialOutcome(repo, 'stop')).toBeUndefined()
  expect(existsSync(pending)).toBe(false)
  writeFileSync(pending, `v=1\nphase=trial\nfrom=${'c'.repeat(40)}\nto=${base}\nboots=1\nat=1\n`)
  expect(recordTrialOutcome(repo, 'crash')).toMatchObject({ phase: 'trial', from: 'c'.repeat(40), to: base })
  expect(readFileSync(pending, 'utf8')).toContain('outcome=crash')
  writeFileSync(pending, `v=1\nphase=trial\nfrom=${'c'.repeat(40)}\nto=${'d'.repeat(40)}\nboots=1\nat=1\n`)
  expect(recordTrialOutcome(repo, 'crash')).toBeUndefined()
  expect(trialOutcomeFor(0, false)).toBe('stop')
  expect(trialOutcomeFor(75, false)).toBe('planned')
  expect(trialOutcomeFor(75, true)).toBe('watchdog')
  expect(trialOutcomeFor(1, false)).toBe('crash')
})

test('[S9] a healthy trial refreshes the guard copy the unit runs from the state directory', async () => {
  const { author, repo } = repos()
  mkdirSync(join(author, 'plugin', 'scripts'), { recursive: true })
  const target = commit(author, 'plugin/scripts/boot-guard.sh', '# new guard\n', 'New guard')
  git(author, 'push', '-q', 'origin', 'main')
  const state = mkdtempSync(join(tmpdir(), 'krot-state-'))
  temporary.push(state)
  writeFileSync(join(state, 'boot-guard.sh'), '# old guard\n')
  const { run } = runner()
  const plan = await updater(repo, run, { stateDir: state }).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  await updater(repo, run, { stateDir: state }).apply(plan)
  // Not before the health mark: the trial is still running the old copy.
  expect(readFileSync(join(state, 'boot-guard.sh'), 'utf8')).toBe('# old guard\n')
  expect(await updater(repo, run, { stateDir: state }).markHealthy(target)).toMatchObject({ to: target })
  expect(readFileSync(join(state, 'boot-guard.sh'), 'utf8')).toBe('# new guard\n')
})
