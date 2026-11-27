// The managed pack in /etc/codex is host-wide: every Codex user on the host runs it. Only the
// bridge user (the uid recorded by the installer in <managedDir>/bridge-uid) gets the full pack.
// A user a trusted bridge-uid proves is not the bridge gets a pure no-op for every event; when
// bridge-uid is missing or untrusted, the PreToolUse safety guard alone stays (fail closed).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMain } from '../../../codex-hooks/src/entry.js'
import { launcherScript, stageManaged } from '../../../codex-hooks/src/install.js'
import { BRIDGE_UID_FILE, bridgeUidContent, hookScope, MANAGED_DIR_ENV } from '../../../codex-hooks/src/scope.js'
import type { Runner } from '../../../codex-hooks/src/types.js'

const BRIDGE_UID = 1000
const OTHER_UID = 1001

let root = ''
let home = ''
let managedDir = ''
let server: ReturnType<typeof Bun.serve> | undefined
let requests = 0
let spawned: string[][] = []

// A runner that records every program the hook would start.
const recording: Runner = argv => { spawned.push([...argv]); return { code: 1, stdout: '' } }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-hooks-second-user-'))
  home = join(root, 'home')
  managedDir = join(root, 'etc-codex', 'hooks')
  mkdirSync(managedDir, { recursive: true })
  // Fixed modes: the fixture must not depend on the runner's umask.
  chmodSync(join(root, 'etc-codex'), 0o755)
  chmodSync(managedDir, 0o755)
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${BRIDGE_UID}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  requests = 0
  spawned = []
  // A gbrain the user's own switchboard points at: the other user's hooks must never call it.
  server = Bun.serve({ port: 0, fetch: () => { requests += 1; return Response.json({ jsonrpc: '2.0', id: 1, result: {} }) } })
  const base = `http://127.0.0.1:${server.port}`
  mkdirSync(join(home, '.config', 'krotov-plugin'), { recursive: true })
  writeFileSync(join(home, '.config', 'krotov-plugin', 'codex-hooks.json'), JSON.stringify({
    agent: 'other-agent', gbrain: { urls: { swarm: `${base}/swarm`, tasks: `${base}/tasks`, recall: `${base}/recall` } },
  }))
  // A Codex home that the session check would complain about (no model, no multi_agent_v2, no AGENTS.md).
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), 'approval_policy = "on-request"\n')
})
afterEach(() => { server?.stop(true); server = undefined; rmSync(root, { recursive: true, force: true }) })

const env = () => ({ HOME: home, CODEX_HOME: join(home, '.codex'), [MANAGED_DIR_ENV]: managedDir })
// Any owner counts as trusted here (the test files are not root-owned); modes and file types are real.
const asUser = (uid: number) => (scopeEnv: Record<string, string | undefined>) => hookScope(scopeEnv, uid, () => true)
// No owner is trusted: bridge-uid cannot tell who the bridge is.
const untrusted = (uid: number) => (scopeEnv: Record<string, string | undefined>) => hookScope(scopeEnv, uid, () => false)

