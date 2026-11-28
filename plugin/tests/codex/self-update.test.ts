import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GUARD_VERSION, guardCopyProblem, guardVersion, INSTALL_ARGS, recordTrialOutcome, runCommand, SelfUpdate, trialOutcomeFor, type Runner } from '../../src/codex/self-update.js'

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
  // The check never deletes a record it did not write; the next apply overwrites it.
  expect(readFileSync(join(repo, '.git', 'krotov-update-pending'), 'utf8')).toContain('phase=trial')
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
  const marker = `# krotov-boot-guard-version: ${GUARD_VERSION}\n`
  const target = commit(author, 'plugin/scripts/boot-guard.sh', marker + '# new guard\n', 'New guard')
  git(author, 'push', '-q', 'origin', 'main')
  const state = mkdtempSync(join(tmpdir(), 'krot-state-'))
  temporary.push(state)
  writeFileSync(join(state, 'boot-guard.sh'), marker + '# old guard\n')
  const { run } = runner()
  const plan = await updater(repo, run, { stateDir: state }).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  await updater(repo, run, { stateDir: state }).apply(plan)
  // Not before the health mark: the trial is still running the old copy.
  expect(readFileSync(join(state, 'boot-guard.sh'), 'utf8')).toBe(marker + '# old guard\n')
  expect(await updater(repo, run, { stateDir: state }).markHealthy(target)).toMatchObject({ to: target })
  expect(readFileSync(join(state, 'boot-guard.sh'), 'utf8')).toBe(marker + '# new guard\n')
})

test('[R29] the health mark of an update starts a 10-minute probation that the boot guard reads', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const { run } = runner()
  const plan = await updater(repo, run).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  await updater(repo, run).apply(plan)
  // now() is 5000 ms: the probation ends 600 s after the health mark, in whole seconds for bash.
  expect(await updater(repo, run).markHealthy(target)).toEqual({ from: base, to: target })
  const probation = readFileSync(join(repo, '.git', 'krotov-update-probation'), 'utf8')
  expect(probation).toBe(`v=1\nfrom=${base}\nto=${target}\nuntil=605\ncrashes=0\n`)
})

test('[R29] the exit of a commit on probation is written for the guard; another commit or no probation writes nothing', () => {
  const { repo, base } = repos()
  const path = join(repo, '.git', 'krotov-update-probation')
  recordTrialOutcome(repo, 'crash')
  expect(existsSync(path)).toBe(false)
  writeFileSync(path, `v=1\nfrom=${'c'.repeat(40)}\nto=${base}\nuntil=999\ncrashes=1\n`)
  recordTrialOutcome(repo, 'crash')
  expect(readFileSync(path, 'utf8')).toBe(`v=1\nfrom=${'c'.repeat(40)}\nto=${base}\nuntil=999\ncrashes=1\noutcome=crash\n`)
  writeFileSync(path, `v=1\nfrom=${'c'.repeat(40)}\nto=${'d'.repeat(40)}\nuntil=999\ncrashes=1\n`)
  recordTrialOutcome(repo, 'crash')
  expect(readFileSync(path, 'utf8')).not.toContain('outcome=')
})

test('[R29] the bad-commit list the boot guard writes is read back, malformed lines ignored', async () => {
  const { repo } = repos()
  const update = updater(repo, runner().run)
  expect(await update.badCommits()).toEqual([])
  writeFileSync(join(repo, '.git', 'krotov-update-bad'), `${'e'.repeat(40)}\nnot a sha\n${'f'.repeat(40)}\n`)
  expect(await update.badCommits()).toEqual(['e'.repeat(40), 'f'.repeat(40)])
})

test('[S9] check and apply are serialized: an apply while a check runs is refused and changes nothing', async () => {
  const { author, repo, base } = repos()
  commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const plan = await updater(repo, runner().run).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let paused = false
  const { run } = runner()
  const gated: Runner = async (command, args, options) => {
    if (command === 'git' && args[0] === 'fetch' && !paused) {
      paused = true
      await gate
    }
    return run(command, args, options)
  }
  const update = updater(repo, gated)
  const checking = update.check()
  while (!paused) await new Promise(resolve => setTimeout(resolve, 5))
  const applied = await update.apply(plan)
  expect(applied).toMatchObject({ ok: false, stage: 'state' })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
  release()
  expect(await checking).toMatchObject({ kind: 'plan' })
})

