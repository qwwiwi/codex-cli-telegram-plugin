import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkHooksPack, fullAccessGuards, guardsActive, installHookPack, installHooks, launcherScript, managedToml, PACK_EVENTS, packCommand, stageManaged, uninstallHooks } from '../../../codex-hooks/src/install.js'
import { BRIDGE_UID_FILE, bridgeUidContent } from '../../../codex-hooks/src/scope.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-hooks-brain-install-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

test('managed TOML adds the SessionStart limit and one optional PreCompact handler without changing the guard stanza', () => {
  expect(managedToml('/fixture/hooks')).toMatchInlineSnapshot(`
"# krotov-plugin codex-hooks: managed hooks

[hooks]
managed_dir = "/fixture/hooks"

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "'/fixture/hooks/run' SessionStart"
timeout = 30
additionalContextLimit = 6000

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "'/fixture/hooks/run' UserPromptSubmit"
timeout = 30

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "'/fixture/hooks/run' PreToolUse"
timeout = 30

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "'/fixture/hooks/run' PostToolUse"
timeout = 30

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "'/fixture/hooks/run' Stop"
timeout = 30

[[hooks.PreCompact]]
[[hooks.PreCompact.hooks]]
type = "command"
command = "'/fixture/hooks/run' PreCompact"
timeout = 30
"
`)
  expect(PACK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
})

test('full-access accepts exact legacy requirements without PreCompact but rejects any guard change', async () => {
  const dir = join(root, 'hooks')
  mkdirSync(dir, { mode: 0o700 })
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml']) writeFileSync(join(dir, name), '')
  writeFileSync(join(dir, 'run'), launcherScript(dir))
  writeFileSync(join(dir, BRIDGE_UID_FILE), bridgeUidContent(), { mode: 0o644 })
  const file = join(root, 'requirements.toml')
  const current = managedToml(dir)
  const withoutCompact = current.split('\n[[hooks.PreCompact]]')[0]!
  expect(withoutCompact).not.toBe(current)
  const legacy = withoutCompact.replace('additionalContextLimit = 6000\n', '')
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: file, command: `'${dir}/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const inspect = (etc: string) => guardsActive(etc, () => true, () => ({ ok: true, why: 'ok' }), uid => uid === process.getuid?.())
  for (const toml of [legacy, withoutCompact, current]) {
    writeFileSync(file, toml)
    expect(await fullAccessGuards(root, async () => listed, inspect)).toEqual({ active: true, why: 'ok' })
  }
  writeFileSync(file, current.replace('PreToolUse"\ntimeout = 30', 'PreToolUse"\ntimeout = 31'))
  expect((await fullAccessGuards(root, async () => listed, inspect)).active).toBe(false)
})

test('user install adds the context limit, tracks PreCompact in doctor, and uninstalls it idempotently', async () => {
  const paths = {
    codexHome: root, configFile: join(root, 'switches.json'), bun: '/fixture/bun',
    main: join(import.meta.dir, '../../../codex-hooks/src/main.ts'),
  }
  const file = join(root, 'hooks.json')
  const foreign = { type: 'command', command: '/fixture/foreign' }
  writeFileSync(file, JSON.stringify({ hooks: { PreCompact: [{ hooks: [foreign] }] } }))
  installHooks(paths)
  const first = readFileSync(file, 'utf8')
  installHooks(paths)
  expect(readFileSync(file, 'utf8')).toBe(first)
  const { hooks } = JSON.parse(first)
  expect(hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(6000)
  expect(hooks.PreCompact.flatMap((group: { hooks: unknown[] }) => group.hooks)).toEqual([
    foreign, { type: 'command', command: "'/fixture/bun' '" + paths.main + "' PreCompact" },
  ])
  const listed = PACK_EVENTS.map(eventName => ({ eventName, sourcePath: file, command: packCommand(paths, eventName), trustStatus: 'trusted' }))
  const brainCheck = async (withCompact: boolean) => (await checkHooksPack(paths, async () => withCompact ? [
    ...listed, { eventName: 'PreCompact', sourcePath: file, command: "'/fixture/bun' '" + paths.main + "' PreCompact", trustStatus: 'trusted' },
  ] : listed)).find(check => check.message.includes('Brain') && check.message.includes('PreCompact'))
  expect((await brainCheck(false))?.status).toBe('info')
  expect((await brainCheck(true))?.status).toBe('ok')
  uninstallHooks(paths, undefined)
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks).toEqual({ PreCompact: [{ hooks: [foreign] }] })
})

test('the installer stages the optional managed update while keeping current guards active', async () => {
  const etc = join(root, 'etc')
  const dir = join(etc, 'hooks')
  const conf = join(root, 'codex')
  const staging = join(conf, 'managed-hooks')
  const paths = { codexHome: conf, configFile: join(root, 'switches.json'), bun: join(root, 'fixture-bun'),
    main: join(import.meta.dir, '../../../codex-hooks/src/main.ts') }
  writeFileSync(paths.bun, 'fixture')
  await stageManaged(paths, staging, etc)
  mkdirSync(etc, { mode: 0o700 })
  mkdirSync(dir, { mode: 0o700 })
  for (const name of ['bridge-uid', 'bun', 'bunfig.toml', 'codex-hooks.js', 'run']) {
    copyFileSync(join(staging, name), join(dir, name))
  }
  const target = join(etc, 'requirements.toml')
  const legacy = managedToml(dir).split('\n[[hooks.PreCompact]]')[0]!.replace('additionalContextLimit = 6000\n', '')
  writeFileSync(target, legacy)
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: target, command: `'${dir}/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const messages: string[] = []
  const trustedOwner = (uid: number) => uid === process.getuid?.()
  const inspectGuards = (dir: string) => guardsActive(dir, () => true, () => ({ ok: true, why: 'ok' }), trustedOwner)
  const result = await installHookPack(paths, async () => listed, { etc, inspectGuards, trustedOwner, report: line => messages.push(line) })
  expect(result).toEqual({ active: true, why: 'ok' })
  expect(readFileSync(target, 'utf8')).toBe(legacy)
  expect(readFileSync(join(staging, 'requirements.toml'), 'utf8')).toBe(managedToml(dir))
  expect(messages.filter(line => line.startsWith('sudo install '))).toEqual([
    `sudo install -D -o root -g root -m 0644 '${join(staging, 'requirements.toml')}' '${target}'`,
  ])
})
