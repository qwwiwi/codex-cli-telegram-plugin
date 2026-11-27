import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { object, type CodexEvent, type CodexServerRequest, type Json } from '../../src/codex/rpc.js'
import { CodexSession, type ApprovalRequest } from '../../src/codex/session.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Call = { method: string; params: Json }

// An in-memory app-server: records every request; `hold` keeps one method pending until released.
class HeldRpc {
  readonly calls: Call[] = []
  private readonly held = new Map<string, Array<(value: Json) => void>>()
  private turns = 0
  constructor(private readonly hold = new Set<string>()) {}

  async initialize(): Promise<void> {}

  request(method: string, params: Json): Promise<Json> {
    this.calls.push({ method, params })
    if (this.hold.has(method)) {
      return new Promise(resolve => {
        const queue = this.held.get(method) ?? []
        queue.push(resolve)
        this.held.set(method, queue)
      })
    }
    return Promise.resolve(this.answer(method))
  }

  release(method: string): void {
    for (const resolve of this.held.get(method)?.splice(0) ?? []) resolve(this.answer(method))
  }

  methods(): string[] {
    return this.calls.map(call => call.method)
  }

  close(): void {}

  private answer(method: string): Json {
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'thread/start') return { thread: { id: 'thread-' + this.calls.length }, model: 'gpt-test' }
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.turns } }
    return {}
  }
}

interface SessionInternals {
  rpc: { close(): void }
  receive(event: CodexEvent): void
  requestApproval(request: CodexServerRequest): Promise<Json | undefined>
}