test('[S9] a check never deletes an applying record it did not create, so the boot guard can still recover it', async () => {
  const { author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const record = `v=1\nphase=applying\nfrom=${base}\nto=${target}\nboots=0\nat=1\nfails=0\n`
  writeFileSync(join(repo, '.git', 'krotov-update-pending'), record)
  await updater(repo, runner().run).check()
  expect(readFileSync(join(repo, '.git', 'krotov-update-pending'), 'utf8')).toBe(record)
})

const updateLockName = 'krotov-update.lock'

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5000
  while (!paths.every(path => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + paths.join(', '))
    await Bun.sleep(5)
  }
}

function lockFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'krot-update-lock-'))
  temporary.push(dir)
  const lock = join(dir, updateLockName)
  const module = join(import.meta.dir, '../../src/codex/self-update.ts')
  const liveChild = `
    import { existsSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const [, dir] = process.argv
    writeFileSync(join(dir, 'child-ready'), '')
    const deadline = Date.now() + 5000
    while (!existsSync(join(dir, 'finish-child')) && Date.now() < deadline) await Bun.sleep(5)
    writeFileSync(join(dir, 'child-finished'), '')
  `
  const worker = (mode: 'race' | 'holder' | 'holder-with-child', id = '') => Bun.spawn([
    process.execPath, '--no-env-file', '-e', `
      import { spawnSync } from 'node:child_process'
      import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { runCommand, SelfUpdate } from ${JSON.stringify(module)}
      const [, dir, lock, mode, id] = process.argv
      const signal = name => writeFileSync(join(dir, name), '')
      const wait = async name => {
        const deadline = Date.now() + 5000
        while (!existsSync(join(dir, name))) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + name)
          await Bun.sleep(5)
        }
      }
      const run = async (_command, [step]) => {
        if (step === 'rev-parse') return { code: 0, stdout: dir, stderr: '' }
        if (step !== 'status') throw new Error('Unexpected git command: ' + step)
        if (mode === 'race') {
          const critical = join(dir, 'crit')
          mkdirSync(critical)
          try {
            await Bun.sleep(50)
            // Independently verify that the winner holds the permanent inode.
            if (spawnSync('flock', ['-n', lock, 'true']).status !== 1) {
              throw new Error('Winner did not hold the kernel lock')
            }
          } finally {
            rmdirSync(critical)
          }
        } else {
          if (mode === 'holder-with-child') {
            void runCommand(process.execPath, ['--no-env-file', '-e', ${JSON.stringify(liveChild)}, dir], { cwd: dir })
            await wait('child-ready')
          }
          signal('held')
          await wait('crash')
          process.kill(process.pid, 'SIGKILL')
        }
        return { code: 0, stdout: ' M fixture', stderr: '' }
      }
      if (mode === 'race') {
        signal('ready-' + id)
        await wait('start')
      }
      const result = await new SelfUpdate({ repo: dir, run, bun: 'unused', guardInstalled: async () => true }).check()
      console.log(result.reason)
    `, dir, lock, mode, id,
  ], { stdout: 'pipe', stderr: 'pipe' })
  const check = () => updater(dir, async (_command, [step]) => ({
    code: 0, stdout: step === 'rev-parse' ? dir : ' M fixture', stderr: '',
  })).check()
  return { dir, lock, worker, check }
}

test('[A1] eight processes contend on the same old lock inode without overlapping', async () => {
  const { dir, lock, worker } = lockFixture()
  const old = new Date(Date.now() - 600_000)
  // Seed the old implementation's filename too, so the same run exercises its stale takeover path.
  for (const file of [lock, join(dir, 'self-update.lock')]) {
    writeFileSync(file, 'junk', { mode: 0o600 })
    utimesSync(file, old, old)
  }
  const original = statSync(lock)
  const ids = Array.from({ length: 8 }, (_, i) => String(i))
  const results = Promise.all(ids.map(async id => {
    const child = worker('race', id)
    return {
      code: await child.exited,
      stdout: (await new Response(child.stdout).text()).trim(),
      stderr: await new Response(child.stderr).text(),
    }
  }))
  try {
    await waitForFiles(ids.map(id => join(dir, 'ready-' + id)))
  } finally {
    writeFileSync(join(dir, 'start'), '')
    await results
  }
  const settled = await results
  for (const { code, stderr } of settled) expect(code, stderr).toBe(0)
  expect(settled.some(result => result.stdout === 'dirty')).toBe(true)
  expect(settled.some(result => result.stdout === 'busy')).toBe(true)
  expect(statSync(lock).ino).toBe(original.ino)
  expect(readFileSync(lock, 'utf8')).toBe('junk')
}, 15_000)

