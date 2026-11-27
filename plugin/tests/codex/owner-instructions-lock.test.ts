import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerInstructionsHome } from '../../src/codex/owner-instructions-lock.js'

let root: string
let codexHome: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-owner-instructions-'))
  codexHome = join(root, 'codex config')
  mkdirSync(codexHome)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function create(name: string): string {
  const path = join(codexHome, name)
  writeFileSync(path, 'Owner instructions')
  return path
}

test('an empty CODEX_HOME uses the default directory under HOME', () => {
  expect(ownerInstructionsHome({ HOME: root, CODEX_HOME: '' }, codexHome)).toBe(join(root, '.codex'))
})

test('the Telegram doctor report shows protected files as facts and unprotected files as problems', async () => {
  const { collectDoctorReport, formatDoctorReport } = await import('../../src/codex/doctor-command.js')
  const main = create('AGENTS.md')
  const override = create('AGENTS.override.md')
  const report = await collectDoctorReport({
    repo: root, env: {}, codexVersion: async () => undefined,
    doctor: async () => [
      { status: 'ok', message: `Защита инструкций Codex: ${main}: protected` },
      { status: 'warning', message: `Защита инструкций Codex: ${override}: NOT protected` },
    ],
  })
  const text = formatDoctorReport(report)
  expect(text).toContain(`${main}: protected`)
  expect(text).toContain(`${override}: NOT protected`)
  expect(report.problems.some(problem => problem.text.includes(main))).toBe(false)
})

test('the immutable probe uses the flag field and omits an absent override', async () => {
  const { ownerInstructionChecks } = await import('../../src/codex/owner-instructions-lock.js')
  const main = create('AGENTS.md')
  const probe = (path: string) => `----i---------e------- ${path}\n`
  expect(ownerInstructionChecks(codexHome, probe)).toEqual([{
    status: 'ok', message: expect.stringContaining(`${main}: protected`),
  }])
  const override = create('AGENTS.override.md')
  expect(ownerInstructionChecks(codexHome, probe)[1]).toEqual({
    status: 'ok', message: expect.stringContaining(`${override}: protected`),
  })
})

test('the lock check marks a mutable override as an error with the precedence and chattr hint', async () => {
  const { ownerInstructionChecks } = await import('../../src/codex/owner-instructions-lock.js')
  const override = create('AGENTS.override.md')
  const checks = ownerInstructionChecks(codexHome, path => `--------------e------- ${path}\n`)
  expect(checks[1]?.status).toBe('error')
  expect(checks[1]?.message).toContain('AGENTS.override.md exists and is not owner-locked – Codex reads it instead of AGENTS.md')
  expect(checks[1]?.message).toContain(`sudo chattr +i '${override}'`)
})

test('bridge startup sends one notice for a mutable override even when AGENTS.md is protected', async () => {
  const { reportOwnerInstructionsAtStartup } = await import('../../src/codex/owner-instructions-lock.js')
  const main = create('AGENTS.md')
  const override = create('AGENTS.override.md')
  const warnings: string[] = []
  const notices: string[] = []
  await reportOwnerInstructionsAtStartup(codexHome, text => { warnings.push(text) }, async text => { notices.push(text) }, path =>
    `${path === main ? '----i---------e-------' : '--------------e-------'} ${path}\n`)

  expect(warnings).toEqual(notices)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('AGENTS.override.md exists and is not owner-locked – Codex reads it instead of AGENTS.md')
  expect(notices[0]).toContain(`sudo chattr +i '${override}'`)
})

test('bridge startup groups unprotected files in a single owner notice and tolerates missing lsattr', async () => {
  const { reportOwnerInstructionsAtStartup } = await import('../../src/codex/owner-instructions-lock.js')
  const main = create('AGENTS.md')
  const override = create('AGENTS.override.md')
  const warnings: string[] = []
  const notices: string[] = []
  const warn = (text: string) => { warnings.push(text) }
  const sendOwner = async (text: string) => { notices.push(text) }
  const missingLsattr = () => { throw Object.assign(new Error('lsattr unavailable'), { code: 'ENOENT' }) }

  await reportOwnerInstructionsAtStartup(codexHome, warn, sendOwner, missingLsattr)
  expect(warnings).toHaveLength(1)
  expect(notices).toHaveLength(1)
  for (const path of [main, override]) {
    expect(warnings[0]).toContain(`${path}: NOT protected`)
    expect(notices[0]).toContain(`sudo chattr +i '${path}'`)
  }
  expect(notices[0]).toContain('lsattr')
  await reportOwnerInstructionsAtStartup(codexHome, warn, sendOwner, path => `----i----------------- ${path}\n`)
  await reportOwnerInstructionsAtStartup(join(root, 'missing'), warn, sendOwner, missingLsattr)
  expect(warnings).toHaveLength(1)
  expect(notices).toHaveLength(1)
})

test('the bridge wires the lock check once to its owner sender before normal and safe mode diverge', () => {
  const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'codex', 'server.ts'), 'utf8')
  const checked = server.match(/reportOwnerInstructionsAtStartup\([^\n]*\bsendOwner\b[^\n]*\)/g)
  expect(checked).toHaveLength(1)
  expect(server.indexOf(checked![0]!)).toBeLessThan(server.indexOf('if (safeEntry)'))
  expect(server).toContain('const sendOwner = (text: string) => reliableTelegram.sendMessage(String(ownerId)')
})

test('the bridge startup guards the owner lock probe with the proxy setting', () => {
  const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'codex', 'server.ts'), 'utf8')
  expect(server).toContain('const proxy = process.env.KROT_CODEX_PROXY')
  expect(/if \(!proxy\) \{\s*void reportOwnerInstructionsAtStartup\(/.test(server)).toBe(true)
})
