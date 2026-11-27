import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../codex-hooks/src/config.js'
import { activateFullAccess, fullAccessGuards, guardsActive, installHookPack, installHooks, launcherScript, managedCheck, managedToml, PACK_EVENTS, selfTest, stageManaged, uninstallHooks } from '../../../codex-hooks/src/install.js'
import { printDoctorChecks } from '../../scripts/doctor.js'

// The test files belong to the runner: trust its uid where the code trusts only root.
const me = (uid: number) => uid === process.getuid?.()

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-hooks-managed-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const paths = () => ({
  codexHome: join(root, '.codex'),
  configFile: join(root, '.config', 'krotov-plugin', 'codex-hooks.json'),
  bun: process.execPath,
  main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts'),
})

test('[R17] the managed TOML runs the launcher with a timeout for every handler', () => {
  const toml = managedToml('/etc/codex/hooks')
  expect(toml).toContain('[hooks]\nmanaged_dir = "/etc/codex/hooks"\n')
  expect(toml).toContain([
    '[[hooks.PreToolUse]]',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "\'/etc/codex/hooks/run\' PreToolUse"',
    'timeout = 30',
  ].join('\n'))
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact']) expect(toml).toContain(`[[hooks.${event}.hooks]]`)
  // Codex 0.172 has no onFailure: the launcher itself blocks a failed PreToolUse (fail-closed.test.ts).
  expect(toml).not.toContain('onFailure')
  expect(toml.match(/timeout = \d+/g)).toHaveLength(6)
})

test('[R17] staging writes the managed files and returns one sudo install line without running sudo', async () => {
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-codex')
  const staged = await stageManaged(paths(), staging, etc)
  expect(existsSync(join(staging, 'requirements.toml'))).toBe(true)
  expect(readFileSync(join(staging, 'codex-hooks.js'), 'utf8')).toContain('PreToolUse')
  expect(staged.command.split('\n')).toHaveLength(1)
  expect(staged.command).toStartWith('sudo install ')
  expect(staged.command).toContain(join(staging, 'requirements.toml'))
  expect(staged.command).toContain(`${etc}/requirements.toml`)
  // Nothing was installed: the owner runs the line.
  expect(existsSync(etc)).toBe(false)
})

test('[R17] no staged managed file contains the installing user home', async () => {
  const home = '/home/a'
  const staging = join(root, 'staging')
  const pack = { ...paths(), codexHome: join(home, '.codex') }
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    await stageManaged(pack, staging)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
  expect(readdirSync(staging).sort()).toEqual(['bridge-uid', 'bun', 'bunfig.toml', 'codex-hooks.js', 'requirements.toml', 'run'])
  expect(readdirSync(staging).filter(name => readFileSync(join(staging, name)).includes(home))).toEqual([])
})

test('[R17] the switchboard cannot turn the safety guards off', () => {
  const file = join(root, 'switches.json')
  writeFileSync(file, JSON.stringify({ enabled: { safety: false, 'git-gate': false, recall: false } }))
  const config = loadConfig(file)
  expect(config.enabled.safety).toBe(true)
  expect(config.enabled['git-gate']).toBe(true)
  expect(config.enabled.recall).toBe(false)
})

test('[R17] danger-full-access is written only after the guards are seen active', async () => {
  const etc = join(root, 'etc-codex')
  const envFile = join(root, 'plugin.env')
  writeFileSync(envFile, 'KROT_CODEX_APPROVAL_MODE=never\n')
  const owned = () => true
  expect(guardsActive(etc, owned).active).toBe(false)
  expect(activateFullAccess(envFile, guardsActive(etc, owned))).toBe(false)
  expect(readFileSync(envFile, 'utf8')).not.toContain('KROT_CODEX_SANDBOX')
  const staging = join(root, 'staging')
  await stageManaged(paths(), staging, etc)
  installStaged(staging, etc)
  // Files the agent user owns are not guards it cannot switch off.
  expect(guardsActive(etc, () => false).active).toBe(false)
  expect(guardsActive(etc, owned, undefined, me).active).toBe(true)
  expect(activateFullAccess(envFile, guardsActive(etc, owned, undefined, me))).toBe(true)
  expect(readFileSync(envFile, 'utf8')).toBe('KROT_CODEX_APPROVAL_MODE=never\nKROT_CODEX_SANDBOX=danger-full-access\n')
})

