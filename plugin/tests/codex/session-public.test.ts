import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexEvent, CodexServerRequest, Json } from '../../src/codex/rpc.js'
import { CodexSession, type ApprovalRequest } from '../../src/codex/session.js'
import { PUBLIC_THREAD_CONFIG } from '../../src/codex/public-profile.js'

const dirs: string[] = []
const sessions: CodexSession[] = []

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Call = { method: string; params: Json }

class FakeRpc {
  readonly calls: Call[] = []
  private turns = 0
  failResume = false
  appsFail = false
  skillsReply: Json = { data: [] }
  mcpPages: Array<{ data: Json[]; nextCursor: string | null }> = [{ data: [{ name: 'probe', runtimeStatus: 'disabled' }], nextCursor: null }]
  async initialize(): Promise<void> {}
  request(method: string, params: Json): Promise<Json> {
    this.calls.push({ method, params })
    if (method === 'thread/resume' && this.failResume) return Promise.reject(new Error('no such thread'))
    if (method === 'account/read') return Promise.resolve({ account: { type: 'chatgpt' } })
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-' + this.calls.length }, model: 'gpt-test' })
    if (method === 'thread/resume') return Promise.resolve({ thread: { id: (params as { threadId: string }).threadId } })
    if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-' + ++this.turns } })
    if (method === 'mcpServerStatus/list') {
      const cursor = (params as { cursor?: string }).cursor
      const page = this.mcpPages[cursor ? Number(cursor) : 0]
      return page ? Promise.resolve(page) : Promise.reject(new Error('bad cursor'))
    }
    if (method === 'skills/list') return Promise.resolve(this.skillsReply)
    if (method === 'config/read') return Promise.resolve({ config: { features: { multi_agent: false } } })
    if (method === 'app/list') {
      return this.appsFail ? Promise.reject(new Error('Codex rejected the request')) : Promise.resolve({ data: [], nextCursor: null })
    }
    return Promise.resolve({})
  }
  of(method: string): Record<string, unknown>[] {
    return this.calls.filter(call => call.method === method).map(call => call.params as Record<string, unknown>)
  }
  close(): void {}
}

interface SessionInternals {
  rpc: { close(): void }
  receive(event: CodexEvent): void
  requestApproval(request: CodexServerRequest): Promise<Json | undefined>
}

function fixture(rpc: FakeRpc, extra: {
  publicWebSearch?: 'disabled' | 'live'; publicAllow?: { mcp: string[]; skills: string[]; home: string }
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-public-'))
  dirs.push(cwd)
  const approvals: ApprovalRequest[] = []
  let chatActions = 0
  const session = new CodexSession({
    cwd, stateFile: join(cwd, 'thread.json'), env: process.env, sandbox: 'danger-full-access',
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    approve: async request => { approvals.push(request); return 'accept' },
    ask: async () => ({ q: { answers: ['yes'] } }),
    chatAction: async () => { chatActions++; return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true } },
    ...extra,
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
  const publicDir = mkdtempSync(join(tmpdir(), 'krot-public-chat-'))
  dirs.push(publicDir)
  return { session, internals, complete, cwd, publicDir, approvals, chats: () => chatActions }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

test('S3: a public thread starts with the no-shell read-only profile in its own folder, never a fork', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  const run = session.runPublic('привет', { cwd: publicDir, instructions: 'role block' })
  await until(() => rpc.of('turn/start').length === 1)
  expect(rpc.of('thread/fork')).toEqual([])
  const start = rpc.of('thread/start')[0]!
  expect(start).toMatchObject({ cwd: publicDir, sandbox: 'read-only', approvalPolicy: 'never' })
  expect(start.dynamicTools).toBeUndefined()
  const config = start.config as Record<string, unknown>
  expect(config['features.shell_tool']).toBe(false)
  expect(config['features.unified_exec']).toBe(false)
  // An empty mcp_servers merges into config.toml (live 0.172): isolation is the public CODEX_HOME.
  expect(config.mcp_servers).toBeUndefined()
  // The owner's developer instructions are replaced by the role block.
  expect(config.developer_instructions).toBe('role block')
  expect(config).toEqual(expect.objectContaining(PUBLIC_THREAD_CONFIG))
  const turn = rpc.of('turn/start')[0]!
  expect(turn).toMatchObject({ approvalPolicy: 'never', cwd: publicDir, sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  const threadId = String(turn.threadId)
  expect(session.currentThread).not.toBe(threadId)
  expect(session.threadRole(threadId)).toBe('public')
  complete(threadId, 'turn-1', 'ответ')
  expect(await run).toMatchObject({ status: 'completed', text: 'ответ', threadId, toolItems: 0 })
})

test('S3: a public turn declines approvals, questions and chat actions', async () => {
  const rpc = new FakeRpc()
  const { session, internals, complete, publicDir, approvals, chats } = fixture(rpc)
  const run = session.runPublic('сделай', { cwd: publicDir, instructions: 'x' })
  await until(() => rpc.of('turn/start').length === 1)
  const threadId = String(rpc.of('turn/start')[0]!.threadId)
  expect(await internals.requestApproval({ id: 1, method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId: 'turn-1', itemId: 'i1', command: 'id', cwd: publicDir } })).toEqual({ decision: 'decline' })
  expect(await internals.requestApproval({ id: 2, method: 'item/tool/call', params: {
    threadId, turnId: 'turn-1', callId: 'c1', namespace: null, tool: 'telegram_action', arguments: {} } })).toBeUndefined()
  expect(await internals.requestApproval({ id: 3, method: 'item/tool/requestUserInput', params: {
    threadId, turnId: 'turn-1', questions: [] } })).toEqual({ answers: {} })
  expect(await session.requestPolicyApproval({ kind: 'command', target: 'id', cwd: publicDir,
    operation: { threadId, turnId: 'turn-1', itemId: 'i1' } })).toBe('decline')
  expect(approvals).toEqual([])
  expect(chats()).toBe(0)
  internals.receive({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'c' } } })
  complete(threadId, 'turn-1')
  expect((await run).toolItems).toBe(1)
})

test('S3: a policy request from a public thread whose turn already ended never reaches the owner', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir, approvals } = fixture(rpc)
  const run = session.runPublic('a', { cwd: publicDir, instructions: 'x' })
  await until(() => rpc.of('turn/start').length === 1)
  const threadId = String(rpc.of('turn/start')[0]!.threadId)
  complete(threadId, 'turn-1')
  await run
  expect(await session.requestPolicyApproval({ kind: 'command', target: 'id', cwd: publicDir,
    operation: { threadId, turnId: 'turn-1', itemId: 'i1' } })).toBe('decline')
  expect(approvals).toEqual([])
})