const base = () => ({ session_id: 's', turn_id: 't', cwd: home })
const inputs: Record<string, string> = {
  SessionStart: JSON.stringify({ ...base(), hook_event_name: 'SessionStart', source: 'startup' }),
  UserPromptSubmit: JSON.stringify({ ...base(), hook_event_name: 'UserPromptSubmit', prompt: 'Reply with OK. Сделай три вещи: раз, два и три, и потом проверь всё.' }),
  PostToolUse: JSON.stringify({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat token.txt' },
    tool_response: { output: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' } }),
  Stop: JSON.stringify({ ...base(), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Готово, всё сделал.' }),
}
const pre = (command: string) => JSON.stringify({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })

test('[second-user]a user a trusted bridge-uid proves is not the bridge gets a pure no-op for all five events', async () => {
  const before = readdirSync(home, { recursive: true }).sort()
  for (const [event, stdin] of Object.entries({ ...inputs, PreToolUse: pre('rm -rf /') })) {
    expect({ event, result: await runMain(event, stdin, env(), recording, undefined, asUser(OTHER_UID)) }).toEqual({ event, result: { stdout: '', code: 0 } })
  }
  // Unreadable input and bridge-only workflow rules are not this pack's business for another user either.
  for (const stdin of ['not json', pre('git push --force origin main'), pre('git push')]) {
    expect(await runMain('PreToolUse', stdin, env(), recording, undefined, asUser(OTHER_UID))).toEqual({ stdout: '', code: 0 })
  }
  expect(spawned).toEqual([])
  expect(requests).toBe(0)
  // No files in their home: no log, no state, no ~/.trash.
  expect(readdirSync(home, { recursive: true }).sort()).toEqual(before)
})

test('[second-user]with an untrusted bridge-uid the other four events stay silent and write nothing', async () => {
  const before = readdirSync(home, { recursive: true }).sort()
  for (const [event, stdin] of Object.entries(inputs)) {
    expect({ event, result: await runMain(event, stdin, env(), recording, undefined, untrusted(OTHER_UID)) }).toEqual({ event, result: { stdout: '', code: 0 } })
  }
  expect(spawned).toEqual([])
  expect(requests).toBe(0)
  expect(readdirSync(home, { recursive: true }).sort()).toEqual(before)
})

test('[second-user]with an untrusted bridge-uid PreToolUse keeps the fail-closed safety guard with a neutral reason', async () => {
  for (const command of ['rm -rf /', 'rm -rf ~', 'git push --force origin main', 'sudo ls']) {
    const result = await runMain('PreToolUse', pre(command), env(), recording, undefined, untrusted(OTHER_UID))
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
    expect({ command, decision: output.hookSpecificOutput.permissionDecision }).toEqual({ command, decision: 'deny' })
    expect(output.hookSpecificOutput.permissionDecisionReason).not.toMatch(/(?<![а-яё])мост|(?<![а-яё])бот(?![а-яё])|doctor|Telegram|телеграм|gbrain|bridge/i)
  }
  expect(JSON.parse((await runMain('PreToolUse', pre('ls'), env(), recording, undefined, untrusted(OTHER_UID))).stdout)).toEqual({})
  // Unreadable input still fails closed.
  const unreadable = JSON.parse((await runMain('PreToolUse', 'not json', env(), recording, undefined, untrusted(OTHER_UID))).stdout)
  expect(unreadable.hookSpecificOutput.permissionDecision).toBe('deny')
  // The bridge workflow guards (git gate) are not part of the safety scope.
  expect(JSON.parse((await runMain('PreToolUse', pre('git push'), env(), recording, undefined, untrusted(OTHER_UID))).stdout)).toEqual({})
  expect(requests).toBe(0)
})

test('[second-user]the bridge user keeps the full pack: the session check still reports its problems', async () => {
  const result = await runMain('SessionStart', inputs.SessionStart ?? '', env(), recording, undefined, asUser(BRIDGE_UID))
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
  expect(context).toContain('multi_agent_v2')
  expect(context).toContain('/doctor')
})

test('[second-user]the scope: full for the recorded uid, other for another uid, safety when bridge-uid proves nothing', () => {
  const managed = { [MANAGED_DIR_ENV]: managedDir }
  const file = join(managedDir, BRIDGE_UID_FILE)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('full')
  expect(hookScope(managed, OTHER_UID, () => true)).toBe('other')
  // A file of an untrusted owner proves nothing.
  expect(hookScope(managed, BRIDGE_UID, () => false)).toBe('safety')
  expect(hookScope(managed, OTHER_UID, () => false)).toBe('safety')
  // The default trust is root only.
  if (process.getuid?.() !== 0) expect(hookScope(managed, BRIDGE_UID)).toBe('safety')
  // A file or a directory the users could have written proves nothing.
  chmodSync(file, 0o666)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  chmodSync(file, 0o644)
  chmodSync(managedDir, 0o775)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  chmodSync(managedDir, 0o755)
  chmodSync(join(root, 'etc-codex'), 0o777)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  chmodSync(join(root, 'etc-codex'), 0o755)
  // Root is never the bridge user.
  writeFileSync(file, '0\n')
  expect(hookScope(managed, 0, () => true)).toBe('safety')
  expect(hookScope(managed, OTHER_UID, () => true)).toBe('safety')
  writeFileSync(file, 'bridge\n')
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  // Oversized content is not read.
  writeFileSync(file, `${'0'.repeat(100)}${BRIDGE_UID}\n`)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  rmSync(file)
  expect(hookScope(managed, BRIDGE_UID, () => true)).toBe('safety')
  // A user-level install (hooks.json of the installing user) has no managed dir: the full pack.
  expect(hookScope({}, OTHER_UID, () => false)).toBe('full')
})

test('[second-user]a symlinked bridge-uid or managed dir is not trusted, even to a valid file', () => {
  const target = join(managedDir, 'real-uid')
  writeFileSync(target, `${BRIDGE_UID}\n`)
  chmodSync(target, 0o644)
  rmSync(join(managedDir, BRIDGE_UID_FILE))
  symlinkSync(target, join(managedDir, BRIDGE_UID_FILE))
  expect(hookScope({ [MANAGED_DIR_ENV]: managedDir }, BRIDGE_UID, () => true)).toBe('safety')
  expect(hookScope({ [MANAGED_DIR_ENV]: managedDir }, OTHER_UID, () => true)).toBe('safety')
  rmSync(join(managedDir, BRIDGE_UID_FILE))
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${BRIDGE_UID}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  const link = join(root, 'etc-codex', 'linked')
  symlinkSync(managedDir, link)
  expect(hookScope({ [MANAGED_DIR_ENV]: link }, BRIDGE_UID, () => true)).toBe('safety')
})

test('[second-user]a FIFO as bridge-uid is not trusted and does not stall the hook', () => {
  rmSync(join(managedDir, BRIDGE_UID_FILE))
  expect(Bun.spawnSync(['mkfifo', '-m', '0644', join(managedDir, BRIDGE_UID_FILE)]).exitCode).toBe(0)
  // In a child with a deadline: a blocking open of the FIFO would hang this test runner itself.
  const scopeModule = join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'scope.ts')
  const script = `const { hookScope } = await import(${JSON.stringify(scopeModule)});`
    + `console.log(hookScope({ ${MANAGED_DIR_ENV}: ${JSON.stringify(managedDir)} }, ${BRIDGE_UID}, () => true))`
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
  expect({ signal: child.signalCode ?? null, stdout: child.stdout.toString().trim() }).toEqual({ signal: null, stdout: 'safety' })
}, 10_000)

test('[second-user]the installer refuses to record root as the bridge user', () => {
  expect(() => bridgeUidContent(0)).toThrow(/root/)
  expect(bridgeUidContent(BRIDGE_UID)).toBe(`${BRIDGE_UID}\n`)
})

test('[second-user]the installer records its own uid in bridge-uid and the launcher names the managed dir', async () => {
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-stage')
  const staged = await stageManaged({ codexHome: join(home, '.codex'), configFile: join(root, 'x.json'), bun: process.execPath,
    main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts') }, staging, etc)
  expect(readFileSync(join(staging, BRIDGE_UID_FILE), 'utf8')).toBe(`${process.getuid?.()}\n`)
  expect(staged.command).toContain(`-m 0644 '${join(staging, BRIDGE_UID_FILE)}' '${etc}/hooks/${BRIDGE_UID_FILE}'`)
  expect(launcherScript(`${etc}/hooks`)).toContain(`${MANAGED_DIR_ENV}='${etc}/hooks'`)
})

test('[second-user]end to end through the installed launcher: a user whose bridge-uid is not trusted gets only the guard', async () => {
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-e2e')
  await stageManaged({ codexHome: join(home, '.codex'), configFile: join(root, 'x.json'), bun: process.execPath,
    main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts') }, staging, etc)
  mkdirSync(join(etc, 'hooks'), { recursive: true })
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml', 'run', BRIDGE_UID_FILE]) copyFileSync(join(staging, name), join(etc, 'hooks', name))
  chmodSync(join(etc, 'hooks', 'bun'), 0o755)
  chmodSync(join(etc, 'hooks', 'run'), 0o755)
  // A group/other-writable bridge-uid is untrusted whoever runs the test, root included.
  chmodSync(join(etc, 'hooks', BRIDGE_UID_FILE), 0o666)
  const launch = (event: string, stdin: string) => Bun.spawnSync([join(etc, 'hooks', 'run'), event], {
    cwd: root, env: { HOME: home, CODEX_HOME: join(home, '.codex') }, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe',
  })
  for (const [event, stdin] of Object.entries(inputs)) {
    const result = launch(event, stdin)
    expect({ event, code: result.exitCode, stdout: result.stdout.toString() }).toEqual({ event, code: 0, stdout: '' })
  }
  const deny = launch('PreToolUse', pre('rm -rf /'))
  expect({ code: deny.exitCode, stdout: deny.stdout.toString() }).toEqual({ code: 2, stdout: '' })
  expect(deny.stderr.toString()).toStartWith('Заблокировано защитой Codex: ')
  expect(requests).toBe(0)
}, 30_000)
