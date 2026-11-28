import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand, SelfUpdate } from '../../src/codex/self-update.js'

const script = resolve(import.meta.dir, '../../scripts/boot-guard.sh')
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

/** A checkout with an old and a new commit, HEAD on the new one, and a fake bun that logs its calls. */
function checkout(installCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'krot-guard-'))
  temporary.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'plugin'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'plugin', 'v.txt'), 'old\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'old')
  const from = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'plugin', 'v.txt'), 'new\n')
  git(repo, 'commit', '-q', '-am', 'new')
  const to = git(repo, 'rev-parse', 'HEAD')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls')
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\nprintf '%s %s\\n' "$PWD" "$*" >> "${calls}"\nexit ${installCode}\n`, { mode: 0o700 })
  const pending = join(repo, '.git', 'krotov-update-pending')
  const write = (phase: string, boots: number, extra = '') =>
    writeFileSync(pending, `v=1\nphase=${phase}\nfrom=${from}\nto=${to}\nboots=${boots}\nat=1\n${extra}`)
  const options = { cwd: join(repo, 'plugin'), env: { PATH: bin + ':/usr/bin:/bin', HOME: root } }
  const run = (path = options.env.PATH, bash = 'bash') => Bun.spawnSync([bash, script], {
    ...options, env: { ...options.env, PATH: path }, stdout: 'pipe', stderr: 'pipe',
  })
  const start = () => Bun.spawn(['bash', script], { ...options, stdout: 'ignore', stderr: 'pipe' })
  const read = () => existsSync(pending) ? readFileSync(pending, 'utf8') : ''
  const callLog = () => existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  return { root, bin, repo, from, to, write, run, start, read, callLog }
}

test('[A4] boot guard leaves an applying record alone while the checkout lock is held', () => {
  const box = checkout()
  box.write('applying', 0)
  const record = box.read()
  const lock = join(box.repo, '.git', 'krotov-update.lock')
  const fd = openSync(lock, 'a', 0o600)
  try {
    expect(spawnSync('flock', ['-n', '0'], { stdio: [fd, 'ignore', 'ignore'], timeout: 5000 }).status).toBe(0)
    const busy = box.run()
    expect(busy.exitCode).toBe(0)
    expect(busy.stderr.toString()).toContain('update lock held, recovery left for the next start')
    expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
    expect(box.read()).toBe(record)
    expect(box.callLog()).toBe('')
  } finally {
    closeSync(fd)
  }
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(box.read()).toContain('phase=rolled_back')
})

test('[A5] boot guard holds the checkout lock throughout its rollback install', async () => {
  const box = checkout()
  const ready = join(box.root, 'ready')
  const finish = join(box.root, 'finish')
  writeFileSync(join(box.bin, 'bun'), `#!/usr/bin/env bash
: > ${JSON.stringify(ready)}
while [[ ! -e ${JSON.stringify(finish)} ]]; do
  (( SECONDS < 5 )) || exit 1
  sleep 0.02
