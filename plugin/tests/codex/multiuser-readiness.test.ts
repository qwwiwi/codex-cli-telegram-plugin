import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CANARY_PROMPT, checkPublicProfile, HookDenials, multiuserProblems, proveHookDenial, publicCapabilitiesProblem, publicFeaturesProblem,
  publicProfileProblem, runPublicCanary,
} from '../../src/codex/multiuser-readiness.js'
import { PUBLIC_FEATURES_OFF } from '../../src/codex/public-profile.js'
import { formatDoctorReport } from '../../src/codex/doctor-command.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(hookLine = 'command = ["/usr/bin/bun", "/opt/codex-permission-hook.js", "/opt/p.yaml", "8092", "/opt/t", "--thread-role"]') {
  const base = mkdtempSync(join(tmpdir(), 'krot-ready-'))
  dirs.push(base)
  const workspace = join(base, 'work')
  const state = join(base, 'state')
  const codexHome = join(base, 'codex')
  for (const dir of [workspace, state, codexHome]) mkdirSync(dir)
  writeFileSync(join(codexHome, 'config.toml'), '[hooks]\n' + hookLine + '\n')
  const env: Record<string, string | undefined> = {
    KROT_PUBLIC_WORKSPACE_ROOT: join(base, 'public'),
    KROT_CODEX_POLICY_TOKEN: 'p'.repeat(40), TELEGRAM_WEBHOOK_TOKEN: 'w'.repeat(40), TELEGRAM_WEBHOOK_PORT: '8092',
    CODEX_HOME: codexHome,
  }
  return { base, workspace, state, env }
}

test('S4 startup: a complete multi-user setup has no problems', () => {
  const { workspace, state, env } = setup()
  expect(multiuserProblems({ env, workspace, stateRoot: state })).toEqual([])
})

test('S4 startup: each missing piece of the public profile is a problem (fail closed)', () => {
  const { base, workspace, state, env } = setup()
  const problems = (overrides: Record<string, string | undefined>) =>
    multiuserProblems({ env: { ...env, ...overrides }, workspace, stateRoot: state })
  expect(problems({ KROT_PUBLIC_WORKSPACE_ROOT: undefined })[0]).toContain('KROT_PUBLIC_WORKSPACE_ROOT')
  expect(problems({ KROT_PUBLIC_WORKSPACE_ROOT: 'relative/dir' })[0]).toContain('KROT_PUBLIC_WORKSPACE_ROOT')
  expect(problems({ KROT_PUBLIC_WORKSPACE_ROOT: join(workspace, 'pub') })[0]).toContain('KROT_PUBLIC_WORKSPACE_ROOT')
  expect(problems({ KROT_PUBLIC_WORKSPACE_ROOT: join(state, 'pub') })[0]).toContain('KROT_PUBLIC_WORKSPACE_ROOT')
  // A root that contains the owner workspace would expose it to public threads.
  expect(problems({ KROT_PUBLIC_WORKSPACE_ROOT: base })[0]).toContain('KROT_PUBLIC_WORKSPACE_ROOT')
  expect(problems({ KROT_CODEX_POLICY_TOKEN: undefined })[0]).toContain('KROT_CODEX_POLICY_TOKEN')
  expect(problems({ KROT_CODEX_POLICY_TOKEN: 'w'.repeat(40) })[0]).toContain('KROT_CODEX_POLICY_TOKEN')
  expect(problems({ TELEGRAM_WEBHOOK_PORT: undefined })[0]).toContain('TELEGRAM_WEBHOOK_PORT')
  // The public app-servers run without the root relay; that pairing is not proven safe, so it is refused.
  expect(problems({ KROT_CODEX_PROXY: '/usr/local/bin/codex-proxy' }).join('\n')).toContain('KROT_CODEX_PROXY')
})

