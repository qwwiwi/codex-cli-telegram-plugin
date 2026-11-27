import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { invokingHome } from '../../../codex-hooks/src/home.js'
import { BRAIN_EVENTS, checkHooksPack, defaultPaths, installHooks, PACK_EVENTS, uninstallHooks } from '../../../codex-hooks/src/install.js'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-hooks-install-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const paths = () => ({
  codexHome: join(root, '.codex'),
  configFile: join(root, '.config', 'krotov-plugin', 'codex-hooks.json'),
  bun: '/usr/local/bin/bun',
  main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts'),
})

test('[R17] the installer registers every event and keeps foreign hooks', () => {
  mkdirSync(join(root, '.codex'))
  const foreign = { type: 'command', command: '/opt/other-hook.sh' }
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [foreign] }] } }))
  installHooks(paths())
  installHooks(paths())
  const file = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'))
  for (const event of [...PACK_EVENTS, ...BRAIN_EVENTS]) {
    const commands = file.hooks[event].flatMap((group: { hooks: Array<{ command: string; type: string }> }) => group.hooks)
    expect(commands.filter((hook: { command: string }) => hook.command.includes('main.ts'))).toHaveLength(1)
    expect(commands.find((hook: { command: string }) => hook.command.includes('main.ts'))?.command).toEndWith(` ${event}`)
  }
  expect(JSON.stringify(file.hooks.PreToolUse)).toContain('/opt/other-hook.sh')
  const config = JSON.parse(readFileSync(paths().configFile, 'utf8'))
  expect(Object.values(config.enabled).every(Boolean)).toBe(true)
})

test('[R17] the installer keeps an existing switchboard file', () => {
  mkdirSync(join(root, '.config', 'krotov-plugin'), { recursive: true })
  writeFileSync(paths().configFile, JSON.stringify({ enabled: { recall: false } }))
  installHooks(paths())
  expect(JSON.parse(readFileSync(paths().configFile, 'utf8')).enabled.recall).toBe(false)
})

test('[R17] the switches file defaults to the plugin config dir and CODEX_HOOKS_CONFIG overrides it', () => {
  expect(defaultPaths({ HOME: root }).configFile).toBe(join(root, '.config', 'krotov-plugin', 'codex-hooks.json'))
  expect(defaultPaths({ HOME: root, CODEX_HOOKS_CONFIG: '/x/hooks.json' }).configFile).toBe('/x/hooks.json')
})

test('[R17] empty home variables fall back to the invoking uid’s passwd home', () => {
  const home = userInfo().homedir
  const defaults = defaultPaths({ HOME: '', CODEX_HOME: '' })
  expect(defaults.codexHome).toBe(join(home, '.codex'))
  expect(defaults.configFile).toBe(join(home, '.config', 'krotov-plugin', 'codex-hooks.json'))
})

test('[R17] invokingHome uses getent for the real uid when the effective uid differs', () => {
  const uid = spyOn(process, 'getuid').mockReturnValue(123456789)
  const euid = spyOn(process, 'geteuid').mockReturnValue(0)
  const spawnGetent = mock((_argv: string[]) => ({
    exitCode: 0,
    stdout: Buffer.from(`invoker:x:123456789:123456789::${root}:/bin/sh\n`),
  }))
  try {
    expect(invokingHome({ HOME: '' }, spawnGetent)).toBe(root)
    expect(spawnGetent).toHaveBeenCalledWith(['/usr/bin/getent', 'passwd', '123456789'])
  } finally {
    uid.mockRestore()
    euid.mockRestore()
  }
})

test('[R17] doctor reports a missing pack as an error', async () => {
  const checks = await checkHooksPack(paths(), async () => [])
  expect(checks[0]?.status).toBe('error')
  expect(checks[0]?.message).toContain('--hooks')
})

