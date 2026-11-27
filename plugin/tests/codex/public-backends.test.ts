import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { doctorPublicRoles, provePublicHooks, startPublicBackends } from '../../src/codex/public-backends.js'
import { HookDenials } from '../../src/codex/multiuser-readiness.js'
import type { PreparedHome, PublicRole } from '../../src/codex/public-home.js'
import { NO_SHELL, PUBLIC_FEATURES_OFF } from '../../src/codex/public-profile.js'
import type { PublicProbe, PublicTurnProfile } from '../../src/codex/session.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

class FakePublicSession {
  readonly runs: string[] = []
  proofs = 0
  leak = false
  hookDenies = true
  proofStatus: 'completed' | 'interrupted' | 'failed' = 'completed'
  answer = NO_SHELL
  constructor(readonly role: PublicRole, readonly denials: HookDenials) {}
  async runHookProof(_cwd: string, _prompt: string, onThread: (id: string) => void) {
    const threadId = 'proof-' + this.role + '-' + ++this.proofs
    onThread(threadId)
    if (this.hookDenies) this.denials.record(threadId)
    return { status: this.proofStatus, text: 'ok', threadId, toolItems: 1 }
  }
  async initialize(): Promise<void> {}
  async probePublicProfile(cwd: string): Promise<PublicProbe> {
    return {
      reply: { thread: { id: 'probe-' + this.role }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', cwd },
      mcp: { data: this.leak ? [{ name: 'kbase', runtimeStatus: 'connected' }] : [], nextCursor: null },
      skills: { data: [{ cwd, errors: [], skills: [] }] },
      apps: { data: [], nextCursor: null },
      config: { config: { features: { ...Object.fromEntries(PUBLIC_FEATURES_OFF.map(name => [name, false])), hooks: true } } },
    }
  }
  async runPublic(text: string, profile: PublicTurnProfile) {
    this.runs.push(text)
    return { status: 'completed' as const, text: this.answer, threadId: this.role + '-' + this.runs.length, toolItems: 0, cwd: profile.cwd }
  }
  async stopPublic(): Promise<boolean> { return false }
}

function setup(leakRole?: PublicRole, root = mkdtempSync(join(tmpdir(), 'krot-public-backends-'))) {
  dirs.push(root)
  const sessions: FakePublicSession[] = []
  const exits = new Map<PublicRole, () => void>()
  const denials = new HookDenials()
  const hashes: Record<PublicRole, string> = { member: 'hash-member', guest: 'hash-guest' }
  const prepared = (role: PublicRole): PreparedHome =>
    ({ role, home: join(root, 'codex-public', role), skills: [], mcp: [], webSearch: false, configHash: hashes[role] })
  const begin = () => startPublicBackends({
    roles: ['member', 'guest'], prepare: prepared, probeCwd: join(root, '_probe'), stopping: () => false,
    proofFile: role => join(root, 'codex-public', role + '.hook-proof.json'),
    createSession: (role, _home, onExit) => {
      const session = new FakePublicSession(role, denials)
      session.leak = role === leakRole
      sessions.push(session)
      exits.set(role, onExit)
      return session
    },
  })
  const prove = (roles: Awaited<ReturnType<typeof begin>>['roles']) =>
    provePublicHooks(roles, { denials, probeCwd: join(root, '_probe'), timeoutMs: 1000 })
  // Startup as server.ts runs it: start, then the hook proof once the thread-role endpoint listens.
  const start = async () => {
    const started = await begin()
    await prove(started.roles)
    return started
  }
  return { root, sessions, exits, start, begin, prove, hashes }
}

test('S4 startup: a public role whose probe fails stops multi-user mode from starting', async () => {
  const { start } = setup('guest')
  await expect(start()).rejects.toThrow('Multi-user mode cannot start (guest)')
})

test('S4 startup: the router runs each role on that role\'s own public session, never another', async () => {
  const { start, sessions } = setup()
  const { router, roles } = await start()
  expect(roles.map(role => role.role)).toEqual(['member', 'guest'])
  const guest = await router.runPublic('hi', { cwd: '/p', instructions: 'x', role: 'guest' })
  expect(guest.threadId).toBe('guest-1')
  expect(sessions.find(session => session.role === 'guest')!.runs).toEqual(['hi'])
  expect(sessions.find(session => session.role === 'member')!.runs).toEqual([])
})

test('S4 doctor: a role whose probe fails is quarantined, gets no canary, and its messages are unavailable', async () => {
  const { start, sessions, root } = setup()
  const { router, roles } = await start()
  const guest = sessions.find(session => session.role === 'guest')!
  guest.leak = true
  const report = await doctorPublicRoles(roles, { probeCwd: join(root, '_probe'), canaryDir: join(root, '_canary'), canaryTimeoutMs: 1000 })
  expect(report.problems.map(problem => problem.text).join('\n')).toContain('kbase')
  // No canary turn ran on the failed role; the member still got one.
  expect(guest.runs).toEqual([])
  expect(sessions.find(session => session.role === 'member')!.runs.length).toBe(1)
  expect(roles.find(role => role.role === 'guest')!.alive()).toBe(false)
  await expect(router.runPublic('hi', { cwd: '/p', instructions: 'x', role: 'guest' })).rejects.toThrow('not running')
  expect(roles.find(role => role.role === 'member')!.alive()).toBe(true)
})

test('S4 doctor: a failed canary quarantines the role too; an exited app-server is reported, not probed', async () => {
  const { start, sessions, exits, root } = setup()
  const { roles } = await start()
  sessions.find(session => session.role === 'member')!.answer = 'uid=1000(openclaw)'
  exits.get('guest')!()
  const report = await doctorPublicRoles(roles, { probeCwd: join(root, '_probe'), canaryDir: join(root, '_canary'), canaryTimeoutMs: 1000 })
  expect(roles.find(role => role.role === 'member')!.alive()).toBe(false)
  expect(report.problems.length).toBe(2)
  expect(sessions.find(session => session.role === 'guest')!.runs).toEqual([])
})

test('S4 R4: a role stays disabled until its hook proof passes; a failed proof quarantines it and is not cached', async () => {
  const { begin, prove, sessions, root } = setup()
  const { roles, router } = await begin()
  // Before the proof no role takes messages.
  expect(roles.map(role => role.alive())).toEqual([false, false])
  await expect(router.runPublic('hi', { cwd: '/p', instructions: 'x', role: 'member' })).rejects.toThrow('not running')
  sessions.find(session => session.role === 'guest')!.hookDenies = false
  const problems = await prove(roles)
  expect(problems.join('\n')).toContain('guest')
  expect(roles.find(role => role.role === 'member')!.alive()).toBe(true)
  expect(roles.find(role => role.role === 'guest')!.alive()).toBe(false)
  expect(existsSync(join(root, 'codex-public', 'member.hook-proof.json'))).toBe(true)
  expect(existsSync(join(root, 'codex-public', 'guest.hook-proof.json'))).toBe(false)
})

test('S4 R4: a hook proof whose turn did not complete is not cached, even with a denial seen', async () => {
  const { begin, prove, sessions, root } = setup()
  const { roles } = await begin()
  sessions.find(session => session.role === 'member')!.proofStatus = 'interrupted'
  sessions.find(session => session.role === 'guest')!.proofStatus = 'failed'
  const problems = await prove(roles)
  expect(problems.length).toBe(2)
  expect(roles.map(role => role.alive())).toEqual([false, false])
  expect(existsSync(join(root, 'codex-public', 'member.hook-proof.json'))).toBe(false)
  expect(existsSync(join(root, 'codex-public', 'guest.hook-proof.json'))).toBe(false)
})

test('S4 R4: a passed hook proof is reused for the same home and redone when the home changes', async () => {
  const first = setup()
  await first.start()
  const again = setup(undefined, first.root)
  const { roles } = await again.begin()
  // Same home hash: enabled at once, no proof turn.
  expect(roles.map(role => role.alive())).toEqual([true, true])
  await again.prove(roles)
  expect(again.sessions.map(session => session.proofs)).toEqual([0, 0])
  const changed = setup(undefined, first.root)
  changed.hashes.guest = 'hash-guest-rebuilt'
  const next = await changed.begin()
  expect(next.roles.map(role => role.alive())).toEqual([true, false])
  await changed.prove(next.roles)
  expect(changed.sessions.map(session => session.proofs)).toEqual([0, 1])
  expect(next.roles.map(role => role.alive())).toEqual([true, true])
})
