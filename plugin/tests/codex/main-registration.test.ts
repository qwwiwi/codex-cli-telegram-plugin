// O1-3: a main thread whose registration failed is registered again by the next turn (getThread retry).
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaySchema } from '../../../codex-brain/src/contract.js'
import { createBrainBridge } from '../../src/codex/brain-bridge.js'
import { CodexSession } from '../../src/codex/session.js'

const day = DaySchema.parse('2026-01-12')
const roots: string[] = []
const sessions: CodexSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const KEY_LINE = /--permit ([0-9a-f]+)/

test('O1-3 onMain fails once: that turn runs without owner rights and the next owner turn registers and gets a permit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-main-registration-'))
  roots.push(root)
  const bridge = createBrainBridge({ brainHome: join(root, 'brain'), scope: 'test', clock: { now: () => new Date(day + 'T12:00:00Z') } })
  const stateFile = join(root, 'thread.json')
  writeFileSync(stateFile, JSON.stringify('legacy-thread') + '\n')
  let failing = true
  const warnings: string[] = []
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile, env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    onMain: async id => {
      if (failing) throw new Error('registry unavailable')
      return bridge.registerOwnerMain(id)
    },
    aroundMainOpen: open => bridge.mainOpen(open),
    onWarning: message => { warnings.push(message) },
  }, () => {})
  sessions.push(session)
  bridge.attach(session)
  await session.initialize()
  const input = (n: number) => ({ key: 'test:' + n, origin: 'owner-direct' as const, inputKind: 'text' as const,
    input: 'Поправка: отчёт по пятницам', cue: true, sessionId: '' })
  const turn = (n: number) => bridge.execution('owner', input(n)).run(() => session.run('Поправка: отчёт по пятницам'))
  const first = await turn(1)
  expect(first.status).toBe('completed')
  expect(first.text).not.toMatch(KEY_LINE)
  expect(await bridge.sessions.resolve('legacy-thread')).toBeNull()
  expect(warnings.some(warning => warning.includes('legacy-thread'))).toBe(true)
  failing = false
  const second = await turn(2)
  expect(second.text).toMatch(KEY_LINE)
  expect(await bridge.sessions.resolve('legacy-thread')).toMatchObject({ role: 'owner', scope: 'test' })
})