test('[R17] uninstall keeps a sibling handler that only mentions the pack path', () => {
  mkdirSync(join(root, '.codex'))
  const sibling = `echo ${paths().main} PreToolUse >> /tmp/hook-audit.log`
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: sibling }] }] } }))
  installHooks(paths())
  uninstallHooks(paths(), undefined)
  const file = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  expect(file.hooks.PreToolUse?.flatMap(group => group.hooks.map(hook => hook.command))).toEqual([sibling])
})

test('[R17] two installs in the same second leave two backups', () => {
  mkdirSync(join(root, '.codex'))
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }))
  const now = new Date(Date.UTC(2026, 10, 26, 12, 0, 0))
  installHooks(paths(), now)
  uninstallHooks(paths(), undefined, now)
  const backups = readdirSync(join(root, '.codex')).filter(name => name.startsWith('hooks.json.bak.'))
  expect(backups).toHaveLength(2)
})

// What the owner's sudo line does, without root: the staged files under <etc>.
function installStaged(staging: string, etc: string): void {
  mkdirSync(join(etc, 'hooks'), { recursive: true })
  // install -D creates root-owned 0755 directories, whatever the runner's umask.
  chmodSync(etc, 0o755)
  chmodSync(join(etc, 'hooks'), 0o755)
  copyFileSync(join(staging, 'requirements.toml'), join(etc, 'requirements.toml'))
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml', 'run', 'bridge-uid']) copyFileSync(join(staging, name), join(etc, 'hooks', name))
  chmodSync(join(etc, 'hooks', 'bun'), 0o755)
  chmodSync(join(etc, 'hooks', 'run'), 0o755)
}

test('[R17] the same managed launcher protects each invoker’s Codex home', async () => {
  const installerHome = join(root, 'installer')
  const workerHome = join(root, 'worker home')
  const workerCodexHome = join(root, 'worker codex')
  const installerCodexHome = join(installerHome, '.codex')
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-codex')
  mkdirSync(installerHome)
  mkdirSync(workerHome)
  await stageManaged({ ...paths(), codexHome: installerCodexHome }, staging, etc)
  installStaged(staging, etc)

  const decision = (env: Record<string, string>, target: string) => {
    const result = Bun.spawnSync([join(etc, 'hooks', 'run'), 'PreToolUse'], {
      cwd: root,
      env, stdout: 'pipe', stderr: 'pipe',
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: 'PreToolUse', cwd: root, tool_name: 'shell', tool_input: { command: `echo x > "${target}"` },
      })),
    })
    // The launcher answers a deny itself: exit 2, the reason on stderr, nothing on stdout.
    if (result.exitCode === 2) {
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toStartWith('Заблокировано защитой Codex: ')
      return 'deny'
    }
    expect({ code: result.exitCode, stdout: result.stdout.toString() }).toEqual({ code: 0, stdout: '{}\n' })
    return undefined
  }
  expect(decision({ HOME: workerHome, CODEX_HOME: workerCodexHome }, join(workerCodexHome, 'AGENTS.md'))).toBe('deny')
  expect(decision({ HOME: workerHome, CODEX_HOME: workerCodexHome }, join(installerCodexHome, 'AGENTS.md'))).toBeUndefined()
  expect(decision({ HOME: workerHome }, join(workerHome, '.codex', 'AGENTS.md'))).toBe('deny')
  expect(decision({ HOME: 'worker home', CODEX_HOME: 'worker codex' }, join(workerCodexHome, 'AGENTS.md'))).toBe('deny')
  expect(decision({ HOME: installerHome }, join(installerCodexHome, 'AGENTS.md'))).toBe('deny')
})