test('S4 startup: the permission hook must be installed in the Codex config with --thread-role', () => {
  const missing = setup('command = ["/usr/bin/bun", "/opt/other-hook.js"]')
  expect(multiuserProblems({ env: missing.env, workspace: missing.workspace, stateRoot: missing.state }).join('\n'))
    .toContain('codex-permission-hook')
  const noFlag = setup('command = ["/usr/bin/bun", "/opt/codex-permission-hook.js", "/opt/p.yaml", "8092", "/opt/t"]')
  expect(multiuserProblems({ env: noFlag.env, workspace: noFlag.workspace, stateRoot: noFlag.state }).join('\n'))
    .toContain('--thread-role')
})

test('S4 startup: the live profile probe passes only when Codex applied read-only, never and the folder', () => {
  const cwd = '/srv/public/_probe'
  expect(publicProfileProblem({ thread: { id: 't' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', cwd }, cwd)).toBeUndefined()
  expect(publicProfileProblem({ thread: { id: 't' }, sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never', cwd }, cwd)).toContain('sandbox')
  expect(publicProfileProblem({ thread: { id: 't' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', cwd }, cwd)).toContain('approval')
  expect(publicProfileProblem({ thread: { id: 't' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', cwd: '/home' }, cwd)).toContain('cwd')
  expect(publicProfileProblem({ thread: { id: 't' } }, cwd)).toBeDefined()
})

function runner(result: { status: 'completed' | 'interrupted' | 'failed'; text: string; toolItems: number } | Error) {
  const prompts: string[] = []
  return {
    prompts,
    runPublic: async (text: string) => {
      prompts.push(text)
      if (result instanceof Error) throw result
      return { ...result, threadId: 'canary' }
    },
    stopPublic: async () => true,
  }
}

test('S4 doctor canary: NO_SHELL with no tool item is a pass line; anything else is a problem', async () => {
  const pass = runner({ status: 'completed', text: 'NO_SHELL', toolItems: 0 })
  const ok = await runPublicCanary(pass, '/srv/public/_canary', 1000)
  expect(ok.ok).toBe(true)
  expect(ok.line).toContain('NO_SHELL')
  expect(pass.prompts).toEqual([CANARY_PROMPT])
  expect(CANARY_PROMPT).toContain('`id`')
  expect((await runPublicCanary(runner({ status: 'completed', text: 'uid=1000(openclaw)', toolItems: 1 }), '/c', 1000)).ok).toBe(false)
  expect((await runPublicCanary(runner({ status: 'completed', text: 'NO_SHELL', toolItems: 1 }), '/c', 1000)).ok).toBe(false)
  expect((await runPublicCanary(runner({ status: 'completed', text: 'не могу', toolItems: 0 }), '/c', 1000)).ok).toBe(false)
  expect((await runPublicCanary(runner(new Error('down')), '/c', 1000)).ok).toBe(false)
  const hung = { runPublic: () => new Promise<never>(() => {}), stopPublic: async () => true }
  expect((await runPublicCanary(hung, '/c', 20)).ok).toBe(false)
})

test('S4 doctor canary: a pass line is shown in the report', () => {
  const text = formatDoctorReport({ problems: [], passes: ['✅ Канарейка: NO_SHELL'] })
  expect(text).toContain('✅ Канарейка: NO_SHELL')
  expect(formatDoctorReport({ problems: [{ text: 'x' }], passes: ['✅ Канарейка: NO_SHELL'] })).toContain('✅ Канарейка: NO_SHELL')
})

const featuresOff = (extra: Record<string, boolean> = {}) =>
  ({ config: { features: { ...Object.fromEntries(PUBLIC_FEATURES_OFF.map(name => [name, false])), hooks: true, ...extra } } })

const mcp = (...entries: Array<[string, string]>) => ({ data: entries.map(([name, runtimeStatus]) => ({ name, runtimeStatus })), nextCursor: null })
const skills = (...names: string[]) => ({ data: [{ cwd: '/p', skills: names.map(name => ({ name, enabled: true })), errors: [] }] })

test('S4 probe: the public thread must see exactly the allowlisted MCP servers and skills, no more', () => {
  const expected = { mcp: ['docs'], skills: ['faq'] }
  expect(publicCapabilitiesProblem({ mcp: mcp(['docs', 'connected']), skills: skills('faq'), apps: { data: [] } }, expected)).toBeUndefined()
  // The owner's servers merged in (the live 0.172 finding) or account connectors: refuse.
  expect(publicCapabilitiesProblem({ mcp: mcp(['docs', 'connected'], ['kbase', 'connected']), skills: skills('faq') }, expected)).toContain('kbase')
  expect(publicCapabilitiesProblem({ mcp: mcp(['codex_apps', 'starting']), skills: skills('faq') }, { mcp: [], skills: ['faq'] })).toContain('codex_apps')
  // A disabled entry is not reachable; an allowlisted server that failed to start is not "more".
  expect(publicCapabilitiesProblem({ mcp: mcp(['kbase', 'disabled'], ['docs', 'failed']), skills: skills('faq'), apps: { data: [], nextCursor: null } }, expected))
    .toBeUndefined()
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills('faq', 'superpowers') }, { mcp: [], skills: ['faq'] })).toContain('superpowers')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills() }, { mcp: [], skills: ['faq'] })).toContain('faq')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills(), apps: { data: [{ id: 'gmail' }] } }, { mcp: [], skills: [] })).toContain('connector')
})

test('S4 probe: anything unreadable fails closed', () => {
  const expected = { mcp: [], skills: [] }
  expect(publicCapabilitiesProblem({ mcp: {}, skills: skills() }, expected)).toBeDefined()
  expect(publicCapabilitiesProblem({ mcp: { data: [{ runtimeStatus: 'connected' }] }, skills: skills() }, expected)).toBeDefined()
  expect(publicCapabilitiesProblem({ mcp: { data: [], nextCursor: 'more' }, skills: skills() }, expected)).toBeDefined()
  // No skills answer at all: the skills cannot be checked, so multi-user does not start.
  expect(publicCapabilitiesProblem({ mcp: mcp() }, expected)).toContain('skills')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: { data: 'x' } }, expected)).toBeDefined()
  // app/list exists on 0.172: no answer (an RPC error) fails closed; an answer must be empty.
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills() }, expected)).toContain('app/list')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills(), apps: { data: [], nextCursor: null } }, expected)).toBeUndefined()
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: skills(), apps: { data: [], nextCursor: 'more' } }, expected)).toBeDefined()
})