done
`, { mode: 0o700 })
  box.write('applying', 0)
  const guard = box.start()
  const stderr = new Response(guard.stderr).text()
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    const update = new SelfUpdate({ repo: box.repo, run: runCommand, bun: 'unused', guardInstalled: async () => true })
    expect(await update.check()).toMatchObject({ kind: 'refused', reason: 'busy' })
  } finally {
    writeFileSync(finish, '')
    await guard.exited
  }
  expect(await guard.exited, await stderr).toBe(0)
  expect(box.read()).toContain('phase=rolled_back')
  expect(statSync(join(box.repo, '.git', 'krotov-update.lock')).mode & 0o777).toBe(0o600)
}, 15_000)

test('[A5] boot guard descendants do not inherit the checkout lock', () => {
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('Fixture needs git')
  for (const stub of ['bun', 'git']) {
    const box = checkout()
    const pids = join(box.root, 'pids')
    // A stub that leaves a background sleep behind (stdio detached), the way a daemonizing child would.
    const leave = `sleep 5 </dev/null >/dev/null 2>&1 &\necho $! >> ${JSON.stringify(pids)}\n`
    if (stub === 'bun') writeFileSync(join(box.bin, 'bun'), `#!/usr/bin/env bash\n${leave}exit 0\n`, { mode: 0o700 })
    else writeFileSync(join(box.bin, 'git'), `#!/usr/bin/env bash\n${leave}exec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o700 })
    box.write('applying', 0)
    try {
      const result = box.run()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(box.read()).toContain('phase=rolled_back')
      expect(readFileSync(pids, 'utf8').trim()).not.toBe('')
      const lock = join(box.repo, '.git', 'krotov-update.lock')
      expect(spawnSync('flock', ['-n', lock, 'true'], { timeout: 5000 }).status, stub).toBe(0)
    } finally {
      for (const pid of existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean) : []) {
        try { process.kill(Number(pid)) } catch { /* already gone */ }
      }
    }
  }
})

test('[A7] boot guard still recovers an interrupted apply when flock is missing', () => {
  const box = checkout()
  for (const command of ['bash', 'git', 'mv']) {
    const path = Bun.which(command)
    if (!path) throw new Error('Fixture needs ' + command)
    symlinkSync(path, join(box.bin, command))
  }
  expect(Bun.which('flock', { PATH: box.bin })).toBeNull()
  box.write('applying', 0)
  const result = box.run(box.bin, join(box.bin, 'bash'))
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toContain('flock missing, recovering without the update lock')
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(box.read()).toContain('phase=rolled_back')
})

test('[S9] boot guard: a trial boot that died without recording its exit gets a second try, the second such boot rolls back', () => {
  const box = checkout()
  box.write('trial', 0)
  const first = box.run()
  expect(first.exitCode, first.stderr.toString()).toBe(0)
  expect(box.read()).toContain('boots=1')
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(box.callLog()).toBe('')
  const second = box.run()
  expect(second.exitCode, second.stderr.toString()).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(box.read()).toContain('phase=trial')
  expect(box.read()).toContain('fails=1')
  const third = box.run()
  expect(third.exitCode, third.stderr.toString()).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(readFileSync(join(box.repo, 'plugin', 'v.txt'), 'utf8')).toBe('old\n')
  expect(box.read()).toContain('phase=rolled_back')
  expect(box.callLog()).toBe(join(box.repo, 'plugin') + ' install --frozen-lockfile --ignore-scripts\n')
})

test('[S9.5] boot guard: an operator stop of the trial boot (exit 0) is not a failure, the trial goes on', () => {
  const box = checkout()
  box.write('trial', 1, 'fails=1\noutcome=stop\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(box.read()).toContain('phase=trial')
  expect(box.read()).toContain('fails=1')
  expect(box.read()).not.toContain('outcome=stop')
  expect(box.callLog()).toBe('')
})

test('[S9.5] boot guard: a trial boot that crashed (exit 1) or hit the startup watchdog is rolled back at once', () => {
  for (const outcome of ['crash', 'watchdog']) {
    const box = checkout()
    box.write('trial', 1, `outcome=${outcome}\n`)
    expect(box.run().exitCode).toBe(0)
    expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
    expect(box.read()).toContain('phase=rolled_back')
  }
})

test('[S9.5] boot guard: a planned exit (409, lock conflict) of the trial counts as one failure, not a rollback', () => {
  const box = checkout()
  box.write('trial', 1, 'outcome=planned\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(box.read()).toContain('fails=1')
})

test('[S9] boot guard: a rollback killed after the reset is finished on the next start (install again, record for the notice)', () => {
  const box = checkout()
  box.write('trial', 2, 'fails=2\n')
  git(box.repo, 'reset', '-q', '--keep', box.from)
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(box.read()).toContain('phase=rolled_back')
  expect(box.callLog()).toBe(join(box.repo, 'plugin') + ' install --frozen-lockfile --ignore-scripts\n')
})

test('[S9] boot guard: an unfinished rollback whose reinstall fails again ends as rollback_failed', () => {
  const box = checkout(1)
  box.write('trial', 2, 'fails=2\n')
  git(box.repo, 'reset', '-q', '--keep', box.from)
  expect(box.run().exitCode).toBe(0)
  expect(box.read()).toContain('phase=rollback_failed')
})

test('[S9] boot guard: an update interrupted while applying is rolled back at the next start', () => {
  const box = checkout()
  box.write('applying', 0)
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(box.read()).toContain('phase=rolled_back')
})

test('[S9] boot guard: a failed reinstall is recorded as rollback_failed and the start still goes on', () => {
  const box = checkout(1)
  box.write('trial', 1, 'outcome=crash\n')
  expect(box.run().exitCode).toBe(0)
  expect(box.read()).toContain('phase=rollback_failed')
})

test('[S9] boot guard: no record, a malformed record or a HEAD moved by hand changes nothing', () => {
  const box = checkout()
  expect(box.run().exitCode).toBe(0)
  writeFileSync(join(box.repo, '.git', 'krotov-update-pending'), 'phase=trial\nfrom=$(touch /tmp/x)\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  box.write('trial', 1)
  writeFileSync(join(box.repo, 'plugin', 'v.txt'), 'third\n')
  git(box.repo, 'commit', '-q', '-am', 'third')
  expect(box.run().exitCode).toBe(0)
  expect(box.read()).toContain('phase=trial')
  expect(box.callLog()).toBe('')
})

// R29: a commit the guard had to roll back is marked bad, so automatic updates never try it again.
const badFile = (repo: string) => join(repo, '.git', 'krotov-update-bad')
const badList = (repo: string) => existsSync(badFile(repo)) ? readFileSync(badFile(repo), 'utf8').split('\n').filter(Boolean) : []

test('[R29] boot guard: a failed trial is rolled back and its commit is marked bad once; an interrupted apply is not', () => {
  const box = checkout()
  box.write('trial', 1, 'outcome=crash\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(badList(box.repo)).toEqual([box.to])
  // The same commit failing again is not listed twice.
  git(box.repo, 'reset', '-q', '--hard', box.to)
  box.write('trial', 1, 'outcome=watchdog\n')
  expect(box.run().exitCode).toBe(0)
  expect(badList(box.repo)).toEqual([box.to])

  // A kill in the middle of /update is not the new commit's fault.
  const applying = checkout()
  applying.write('applying', 0)
  expect(applying.run().exitCode).toBe(0)
  expect(git(applying.repo, 'rev-parse', 'HEAD')).toBe(applying.from)
  expect(badList(applying.repo)).toEqual([])
})

// R29: after its health mark the new commit stays on probation for 10 minutes; a third crash in it rolls back.
function probation(box: ReturnType<typeof checkout>, extra: string, until = Math.floor(Date.now() / 1000) + 600) {
  writeFileSync(join(box.repo, '.git', 'krotov-update-probation'), `v=1\nfrom=${box.from}\nto=${box.to}\nuntil=${until}\n${extra}`)
}
const probationText = (repo: string) => {
  const path = join(repo, '.git', 'krotov-update-probation')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('[R29] boot guard: the third crash of an updated commit within 10 minutes of its health mark rolls it back and marks it bad', () => {
  const box = checkout()
  probation(box, 'crashes=0\noutcome=crash\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(probationText(box.repo)).toContain('crashes=1')
  expect(probationText(box.repo)).not.toContain('outcome=')
  // A boot killed without recording its exit counts as a crash too.
  expect(box.run().exitCode).toBe(0)
  expect(probationText(box.repo)).toContain('crashes=2')
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  probation(box, 'crashes=2\noutcome=watchdog\n')
  const third = box.run()
  expect(third.exitCode, third.stderr.toString()).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
  expect(box.callLog()).toContain('install --frozen-lockfile --ignore-scripts')
  expect(badList(box.repo)).toEqual([box.to])
  // The old version tells the owner once, through the same record as a failed trial.
  expect(box.read()).toContain('phase=rolled_back')
  expect(box.read()).toContain(`to=${box.to}`)
  expect(probationText(box.repo)).toBe('')
})

test('[R29] boot guard: clean stops and planned restarts on probation do not count; an expired probation is dropped', () => {
  const box = checkout()
  probation(box, 'crashes=2\noutcome=stop\n')
  expect(box.run().exitCode).toBe(0)
  probation(box, 'crashes=2\noutcome=planned\n')
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(probationText(box.repo)).toContain('crashes=2')
  probation(box, 'crashes=2\noutcome=crash\n', Math.floor(Date.now() / 1000) - 1)
  expect(box.run().exitCode).toBe(0)
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.to)
  expect(probationText(box.repo)).toBe('')
  expect(badList(box.repo)).toEqual([])
})

test('[R29] boot guard: a probation rollback records itself before the reset, so a kill in the middle is finished on the next start', () => {
  const box = checkout()
  const root = resolve(box.repo, '..')
  const seen = join(root, 'seen')
  // A bun that shows what the pending record says while the rollback installs.
  writeFileSync(join(root, 'bin', 'bun'), `#!/usr/bin/env bash\ncat "${join(box.repo, '.git', 'krotov-update-pending')}" >> "${seen}"\nexit 0\n`, { mode: 0o700 })
  probation(box, 'crashes=2\noutcome=crash\n')
  expect(box.run().exitCode).toBe(0)
  expect(readFileSync(seen, 'utf8')).toContain('phase=applying')
  expect(box.read()).toContain('phase=rolled_back')
  expect(git(box.repo, 'rev-parse', 'HEAD')).toBe(box.from)
})
