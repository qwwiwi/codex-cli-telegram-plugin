import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { safetyHook } from '../../../codex-hooks/src/pre.js'
import { assess, type SafetyView } from '../../../codex-hooks/src/safety.js'
import { cleanPreviewArgs } from '../../../codex-hooks/src/snapshot.js'
import type { HookContext, Json, Runner } from '../../../codex-hooks/src/types.js'

// git clean is parsed with a strict allowlist; the dry run that lists what to snapshot is built
// only from the parsed model, never from the agent's own words.

const onBranch = (branch: string): SafetyView => ({
  cwd: '/work/repo', home: '/home/u', branchOf: () => branch, exists: () => false, dirty: () => false, tmpDirs: ['/tmp'],
})
const verdict = (command: string) => assess(command, onBranch('feature/x'))
const model = (over: Record<string, unknown> = {}) => ({ force: 1, dirs: false, ignored: false, onlyIgnored: false, excludes: [], paths: [], ...over })

describe('v0.4 git clean: strict allowlist', () => {
  const denied = [
    'git clean --qui -fd', 'git clean --q -fd', 'git clean --quie -fd', 'git clean --forc -d', 'git clean --f -d',
    'git clean --fo -d', 'git clean -f --dry', 'git clean -f --excl=x', 'git clean -f --excl x', 'git clean -f --inter',
    'git clean -f --no-dry-run', 'git clean -f --no-dry', 'git clean -fn --no-dry-run', 'git clean -f --no-quiet',
    'git clean -f --no-force', 'git clean -fi', 'git clean -f -i', 'git clean -f --interactive', 'git clean -fdh',
    'git clean -f --force=yes', 'git clean -f --end-of-options x', 'git clean -f -', 'git clean -f -e',
    'git clean -f --exclude', 'git clean --forc', 'git clean --no-dry-run',
    // --exclude takes the next word, even `--`, so --qui is still an option here.
    'git clean --force --exclude -- --qui -- notes.md', 'git clean -fe -- --no-dry-run -- x',
  ]
  for (const command of denied) {
    test(`[R17] denied: ${command}`, () => {
      const result = verdict(command)
      expect(result.deny).toContain('полностью')
      expect(result.plans).toEqual([])
    })
  }

  const planned: Array<[string, Record<string, unknown>]> = [
    ['git clean -fd', { dirs: true }],
    ['git clean -fdx', { dirs: true, ignored: true }],
    ['git clean -fdX', { dirs: true, onlyIgnored: true }],
    ['git clean -ffd', { force: 2, dirs: true }],
    ['git clean --force -d --quiet', { dirs: true }],
    ['git clean -qfd -- tools', { dirs: true, paths: ['tools'] }],
    ['git clean -f -- --qui', { paths: ['--qui'] }],
    ['git clean -f -- -- x', { paths: ['--', 'x'] }],
    ['git clean -fe --quiet', { excludes: ['--quiet'] }],
    ['git clean -fe -- -- x', { excludes: ['--'], paths: ['x'] }],
    ['git clean --force --exclude -- -- notes.md', { excludes: ['--'], paths: ['notes.md'] }],
    ['git clean -f --exclude --no-dry-run', { excludes: ['--no-dry-run'] }],
    ['git clean -f --exclude=*.log -e x -fde*.tmp', { force: 2, dirs: true, excludes: ['*.log', 'x', '*.tmp'] }],
    ['git clean src -fd', { dirs: true, paths: ['src'] }],
  ]
  for (const [command, over] of planned) {
    test(`[R17] planned from the parsed model: ${command}`, () => {
      const result = verdict(command)
      expect(result.deny).toBeUndefined()
      expect(result.plans).toEqual([{ kind: 'clean', dir: '/work/repo', model: model(over) }])
    })
  }

  test('[R17] a dry run plans no snapshot', () => {
    for (const command of [
      'git clean -n', 'git clean -fdn', 'git clean --dry-run -fd', 'git -c clean.requireForce=false clean -dn',
      'GIT_WORK_TREE=/tmp/x git clean -n', 'env GIT_DIR=/x git clean -fn', 'export GIT_WORK_TREE=/x; git clean -n',
    ]) {
      const result = verdict(command)
      expect(result.deny).toBeUndefined()
      expect(result.plans).toEqual([])
    }
  })

  test('[R17] git clean still plans with unrelated assignments and GIT_* operands', () => {
    for (const command of [
      'export OTHER=x; env OTHER=y git clean -fd -- GIT_DIR=notes',
      'GIT_WORK_TREE=/x git status; git clean -fd -- GIT_DIR=notes',
      'printf %s GIT_WORK_TREE=/x; git clean -fd -- GIT_DIR=notes',
    ]) {
      const result = verdict(command)
      expect(result.deny).toBeUndefined()
      expect(result.plans).toEqual([{ kind: 'clean', dir: '/work/repo', model: model({ dirs: true, paths: ['GIT_DIR=notes'] }) }])
    }
  })

  test('[R17] modeled global -C options set the clean preview directory', () => {
    const result = verdict('git -C src -C gen clean -fd')
    expect(result.deny).toBeUndefined()
    expect(result.plans).toEqual([{ kind: 'clean', dir: '/work/repo/src/gen', model: model({ dirs: true }) }])
  })

  test('[R17] the preview argv is -n, canonical flags, --exclude=<pattern>, --, paths', () => {
    expect(cleanPreviewArgs(model({ force: 2, dirs: true, ignored: true, excludes: ['--no-dry-run', '--'], paths: ['--qui', 'a b'] })))
      .toEqual(['-n', '-f', '-f', '-d', '-x', '--exclude=--no-dry-run', '--exclude=--', '--', '--qui', 'a b'])
    expect(cleanPreviewArgs(model({ onlyIgnored: true }))).toEqual(['-n', '-X', '--'])
  })
})

