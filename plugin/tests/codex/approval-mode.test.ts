import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveApprovalSetup, sessionApprovalOptions } from '../../src/codex/approval-mode.js'
import { CodexSession, type ApprovalRequest } from '../../src/codex/session.js'
import { RuntimeEnvSchema } from '../../src/config.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The installer always writes KROT_CODEX_APPROVALS=1 into plugin/.env and, without
// --approval-mode, KROT_CODEX_APPROVAL_MODE=never (setup.test.ts runs the installer).
const freshInstall = { KROT_CODEX_APPROVALS: '1' }

test('[R01] a fresh install runs autonomously without approval cards, standard and risky stay selectable', () => {
  expect(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'never' })).toEqual({ cards: false, risky: false })
  expect(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'standard' }))
    .toEqual({ cards: true, risky: false })
  expect(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'risky' }))
    .toEqual({ cards: true, risky: true })
  expect(resolveApprovalSetup({})).toEqual({ cards: false, risky: false })
  expect(() => resolveApprovalSetup({ KROT_CODEX_APPROVAL_MODE: 'risky' })).toThrow('requires KROT_CODEX_APPROVALS=1')
})

test('[R01] approval mode never turns every approval card off, even with the installer\'s KROT_CODEX_APPROVALS=1', () => {
  expect(RuntimeEnvSchema.safeParse({ TELEGRAM_BOT_TOKEN: 'x', KROT_CODEX_APPROVAL_MODE: 'never' }).success).toBe(true)
  expect(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'never' })).toEqual({ cards: false, risky: false })
  expect(resolveApprovalSetup({ KROT_CODEX_APPROVAL_MODE: 'never' })).toEqual({ cards: false, risky: false })
})

test('[R01] with approval policy never no Codex or GitHub connector approval reaches the owner', async () => {
  const shown: ApprovalRequest[] = []
  const cards = { request: async (request: ApprovalRequest) => { shown.push(request); return 'accept' as const } }
  const options = sessionApprovalOptions(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'never' }), cards)
  expect(options).toEqual({})

  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-never-'))
  dirs.push(cwd)
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile: join(cwd, 'thread.json'), env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    ...options,
  }, () => {})
  sessions.push(session)
  await session.initialize()

  expect(JSON.parse((await session.run('mcp-approval:github')).text)).toEqual({ action: 'cancel' })
  expect(JSON.parse((await session.run('mcp-approval:valid')).text)).toEqual({ action: 'cancel' })
  expect((await session.run('approval:valid')).text).toBe('decline')
  expect(shown).toEqual([])

  // The same bridge with cards on (approval mode standard) does relay them.
  const standard = sessionApprovalOptions(resolveApprovalSetup({ ...freshInstall, KROT_CODEX_APPROVAL_MODE: 'standard' }), cards)
  expect(typeof standard.approve).toBe('function')
  expect(standard.riskyApprovals).toBe(false)
})
