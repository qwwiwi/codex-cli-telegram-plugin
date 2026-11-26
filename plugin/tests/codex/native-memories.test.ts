import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAppServerCommand } from '../../src/codex/native-memories.js'

const base = ['codex', 'app-server', '--listen', 'stdio://'] as const
let home: string
let workspace: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-memories-'))
  workspace = join(home, 'work')
  mkdirSync(workspace)
  env = { CODEX_HOME: home }
})

afterEach(() => rmSync(home, { recursive: true }))

test('enables native memories for a new installation with no explicit setting', () => {
  expect(codexAppServerCommand(workspace, env, true)).toEqual([...base, '-c', 'features.memories=true'])
  writeFileSync(join(home, 'config.toml'), '[features]\ngoals = true # keep this\n')
  expect(codexAppServerCommand(workspace, env, true)).toEqual([...base, '-c', 'features.memories=true'])
})

test.each([
  '[features]\nmemories = false\n',
  '[features]\nmemories = true\n',
  'features = { memories = false }\n',
  '"features"."memories" = false\n',
  'setting =',
])('lets Codex handle an existing setting or invalid TOML: %s', config => {
  writeFileSync(join(home, 'config.toml'), config)
  expect(codexAppServerCommand(workspace, env, true)).toEqual(base)
})

test('respects a workspace config and the installer opt-out', () => {
  expect(codexAppServerCommand(workspace, env, false)).toEqual(base)
  mkdirSync(join(workspace, '.codex'))
  writeFileSync(join(workspace, '.codex', 'config.toml'), '[features]\nmemories = false\n')
  expect(codexAppServerCommand(workspace, env, true)).toEqual(base)
})