test('[R17] a rerun stages an active older managed bundle and accepts the installed replacement', async () => {
  const pack = paths()
  const etc = join(root, 'etc-codex')
  const staging = join(pack.codexHome, 'managed-hooks')
  const oldStage = join(root, 'old-stage')
  const bundle = 'codex-hooks.js'
  await stageManaged(pack, oldStage, etc)
  installStaged(oldStage, etc)
  const installed = join(etc, 'hooks', bundle)
  const releaseBytes = readFileSync(installed)
  writeFileSync(installed, Buffer.concat([releaseBytes, Buffer.from('\n// Simulated older revision\n')]))
  const inspectGuards = (dir?: string) => guardsActive(dir, () => true, undefined, me)
  expect(inspectGuards(etc).active).toBe(true)
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: `${etc}/requirements.toml`, command: `'${etc}/hooks/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const messages: string[] = []
  const rerun = () => installHookPack(pack, async () => listed, {
    etc, inspectGuards, trustedOwner: me, report: message => messages.push(message),
  })

  const pending = await rerun()
  expect(existsSync(join(staging, bundle))).toBe(true)
  expect(readFileSync(join(staging, bundle)).equals(releaseBytes)).toBe(true)
  expect(messages.find(message => message.startsWith('sudo install ')))
    .toBe(`sudo install -D -o root -g root -m 0644 '${join(staging, bundle)}' '${installed}'`)
  expect(pending.active).toBe(false)
  expect(existsSync(join(pack.codexHome, 'hooks.json'))).toBe(false)

  copyFileSync(join(staging, bundle), installed)
  messages.length = 0
  expect((await rerun()).active).toBe(true)
  expect(messages.some(message => message.startsWith('sudo install '))).toBe(false)
})

test('[R17] doctor flags only a legacy installed launcher with the reinstall instruction', () => {
  const { codexHome } = paths()
  const etc = join(root, 'etc-codex')
  const managedDir = join(etc, 'hooks')
  const staging = join(codexHome, 'managed-hooks')
  const installed = join(managedDir, 'run')
  const staged = join(staging, 'run')
  const legacy = '#!/bin/sh\n# krotov-plugin codex-hooks: root-owned launcher of the managed hooks.\n' +
    `cd '${managedDir}' || exit 2\n` +
    `exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME='${root}' CODEX_HOME='${codexHome}' TMPDIR=/tmp LANG=C.UTF-8 ` +
    './bun --no-env-file --config=./bunfig.toml ./codex-hooks.js "$1"\n'
  mkdirSync(managedDir, { recursive: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(installed, legacy)
  writeFileSync(staged, launcherScript(managedDir))

  const installedCheck = managedCheck(etc)
  expect(installedCheck.status).toBe('error')
  expect(installedCheck.message).toContain(installed)
  expect(installedCheck.message).toContain('./install.sh --hooks')
  expect(installedCheck.message).toContain('sudo install')
  expect(readFileSync(installed, 'utf8')).toBe(legacy)

  writeFileSync(installed, launcherScript(managedDir))
  writeFileSync(staged, legacy)
  const stagedCheck = managedCheck(etc)
  expect(stagedCheck.status).not.toBe('error')
  expect(stagedCheck.message).not.toContain(staged)
  expect(readFileSync(staged, 'utf8')).toBe(legacy)
})

test('[R17] doctor reports installed launcher drift as a non-blocking error', () => {
  const etc = join(root, 'etc-codex')
  mkdirSync(join(etc, 'hooks'), { recursive: true })
  writeFileSync(join(etc, 'hooks', 'run'), '#!/bin/sh\n')

  const drift = managedCheck(etc)
  expect(drift).toMatchObject({ status: 'error', blocking: false })
  const lines: string[] = []
  const log = (line: string) => { lines.push(line) }
  expect(printDoctorChecks([drift], log)).toBe(0)
  expect(lines[0]).toBe(`[ОШИБКА] ${drift.message}`)
  expect(printDoctorChecks([drift, { status: 'error', message: 'Blocking error' }], log)).toBe(1)
})

test('[R17] a rerun stages a legacy installed launcher and leaves a stale staged copy alone', async () => {
  const pack = paths()
  const etc = join(root, 'etc-codex')
  const oldStage = join(root, 'old-stage')
  const staging = join(pack.codexHome, 'managed-hooks')
  await stageManaged(pack, oldStage, etc)
  installStaged(oldStage, etc)
  const installed = join(etc, 'hooks', 'run')
  writeFileSync(installed, `#!/bin/sh\nexport HOME='${root}'\n`)
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: `${etc}/requirements.toml`, command: `'${etc}/hooks/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const messages: string[] = []
  const rerun = () => installHookPack(pack, async () => listed, {
    etc, inspectGuards: () => ({ active: true, why: 'ok' }), trustedOwner: me, report: message => messages.push(message),
  })

  expect((await rerun()).active).toBe(false)
  const staged = join(staging, 'run')
  expect(messages.find(message => message.startsWith('sudo install ')))
    .toBe(`sudo install -D -o root -g root -m 0755 '${staged}' '${installed}'`)
  copyFileSync(staged, installed)
  writeFileSync(staged, '#!/bin/sh\n')
  messages.length = 0
  expect((await rerun()).active).toBe(true)
  expect(readFileSync(staged, 'utf8')).toBe('#!/bin/sh\n')
  expect(messages.some(message => message.startsWith('sudo install '))).toBe(false)
})

test('[R17] a rerun restages a requirements.toml that still carries onFailure', async () => {
  const pack = paths()
  const etc = join(root, 'etc-codex')
  const oldStage = join(root, 'old-stage')
  const staging = join(pack.codexHome, 'managed-hooks')
  await stageManaged(pack, oldStage, etc)
  installStaged(oldStage, etc)
  const toml = join(etc, 'requirements.toml')
  // The previous release put onFailure = "block" under the PreToolUse handler.
  writeFileSync(toml, managedToml(join(etc, 'hooks')).replace(/(PreToolUse"\ntimeout = 30\n)/, '$1onFailure = "block"\n'))
  expect(readFileSync(toml, 'utf8')).toContain('onFailure')
  const listed = PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: `${etc}/requirements.toml`, command: `'${etc}/hooks/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const messages: string[] = []
  const rerun = () => installHookPack(pack, async () => listed, {
    etc, inspectGuards: dir => guardsActive(dir, () => true, () => ({ ok: true, why: 'ok' }), me), trustedOwner: me, report: message => messages.push(message),
  })
  expect((await rerun()).active).toBe(false)
  // A requirements.toml that is not exactly the generated one is no active guard: the whole pack is staged again.
  const staged = join(staging, 'requirements.toml')
  expect(messages.find(message => message.startsWith('sudo install ')))
    .toStartWith(`sudo install -D -o root -g root -m 0644 '${staged}' '${toml}' && `)
  expect(readFileSync(staged, 'utf8')).toBe(managedToml(join(etc, 'hooks')))
  copyFileSync(staged, toml)
  messages.length = 0
  expect((await rerun()).active).toBe(true)
  expect(messages.some(message => message.startsWith('sudo install '))).toBe(false)
})

