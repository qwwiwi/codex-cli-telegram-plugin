import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSession, type ApprovalRequest } from '../../src/codex/session.js'
import { startExternalTasks } from '../../src/codex/external.js'
import { automaticContinuation, hideContinuationMarker } from '../../src/codex/continuation.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

function fixture(auth: string = 'chatgpt', approve?: (request: ApprovalRequest) => Promise<'accept' | 'decline' | 'cancel'>,
  onActivity?: ConstructorParameters<typeof CodexSession>[0]['onActivity'], env = process.env) {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-test-'))
  dirs.push(cwd)
  const stateFile = join(cwd, 'thread.json')
  const create = () => {
    const session = new CodexSession({
      cwd: import.meta.dir, stateFile, env,
      command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), auth],
      ...(approve ? { approve } : {}),
      ...(onActivity ? { onActivity } : {}),
    }, () => {})
    sessions.push(session)
    return session
  }
  return { create, readThread: () => JSON.parse(readFileSync(stateFile, 'utf8')) }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('keeps the final answer and resumes the same thread after restart', async () => {
  const state = fixture()
  const first = state.create()
  await first.initialize()
  expect(await first.run('first')).toEqual({ status: 'completed', text: 'first' })
  const id = state.readThread()
  first.close()
  const restarted = state.create()
  await restarted.initialize()
  expect(await restarted.run('next')).toEqual({ status: 'completed', text: 'next' })
  expect(state.readThread()).toBe(id)
  restarted.reset()
  expect(state.readThread()).toBeNull()
  await restarted.run('new')
  expect(state.readThread()).not.toBe(id)
})

test('interrupts a running turn and can run a new turn afterward', async () => {
  const session = fixture().create()
  await session.initialize()
  await session.run('initialize thread')
  const pending = session.run('wait')
  await Bun.sleep(0)
  expect(await session.stop()).toBe(true)
  expect(await pending).toEqual({ status: 'interrupted', text: '' })
  expect(await session.run('next')).toEqual({ status: 'completed', text: 'next' })
})

test('stops during thread initialization without starting a turn', async () => {
  const session = fixture().create()
  await session.initialize()
  const pending = session.run('wait')
  expect(await session.stop()).toBe(true)
  expect(await pending).toEqual({ status: 'interrupted', text: '' })
  expect(await session.run('next')).toEqual({ status: 'completed', text: 'next' })
})

test('steers the active turn and receives a reply while the turn is still running', async () => {
  let answered!: (text: unknown) => void
  const reply = new Promise<unknown>(resolve => { answered = resolve })
  const session = fixture('chatgpt', undefined, event => {
    const item = event.params.item as { phase?: string; text?: string } | undefined
    if (item?.phase === 'commentary' && item.text !== 'status') answered(item.text)
  }).create()
  await session.initialize()
  expect(await session.steer('Too early', 1)).toBe(false)
  await session.run('initialize thread')
  const running = session.run('wait')
  while (!await session.steer('How is it going?', 2)) await Bun.sleep(5)
  expect(await reply).toBe('Follow-up: How is it going?')
  expect(session.isRunning).toBe(true)
  expect(await session.goal()).toBeNull()
  await session.stop()
  expect((await running).status).toBe('interrupted')
})

test('continues only when the current turn emits its own marker and keeps the owner objective', () => {
  const continuation = automaticContinuation('The original owner task')
  const marker = continuation.instructions.match(/KROT_CONTINUE_[a-f0-9-]{36}/)?.[0]
  expect(marker).toBeDefined()
  expect(continuation.take('Done.')).toBeUndefined()
  expect(continuation.take('Progress\n' + marker + '\n```')).toBeUndefined()
  expect(continuation.take('Progress\n' + marker)).toBe('Progress')
  expect(continuation.objective).toBe('The original owner task')
  expect(hideContinuationMarker('Progress\n' + marker)).toBe('Progress')
})

test('compacts the existing thread and captures its native token usage', async () => {
  const state = fixture()
  const session = state.create()
  await session.initialize()
  await expect(session.compact()).rejects.toThrow('no Codex conversation')
  await session.run('first')
  const thread = state.readThread()
  expect(await session.compact()).toBe('completed')
  expect(state.readThread()).toBe(thread)
  expect(session.status).toEqual({
    hasThread: true, model: 'gpt-test', usage: { usedTokens: 10, windowTokens: 100 },
  })
  session.reset()
  expect(session.status).toEqual({ hasThread: false, model: undefined, usage: undefined })
})

test('switches back to a known conversation and reads its turns and account metadata', async () => {
  const state = fixture()
  const session = state.create()
  await session.initialize()
  await session.run('first')
  const original = state.readThread()
  session.reset()
  await session.run('second')
  expect(state.readThread()).not.toBe(original)
  await session.resume(original)
  expect(state.readThread()).toBe(original)
  expect(await session.models()).toEqual([{ name: 'gpt-test', default: true }])
  expect(await session.usageLimits()).toEqual([{ used: 17, minutes: 300 }])
  expect(await session.recentTurns()).toMatchObject({ partial: false, turns: [{ items: [{ text: 'Example' }] }] })
})

