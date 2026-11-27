// Only "no such file" (ENOENT, ENOTDIR) means a path is absent. Any other lstat error (a transient
// EIO, EACCES, ELOOP) is unknown: the guard must not treat the file as new and skip its snapshot.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { dispatch } from '../../../codex-hooks/src/dispatch.js'
import { safetyHook } from '../../../codex-hooks/src/pre.js'
import type { HookContext, Runner } from '../../../codex-hooks/src/types.js'

const noGit: Runner = () => ({ code: 1, stdout: '' })
// An lstat that fails with `code` for notes.md and is the real one for every other path.
const failing = (code: string) => (path: string): Stats => {
  if (path.endsWith('notes.md')) throw Object.assign(new Error(`${code}: injected error, lstat '${path}'`), { code })
  return lstatSync(path)
}

let root = ''
let home = ''
let repo = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lstat-errors-'))
  home = join(root, 'home')
  repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(root, 'scratch'))
  writeFileSync(join(repo, 'notes.md'), 'my notes\n')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const UPDATE = '*** Begin Patch\n*** Update File: notes.md\n@@\n-my notes\n+x\n*** End Patch\n'

function ctx(patch: string, extra: Partial<HookContext> = {}): HookContext {
  return {
    event: 'PreToolUse', input: { tool_name: 'apply_patch', tool_input: { input: patch }, cwd: repo, tool_use_id: 'call-1' },
    config: DEFAULT_CONFIG, home, codexHome: join(home, '.codex'), stateDir: join(home, 'state'),
    now: () => Date.UTC(2026, 10, 26, 12, 0, 0), run: noGit, gbrain: undefined, log: () => undefined, tmpDirs: [join(root, 'scratch')], safetyOnly: true, ...extra,
  }
}
const trash = () => { try { return readdirSync(join(home, '.trash')) } catch { return [] } }

test('[lstat] an apply_patch update of an existing file is snapshotted', async () => {
  expect(await dispatch(ctx(UPDATE))).toEqual({})
  expect(trash().length).toBe(1)
})

test('[lstat] a transient EIO from lstat denies the apply_patch update instead of skipping its snapshot', async () => {
  for (const code of ['EIO', 'EACCES', 'ELOOP']) {
    expect(() => safetyHook(ctx(UPDATE, { lstat: failing(code) }))).toThrow(code)
    const answer = await dispatch(ctx(UPDATE, { lstat: failing(code) }))
    expect(answer).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
    expect(JSON.stringify(answer)).toContain('сбой проверки безопасности (safety)')
  }
  expect(trash()).toEqual([])
})

test('[lstat] ENOENT and ENOTDIR still mean a new file: the update passes without a snapshot', async () => {
  for (const code of ['ENOENT', 'ENOTDIR']) expect(await dispatch(ctx(UPDATE, { lstat: failing(code) }))).toEqual({})
  expect(trash()).toEqual([])
})

test('[lstat] the shell guard denies an overwrite when lstat fails with EIO', async () => {
  const overwrite = (extra: Partial<HookContext>) => dispatch({ ...ctx(UPDATE, extra), input: { tool_name: 'shell', tool_input: { command: 'echo x > notes.md' }, cwd: repo, tool_use_id: 'call-2' } })
  expect(await overwrite({ lstat: failing('EIO') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  expect(await overwrite({ lstat: failing('ENOENT') })).toEqual({})
})

test('[lstat] pathExists: true for a path, false for ENOENT/ENOTDIR, throws on every other error', async () => {
  const { pathExists } = await import('../../../codex-hooks/src/snapshot.js')
  expect(pathExists(join(repo, 'notes.md'))).toBe(true)
  expect(pathExists(join(repo, 'missing.md'))).toBe(false)
  expect(pathExists(join(repo, 'notes.md', 'below'))).toBe(false)
  expect(pathExists(join(repo, 'notes.md'), failing('ENOENT'))).toBe(false)
  expect(pathExists(join(repo, 'notes.md'), failing('ENOTDIR'))).toBe(false)
  for (const code of ['EIO', 'EACCES', 'ELOOP', 'ENAMETOOLONG']) expect(() => pathExists(join(repo, 'notes.md'), failing(code))).toThrow(code)
})