describe('R3 B3 + sol(b): a root-owned interpreter and a live self-test', () => {
  test('[R17] staging adds a bun copy, an empty bunfig and a launcher with a clean env and fixed cwd', async () => {
    const staging = join(root, 'staging')
    const etc = join(root, 'etc-codex')
    const staged = await stageManaged(paths(), staging, etc)
    expect(statSync(join(staging, 'bun')).size).toBe(statSync(process.execPath).size)
    expect(readFileSync(join(staging, 'bunfig.toml'), 'utf8')).toBe('')
    const launcher = readFileSync(join(staging, 'run'), 'utf8')
    expect(launcher).toStartWith('#!/bin/sh\n')
    expect(launcher).toContain(`cd '${etc}/hooks' || fail `)
    expect(launcher).toContain('\nhook() {\n  /usr/bin/env -i ')
    expect(launcher).toContain(`./bun --no-env-file --config=./bunfig.toml ./codex-hooks.js "$event"`)
    expect(readFileSync(join(staging, 'requirements.toml'), 'utf8')).not.toContain(process.execPath)
    for (const name of ['bun', 'bunfig.toml', 'run', 'codex-hooks.js']) expect(staged.command).toContain(`${etc}/hooks/${name}`)
  })

  test('[R17] the installed guards pass the self-test from a hostile cwd (bunfig preload, .env)', async () => {
    const staging = join(root, 'staging')
    const etc = join(root, 'etc-codex')
    await stageManaged(paths(), staging, etc)
    installStaged(staging, etc)
    const probe = selfTest(etc)
    expect(probe.why).toBe('ok')
    expect(probe.ok).toBe(true)
  })

  test('[R17] an interpreter or launcher the agent owns is not an active guard', async () => {
    const staging = join(root, 'staging')
    const etc = join(root, 'etc-codex')
    await stageManaged(paths(), staging, etc)
    installStaged(staging, etc)
    for (const name of ['bun', 'run', 'bunfig.toml']) {
      const guards = guardsActive(etc, path => path !== join(etc, 'hooks', name), () => ({ ok: true, why: 'ok' }))
      expect(guards.active).toBe(false)
      expect(guards.why).toContain(name)
    }
    expect(guardsActive(etc, path => path !== join(etc, 'hooks'), () => ({ ok: true, why: 'ok' })).active).toBe(false)
  })

  const broken: Array<[string, string]> = [
    ['a missing launcher', ''],
    ['a non-zero exit', '#!/bin/sh\nexit 1\n'],
    ['malformed output', '#!/bin/sh\necho not-json\n'],
    ['a hook that allows everything', '#!/bin/sh\necho {}\n'],
    ['a deny as JSON at exit 0 (the launcher must answer exit 2 itself)', `#!/bin/sh\nif grep -q "rm -rf"; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}'; else echo {}; fi\n`],
    ['an exit 2 without the launcher prefix', '#!/bin/sh\ngrep -q "rm -rf" && { echo no >&2; exit 2; }\necho {}\n'],
    ['a timeout', '#!/bin/sh\nsleep 5\n'],
  ]
  for (const [what, script] of broken) {
    test(`[R17] the self-test fails closed on ${what}, so full access stays off`, async () => {
      const staging = join(root, 'staging')
      const etc = join(root, 'etc-codex')
      await stageManaged(paths(), staging, etc)
      installStaged(staging, etc)
      const launcher = join(etc, 'hooks', 'run')
      if (script) { writeFileSync(launcher, script); chmodSync(launcher, 0o755) } else rmSync(launcher)
      const probe = selfTest(etc, 1500)
      expect(probe.ok).toBe(false)
      const envFile = join(root, 'plugin.env')
      expect(activateFullAccess(envFile, guardsActive(etc, () => true, () => probe))).toBe(false)
      expect(existsSync(envFile)).toBe(false)
    })
  }

  test('[R17] a launcher that starts bun in the caller cwd fails the self-test (cwd bunfig preload runs)', async () => {
    const staging = join(root, 'staging')
    const etc = join(root, 'etc-codex')
    await stageManaged(paths(), staging, etc)
    installStaged(staging, etc)
    const launcher = join(etc, 'hooks', 'run')
    // It keeps the verdict contract (exit 3 becomes exit 2 with the prefix) but not the fixed cwd and clean env.
    writeFileSync(launcher, `#!/bin/sh\nreason=$('${process.execPath}' '${etc}/hooks/codex-hooks.js' "$1" launcher-verdict)\n[ $? -eq 0 ] && exit 0\necho "Заблокировано защитой Codex: $reason" >&2\nexit 2\n`)
    chmodSync(launcher, 0o755)
    const probe = selfTest(etc)
    expect(probe.ok).toBe(false)
    expect(probe.why).toContain('загрузил код')
  })

  test('[R17] a stale danger-full-access line is removed while the guards are inactive', () => {
    const envFile = join(root, 'plugin.env')
    writeFileSync(envFile, 'A=1\nKROT_CODEX_SANDBOX=danger-full-access\n')
    expect(activateFullAccess(envFile, { active: false })).toBe(false)
    expect(readFileSync(envFile, 'utf8')).toBe('A=1\n')
  })
})