test('[A2] a four-hour-old live lock stays held and is immediately free after SIGKILL', async () => {
  const { dir, lock, worker, check } = lockFixture()
  const holder = worker('holder')
  let contention
  try {
    await waitForFiles([join(dir, 'held')])
    const old = new Date(Date.now() - 4 * 3_600_000)
    for (const file of [lock, join(dir, 'self-update.lock')]) {
      if (existsSync(file)) utimesSync(file, old, old)
    }
    contention = await check()
  } finally {
    writeFileSync(join(dir, 'crash'), '')
    await holder.exited
  }
  expect(contention).toMatchObject({ kind: 'refused', reason: 'busy' })
  expect(holder.signalCode).toBe('SIGKILL')
  expect(await check()).toMatchObject({ kind: 'refused', reason: 'dirty' })
  expect(statSync(lock).mode & 0o777).toBe(0o600)
}, 15_000)

test('[A6] a live subprocess does not keep the lock after its holder is killed', async () => {
  const { dir, worker, check } = lockFixture()
  const holder = worker('holder-with-child')
  const childReady = join(dir, 'child-ready')
  const childFinished = join(dir, 'child-finished')
  const crash = join(dir, 'crash')
  try {
    await waitForFiles([join(dir, 'held'), childReady])
    expect(await check()).toMatchObject({ kind: 'refused', reason: 'busy' })
    writeFileSync(crash, '')
    await holder.exited
    expect(holder.signalCode).toBe('SIGKILL')
    expect(await check()).toMatchObject({ kind: 'refused', reason: 'dirty' })
    expect(existsSync(childFinished)).toBe(false)
  } finally {
    writeFileSync(crash, '')
    writeFileSync(join(dir, 'finish-child'), '')
    await holder.exited
    if (existsSync(childReady)) await waitForFiles([childFinished])
  }
}, 15_000)

test('[A3] updaters with different state directories share the checkout lock and applying record', async () => {
  const { root, author, repo, base } = repos()
  const target = commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const plan = await updater(repo, runner().run).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  const next = commit(author, 'c.txt', '3\n', 'Third version')
  git(repo, 'fetch', '-q', author, 'main')
  const nextPlan = { ...plan, from: target, to: next, commits: [next.slice(0, 7) + ' Third version'] }
  const pending = join(repo, '.git', 'krotov-update-pending')
  const atInstall = Promise.withResolvers<void>()
  const finishInstall = Promise.withResolvers<void>()
  const a = runner()
  const contenderA: Runner = async (command, args, options) => {
    if (command === 'bun-bin' && args[0] === 'install') {
      atInstall.resolve()
      await finishInstall.promise
    }
    return a.run(command, args, options)
  }
  const b = runner()
  const stateA = join(root, 'state-a')
  const stateB = join(root, 'state-b')
  for (const state of [stateA, stateB]) {
    mkdirSync(state)
    writeFileSync(join(state, 'boot-guard.sh'), `# krotov-boot-guard-version: ${GUARD_VERSION}\n`)
  }
  const applying = updater(repo, contenderA, { stateDir: stateA }).apply(plan)
  try {
    await Promise.race([atInstall.promise, applying])
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(target)
    const record = readFileSync(pending, 'utf8')
    expect(record).toContain(`phase=applying\nfrom=${base}\nto=${target}\n`)
    const result = await updater(repo, b.run, { stateDir: stateB }).apply(nextPlan)
    expect(b.calls).toEqual([])
    expect(result).toMatchObject({ ok: false, stage: 'state', detail: 'Обновление уже идёт.' })
    expect(readFileSync(pending, 'utf8')).toBe(record)
  } finally {
    finishInstall.resolve()
    await applying
  }
  expect(await applying).toEqual({ ok: true, from: base, to: target })
  expect(readFileSync(pending, 'utf8')).toBe(`v=1\nphase=trial\nfrom=${base}\nto=${target}\nboots=0\nat=5000\nfails=0\n`)
})