test('S4 R3: a public turn cancelled while its thread opens never reaches turn/start', async () => {
  const rpc = new FakeRpc()
  const { session, publicDir } = fixture(rpc)
  let cancelled = false
  const run = session.runPublic('a', {
    cwd: publicDir, instructions: 'x', threadId: 'saved-1',
    // Revoked while thread/resume was in flight: true by the time the turn would start.
    onThread: () => { cancelled = true },
    cancelled: () => cancelled,
  })
  await until(() => rpc.of('thread/resume').length === 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(rpc.of('turn/start')).toEqual([])
  expect(await run).toMatchObject({ status: 'interrupted', text: '', threadId: 'saved-1', toolItems: 0 })
})

test('S3: a saved public thread is resumed with the same profile; a lost one starts fresh', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  const first = session.runPublic('a', { cwd: publicDir, instructions: 'x', threadId: 'saved-1' })
  await until(() => rpc.of('turn/start').length === 1)
  expect(rpc.of('thread/resume')[0]).toMatchObject({ threadId: 'saved-1', sandbox: 'read-only', approvalPolicy: 'never', cwd: publicDir })
  expect(rpc.of('thread/resume')[0]!.config).toEqual(expect.objectContaining(PUBLIC_THREAD_CONFIG))
  complete('saved-1', 'turn-1')
  expect((await first).threadId).toBe('saved-1')
  rpc.failResume = true
  const second = session.runPublic('b', { cwd: publicDir, instructions: 'x', threadId: 'gone' })
  await until(() => rpc.of('turn/start').length === 2)
  const threadId = String(rpc.of('turn/start')[1]!.threadId)
  expect(threadId).not.toBe('gone')
  complete(threadId, 'turn-2')
  expect((await second).threadId).toBe(threadId)
})

