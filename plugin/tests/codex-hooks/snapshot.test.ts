import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const hashes = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort()
  .filter(name => statSync(join(dir, name)).isFile())
  .map(name => `${name}:${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}`)

describe('S2 snapshot-before-delete', () => {
  test('[R17] rm -rf src is allowed after the trash holds the same tree', () => {
    expect(hook('rm -rf src').deny).toBeUndefined()
    const saved = join(trashRoot(), repo, 'src')
    expect(hashes(saved)).toEqual(hashes(join(repo, 'src')))
    expect(hashes(saved).length).toBe(2)
  })

  test('[R17] an unwritable trash denies', () => {
    mkdirSync(join(home, '.trash'))
    chmodSync(join(home, '.trash'), 0o500)
    expect(hook('rm -rf src').deny).toBeString()
  })

  test('[R17] a gitignored .env is snapshotted, not treated as scratch', () => {
    expect(hook('rm .env').deny).toBeUndefined()
    expect(readFileSync(join(trashRoot(), repo, '.env'), 'utf8')).toBe('KEY=value\n')
  })

  test('[R17] > on an existing file saves a real copy with another inode', () => {
    expect(hook('> notes.md').deny).toBeUndefined()
    const copy = join(trashRoot(), repo, 'notes.md')
    expect(readFileSync(copy, 'utf8')).toBe('my notes\n')
    expect(statSync(copy).ino).not.toBe(statSync(join(repo, 'notes.md')).ino)
  })

  test('[R17] mv -f onto an existing file snapshots the destination', () => {
    writeFileSync(join(repo, 'draft.md'), 'draft\n')
    expect(hook('mv -f draft.md notes.md').deny).toBeUndefined()
    expect(readFileSync(join(trashRoot(), repo, 'notes.md'), 'utf8')).toBe('my notes\n')
  })

  test('[R17] nothing inside ~/.trash may be deleted', () => {
    mkdirSync(join(home, '.trash', 'old'), { recursive: true })
    writeFileSync(join(home, '.trash', 'old', 'x'), 'x')
    expect(hook(`rm -rf ${home}/.trash/old`).deny).toContain('.trash')
    expect(hook('rm -rf ~/.trash').deny).toBeString()
  })

  test('[R17] a symlinked scratch parent is classified by its real target', () => {
    symlinkSync(repo, join(scratch, 'link'))
    expect(hook(`rm ${scratch}/link/notes.md`).deny).toBeUndefined()
    expect(readFileSync(join(trashRoot(), repo, 'notes.md'), 'utf8')).toBe('my notes\n')
  })

  test('[R17] over the cap the hook denies with an mv hint', () => {
    const reason = hook('rm -rf src', { snapshotLimits: { maxFiles: 1, maxBytes: 1 << 20 } }).deny
    expect(reason).toContain('mv ')
    expect(reason).toContain('.trash')
  })

  test('[R17] a forged backups.json changes no decision', () => {
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'backups.json'), JSON.stringify({ [join(repo, 'src')]: { at: Date.UTC(2026, 10, 26, 12, 0, 0) } }))
    expect(hook('rm -rf src', { snapshotLimits: { maxFiles: 1, maxBytes: 1 << 20 } }).deny).toBeString()
  })

  test('[R17] an apply_patch deletion is snapshotted first', () => {
    const patch = '*** Begin Patch\n*** Delete File: notes.md\n*** Update File: src/a.ts\n@@\n-export const a = 1\n+export const a = 3\n*** End Patch\n'
    expect(safetyHook(ctx({ input: patch }, {}, 'apply_patch')).deny).toBeUndefined()
    expect(readFileSync(join(trashRoot(), repo, 'notes.md'), 'utf8')).toBe('my notes\n')
    expect(readFileSync(join(trashRoot(), repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  test('[R17] git clean -fdx snapshots its own dry-run list', () => {
    mkdirSync(join(repo, 'build'))
    writeFileSync(join(repo, 'build', 'out.js'), 'out\n')
    writeFileSync(join(repo, 'untracked.txt'), 'u\n')
    expect(hook('git clean -fdx').deny).toBeUndefined()
    const saved = join(trashRoot(), repo)
    expect(readFileSync(join(saved, 'build', 'out.js'), 'utf8')).toBe('out\n')
    expect(readFileSync(join(saved, 'untracked.txt'), 'utf8')).toBe('u\n')
    expect(readFileSync(join(saved, '.env'), 'utf8')).toBe('KEY=value\n')
  })

  test('[R17] a dirty git reset --hard leaves refs/backup/* equal to the pre-state', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 42\n')
    expect(hook('git reset --hard').deny).toBeUndefined()
    const ref = sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/backup/')
    expect(ref).toStartWith('refs/backup/')
    expect(sh(repo, 'diff', ref)).toBe('')
  })

  test('[R17] git branch -D keeps the tip under refs/backup/branches', () => {
    sh(repo, 'branch', 'old')
    expect(hook('git branch -D old').deny).toBeUndefined()
    expect(sh(repo, 'for-each-ref', '--format=%(objectname)', 'refs/backup/branches/')).toBe(sh(repo, 'rev-parse', 'old'))
  })
})