test('S4 probe: checkPublicProfile runs the probe in a fresh folder and joins both checks', async () => {
  const base = mkdtempSync(join(tmpdir(), 'krot-probe-'))
  dirs.push(base)
  const cwd = join(base, '_probe')
  const good = { probePublicProfile: async (dir: string) => ({
    reply: { thread: { id: 't' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', cwd: dir },
    mcp: mcp(), skills: skills('faq'), apps: { data: [], nextCursor: null }, config: featuresOff(),
  }) }
  expect(await checkPublicProfile(good, cwd, { mcp: [], skills: ['faq'] })).toBeUndefined()
  // The effective features are part of the check: no config/read answer fails closed.
  const noConfig = { probePublicProfile: async (dir: string) => {
    const { config: _config, ...rest } = await good.probePublicProfile(dir)
    return rest
  } }
  expect(await checkPublicProfile(noConfig, cwd, { mcp: [], skills: ['faq'] })).toContain('config/read')
  const leaky = { probePublicProfile: async (dir: string) => ({ ...(await good.probePublicProfile(dir)), mcp: mcp(['kbase', 'connected']) }) }
  expect(await checkPublicProfile(leaky, cwd, { mcp: [], skills: ['faq'] })).toContain('kbase')
  const down = { probePublicProfile: async () => { throw new Error('closed') } }
  expect(await checkPublicProfile(down, cwd, { mcp: [], skills: [] })).toContain('probe')
})

// Live 0.172: skills/list entries carry scope; Codex unpacks its bundled skills into $CODEX_HOME/skills/.system/.
const SYSTEM_SKILLS = ['create-statusline', 'imagegen', 'openai-docs', 'review-agent', 'skill-creator', 'skill-installer']
const scoped = (entries: Array<[string, string]>, errors: unknown[] = []) => ({
  data: [{ cwd: '/p', errors, skills: entries.map(([name, scope]) =>
    ({ name, description: 'd', enabled: true, path: '/h/' + name + '/SKILL.md', scope })) }],
})
const noApps = { data: [], nextCursor: null }

test('S4 probe: Codex bundled system skills do not count against the allowlist; user, repo and admin skills do', () => {
  const expected = { mcp: [], skills: ['faq'] }
  const live = scoped([['faq', 'user'], ...SYSTEM_SKILLS.map((name): [string, string] => [name, 'system'])])
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: live, apps: noApps }, expected)).toBeUndefined()
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: scoped([['faq', 'user'], ['owner-notes', 'repo']]), apps: noApps }, expected))
    .toContain('owner-notes')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: scoped([['faq', 'user'], ['policy', 'admin']]), apps: noApps }, expected))
    .toContain('policy')
  // A system skill does not stand in for an allowlisted one.
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: scoped([['imagegen', 'system']]), apps: noApps }, { mcp: [], skills: ['imagegen'] }))
    .toContain('imagegen')
})