// A real process runner that records every argv it runs.
const calls: string[][] = []
const run: Runner = (argv, options) => {
  calls.push([...argv])
  const result = Bun.spawnSync([...argv], { ...(options.cwd ? { cwd: options.cwd } : {}), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  return { code: result.exitCode, stdout: result.stdout.toString() }
}
const git = (cwd: string, ...argv: string[]) => {
  const result = run(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...argv], { cwd, timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`git ${argv.join(' ')} failed`)
  return result.stdout
}

let root = ''
let home = ''
let repo = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clean-'))
  home = join(root, 'home')
  repo = join(home, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(repo, '.gitignore'), '*.log\nbuild/\n')
  git(repo, 'init', '-q', '-b', 'feature/x')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  // Untracked, ignored, excluded-by-pattern, directories and a nested repository.
  writeFileSync(join(repo, 'notes.md'), 'notes\n')
  writeFileSync(join(repo, '--qui'), 'dash file\n')
  writeFileSync(join(repo, 'run.log'), 'log\n')
  writeFileSync(join(repo, 'keep.tmp'), 'tmp\n')
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'out.js'), 'out\n')
  mkdirSync(join(repo, 'src', 'gen'))
  writeFileSync(join(repo, 'src', 'gen', 'g.ts'), 'g\n')
  writeFileSync(join(repo, 'src', 'gen', 'g.tmp'), 'gt\n')
  mkdirSync(join(repo, 'tools'))
  writeFileSync(join(repo, 'tools', 'run.sh'), 'tool\n')
  mkdirSync(join(repo, 'nested'))
  writeFileSync(join(repo, 'nested', 'work.txt'), 'nested\n')
  git(join(repo, 'nested'), 'init', '-q')
  calls.length = 0
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function ctx(command: string): HookContext {
  return {
    event: 'PreToolUse', input: { tool_name: 'shell', tool_input: { command } as Json, cwd: repo, tool_use_id: 'call-1' },
    config: DEFAULT_CONFIG, home, codexHome: join(home, '.codex'), stateDir: join(home, 'state'),
    now: () => Date.UTC(2026, 10, 26, 12, 0, 0), run, gbrain: undefined, log: () => undefined, tmpDirs: [],
  }
}

// Every file below `dir` (relative), the top .git excluded.
function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true }).map(String)
    .filter(name => name !== '.git' && !name.startsWith('.git/') && statSync(join(dir, name)).isFile()).sort()
}
const savedFiles = () => {
  const trash = join(home, '.trash')
  if (!existsSync(trash)) return []
  const stamp = readdirSync(trash)[0] ?? ''
  return tree(join(trash, stamp, repo))
}
// Every git clean the hook ran: each must be a dry run made of canonical words only.
const cleanCalls = () => calls.filter(argv => argv.includes('clean')).map(argv => argv.slice(argv.indexOf('clean') + 1))

