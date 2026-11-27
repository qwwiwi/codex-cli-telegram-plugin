import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { safetyHook } from '../../../codex-hooks/src/pre.js'
import { dangerReason, type SafetyView } from '../../../codex-hooks/src/safety.js'
import { readCommand } from '../../../codex-hooks/src/shell.js'
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
const clearTrash = () => rmSync(join(home, '.trash'), { recursive: true, force: true })
const strictView: SafetyView = { cwd: '/work/repo', home: '/home/u', branchOf: () => 'feature/x', exists: () => false, dirty: () => false, tmpDirs: ['/tmp'] }
const HINT = 'write it as plain commands'

describe('R3 B1: a shell reading its script from stdin is unparsed', () => {
  const forms = [
    "cat <<'X' | bash\nrm -rf src\nX",
    "bash <<< 'rm -rf src'",
    "echo 'rm -rf src' | bash",
    "printf 'rm -rf src\\n' | sh",
    '"bash" <<EOF\nrm -rf src\nEOF',
    "bash -s <<< 'rm -rf src'",
  ]
  for (const command of forms) {
    test(`[R17] denied: ${JSON.stringify(command)}`, () => {
      expect(readCommand(command, strictView.cwd, '/home/u').unparsed).toBeDefined()
      expect(dangerReason(command, strictView)).toContain(HINT)
    })
  }
  test('[R17] sh < file is unparsed; a shell running a named script is not', () => {
    expect(readCommand('sh < script.sh', '/w', '/h').unparsed).toBeDefined()
    expect(readCommand('cat input | bash run.sh', '/w', '/h').unparsed).toBeUndefined()
    expect(dangerReason('echo hi | bash', strictView)).toBeUndefined()
  })
  test('[R17] a quoted command word in a subshell still counts as a mention', () => {
    expect(dangerReason("(r'm' -rf src)", strictView)).toContain(HINT)
  })
})

describe('R3 sol(a): snapshots follow the real targets', () => {
  test('[R17] B2 git clean snapshots a non-ASCII file name', () => {
    writeFileSync(join(repo, 'заметки.md'), 'важно\n')
    expect(hook('git clean -fd').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'заметки.md')), 'utf8')).toBe('важно\n')
  })
  test('[R17] git clean -ffd keeps the force level and snapshots a nested repository', () => {
    mkdirSync(join(repo, 'nested'))
    writeFileSync(join(repo, 'nested', 'work.txt'), 'nested work\n')
    sh(join(repo, 'nested'), 'init', '-q')
    expect(hook('git clean -ffd').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'nested', 'work.txt')), 'utf8')).toBe('nested work\n')
  })
  test('[R17] B4 rm -rf link/ snapshots the target directory', () => {
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'keep.txt'), 'keep\n')
    symlinkSync(join(root, 'data'), join(repo, 'd'))
    expect(hook('rm -rf d/').deny).toBeUndefined()
    expect(readFileSync(saved(join(root, 'data', 'keep.txt')), 'utf8')).toBe('keep\n')
  })
  test('[R17] B4 rm -rf link/ to the home directory is catastrophic', () => {
    symlinkSync(home, join(repo, 'h'))
    expect(hook('rm -rf h/').deny).toContain('домашней')
    expect(hook('rm -rf h/.').deny).toContain('домашней')
  })
  test('[R17] env -C / --chdir moves the snapshot to that directory', () => {
    mkdirSync(join(repo, 'out'))
    writeFileSync(join(repo, 'out', 'notes.md'), 'out notes\n')
    expect(hook('env -C out rm notes.md').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'out', 'notes.md')), 'utf8')).toBe('out notes\n')
    clearTrash()
    expect(hook('env --chdir out rm notes.md').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'out', 'notes.md')), 'utf8')).toBe('out notes\n')
  })
  test('[R17] a cd that may fail leaves the old directory a candidate', () => {
    expect(hook('cd missing; rm notes.md').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
  })
  test('[R17] find -exec rm with an explicit path snapshots it; -execdir with one is denied', () => {
    expect(hook('find src -name a.ts -exec rm notes.md \\;').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
    expect(hook('find src -name a.ts -execdir rm ../notes.md \\;').deny).toBeString()
  })
  test('[R17] truncate through a symlink copies the referent', () => {
    symlinkSync(join(repo, 'notes.md'), join(repo, 'link.md'))
    expect(hook('truncate -s 0 link.md').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
  })
  test('[R17] brace expansion is bounded and a glob that climbs out is denied', () => {
    expect(hook('rm -rf {notes.md,src}').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
    expect(hook('rm -rf src/*/../../notes.md').deny).toBeString()
  })
  test('[R17] an unparsed line that overwrites an existing file is denied', () => {
    expect(hook('printf "%s" "$(date)" > notes.md').deny).toBeString()
    expect(hook('echo "$(date)" > fresh.md').deny).toBeUndefined()
  })
  test('[R17] a shell call starting with apply_patch still checks its trailing command', () => {
    expect(hook("apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF\nrm notes.md").deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
  })
  test('[R17] tee and dd of= onto an existing file are snapshotted', () => {
    expect(hook('tee notes.md < /dev/null').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'notes.md')), 'utf8')).toBe('my notes\n')
    clearTrash()
    expect(hook('dd if=/dev/zero of=src/a.ts count=1').deny).toBeUndefined()
    expect(readFileSync(saved(join(repo, 'src', 'a.ts')), 'utf8')).toBe('export const a = 1\n')
  })
  test('[R17] the root, a top-level directory and another home are never deleted', () => {
    for (const command of ['rm -rf /data', 'rm -rf /home/other', 'rm -rf /']) expect(dangerReason(command, strictView)).toContain('корня')
  })
})
