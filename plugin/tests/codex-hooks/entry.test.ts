import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook, runMain } from '../../../codex-hooks/src/entry.js'
import { createGbrain } from '../../../codex-hooks/src/mcp.js'
import type { Runner } from '../../../codex-hooks/src/types.js'

let home = ''
let server: ReturnType<typeof Bun.serve> | undefined
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-hooks-entry-')) })
afterEach(() => { server?.stop(true); server = undefined; rmSync(home, { recursive: true, force: true }) })

const noProcess: Runner = () => ({ code: 1, stdout: '' })
const pre = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't',
  cwd: home, tool_name: 'Bash', tool_input: { command } })

test('[R17] unreadable PreToolUse input fails closed', async () => {
  const out = JSON.parse(await runHook('PreToolUse', 'not json', {}, home, noProcess))
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(await runHook('Stop', 'not json', {}, home, noProcess)).toBe('{}')
})

test('[R17] an unknown event is answered with an empty object and logged', async () => {
  expect(await runHook('Nope', '{}', {}, home, noProcess)).toBe('{}')
  expect(readFileSync(join(home, '.local', 'state', 'krotov-plugin', 'codex-hooks', 'hooks.log'), 'utf8')).toContain('unknown event Nope')
})

test('[R17] the config file cannot switch the safety guard off end to end', async () => {
  expect(JSON.parse(await runHook('PreToolUse', pre('sudo ls'), {}, home, noProcess)).hookSpecificOutput.permissionDecision).toBe('deny')
  const config = join(home, 'hooks-config.json')
  writeFileSync(config, JSON.stringify({ enabled: { safety: false, 'git-gate': false } }))
  expect(JSON.parse(await runHook('PreToolUse', pre('sudo ls'), { CODEX_HOOKS_CONFIG: config }, home, noProcess)).hookSpecificOutput.permissionDecision).toBe('deny')
})

interface Seen { path: string; auth: string | null; tool: string | undefined; args: unknown }

// A fake gbrain that answers every MCP path it serves and records which path and key each request used.
function fakeGbrain(seen: Seen[]) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: unknown } }
      seen.push({ path: new URL(request.url).pathname, auth: request.headers.get('authorization'), tool: body.params?.name,
        args: body.params?.arguments })
      if (body.id === undefined) return new Response(null, { status: 202 })
      const text = `${new URL(request.url).pathname}: оплата через ЮKassa`
      const result = body.method === 'tools/call' ? { content: [{ type: 'text', text }] } : {}
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
}

const promptInput = () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: home,
  prompt: 'Как мы подключали оплату?' })

test('[R17] each gbrain tool goes to its own server URL with the key file named in the switches file, and the key never reaches the output', async () => {
  const seen: Seen[] = []
  server = fakeGbrain(seen)
  const base = `http://127.0.0.1:${server.port}`
  const config = join(home, 'hooks-config.json')
  writeFileSync(config, JSON.stringify({ agent: 'agent-a', enabled: { 'session-sanity': false, 'active-briefs': false },
    gbrain: { urls: { swarm: `${base}/swarm/mcp`, tasks: `${base}/task/mcp`, recall: `${base}/recall/mcp` }, envFile: '~/keys/brain.env' } }))
  mkdirSync(join(home, 'keys'))
  writeFileSync(join(home, 'keys', 'brain.env'), 'GBRAIN_BEARER=key-from-file\n')
  const start = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', turn_id: 't', cwd: home, source: 'startup' })
  const opened = await runHook('SessionStart', start, { CODEX_HOOKS_CONFIG: config }, home, noProcess)
  expect(opened).toContain('/swarm/mcp: оплата')
  expect(opened).toContain('/task/mcp: оплата')
  const out = await runHook('UserPromptSubmit', promptInput(), { CODEX_HOOKS_CONFIG: config }, home, noProcess)
  expect(out).toContain('/recall/mcp: оплата через ЮKassa')
  expect(out).not.toContain('key-from-file')
  const called = seen.filter(request => request.tool).map(request => `${request.path} ${request.tool}`)
  expect(called).toEqual(['/swarm/mcp list_my_pending', '/task/mcp task_list', '/task/mcp agent_heartbeat', '/recall/mcp recall'])
  expect(seen.filter(request => request.tool === 'task_list').map(request => request.args)).toEqual([{ assignee: 'agent-a' }])
  expect(seen.every(request => request.auth === 'Bearer key-from-file')).toBe(true)
})