test('S4: the startup probe opens one ephemeral public thread and reads what it can reach', async () => {
  const rpc = new FakeRpc()
  const { session, publicDir } = fixture(rpc)
  const probe = await session.probePublicProfile(publicDir)
  expect(probe.reply.thread).toBeDefined()
  const start = rpc.of('thread/start')[0]!
  expect(start).toMatchObject({ cwd: publicDir, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
  expect(start.config).toEqual(expect.objectContaining(PUBLIC_THREAD_CONFIG))
  expect(rpc.of('turn/start')).toEqual([])
  const threadId = String((probe.reply.thread as { id: string }).id)
  expect(session.threadRole(threadId)).toBe('public')
  expect(rpc.of('mcpServerStatus/list')).toEqual([{ threadId }])
  expect(rpc.of('skills/list')).toEqual([{ cwds: [publicDir], forceReload: true }])
  expect(rpc.of('app/list')).toEqual([{ threadId }])
  // The effective config of the public home: the probe checks its features (subagents, tools) are off.
  expect(rpc.of('config/read')).toEqual([{ cwd: publicDir, includeLayers: false }])
  expect(probe.config).toEqual({ config: { features: { multi_agent: false } } })
  expect(probe.mcp).toEqual({ data: [{ name: 'probe', runtimeStatus: 'disabled' }], nextCursor: null })
  expect(probe.skills).toEqual({ data: [] })
  expect(probe.apps).toEqual({ data: [], nextCursor: null })
})

test('S4: the probe follows mcpServerStatus/list nextCursor and joins every page', async () => {
  const rpc = new FakeRpc()
  const entry = { authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [] }
  rpc.mcpPages = [
    { data: [{ name: 'docs', ...entry }], nextCursor: '1' },
    { data: [{ name: 'kbase', ...entry, runtimeStatus: 'connected' }], nextCursor: null },
  ]
  const { session, publicDir } = fixture(rpc)
  const probe = await session.probePublicProfile(publicDir)
  const threadId = String((probe.reply.thread as { id: string }).id)
  expect(rpc.of('mcpServerStatus/list')).toEqual([{ threadId }, { threadId, cursor: '1' }])
  expect((probe.mcp.data as Array<{ name: string }>).map(server => server.name)).toEqual(['docs', 'kbase'])
  expect(probe.mcp.nextCursor).toBeNull()
})

test('S4: a refused later mcpServerStatus/list page leaves no list at all, never a partial one', async () => {
  const rpc = new FakeRpc()
  rpc.mcpPages = [{ data: [], nextCursor: '7' }]
  const { session, publicDir } = fixture(rpc)
  const probe = await session.probePublicProfile(publicDir)
  expect(rpc.of('mcpServerStatus/list').length).toBe(2)
  expect(probe.mcp).toEqual({})
})

test('S4: a fresh public thread whose folder shows skills outside the allowlist never gets a turn', async () => {
  const rpc = new FakeRpc()
  const { session, publicDir } = fixture(rpc, { publicAllow: { mcp: [], skills: ['faq'], home: '/state/codex-public/member' } })
  rpc.skillsReply = { data: [{ cwd: publicDir, errors: [], skills: [
    { name: 'faq', enabled: true, scope: 'repo', path: join(publicDir, '.agents', 'skills', 'faq', 'SKILL.md') },
  ] }] }
  // Raced against a timer: without the check the turn would start and wait for Codex forever.
  const refused = Promise.race([
    session.runPublic('a', { cwd: publicDir, instructions: 'x' }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the turn was started')), 1000)),
  ])
  await expect(refused).rejects.toThrow('faq')
  expect(rpc.of('skills/list')).toEqual([{ cwds: [publicDir], forceReload: true }])
  expect(rpc.of('turn/start')).toEqual([])
  // The same thread passes once its skills are exactly the home's copies.
  rpc.skillsReply = { data: [{ cwd: publicDir, errors: [], skills: [
    { name: 'faq', enabled: true, scope: 'user', path: '/state/codex-public/member/skills/faq/SKILL.md' },
  ] }] }
  const run = session.runPublic('b', { cwd: publicDir, instructions: 'x' })
  await until(() => rpc.of('turn/start').length === 1)
  void run
})

test('S4: a refused app/list leaves the probe without an apps answer (the check then fails closed)', async () => {
  const rpc = new FakeRpc()
  rpc.appsFail = true
  const { session, publicDir } = fixture(rpc)
  expect((await session.probePublicProfile(publicDir)).apps).toBeUndefined()
})

test('S4: web search per public thread: disabled by default, live only when the session is set to live', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  await session.probePublicProfile(publicDir)
  const run = session.runPublic('a', { cwd: publicDir, instructions: 'x' })
  await until(() => rpc.of('turn/start').length === 1)
  expect(rpc.of('thread/start').length).toBe(2)
  for (const start of rpc.of('thread/start')) expect((start.config as Record<string, unknown>).web_search).toBe('disabled')
  complete(String(rpc.of('turn/start')[0]!.threadId), 'turn-1')
  await run

  const liveRpc = new FakeRpc()
  const live = fixture(liveRpc, { publicWebSearch: 'live' })
  const liveRun = live.session.runPublic('a', { cwd: live.publicDir, instructions: 'x', threadId: 'saved-1' })
  await until(() => liveRpc.of('turn/start').length === 1)
  expect((liveRpc.of('thread/resume')[0]!.config as Record<string, unknown>).web_search).toBe('live')
  live.complete('saved-1', 'turn-1')
  await liveRun
})

test('S4: the public profile config no longer pretends an empty mcp_servers keeps servers out', () => {
  expect('mcp_servers' in PUBLIC_THREAD_CONFIG).toBe(false)
})

test('S4: thread roles: main is owner, public is public, an unseen thread is unknown', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  const owner = session.run('owner')
  await until(() => rpc.of('turn/start').length === 1)
  const main = String(rpc.of('turn/start')[0]!.threadId)
  expect(session.threadRole(main)).toBe('owner')
  const run = session.runPublic('a', { cwd: publicDir, instructions: 'x' })
  await until(() => rpc.of('turn/start').length === 2)
  const pub = String(rpc.of('turn/start')[1]!.threadId)
  // A public thread that starts while the owner turn runs is never taken for its subagent.
  const internals = session as unknown as SessionInternals
  internals.receive({ method: 'turn/started', params: { threadId: pub, turn: { id: 'turn-2' } } })
  expect(session.threadRole(pub)).toBe('public')
  complete(main, 'turn-1')
  await owner
  expect(session.threadRole('never-seen')).toBe('unknown')
  complete(pub, 'turn-2')
  await run
  expect(session.threadRole(pub)).toBe('public')
})

test('S4 R4: the hook proof turn runs once on a fresh ephemeral read-only thread with only the shell tool on', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  let opened: string | undefined
  const run = session.runHookProof(publicDir, 'run true', id => { opened = id }, () => {})
  await until(() => rpc.of('turn/start').length === 1)
  const start = rpc.of('thread/start')[0]!
  expect(start).toMatchObject({ cwd: publicDir, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
  const config = start.config as Record<string, unknown>
  expect(config['features.shell_tool']).toBe(true)
  // Everything else of the public profile stays off.
  for (const [key, value] of Object.entries(PUBLIC_THREAD_CONFIG)) {
    if (key !== 'features.shell_tool') expect(config[key]).toBe(value)
  }
  expect(config.web_search).toBe('disabled')
  const turn = rpc.of('turn/start')[0]!
  expect(turn).toMatchObject({ approvalPolicy: 'never', cwd: publicDir, sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  const threadId = String(turn.threadId)
  expect(opened).toBe(threadId)
  complete(threadId, 'turn-1', 'ok')
  expect(await run).toMatchObject({ status: 'completed', threadId })
  // The proof thread is never offered again as a public chat thread.
  const next = session.runPublic('hi', { cwd: publicDir, instructions: 'x', threadId })
  await until(() => rpc.of('turn/start').length === 2)
  expect(rpc.of('thread/resume')).toEqual([])
  expect(rpc.of('thread/start').length).toBe(2)
  expect(String(rpc.of('turn/start')[1]!.threadId)).not.toBe(threadId)
  complete(String(rpc.of('turn/start')[1]!.threadId), 'turn-2')
  await next
})

test('S4 R4: the hook proof turn reports every executed or ambiguous command item, never a declined one', async () => {
  const rpc = new FakeRpc()
  const { session, complete, publicDir } = fixture(rpc)
  const internals = session as unknown as SessionInternals
  let ran = 0
  const run = session.runHookProof(publicDir, 'run true', () => {}, () => { ran++ })
  await until(() => rpc.of('turn/start').length === 1)
  const threadId = String(rpc.of('turn/start')[0]!.threadId)
  const item = (fields: Record<string, unknown>) => internals.receive({ method: 'item/completed', params: { threadId, turnId: 'turn-1',
    item: { type: 'commandExecution', id: 'cmd-' + JSON.stringify(fields), command: 'true', ...fields } } })
  // Declined without an exit code: the hook (or Codex) stopped it before it ran.
  item({ status: 'declined', exitCode: null })
  item({ status: 'declined' })
  expect(ran).toBe(0)
  // Any numeric exit code means a process ran, whatever the status says.
  item({ status: 'failed', exitCode: 1 })
  item({ status: 'declined', exitCode: 127 })
  item({ status: 'completed', exitCode: 0 })
  expect(ran).toBe(3)
  // Ambiguous results fail closed: completed or failed without an exit code, an unknown or missing status.
  item({ status: 'completed' })
  item({ status: 'failed' })
  item({ status: 'inProgress' })
  item({})
  expect(ran).toBe(7)
  complete(threadId, 'turn-1', 'DONE')
  await run
})