test('[R17] doctor accepts all five managed hooks after removing the user hooks', async () => {
  installHooks(paths())
  uninstallHooks(paths(), undefined)
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: '/etc/codex/requirements.toml', command: `'/etc/codex/hooks/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  expect((await checkHooksPack(paths(), async () => listed)).map(check => check.status)).toEqual(['ok', 'info'])
  expect((await checkHooksPack(paths(), async () => listed.slice(1)))[0]?.status).toBe('error')
})

test('[R17] doctor passes only when every pack hook is trusted', async () => {
  installHooks(paths())
  const hooksFile = join(root, '.codex', 'hooks.json')
  const entries = (status: string) => PACK_EVENTS.map(eventName => ({ eventName, sourcePath: hooksFile, trustStatus: status }))
  expect((await checkHooksPack(paths(), async () => entries('trusted'))).map(check => check.status)).toEqual(['ok', 'ok', 'info'])
  const untrusted = await checkHooksPack(paths(), async () => entries('untrusted'))
  expect(untrusted[1]?.status).toBe('warning')
  expect(untrusted[1]?.message).toMatch(/довер/)
  const unknown = await checkHooksPack(paths(), async () => { throw new Error('no app-server') })
  expect(unknown[1]?.status).toBe('warning')
})

const ours = (event: string) => `'/usr/local/bin/bun' '${paths().main.replace(/'/g, `'\\''`)}' ${event}`
const readHooks = () => JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')) as
  { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }

test('[R17] the installer keeps foreign handlers that share a group with ours and backs hooks.json up once', () => {
  mkdirSync(join(root, '.codex'))
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: ours('Stop') }, { type: 'command', command: '/opt/sibling.sh' }] }] } })
  writeFileSync(join(root, '.codex', 'hooks.json'), original)
  installHooks(paths())
  installHooks(paths())
  const stop = readHooks().hooks.Stop?.flatMap(group => group.hooks.map(hook => hook.command)) ?? []
  expect(stop).toContain('/opt/sibling.sh')
  expect(stop.filter(command => command.includes('main.ts'))).toHaveLength(1)
  const backups = readdirSync(join(root, '.codex')).filter(name => /^hooks\.json\.bak\.\d{8}-\d{6}/.test(name))
  expect(backups).toHaveLength(1)
  expect(readFileSync(join(root, '.codex', backups[0] ?? ''), 'utf8')).toBe(original)
})

test('[R17] --uninstall removes exactly our handlers and the env flag', () => {
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/other-hook.sh' }] }] } }))
  installHooks(paths())
  const envFile = join(root, 'plugin.env')
  writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN=x\nKROT_CODEX_HOOKS=1\nKROT_ACK_REACTION=off\n')
  uninstallHooks(paths(), envFile)
  const file = readHooks()
  expect(JSON.stringify(file)).not.toContain('main.ts')
  expect(JSON.stringify(file.hooks.PreToolUse)).toContain('/opt/other-hook.sh')
  expect(readFileSync(envFile, 'utf8')).toBe('TELEGRAM_BOT_TOKEN=x\nKROT_ACK_REACTION=off\n')
})

test('[R17] doctor trust looks only at our handler of each event', async () => {
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/other-hook.sh' }] }] } }))
  installHooks(paths())
  const hooksFile = join(root, '.codex', 'hooks.json')
  const listed = (ourStatus: string, otherStatus: string, withCommand: boolean) => [
    { eventName: 'PreToolUse', sourcePath: hooksFile, trustStatus: otherStatus, ...(withCommand ? { command: '/opt/other-hook.sh' } : {}) },
    ...PACK_EVENTS.map(eventName => ({ eventName, sourcePath: hooksFile, trustStatus: ourStatus, ...(withCommand ? { command: ours(eventName) } : {}) })),
  ]
  for (const withCommand of [true, false]) {
    expect((await checkHooksPack(paths(), async () => listed('trusted', 'untrusted', withCommand)))[1]?.status).toBe('ok')
    expect((await checkHooksPack(paths(), async () => listed('untrusted', 'trusted', withCommand)))[1]?.status).toBe('warning')
  }
  // One of ours missing from the list is not trusted.
  expect((await checkHooksPack(paths(), async () => listed('trusted', 'trusted', true).slice(0, -1)))[1]?.status).toBe('warning')
})