test('S4 probe: a skills/list group with errors fails closed', () => {
  const broken = scoped([['faq', 'user']], [{ path: '/h/bad/SKILL.md', message: 'invalid frontmatter' }])
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: broken, apps: noApps }, { mcp: [], skills: ['faq'] })).toContain('error')
  const unreadable = { data: [{ cwd: '/p', skills: [], errors: 'x' }] }
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: unreadable, apps: noApps }, { mcp: [], skills: [] })).toBeDefined()
})

test('S4 probe: an empty skills answer fails closed', () => {
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: { data: [] }, apps: noApps }, { mcp: [], skills: [] })).toContain('skills')
})

test('S4 probe: an allowlisted skill name loaded from outside the public home skills folder fails closed', () => {
  const home = '/state/codex-public/guest'
  const at = (path: unknown) => ({ data: [{ cwd: '/p', errors: [], skills: [{ name: 'faq', enabled: true, scope: 'repo', path }] }] })
  const expected = { mcp: [], skills: ['faq'], home }
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: at(home + '/skills/faq/SKILL.md'), apps: noApps }, expected)).toBeUndefined()
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: at('/p/.agents/skills/faq/SKILL.md'), apps: noApps }, expected)).toContain('faq')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: at(home + '/skills/faq/../../../x/SKILL.md'), apps: noApps }, expected))
    .toContain('faq')
  expect(publicCapabilitiesProblem({ mcp: mcp(), skills: at(undefined), apps: noApps }, expected)).toContain('faq')
})

test('S4 probe: a leftover mcpServerStatus nextCursor alone fails the check', () => {
  const full = { skills: skills(), apps: noApps }
  expect(publicCapabilitiesProblem({ mcp: { data: [], nextCursor: null }, ...full }, { mcp: [], skills: [] })).toBeUndefined()
  expect(publicCapabilitiesProblem({ mcp: { data: [], nextCursor: 'more' }, ...full }, { mcp: [], skills: [] })).toContain('mcpServerStatus')
})

test('S4 probe: the effective features must have subagents and every tool feature off; nothing unknown on', () => {
  expect(publicFeaturesProblem(featuresOff())).toBeUndefined()
  expect(publicFeaturesProblem(undefined)).toContain('config/read')
  expect(publicFeaturesProblem({ config: {} })).toBeDefined()
  for (const name of ['multi_agent', 'multi_agent_v2', 'view_image', 'shell_tool']) {
    expect(publicFeaturesProblem(featuresOff({ [name]: true }))).toContain(name)
  }
  const missing = featuresOff()
  delete (missing.config.features as Record<string, boolean>).multi_agent_v2
  expect(publicFeaturesProblem(missing)).toContain('multi_agent_v2')
  // A tool feature a Codex update adds and turns on is outside the allowlist.
  expect(publicFeaturesProblem(featuresOff({ new_tool: true }))).toContain('new_tool')
})

test('S4 R4: a public home whose effective config has the hooks feature off (or unset) fails the startup probe', () => {
  expect(publicFeaturesProblem(featuresOff({ hooks: false }))).toContain('hooks')
  const unset = featuresOff()
  delete (unset.config.features as Record<string, boolean>).hooks
  expect(publicFeaturesProblem(unset)).toContain('hooks')
})