test('[R17] a server missing from the switchboard is found through config.toml', async () => {
  const seen: Seen[] = []
  server = fakeGbrain(seen)
  const config = join(home, 'hooks-config.json')
  writeFileSync(config, JSON.stringify({ agent: 'agent-a', gbrain: { tools: { recall: { server: 'brain', name: 'recall' } } } }))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.brain]\nurl = "http://127.0.0.1:${server.port}/brain/mcp"\n`)
  const out = await runHook('UserPromptSubmit', promptInput(), { CODEX_HOOKS_CONFIG: config, GBRAIN_BEARER: 'env-key' }, home, noProcess)
  expect(out).toContain('/brain/mcp: оплата через ЮKassa')
  expect(out).not.toContain('env-key')
  expect(seen.every(request => request.auth === 'Bearer env-key')).toBe(true)
})

const startInput = () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', turn_id: 't', cwd: home, source: 'startup' })
const hooksLog = () => readFileSync(join(home, '.local', 'state', 'krotov-plugin', 'codex-hooks', 'hooks.log'), 'utf8')
const tomlServers = (base: string) => ['swarm', 'tasks', 'recall'].map(name => `[mcp_servers.${name}]\nurl = "${base}/${name}/mcp"\n`).join('')

test('[R17] the default server names swarm, tasks and recall resolve through config.toml and the agent id comes from CODEX_HOOKS_AGENT_ID', async () => {
  const seen: Seen[] = []
  server = fakeGbrain(seen)
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), tomlServers(`http://127.0.0.1:${server.port}`))
  const env = { CODEX_HOOKS_AGENT_ID: 'agent-b', GBRAIN_BEARER: 'env-key' }
  const opened = await runHook('SessionStart', startInput(), env, home, noProcess)
  expect(opened).toContain('/swarm/mcp: оплата')
  await runHook('UserPromptSubmit', promptInput(), env, home, noProcess)
  const called = seen.filter(request => request.tool).map(request => `${request.path} ${request.tool} ${JSON.stringify(request.args)}`)
  expect(called).toEqual([
    '/swarm/mcp list_my_pending {}',
    '/tasks/mcp task_list {"assignee":"agent-b"}',
    '/tasks/mcp agent_heartbeat {"agent":"agent-b","status":"online"}',
    '/recall/mcp recall {"limit":5,"query":"Как мы подключали оплату?"}',
  ])
})

test('[R17] without an agent id the gbrain hooks make no request and log one line', async () => {
  const seen: Seen[] = []
  server = fakeGbrain(seen)
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), tomlServers(`http://127.0.0.1:${server.port}`))
  const out = await runHook('UserPromptSubmit', promptInput(), { GBRAIN_BEARER: 'env-key' }, home, noProcess)
  expect(out).not.toContain('оплата через')
  expect(seen).toEqual([])
  const lines = hooksLog().trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('MCP hooks skipped')
  expect(lines[0]).toContain('CODEX_HOOKS_AGENT_ID')
})

test('[R17] without any gbrain URL the gbrain hooks skip with one log line', async () => {
  const out = await runHook('SessionStart', startInput(), { CODEX_HOOKS_AGENT_ID: 'agent-b' }, home, noProcess)
  expect(out).not.toContain('Сервер MCP недоступен')
  const lines = hooksLog().trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('MCP hooks skipped')
  expect(lines[0]).toContain('mcp_servers')
})

test('[R17] a hook process crash reports its cause, denies PreToolUse with exit 2 and fails open elsewhere', async () => {
  const failure = 'ENOTDIR: could not open turns.json'
  const secret = 'fixture-secret-value'
  const crash = async () => { throw new Error(`${failure}; ${secret}`) }
  const pre = await runMain('PreToolUse', '{}', { HOME: home, TEST_TOKEN: secret }, noProcess, crash)
  expect(pre.code).toBe(2)
  const output = JSON.parse(pre.stdout).hookSpecificOutput
  expect(output.permissionDecision).toBe('deny')
  expect(output.permissionDecisionReason).toContain(failure)
  expect(pre.stdout).not.toContain(secret)
  expect(pre.stderr).toContain(failure)
  expect(pre.stderr).not.toContain(secret)
  const stop = await runMain('Stop', '{}', { HOME: home, TEST_TOKEN: secret }, noProcess, crash)
  expect(stop).toEqual({ stdout: '{}', code: 0, ...(pre.stderr === undefined ? {} : { stderr: pre.stderr }) })
  expect(await runMain('Stop', '{}', { HOME: home }, noProcess)).toEqual({ stdout: '{}', code: 0 })
})

async function expectHomeFailure(path: string) {
  const env = { HOME: path }
  const noRepo: Runner = () => ({ code: 128, stdout: '' })
  const result = await runMain('PreToolUse', pre('ls'), env, noRepo)
  expect(result.code).toBe(2)
  const output = JSON.parse(result.stdout).hookSpecificOutput
  expect(output.permissionDecision).toBe('deny')
  expect(output.permissionDecisionReason).toContain('HOME')
  expect(output.permissionDecisionReason).toContain(path)
  expect(output.permissionDecisionReason).not.toMatch(/[\r\n]/)
  expect(result.stderr).toContain('HOME')
  expect(result.stderr).toContain(path)

  const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: 's', turn_id: 't', cwd: home })
  expect(await runMain('Stop', stop, env, noRepo)).toEqual({ stdout: '{}', code: 0, ...(result.stderr === undefined ? {} : { stderr: result.stderr }) })
}

test('[R17] a missing HOME fails before hook dispatch', async () => {
  await expectHomeFailure(join(home, 'missing home'))
})

test('[R17] a regular-file HOME fails before hook dispatch', async () => {
  const file = join(home, 'home file')
  writeFileSync(file, '')
  await expectHomeFailure(file)
})

// Root can access a directory despite these mode bits.
test.skipIf(process.geteuid?.() === 0)('[R17] a HOME without read or search permission fails before hook dispatch', async () => {
  const directory = join(home, 'restricted home')
  mkdirSync(directory)
  try {
    chmodSync(directory, 0o400)
    await expectHomeFailure(directory)
    chmodSync(directory, 0o100)
    await expectHomeFailure(directory)
  } finally {
    chmodSync(directory, 0o700)
  }
})

test('[R17] the bearer is never sent over plain http to a non-loopback host', async () => {
  const client = createGbrain('http://mcp.example.com/mcp', 'secret-key', 500)
  await expect(client.call('recall', {})).rejects.toThrow(/https/)
})