describe('v0.4 git clean: the snapshot is exactly what the real clean deletes', () => {
  const forms: string[][] = [
    ['-fd'], ['-f'], ['-fdx'], ['-fdX'], ['-ffd'], ['-fdq'], ['--force', '-d', '--quiet'], ['-qfdx'],
    ['-fdx', '-e', '*.tmp'], ['-fdx', '--exclude=*.tmp'], ['-fdx', '--exclude', '*.tmp'], ['-fdxe*.tmp'], ['-fdxe', '*.tmp'],
    ['-fd', '--', 'tools'], ['-fd', 'tools', '-x', 'build'], ['-fd', '--', '--qui'], ['-f', '-d', '-x', '--', 'build', 'notes.md'],
    ['--force', '--exclude', '--', '--', 'notes.md'], ['-fde', '--qui', '--', '.'],
  ]
  for (const form of forms) {
    const command = `git clean ${form.map(word => `'${word}'`).join(' ')}`
    test(`[R17] ${command}`, () => {
      const before = tree(repo)
      expect(safetyHook(ctx(command)).deny).toBeUndefined()
      expect(cleanCalls().length).toBeGreaterThan(0)
      for (const args of cleanCalls()) {
        expect(args[0]).toBe('-n')
        expect(args.slice(0, args.indexOf('--')).every(word => /^(?:-[nfdxX]|--exclude=.*)$/.test(word))).toBe(true)
      }
      git(repo, 'clean', ...form)
      const after = new Set(tree(repo))
      const deleted = before.filter(name => !after.has(name))
      expect(deleted.length).toBeGreaterThan(0)
      expect(savedFiles()).toEqual(deleted)
    })
  }

  test('[R17] git clean -d snapshots exactly what it deletes when clean.requireForce is false', () => {
    git(repo, 'config', 'clean.requireForce', 'false')
    const before = tree(repo)
    expect(safetyHook(ctx('git clean -d')).deny).toBeUndefined()
    const previews = cleanCalls()
    git(repo, 'clean', '-d')
    const after = new Set(tree(repo))
    const deleted = before.filter(name => !after.has(name))
    expect(deleted).toContain('notes.md')
    expect(savedFiles()).toEqual(deleted)
    expect(previews).toEqual([['-n', '-d', '--']])
  })

  const globalOptions = [
    'git -c clean.requireForce=false clean -d',
    'git --work-tree=codex-hooks clean -fd -- src/safety.ts',
    'git --git-dir .git clean -fd',
    'git --namespace=other clean -fd',
    'git --config-env=clean.requireForce=CLEAN_REQUIRE_FORCE clean -d',
    'git --config-env clean.requireForce=CLEAN_REQUIRE_FORCE clean -d',
    'git --attr-source HEAD clean -fd',
    'git -C src --no-pager clean -fd',
  ]
  for (const command of globalOptions) {
    test(`[R17] denies global options before any git clean preview: ${command}`, () => {
      const { deny } = safetyHook(ctx(command))
      expect(deny).toBeDefined()
      expect(deny).toContain('только -C')
      expect(cleanCalls()).toEqual([])
      expect(savedFiles()).toEqual([])
    })
  }

  for (const command of [
    'GIT_WORK_TREE=/tmp/x git clean -f',
    'GIT_WORK_TREE+=fixture git clean -fd',
    'env GIT_DIR=/x git clean -f',
    'export GIT_WORK_TREE=/x; git clean -f',
    'export GIT_WORK_TREE+=fixture; git clean -fd',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile GIT_CONFIG_VALUE_0=/x git clean -d',
    'OTHER=x GIT_WORK_TREE=/x && git clean -fd',
    'export GIT_DIR; git clean -fd',
  ]) {
    test(`[R17] denies GIT_* variables before any git clean preview: ${command}`, () => {
      expect(safetyHook(ctx(command)).deny).toContain('GIT_*')
      expect(cleanCalls()).toEqual([])
      expect(savedFiles()).toEqual([])
    })
  }

  for (const command of ['git clean --force --exclude -- --qui -- notes.md', 'git clean -f --no-dry-run -d', 'git clean -fd --no-dry',
    'git clean --qui -fd -- tools', 'git clean --forc -d -- tools', 'git clean -fd --excl=x']) {
    test(`[R17] denied before any git clean runs: ${command}`, () => {
      expect(safetyHook(ctx(command)).deny).toContain('полностью')
      expect(cleanCalls()).toEqual([])
      expect(savedFiles()).toEqual([])
    })
  }
})
