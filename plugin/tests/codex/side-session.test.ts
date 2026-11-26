import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSession, type ApprovalRequest } from '../../src/codex/session.js'
import { CodexWorkStatus } from '../../src/codex/work-status.js'
import type { CodexEvent } from '../../src/codex/rpc.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

function fixture(options: {
  approve?: (request: ApprovalRequest) => Promise<'accept' | 'decline' | 'cancel'>
  onActivity?: (event: CodexEvent, currentThread: string | null) => void
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-side-'))
  dirs.push(cwd)
  const stateFile = join(cwd, 'thread.json')
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile, env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  }, () => {})
  sessions.push(session)
  return { session, readThread: (): unknown => JSON.parse(readFileSync(stateFile, 'utf8')) }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a side turn answers on its own thread while the main turn keeps running', async () => {
  const { session, readThread } = fixture()
  await session.initialize()
  const main = session.run('wait')
  await until(() => session.steerableTurn !== undefined)
  const mainTurn = session.steerableTurn
  const mainThread = readThread()
  const started: string[] = []
  const side = await session.runSide('Какая погода?', [], undefined, thread => { started.push(thread) })
  expect(side.status).toBe('completed')
  expect(side.text).toBe('side: Какая погода?')
  expect(started).toEqual([side.threadId])
  expect(side.threadId).not.toBe(mainThread)
  // The main conversation, its steerable turn and its HUD numbers are untouched by the side.
  expect(readThread()).toBe(mainThread)
  expect(session.currentThread).toBe(mainThread as string)
  expect(session.steerableTurn).toBe(mainTurn)
  expect(session.status.usage).toBeUndefined()
  expect(session.status.model).toBe('gpt-test')
  expect(session.sideRunning).toBe(0)
  expect(await session.steer('уточнение', 5)).toBe(true)
  // A reply to the side conversation reuses its thread.
  const again = await session.runSide('ещё', [], side.threadId)
  expect(again).toEqual({ status: 'completed', text: 'side: ещё', threadId: side.threadId })
  await session.stop()
  expect((await main).status).toBe('interrupted')
})

test('two turns can finish in either order and a side can be stopped alone', async () => {
  const { session } = fixture()
  await session.initialize()
  const main = session.run('wait')
  await until(() => session.steerableTurn !== undefined)
  const side = session.runSide('долгая side-wait')
  await until(() => session.sideRunning === 1)
  expect(session.isRunning).toBe(true)
  expect(await session.stopSide()).toBe(true)
  expect((await side).status).toBe('interrupted')
  expect(session.sideRunning).toBe(0)
  expect(session.steerableTurn).toBeDefined()
  expect(await session.stopSide()).toBe(false)
  await session.stop()
  expect((await main).status).toBe('interrupted')
})

test('a side turn gets its own approval and is not counted as a child of the main turn', async () => {
  const requests: ApprovalRequest[] = []
  const { session } = fixture({ approve: async request => { requests.push(request); return 'accept' } })
  await session.initialize()
  const main = session.run('wait')
  await until(() => session.steerableTurn !== undefined)
  const side = await session.runSide('side-approval')
  expect(side.text).toBe('side accept')
  expect(requests.map(request => request.target)).toEqual(['printf side'])
  await session.stop()
  expect((await main).status).toBe('interrupted')
})

test('the status bubble keeps following the main turn while a side turn runs', async () => {
  const calls: string[] = []
  const manager = {
    start: async (_chat: string, replyTo: number | undefined) => { calls.push('start:' + replyTo); return { id: 1 } as never },
    update: async () => { calls.push('update') },
    complete: async () => { calls.push('complete') },
    isActive: () => calls.includes('start:7'),
    activeMessageId: () => 0,
  }
  const work = new CodexWorkStatus(manager, 'owner', {
    enabled: true, thoughts: { enabled: false, max_lines: 1, max_chars: 1 }, suppress_typing_bubble: false,
  } as never, [])
  const { session } = fixture({ onActivity: (event, thread) => work.receive(event, thread) })
  await session.initialize()
  work.begin(7)
  const main = session.run('wait')
  await until(() => session.steerableTurn !== undefined)
  await until(() => calls.includes('start:7'))
  await new Promise(resolve => setTimeout(resolve, 50))
  const before = calls.length
  const side = await session.runSide('вопрос')
  expect(side.status).toBe('completed')
  await new Promise(resolve => setTimeout(resolve, 50))
  // No new bubble, no completion of the main bubble, no tool line from the side's command.
  expect(calls.slice(before)).toEqual([])
  expect(work.busy).toBe(true)
  await session.stop()
  await main
  work.finish()
})