test('delivers the result of a native goal turn authorized for this conversation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-goal-'))
  dirs.push(cwd)
  let allowed: string | undefined
  let ended!: (text: string) => void
  const result = new Promise<string>(resolve => { ended = resolve })
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile: join(cwd, 'thread.json'), env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts')],
    mayRunGoal: thread => allowed === thread,
    onGoalResult: (_thread, answer) => ended(answer.text),
  }, () => {})
  sessions.push(session)
  await session.initialize()
  allowed = await session.attachGoalThread()
  await session.setGoal(allowed, 'active', 'Finish the smoke test', 'automatic')
  expect(await result).toBe('Goal achieved')
  expect(await session.goal()).toMatchObject({ status: 'complete', origin: 'automatic' })
})

test('refuses to start without managed ChatGPT authentication', async () => {
  const session = fixture('apiKey').create()
  await expect(session.initialize()).rejects.toThrow('managed ChatGPT login')
})

test('delivers the photo as a native localImage input', async () => {
  const session = fixture().create()
  await session.initialize()
  expect(await session.run('Describe this', ['/tmp/picture.jpg'])).toEqual({
    status: 'completed', text: 'Describe this|localImage:/tmp/picture.jpg',
  })
})

test('relays one active command approval and rejects mismatched or incomplete requests', async () => {
  const seen: ApprovalRequest[] = []
  const session = fixture('chatgpt', async approval => {
    seen.push(approval)
    return 'accept'
  }).create()
  await session.initialize()
  expect((await session.run('approval:valid')).text).toBe('accept')
  expect((await session.run('approval:foreign')).text).toBe('decline')
  expect((await session.run('approval:incomplete')).text).toBe('decline')
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ kind: 'command', target: 'printf test', cwd: '/workspace' })
})

test('relays a verified subagent approval and rejects a different child turn', async () => {
  const seen: ApprovalRequest[] = []
  const session = fixture('chatgpt', async approval => {
    seen.push(approval)
    return 'accept'
  }).create()
  await session.initialize()
  expect((await session.run('approval:child')).text).toBe('accept')
  expect((await session.run('approval:child-wrong-turn')).text).toBe('decline')
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ kind: 'command', target: 'printf test' })
})

test('asks once for the exact local network destination without allowing persistent, remote or unseen actions', async () => {
  const seen: ApprovalRequest[] = []
  const session = fixture('chatgpt', async approval => {
    seen.push(approval)
    return 'accept'
  }).create()
  await session.initialize()
  expect((await session.run('approval:network')).text).toBe('accept')
  expect((await session.run('approval:network-persistent-only')).text).toBe('decline')
  expect((await session.run('approval:network-remote')).text).toBe('decline')
  expect((await session.run('approval:network-invalid')).text).toBe('decline')
  expect((await session.run('approval:stdin')).text).toBe('decline')
  expect((await session.run('approval:stdin-visible')).text).toBe('accept')
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ kind: 'network', target: 'https://example.test:443\n\nprintf test' })
  expect(seen[1]).toMatchObject({ kind: 'stdin', target: "write_stdin --session-id 123 'test input'" })
})

test('reuses one YAML decision for the same Codex command and asks again for a different command', async () => {
  const seen: ApprovalRequest[] = []
  let session: CodexSession
  const server = await startExternalTasks(0, 'test-agent', '123', () => 'accepted', {
    token: 'test-policy', request: request => session.requestPolicyApproval(request),
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    session = fixture('chatgpt', async approval => {
      seen.push(approval)
      return 'accept'
    }, undefined, { ...process.env, KROT_TEST_POLICY_URL: `http://127.0.0.1:${address.port}/hooks/permission/request` }).create()
    await session.initialize()
    expect((await session.run('approval:policy')).text).toBe('accept')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reason).toContain('вне песочницы')
    expect((await session.run('approval:policy-production-shell')).text).toBe('accept')
    expect(seen).toHaveLength(2)
    expect((await session.run('approval:policy-mismatch')).text).toBe('accept')
    expect(seen.map(request => request.target)).toEqual([
      'printf test', 'printf test', 'printf test', "/usr/bin/bash -lc 'printf other'",
    ])
    seen.length = 0
    expect((await session.run('approval:policy-file')).text).toBe('accept')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.target).toContain('*** Delete File: nested/remove.txt')
    expect((await session.run('approval:policy-file-mismatch')).text).toBe('accept')
    expect(seen).toHaveLength(3)
    expect(seen.at(-1)?.target).toContain('+different')
  } finally { server.close() }
})