test('[A7] check refuses when flock is missing without changing the checkout', async () => {
  const { root, repo, base } = repos()
  const path = process.env.PATH
  const emptyPath = join(root, 'empty-path')
  mkdirSync(emptyPath)
  const commands: string[] = []
  const update = updater(repo, async (_command, [step]) => {
    if (step) commands.push(step)
    return { code: 0, stdout: join(repo, '.git'), stderr: '' }
  })
  try {
    process.env.PATH = emptyPath
    expect(await update.check()).toEqual({ kind: 'refused', reason: 'lock',
      text: 'Не найдена утилита flock – обновление невозможно. Установи flock и повтори.' })
    expect(await update.apply({ kind: 'plan', from: base, to: base, commits: [], total: 0 })).toMatchObject({ ok: false, stage: 'state',
      detail: 'Не найдена утилита flock – обновление невозможно. Установи flock и повтори.' })
    expect(await update.rollback()).toEqual({ ok: false, reason: 'failed',
      text: 'Не найдена утилита flock – обновление невозможно. Установи flock и повтори.' })
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
  expect(commands).toEqual(['rev-parse'])
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
})

test('[A7] a flock that does not answer in time is a lock failure, not a busy update', async () => {
  const { root, repo, base } = repos()
  const path = process.env.PATH
  const slow = join(root, 'slow-flock')
  mkdirSync(slow)
  writeFileSync(join(slow, 'flock'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o700 })
  const update = updater(repo, async () => ({ code: 0, stdout: join(repo, '.git'), stderr: '' }))
  try {
    process.env.PATH = slow + ':/usr/bin:/bin'
    expect(await update.check()).toEqual({ kind: 'refused', reason: 'lock',
      text: 'Не удалось взять блокировку обновления. Повтори позже.' })
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
}, 15_000)

test('[R29] the boot guard of this checkout carries the version marker the bridge requires', () => {
  const guard = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'boot-guard.sh'), 'utf8')
  expect(guardVersion(guard)).toBe(GUARD_VERSION)
  expect(guardVersion('#!/usr/bin/env bash\n# an older guard without a marker\n')).toBe(0)
})

test('[R29] an installed guard copy older than the bridge needs is refreshed from the checkout before an update', async () => {
  const { author, repo } = repos()
  mkdirSync(join(author, 'plugin', 'scripts'), { recursive: true })
  const current = `#!/usr/bin/env bash\n# krotov-boot-guard-version: ${GUARD_VERSION}\n`
  commit(author, 'plugin/scripts/boot-guard.sh', current, 'Current guard')
  git(author, 'push', '-q', 'origin', 'main')
  git(repo, 'pull', '-q', '--ff-only')
  commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const state = mkdtempSync(join(tmpdir(), 'krot-state-'))
  temporary.push(state)
  // The guard copy an install of an earlier release left: it exists, but it does not mark bad commits.
  writeFileSync(join(state, 'boot-guard.sh'), '#!/usr/bin/env bash\n# old guard\n')
  expect(guardCopyProblem(state)).toContain(`версия 0, нужна ${GUARD_VERSION}`)
  expect(await updater(repo, runner().run, { stateDir: state }).check()).toMatchObject({ kind: 'plan' })
  expect(readFileSync(join(state, 'boot-guard.sh'), 'utf8')).toBe(current)
  expect(guardCopyProblem(state)).toBeUndefined()
})

test('[R29] without a compatible guard copy the update is refused with the reason, and nothing is applied', async () => {
  const { author, repo, base } = repos()
  commit(author, 'b.txt', '2\n', 'Second version')
  git(author, 'push', '-q', 'origin', 'main')
  const state = mkdtempSync(join(tmpdir(), 'krot-state-'))
  temporary.push(state)
  writeFileSync(join(state, 'boot-guard.sh'), '#!/usr/bin/env bash\n# old guard\n')
  // This checkout has no current guard to install: the old copy cannot be replaced.
  const refused = await updater(repo, runner().run, { stateDir: state }).check()
  expect(refused).toMatchObject({ kind: 'refused', reason: 'old-guard' })
  if (refused.kind !== 'refused') throw new Error('not refused')
  expect(refused.text).toContain('boot-guard.sh')
  expect(refused.text).toContain(`Проверка версии ${GUARD_VERSION} нужна, чтобы восстановление после сбоя не шло одновременно с обновлением.`)
  expect(refused.text).not.toContain('помечена плохой')
  const plan = await updater(repo, runner().run).check()
  if (plan.kind !== 'plan') throw new Error('no plan')
  expect(await updater(repo, runner().run, { stateDir: state }).apply(plan)).toMatchObject({ ok: false, stage: 'guard', restored: true })
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(base)
  expect(existsSync(join(repo, '.git', 'krotov-update-pending'))).toBe(false)
})
