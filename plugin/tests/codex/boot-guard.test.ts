import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  const run = () => Bun.spawnSync(['bash', script], { cwd: join(repo, 'plugin'),
    env: { PATH: bin + ':/usr/bin:/bin', HOME: root }, stdout: 'pipe', stderr: 'pipe' })
  const read = () => existsSync(pending) ? readFileSync(pending, 'utf8') : ''
  const callLog = () => existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  return { repo, from, to, write, run, read, callLog }
}

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