describe('bridge-uid: one validation for the full-access gate, doctor and the installer', () => {
  const okProbe = () => ({ ok: true, why: 'ok' })
  const listedFor = (etc: string) => PACK_EVENTS.map(eventName => ({
    eventName, sourcePath: `${etc}/requirements.toml`, command: `'${etc}/hooks/run' ${eventName}`,
    handlerType: 'command', isManaged: true, source: 'system', enabled: true, trustStatus: 'managed',
  }))
  const installed = async () => {
    const etc = join(root, 'etc-codex')
    await stageManaged(paths(), join(root, 'stage'), etc)
    installStaged(join(root, 'stage'), etc)
    return { etc, uidFile: join(etc, 'hooks', 'bridge-uid') }
  }
  const otherUid = (process.getuid?.() ?? 1000) + 1

  test('[R17] the gate is inactive unless bridge-uid is valid and names the calling uid', async () => {
    const { etc, uidFile } = await installed()
    expect(guardsActive(etc, () => true, okProbe, me)).toEqual({ active: true, why: 'ok' })
    expect((await fullAccessGuards(etc, async () => listedFor(etc), dir => guardsActive(dir, () => true, okProbe, me))).active).toBe(true)
    // Another uid recorded: this process is not the bridge user, so its hooks would be no-ops.
    writeFileSync(uidFile, `${otherUid}\n`)
    const other = guardsActive(etc, () => true, okProbe, me)
    expect(other.active).toBe(false)
    expect(other.why).toContain('./install.sh --hooks')
    expect(other.why).toContain('sudo')
    expect((await fullAccessGuards(etc, async () => listedFor(etc), dir => guardsActive(dir, () => true, okProbe, me))).active).toBe(false)
    const envFile = join(root, 'plugin.env')
    expect(activateFullAccess(envFile, guardsActive(etc, () => true, okProbe, me))).toBe(false)
    // Root recorded as the bridge user.
    writeFileSync(uidFile, '0\n')
    expect(guardsActive(etc, () => true, okProbe, me).active).toBe(false)
    // The right uid in a file root does not own (the default trust is root only).
    writeFileSync(uidFile, `${process.getuid?.()}\n`)
    if (process.getuid?.() !== 0) expect(guardsActive(etc, () => true, okProbe).active).toBe(false)
    // Missing.
    rmSync(uidFile)
    expect(guardsActive(etc, () => true, okProbe, me).active).toBe(false)
  })

  test('[R17] doctor reports an invalid bridge-uid as an error with the reinstall instruction', async () => {
    const { etc, uidFile } = await installed()
    expect(managedCheck(etc, me).status).not.toBe('error')
    writeFileSync(uidFile, `${otherUid}\n`)
    const other = managedCheck(etc, me)
    expect(other.status).toBe('error')
    expect(other.message).toContain('bridge-uid')
    expect(other.message).toContain('./install.sh --hooks')
    writeFileSync(uidFile, `${process.getuid?.()}\n`)
    if (process.getuid?.() !== 0) expect(managedCheck(etc).status).toBe('error')
  })

  test('[R17] a rerun restages bridge-uid whose bytes match but whose metadata is invalid', async () => {
    const pack = paths()
    const { etc, uidFile } = await installed()
    const staging = join(pack.codexHome, 'managed-hooks')
    // Same bytes, but writable by others: the scope check would never trust it.
    chmodSync(uidFile, 0o666)
    const messages: string[] = []
    const pending = await installHookPack(pack, async () => listedFor(etc), {
      etc, inspectGuards: () => ({ active: true, why: 'ok' }), trustedOwner: me, report: message => messages.push(message),
    })
    expect(pending.active).toBe(false)
    expect(messages.find(message => message.startsWith('sudo install ')))
      .toBe(`sudo install -D -o root -g root -m 0644 '${join(staging, 'bridge-uid')}' '${uidFile}'`)
  })

  test('[R17] a rerun by a user who is not the recorded bridge user prints the replacement line', async () => {
    const pack = paths()
    const { etc, uidFile } = await installed()
    writeFileSync(uidFile, `${otherUid}\n`)
    const messages: string[] = []
    const pending = await installHookPack(pack, async () => listedFor(etc), {
      etc, inspectGuards: dir => guardsActive(dir, () => true, okProbe, me), trustedOwner: me, report: message => messages.push(message),
    })
    expect(pending.active).toBe(false)
    const line = messages.find(message => message.startsWith('sudo install '))
    expect(line).toContain(`'${join(pack.codexHome, 'managed-hooks', 'bridge-uid')}' '${uidFile}'`)
    expect(readFileSync(join(pack.codexHome, 'managed-hooks', 'bridge-uid'), 'utf8')).toBe(`${process.getuid?.()}\n`)
  })
})
