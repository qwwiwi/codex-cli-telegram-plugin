import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullAccessGuards, managedListing, PACK_EVENTS, uninstallHooks, type ListedHook } from '../../../codex-hooks/src/install.js'
import { startupSandbox } from '../../src/codex/full-access.js'
import { runDoctor } from '../../scripts/doctor.js'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-hooks-full-access-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const etc = '/etc/codex'
// Shaped like Codex 0.172 HookMetadata (app-server hooks/list), with every required field.
const managed = (extra: Record<string, unknown> = {}): ListedHook[] => PACK_EVENTS.map((event, index) => ({
  key: `system:${etc}/requirements.toml:${event}:0:0`, eventName: event, handlerType: 'command', matcher: null,
  command: `'${etc}/hooks/run' ${event}`, timeoutSec: 600, statusMessage: null, sourcePath: `${etc}/requirements.toml`,
  source: 'system', pluginId: null, displayOrder: index, enabled: true, isManaged: true,
  currentHash: `sha256:${index}`, trustStatus: 'managed', ...extra,
}))
const without = (field: string): ListedHook[] => managed().map(hook => {
  const copy: Record<string, unknown> = { ...hook }
  delete copy[field]
  return copy
})
const active = () => ({ active: true, why: 'ok' })

describe('v0.4 control: full access only with live guards', () => {
  test('[R17] uninstall resets the sandbox setting', () => {
    const envFile = join(root, '.env')
    writeFileSync(envFile, 'KROT_CODEX_HOOKS=1\nKROT_CODEX_SANDBOX=danger-full-access\nOTHER=1\n')
    const paths = { codexHome: join(root, '.codex'), configFile: join(root, 'c.json'), bun: process.execPath, main: '/x/codex-hooks/src/main.ts' }
    expect(uninstallHooks(paths, envFile).envChanged).toBe(true)
    expect(readFileSync(envFile, 'utf8')).toBe('OTHER=1\n')
  })

  test('[R17] Codex must list every managed hook from requirements.toml', () => {
    expect(managedListing(managed(), etc).ok).toBe(true)
    // Only the user-level copy is loaded: Codex never picked up requirements.toml.
    expect(managedListing(managed({ sourcePath: '/home/u/.codex/hooks.json' }), etc).ok).toBe(false)
    expect(managedListing(managed().slice(1), etc).ok).toBe(false)
    expect(managedListing(managed({ command: "'/tmp/run' PreToolUse" }), etc).ok).toBe(false)
    expect(managedListing([], etc).ok).toBe(false)
  })

  test('[R17] Codex 0.172 lists managed hooks with sourcePath = the managed_dir and that counts', () => {
    // Live shape on Codex 0.172: sourcePath is [hooks].managed_dir, not requirements.toml.
    expect(managedListing(managed({ sourcePath: `${etc}/hooks` }), etc)).toEqual({ ok: true, why: 'ok' })
    // Same path after normalisation.
    expect(managedListing(managed({ sourcePath: `${etc}/hooks/` }), etc).ok).toBe(true)
    expect(managedListing(managed({ sourcePath: `${etc}//hooks` }), etc).ok).toBe(true)
    // Every other check still applies with the managed_dir source.
    expect(managedListing(managed({ sourcePath: `${etc}/hooks`, isManaged: false }), etc).ok).toBe(false)
    expect(managedListing(managed({ sourcePath: `${etc}/hooks`, trustStatus: 'trusted' }), etc).ok).toBe(false)
    expect(managedListing(managed({ sourcePath: `${etc}/hooks`, command: "'/tmp/run' PreToolUse" }), etc).ok).toBe(false)
  })

  test('[R17] a managed hook from any other sourcePath is not loaded', () => {
    for (const sourcePath of [etc, `${etc}/hooks/run`, `${etc}/hooks/../hooks2`, `${etc}/hooks2`, '/tmp/hooks',
      '/etc/codex-evil/hooks', `${etc}/config.toml`, 'etc/codex/hooks', '', null]) {
      expect(managedListing(managed({ sourcePath }), etc).ok).toBe(false)
    }
  })

  test('[R17] a managed hook that Codex lists as disabled or untrusted does not count', () => {
    expect(managedListing(managed({ enabled: false }), etc).ok).toBe(false)
    expect(managedListing(managed({ trustStatus: 'untrusted' }), etc).ok).toBe(false)
  })

  test('[R17] only a hook Codex lists as managed, enabled and with the exact launcher command counts', () => {
    expect(managedListing(managed({ isManaged: false }), etc).ok).toBe(false)
    expect(managedListing(managed({ trustStatus: 'trusted' }), etc).ok).toBe(false)
    expect(managedListing(managed({ source: 'user' }), etc).ok).toBe(false)
    expect(managedListing(managed({ source: 'project' }), etc).ok).toBe(false)
    expect(managedListing(managed({ handlerType: 'prompt' }), etc).ok).toBe(false)
    expect(managedListing(managed({ enabled: 'true' }), etc).ok).toBe(false)
    for (const field of ['enabled', 'isManaged', 'trustStatus', 'source', 'handlerType', 'command']) {
      expect(managedListing(without(field), etc).ok).toBe(false)
    }
    expect(managedListing(managed({ command: `'${etc}/hooks/run' PreToolUse --off` }), etc).ok).toBe(false)
    expect(managedListing(managed({ command: null }), etc).ok).toBe(false)
  })

  test('[R17] full access needs the live guards and the Codex listing; a Codex without hooks/list fails closed', async () => {
    expect((await fullAccessGuards(etc, async () => managed(), active)).active).toBe(true)
    expect((await fullAccessGuards(etc, async () => managed(), () => ({ active: false, why: 'нет файла' }))).active).toBe(false)
    const unsupported = await fullAccessGuards(etc, async () => { throw new Error('method not found') }, active)
    expect(unsupported.active).toBe(false)
    expect(unsupported.why).toContain('hooks/list')
    expect((await fullAccessGuards(etc, async () => [], active)).active).toBe(false)
  })

  test('[R17] the bridge falls back to workspace-write at startup when the guards are not live', async () => {
    let checked = 0
    const failing = async () => { checked++; return { active: false, why: 'нет /etc/codex/requirements.toml' } }
    expect(await startupSandbox('danger-full-access', failing)).toEqual({ sandbox: 'workspace-write', fallback: 'нет /etc/codex/requirements.toml' })
    expect(await startupSandbox('danger-full-access', async () => { throw new Error('boom') })).toMatchObject({ sandbox: 'workspace-write' })
    expect(await startupSandbox('danger-full-access', async () => active())).toEqual({ sandbox: 'danger-full-access' })
    expect(await startupSandbox('workspace-write', failing)).toEqual({ sandbox: 'workspace-write' })
    expect(await startupSandbox(undefined, failing)).toEqual({ sandbox: undefined })
    expect(checked).toBe(1)
  })

  test('[R17] the bridge starts Codex with the startup decision, never with the raw KROT_CODEX_SANDBOX', () => {
    // server.ts main() needs Telegram and a Codex binary, so its wiring is checked in the source.
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'codex', 'server.ts'), 'utf8')
    expect(source).toMatch(/const sandbox = await startupSandbox\(env\.KROT_CODEX_SANDBOX,\s*\(\) => fullAccessGuards\(ETC_CODEX,/)
    const start = source.indexOf('new CodexSession({')
    expect(start).toBeGreaterThan(0)
    const options = source.slice(start, source.indexOf('\n    }, () => {', start))
    expect(options).toContain('...(sandbox.sandbox ? { sandbox: sandbox.sandbox } : {}),')
    expect(options).not.toContain('KROT_CODEX_SANDBOX')
    expect(source.match(/\bsandbox: /g)?.length).toBe(1)
  })

  test('[R17] install.ts --uninstall removes the full-access setting from the env file', () => {
    const envFile = join(root, 'plugin.env')
    writeFileSync(envFile, 'A=1\nKROT_CODEX_HOOKS=1\nKROT_CODEX_SANDBOX=danger-full-access\n')
    const script = join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'install.ts')
    const result = Bun.spawnSync([process.execPath, script, '--uninstall', '--env-file', envFile], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: root, CODEX_HOME: join(root, '.codex'), CODEX_HOOKS_CONFIG: join(root, 'c.json') },
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(envFile, 'utf8')).toBe('A=1\n')
  })

  test('[R17] /doctor reports the startup fallback', async () => {
    const ownerInstructionChecks = mock((_home: string) => [])
    const checks = await runDoctor({
      HOME: root, KROT_CODEX_SANDBOX: 'danger-full-access', KROT_CODEX_SANDBOX_FALLBACK: 'нет /etc/codex/requirements.toml',
    }, {
      checkCodex: () => ({ status: 'ok', message: 'Codex CLI готов' }),
      ownerInstructionChecks,
      telegram: async () => null,
    })
    expect(ownerInstructionChecks).toHaveBeenCalledWith(join(root, '.codex'))
    const fallback = checks.find(check => check.message.includes('workspace-write'))
    expect(fallback?.status).toBe('error')
    expect(fallback?.message).toContain('нет /etc/codex/requirements.toml')
  })
})
