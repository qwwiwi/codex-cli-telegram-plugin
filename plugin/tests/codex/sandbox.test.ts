import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSession, type ApprovalDecision } from '../../src/codex/session.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

// The fake App Server rejects thread/start and thread/resume unless it gets
// exactly the expected "approvalPolicy/sandbox" pair.
function session(expected: string, extra: Partial<ConstructorParameters<typeof CodexSession>[0]>): CodexSession {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-sandbox-'))
  dirs.push(cwd)
  const created = new CodexSession({
    cwd: import.meta.dir, stateFile: join(cwd, 'thread.json'), env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt', 'default', expected],
    ...extra,
  }, () => {})
  sessions.push(created)
  return created
}

afterEach(() => {
  for (const item of sessions.splice(0)) item.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('full-access sandbox without approvals runs Codex with policy never and no approval cards', async () => {
  const codex = session('never/danger-full-access', { sandbox: 'danger-full-access' })
  await codex.initialize()
  expect(await codex.run('first')).toEqual({ status: 'completed', text: 'first' })
})

test('default sandbox stays workspace-write', async () => {
  const codex = session('never/workspace-write', {})
  await codex.initialize()
  expect(await codex.run('first')).toEqual({ status: 'completed', text: 'first' })
})

test('approvals keep on-request inside the configured sandbox', async () => {
  const approve = async (): Promise<ApprovalDecision> => 'decline'
  const codex = session('on-request/danger-full-access', { sandbox: 'danger-full-access', approve })
  await codex.initialize()
  expect(await codex.run('first')).toEqual({ status: 'completed', text: 'first' })
})