test('S4 R4: the hook proof passes only when the bridge saw the hook deny the proof thread itself', async () => {
  const cwd = join(setup().base, 'proof')
  const denials = new HookDenials()
  let stopped = 0
  const runner = (deny: string | undefined, hang = false) => ({
    async runHookProof(_cwd: string, _prompt: string, onThread: (id: string) => void) {
      onThread('proof-1')
      if (deny) denials.record(deny)
      if (hang) await new Promise(() => {})
      return { status: 'completed' as const, text: 'ok', threadId: 'proof-1', toolItems: 1 }
    },
    async stopPublic() { stopped++; return true },
  })
  expect(await proveHookDenial(runner('proof-1'), denials, cwd, 1000)).toBeUndefined()
  // A denial of another thread, or none at all, proves nothing.
  const other = new HookDenials()
  expect(await proveHookDenial(runner(undefined), other, cwd, 1000)).toContain('hook')
  other.record('someone-else')
  expect(await proveHookDenial(runner(undefined), other, cwd, 1000)).toContain('hook')
  expect(await proveHookDenial(runner(undefined, true), new HookDenials(), cwd, 20)).toContain('hook')
  expect(stopped).toBe(1)
  const failing = { async runHookProof(): Promise<never> { throw new Error('boom') }, async stopPublic() { return false } }
  expect(await proveHookDenial(failing, new HookDenials(), cwd, 1000)).toContain('hook')
})

test('S4 R4: the hook proof needs a completed turn: interrupted, failed or timed out fails even with a denial', async () => {
  const cwd = join(setup().base, 'proof')
  let denials = new HookDenials()
  const ended = (status: 'interrupted' | 'failed') => ({
    async runHookProof(_cwd: string, _prompt: string, onThread: (id: string) => void) {
      onThread('proof-3')
      denials.record('proof-3')
      return { status, text: '', threadId: 'proof-3', toolItems: 1 }
    },
    async stopPublic() { return true },
  })
  expect(await proveHookDenial(ended('interrupted'), denials, cwd, 1000)).toContain('did not complete')
  denials = new HookDenials()
  expect(await proveHookDenial(ended('failed'), denials, cwd, 1000)).toContain('did not complete')
  // A timeout fails whether the denial came before the stop or only after the interrupt was acknowledged.
  let stopped = 0
  const hangs = (denyOnStop: boolean) => ({
    async runHookProof(_cwd: string, _prompt: string, onThread: (id: string) => void): Promise<never> {
      onThread('proof-4')
      if (!denyOnStop) denials.record('proof-4')
      return new Promise(() => {})
    },
    async stopPublic(threadId: string) {
      stopped++
      if (denyOnStop) denials.record(threadId)
      return true
    },
  })
  denials = new HookDenials()
  expect(await proveHookDenial(hangs(false), denials, cwd, 20)).toContain('did not finish')
  denials = new HookDenials()
  expect(await proveHookDenial(hangs(true), denials, cwd, 20)).toContain('did not finish')
  expect(stopped).toBe(2)
})

test('S4 R4: a denial is not enough: the hook proof fails when the fixture command still ran', async () => {
  const cwd = join(setup().base, 'proof')
  const ranAnyway = (hang: boolean) => ({
    async runHookProof(_cwd: string, _prompt: string, onThread: (id: string) => void, onCommandRan: () => void) {
      onThread('proof-2')
      denials.record('proof-2')
      onCommandRan()
      if (hang) await new Promise(() => {})
      return { status: 'completed' as const, text: 'DONE', threadId: 'proof-2', toolItems: 1 }
    },
    async stopPublic() { return true },
  })
  let denials = new HookDenials()
  expect(await proveHookDenial(ranAnyway(false), denials, cwd, 1000)).toContain('ran')
  // The timeout path too: a denial seen before the stop does not pass when the command ran.
  denials = new HookDenials()
  expect(await proveHookDenial(ranAnyway(true), denials, cwd, 20)).toContain('ran')
})