function fixture(rpc: HeldRpc, options: {
  approve?: (request: ApprovalRequest) => Promise<'accept' | 'decline' | 'cancel'>
  chatAction?: (key: string, args: unknown, current: () => boolean, tool: string) =>
    Promise<{ contentItems: [{ type: 'inputText'; text: string }]; success: boolean }>
  sandbox?: 'workspace-write' | 'danger-full-access'
  widgetsAvailable?: () => boolean
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-untrusted-'))
  dirs.push(cwd)
  const session = new CodexSession({
    cwd, stateFile: join(cwd, 'thread.json'), env: process.env, sandbox: options.sandbox ?? 'danger-full-access',
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.chatAction ? { chatAction: options.chatAction } : {}),
    ...(options.widgetsAvailable ? { widgetsAvailable: options.widgetsAvailable } : {}),
  }, () => {})
  sessions.push(session)
  const internals = session as unknown as SessionInternals
  internals.rpc.close()
  internals.rpc = rpc
  const complete = (threadId: string, turnId: string, text = 'done') => {
    internals.receive({ method: 'item/completed', params: { threadId, turnId,
      item: { type: 'agentMessage', phase: 'final_answer', text } } })
    internals.receive({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
  }
  return { session, internals, complete, cwd }
}

// The full Codex app-server workspaceWrite SandboxPolicy (v2 TurnStartParams):
// every field is required, a bare { type } is rejected by the real server.
function expectFullWorkspaceWrite(policy: unknown, cwd: string): void {
  expect(policy).toEqual({
    type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  })
  const roots = (policy as { writableRoots: unknown[] }).writableRoots
  for (const root of roots) expect(typeof root === 'string' && isAbsolute(root)).toBe(true)
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

function turnStarts(rpc: HeldRpc): Json[] {
  return rpc.calls.filter(call => call.method === 'turn/start').map(call => call.params)
}

test('F2: stopping a side turn while its thread is still opening never starts the turn', async () => {
  const rpc = new HeldRpc(new Set(['thread/start']))
  const { session } = fixture(rpc)
  const side = session.runSide('долгая задача')
  await until(() => rpc.methods().includes('thread/start'))
  expect(session.sideRunning).toBe(1)
  expect(await session.stopSide()).toBe(true)
  rpc.release('thread/start')
  expect((await side).status).toBe('interrupted')
  expect(rpc.methods()).not.toContain('turn/start')
  expect(session.sideRunning).toBe(0)
})

test('F2: a side stopped while turn/start is pending is interrupted as soon as Codex names the turn', async () => {
  const rpc = new HeldRpc(new Set(['turn/start']))
  const { session, complete } = fixture(rpc)
  const side = session.runSide('долгая задача')
  await until(() => rpc.methods().includes('turn/start'))
  expect(await session.stopSide()).toBe(true)
  rpc.release('turn/start')
  await until(() => rpc.methods().includes('turn/interrupt'))
  const threadId = String(turnStarts(rpc)[0]!.threadId)
  complete(threadId, 'turn-1')
  expect((await side).status).toBe('completed')
})

test('F1: an agent turn runs in workspace-write without approvals and the next owner turn restores the mode', async () => {
  const rpc = new HeldRpc()
  const { session, complete, cwd } = fixture(rpc)
  const agent = session.run('agent input', [], undefined, { untrusted: true })
  await until(() => turnStarts(rpc).length === 1)
  const thread = String(turnStarts(rpc)[0]!.threadId)
  expect(turnStarts(rpc)[0]).toMatchObject({ approvalPolicy: 'never' })
  expectFullWorkspaceWrite(turnStarts(rpc)[0]!.sandboxPolicy, cwd)
  complete(thread, 'turn-1')
  await agent
  const owner = session.run('owner input')
  await until(() => turnStarts(rpc).length === 2)
  expect(turnStarts(rpc)[1]).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' } })
  complete(thread, 'turn-2')
  await owner
  const plain = session.run('owner again')
  await until(() => turnStarts(rpc).length === 3)
  // Owner turns that do not follow an agent turn are unchanged.
  expect(turnStarts(rpc)[2]!.sandboxPolicy).toBeUndefined()
  expect(turnStarts(rpc)[2]!.approvalPolicy).toBeUndefined()
  complete(thread, 'turn-3')
  await plain
})

test('F1: an agent side turn is restricted and never reaches owner approvals, questions or chat actions', async () => {
  const rpc = new HeldRpc()
  const approvals: ApprovalRequest[] = []
  let chatActions = 0
  const { session, internals, complete, cwd } = fixture(rpc, {
    approve: async request => { approvals.push(request); return 'accept' },
    chatAction: async () => { chatActions++; return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true } },
  })
  const side = session.runSide('agent side', [], undefined, undefined, { untrusted: true })
  await until(() => turnStarts(rpc).length === 1)
  const start = turnStarts(rpc)[0]!
  expect(start).toMatchObject({ approvalPolicy: 'never' })
  expectFullWorkspaceWrite(start.sandboxPolicy, cwd)
  const threadId = String(start.threadId)
  await until(() => session.isUntrustedTurn(threadId, 'turn-1'))
  const command = await internals.requestApproval({ id: 1, method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId: 'turn-1', itemId: 'i1', command: 'ls', cwd: '/tmp' } })
  expect(command).toEqual({ decision: 'decline' })
  const tool = await internals.requestApproval({ id: 2, method: 'item/tool/call', params: {
    threadId, turnId: 'turn-1', callId: 'c1', namespace: null, tool: 'telegram_action', arguments: {} } })
  expect(tool).toBeUndefined()
  expect(approvals).toEqual([])
  expect(chatActions).toBe(0)
  complete(threadId, 'turn-1')
  expect((await side).status).toBe('completed')
})

test('[R42] a fresh guest side thread is opened without the client tools, an owner side one with them', async () => {
  const rpc = new HeldRpc()
  const { session, complete } = fixture(rpc, {
    chatAction: async () => ({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true }),
  })
  const sideStarts = () => rpc.calls.filter(call => call.method === 'thread/start').map(call => object(call.params))
  const guest = session.runSide('guest side', [], undefined, undefined, { untrusted: true })
  await until(() => turnStarts(rpc).length === 1)
  // No catalog at all: render_preview (and every other client tool) is never offered to a guest thread.
  expect(sideStarts()[0]).not.toHaveProperty('dynamicTools')
  complete(String(turnStarts(rpc)[0]!.threadId), 'turn-1')
  await guest
  const owner = session.runSide('owner side')
  await until(() => turnStarts(rpc).length === 2)
  const tools = sideStarts()[1]?.dynamicTools
  expect(Array.isArray(tools) ? tools.map(tool => object(tool).name) : tools).toContain('render_preview')
  complete(String(turnStarts(rpc)[1]!.threadId), 'turn-2')
  await owner
})

test('F1: in workspace-write mode the owner turn after an agent turn restores a full workspaceWrite policy', async () => {
  const rpc = new HeldRpc()
  const { session, complete, cwd } = fixture(rpc, { sandbox: 'workspace-write' })
  const agent = session.run('agent input', [], undefined, { untrusted: true })
  await until(() => turnStarts(rpc).length === 1)
  const thread = String(turnStarts(rpc)[0]!.threadId)
  complete(thread, 'turn-1')
  await agent
  const owner = session.run('owner input')
  await until(() => turnStarts(rpc).length === 2)
  expect(turnStarts(rpc)[1]).toMatchObject({ approvalPolicy: 'never' })
  expectFullWorkspaceWrite(turnStarts(rpc)[1]!.sandboxPolicy, cwd)
  complete(thread, 'turn-2')
  await owner
})

test('[R12][R13] a trusted Codex thread is offered the component tools and their calls reach the bridge by tool name', async () => {
  const rpc = new HeldRpc()
  const routed: unknown[] = []
  const { session, internals, complete } = fixture(rpc, {
    chatAction: async (_key, args, _current, tool) => {
      routed.push([tool, args])
      return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true }
    },
  })
  const run = session.run('покажи итоги')
  await until(() => turnStarts(rpc).length === 1)
  const start = rpc.calls.find(call => call.method === 'thread/start')!.params as { dynamicTools: Array<{ name: string }> }
  expect(start.dynamicTools.map(tool => tool.name))
    .toEqual(['telegram_action', 'send_component', 'update_component', 'component_schema', 'render_preview'])
  const threadId = String(turnStarts(rpc)[0]!.threadId)
  await until(() => session.steerableTurn === 'turn-1')
  const call = (tool: string, id: number) => internals.requestApproval({ id, method: 'item/tool/call', params: {
    threadId, turnId: 'turn-1', callId: 'c' + id, namespace: null, tool, arguments: { component: 'kpi' } } })
  expect(await call('component_schema', 1)).toEqual({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true })
  expect(await call('unknown_tool', 2)).toBeUndefined()
  expect(routed).toEqual([['component_schema', { component: 'kpi' }]])
  complete(threadId, 'turn-1')
  expect((await run).status).toBe('completed')
})

test('new owner and side threads omit send_component when widgets are unavailable', async () => {
  const rpc = new HeldRpc()
  const { session, complete } = fixture(rpc, {
    chatAction: async () => ({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true }),
    widgetsAvailable: () => false,
  })
  const owner = session.run('owner input')
  await until(() => turnStarts(rpc).length === 1)
  complete(String(turnStarts(rpc)[0]!.threadId), 'turn-1')
  await owner
  const side = session.runSide('side input')
  await until(() => turnStarts(rpc).length === 2)
  complete(String(turnStarts(rpc)[1]!.threadId), 'turn-2')
  await side
  const starts = rpc.calls.filter(call => call.method === 'thread/start')
  expect(starts).toHaveLength(2)
  for (const start of starts) {
    const tools = object(start.params).dynamicTools
    expect(Array.isArray(tools) ? tools.map(tool => object(tool).name) : tools)
      .toEqual(['telegram_action', 'update_component', 'component_schema', 'render_preview'])
  }
})
