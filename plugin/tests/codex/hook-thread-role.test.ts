import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startExternalTasks } from '../../src/codex/external.js'
import { threadToolAccess } from '../../src/codex/thread-role.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const hook = join(import.meta.dir, '..', '..', 'scripts', 'codex-permission-hook.ts')
const token = 'p'.repeat(40)

function files(): { policy: string; tokenFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'krot-hook-role-'))
  dirs.push(dir)
  const policy = join(dir, 'policy.yaml')
  const tokenFile = join(dir, 'token')
  writeFileSync(policy, 'version: 1\ndefault_tier: allow\n')
  writeFileSync(tokenFile, token + '\n')
  return { policy, tokenFile }
}

async function runHook(args: string[], input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, hook, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  child.stdin.write(JSON.stringify(input))
  await child.stdin.end()
  const out = await new Response(child.stdout).text()
  await child.exited
  return JSON.parse(out) as Record<string, unknown>
}

const call = (tool: string, threadId: string) => ({
  hook_event_name: 'PreToolUse', tool_name: tool, session_id: threadId, turn_id: 't1', tool_use_id: 'u1', cwd: '/tmp',
  tool_input: tool === 'Bash' ? { command: 'id' } : { command: '*** Begin Patch\n*** Add File: /tmp/a\n+x\n*** End Patch' },
})

function denied(output: Record<string, unknown>): boolean {
  return (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny'
}

test('S4: only owner and agent threads may use tools while multi-user is on', () => {
  expect(threadToolAccess('owner', true)).toBe(true)
  expect(threadToolAccess('agent', true)).toBe(true)
  expect(threadToolAccess('public', true)).toBe(false)
  expect(threadToolAccess('unknown', true)).toBe(false)
  // Flag off: the bridge has no public threads, the hook stays as before.
  expect(threadToolAccess('unknown', false)).toBe(true)
  expect(threadToolAccess('public', false)).toBe(false)
})

test('S4: the bridge answers a thread role on loopback behind the policy token only', async () => {
  const server = await startExternalTasks(0, 'tasks-only', '123', () => { throw Error('Unexpected queued task') }, {
    token, request: async () => 'decline',
    threadRole: id => id === 'pub' ? 'public' : id === 'main' ? 'owner' : 'unknown', multiuser: true,
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const ask = (secret: string, body: unknown) => fetch('http://127.0.0.1:' + address.port + '/hooks/thread-role', {
      method: 'POST', headers: { authorization: 'Bearer ' + secret }, body: JSON.stringify(body) })
    expect((await ask('tasks-only', { thread_id: 'pub' })).status).toBe(401)
    expect((await ask(token, { thread_id: '' })).status).toBe(400)
    expect(await (await ask(token, { thread_id: 'pub' })).json()).toEqual({ role: 'public', allow: false })
    expect(await (await ask(token, { thread_id: 'main' })).json()).toEqual({ role: 'owner', allow: true })
    expect(await (await ask(token, { thread_id: 'x' })).json()).toEqual({ role: 'unknown', allow: false })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})

test('R3: the thread-role endpoint awaits an asynchronous lookup (an owner subagent verified by thread/read)', async () => {
  const server = await startExternalTasks(0, 'tasks-only', '123', () => { throw Error('Unexpected queued task') }, {
    token, request: async () => 'decline',
    threadRole: async id => id === 'late-child' ? 'owner' : 'unknown', multiuser: true,
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const ask = (body: unknown) => fetch('http://127.0.0.1:' + address.port + '/hooks/thread-role', {
      method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
    expect(await (await ask({ thread_id: 'late-child' })).json()).toEqual({ role: 'owner', allow: true })
    expect(await (await ask({ thread_id: 'pub' })).json()).toEqual({ role: 'unknown', allow: false })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})

test('S4: with --thread-role the hook denies every tool of a public thread and allows the owner', async () => {
  const { policy, tokenFile } = files()
  const server = await startExternalTasks(0, 'tasks-only', '123', () => { throw Error('Unexpected queued task') }, {
    token, request: async () => 'decline',
    threadRole: id => id === 'pub' ? 'public' : 'owner', multiuser: true,
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const args = [policy, String(address.port), tokenFile, 'main', '--thread-role']
    expect(denied(await runHook(args, call('Bash', 'pub')))).toBe(true)
    expect(denied(await runHook(args, call('apply_patch', 'pub')))).toBe(true)
    expect(denied(await runHook(args, { ...call('Bash', 'pub'), tool_name: 'mcp__kbase__search', tool_input: {} }))).toBe(true)
    expect(denied(await runHook(args, call('Bash', 'main')))).toBe(false)
    // No session ID: nothing to vouch for the thread.
    expect(denied(await runHook(args, { ...call('Bash', 'main'), session_id: undefined }))).toBe(true)
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})

test('S4: with --thread-role an unreachable bridge means deny; without it the hook is unchanged', async () => {
  const { policy, tokenFile } = files()
  // Port 9 (discard) on loopback: nothing listens there in tests.
  expect(denied(await runHook([policy, '9', tokenFile, '--thread-role'], call('Bash', 'main')))).toBe(true)
  expect(denied(await runHook([policy, '9', tokenFile], call('Bash', 'main')))).toBe(false)
})

test('S4 R4: the bridge reports every thread-role denial it answers, never an allow (the startup hook proof reads it)', async () => {
  const denials: string[] = []
  const server = await startExternalTasks(0, 'tasks-only', '123', () => { throw Error('Unexpected queued task') }, {
    token, request: async () => 'decline', onDenied: id => denials.push(id),
    threadRole: id => id === 'pub' ? 'public' : id === 'main' ? 'owner' : 'unknown', multiuser: true,
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const ask = (body: unknown) => fetch('http://127.0.0.1:' + address.port + '/hooks/thread-role', {
      method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
    await ask({ thread_id: 'pub' })
    await ask({ thread_id: 'main' })
    await ask({ thread_id: 'x' })
    expect(denials).toEqual(['pub', 'x'])
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})
