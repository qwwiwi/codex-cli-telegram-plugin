import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { safetyHook } from '../../../codex-hooks/src/pre.js'
import type { HookContext, Json, Runner } from '../../../codex-hooks/src/types.js'

// A real process runner, as main.ts uses.
const run: Runner = (argv, options) => {
  const result = Bun.spawnSync([...argv], { ...(options.cwd ? { cwd: options.cwd } : {}), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  return { code: result.exitCode, stdout: result.stdout.toString() }
}
const sh = (cwd: string, ...argv: string[]) => {
  const result = run(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...argv], { cwd, timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`git ${argv.join(' ')} failed`)
  return result.stdout.trim()
}

let root = ''
let home = ''
let repo = ''
let scratch = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'snap-'))
  home = join(root, 'home')
  repo = join(home, 'repo')
  scratch = join(root, 'scratch')
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  mkdirSync(scratch)
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'src', 'deep', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(repo, 'notes.md'), 'my notes\n')
  writeFileSync(join(repo, '.gitignore'), '.env\nbuild/\n')
  writeFileSync(join(repo, '.env'), 'KEY=value\n')
  sh(repo, 'init', '-q', '-b', 'feature/x')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')
})
afterEach(() => {
  chmodSync(home, 0o700)
  if (existsSync(join(home, '.trash'))) chmodSync(join(home, '.trash'), 0o700)
  rmSync(root, { recursive: true, force: true })
})

function ctx(toolInput: Json, extra: Partial<HookContext> = {}, tool = 'shell'): HookContext {
  return {
    event: 'PreToolUse', input: { tool_name: tool, tool_input: toolInput, cwd: repo, tool_use_id: 'call-1' },
    config: DEFAULT_CONFIG, home, codexHome: join(home, '.codex'), stateDir: join(home, 'state'),
    now: () => Date.UTC(2026, 10, 26, 12, 0, 0), run, gbrain: undefined, log: () => undefined, tmpDirs: [scratch], ...extra,
  }
}
const hook = (command: string, extra: Partial<HookContext> = {}) => safetyHook(ctx({ command }, extra))
const trashRoot = () => join(home, '.trash', readdirSync(join(home, '.trash'))[0] ?? '')
const saved = (path: string) => join(trashRoot(), path)

describe('v0.4 control: git clean listing is complete', () => {
  for (const command of ['git clean -fdq', 'git clean -fd -q', 'git clean --quiet -fd', 'git clean -qfd']) {
    test(`[R17] ${command} snapshots every file it removes`, () => {
      writeFileSync(join(repo, 'untracked.txt'), 'untracked work\n')
      expect(hook(command).deny).toBeUndefined()
      expect(readFileSync(saved(join(repo, 'untracked.txt')), 'utf8')).toBe('untracked work\n')
    })
  }
  // git accepts any unambiguous prefix of a long option (--qui is --quiet, --forc is --force): the
  // guard does not guess and denies every abbreviation.
  for (const command of ['git clean --qui -fd -- tools', 'git clean --q -fd -- tools', 'git clean --quie -fd -- tools',
    'git clean --forc -d -- tools', 'git clean --f --qu -d -- tools']) {
    test(`[R17] ${command} is denied with a hint to use full option names`, () => {
      mkdirSync(join(repo, 'tools'))
      writeFileSync(join(repo, 'tools', 'run.sh'), 'my tool\n')
      expect(hook(command).deny).toContain('полностью')
    })
  }
})

describe('v0.4 control: git reset --hard over untracked files', () => {
  test('[R17] an untracked file at a path the target tracks is snapshotted before the reset', () => {
    writeFileSync(join(repo, 'x.txt'), 'old tracked\n')
    sh(repo, 'add', 'x.txt')
    sh(repo, 'commit', '-q', '-m', 'add x')
    sh(repo, 'rm', '-q', 'x.txt')
    sh(repo, 'commit', '-q', '-m', 'drop x')
    writeFileSync(join(repo, 'x.txt'), 'MY UNTRACKED WORK\n')
    expect(hook('git reset --hard HEAD~1').deny).toBeUndefined()
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
    expect(readFileSync(join(repo, 'x.txt'), 'utf8')).toBe('old tracked\n')
    expect(readFileSync(saved(join(repo, 'x.txt')), 'utf8')).toBe('MY UNTRACKED WORK\n')
  })
  test('[R17] an untracked file in the way of a tracked directory is snapshotted', () => {
    sh(repo, 'rm', '-q', '-r', 'src')
    sh(repo, 'commit', '-q', '-m', 'drop src')
    writeFileSync(join(repo, 'src'), 'a file named src\n')
    expect(hook('git reset --hard HEAD~1').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'src')), 'utf8')).toBe('a file named src\n')
  })
  test('[R17] a reset target that cannot be resolved is denied', () => {
    writeFileSync(join(repo, 'x.txt'), 'MY UNTRACKED WORK\n')
    expect(hook('git reset --hard no-such-rev').deny).toBeString()
  })
})

describe('v0.4 control: shell redirects resolve against the shell cwd', () => {
  test('[R17] env -C out printf x > notes.md snapshots the caller notes.md', () => {
    mkdirSync(join(repo, 'out'))
    expect(hook('env -C out printf x > notes.md').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
  })
})
