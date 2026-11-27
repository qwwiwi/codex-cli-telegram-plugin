import { expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodex, probeProxy, runDoctor } from '../scripts/doctor.js'
import { OWNER_INSTRUCTIONS_CHECK_PREFIX, ownerInstructionChecks } from '../src/codex/owner-instructions-lock.js'
import { getStatePaths, loadConfig, RuntimeEnvSchema } from '../src/config.js'

const token = '100001:fake-token-with-enough-characters'

test('omitted routing configuration leaves Telegram identity and access unconfigured', () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-config-'))
  try {
    const env = { TELEGRAM_BOT_TOKEN: token, XDG_STATE_HOME: root }
    const config = loadConfig(env)
    expect(config.bot_id).toBeUndefined()
    expect(config.allowed_user_ids).toEqual([])
    expect(config.allowed_chat_ids).toEqual([])
    expect(config.permission_relay.allowed_user_ids).toEqual([])
    expect(getStatePaths(config, RuntimeEnvSchema.parse(env)).root).toBe(join(root, 'krotov-plugin'))
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('doctor verifies ChatGPT login through the configured App Server connection', async () => {
  const command = [process.execPath, join(import.meta.dir, 'codex', 'fake-app-server.ts')] as const
  expect((await probeProxy(import.meta.dir, process.env, [...command, 'chatgpt'])).status).toBe('ok')
  expect((await probeProxy(import.meta.dir, process.env, [...command, 'apiKey'])).status).toBe('error')
})

async function checkInstallation(options: { botId?: number; webhook?: string; omitOwner?: boolean; networkError?: boolean; env?: Record<string, string>; instructionsProtected?: boolean; mutableOverride?: boolean; codexConfig?: string; unit?: { name: string; text: string } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'krotov-doctor-'))
  try {
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'))
    const codexHome = join(root, 'codex')
    mkdirSync(codexHome)
    if (options.codexConfig !== undefined) writeFileSync(join(codexHome, 'config.toml'), options.codexConfig)
    if (options.unit) {
      const units = join(root, 'config/systemd/user')
      mkdirSync(units, { recursive: true })
      writeFileSync(join(units, options.unit.name), options.unit.text)
    }
    writeFileSync(join(codexHome, 'AGENTS.md'), '')
    const override = join(codexHome, 'AGENTS.override.md')
    if (options.mutableOverride) writeFileSync(override, '')
    const lockCheck = mock((home: string) => ownerInstructionChecks(home, path => {
      const flags = options.instructionsProtected === false || path === override ? '--------------e-------' : '----i---------e-------'
      return `${flags} ${path}\n`
    }))
    const calls: string[] = []
    const checks = await runDoctor({
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_EXPECTED_BOT_ID: '100001',
      TELEGRAM_ALLOWED_USER_IDS: options.omitOwner ? undefined : '200001',
      TELEGRAM_ALLOWED_CHAT_IDS: '200001',
      TELEGRAM_WORKSPACE_ROOT: join(root, 'workspace'),
      TELEGRAM_STATE_DIR: join(root, 'state'),
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(root, 'config'),
      ...options.env,
    }, {
      checkCodex: () => ({ status: 'ok', message: 'Codex CLI готов' }),
      listHooks: async () => [],
      managedCheck: () => ({ status: 'ok', message: 'Managed hooks fixture' }),
      ownerInstructionChecks: lockCheck,
      telegram: async (method) => {
        calls.push(method)
        if (options.networkError) throw new Error(token)
        return method === 'getMe'
          ? { id: options.botId ?? 100001 }
          : { url: options.webhook ?? '' }
      },
    })
    return { checks, calls, codexHome, lockCheck }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('doctor reads the configured service unit and checks its own failure notifier', async () => {
  const name = 'fixture-bridge.service'
  const text = `
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=6
OnFailure=fixture-bridge-failed.service
[Service]
ExecStartPre=-/bin/bash "/fixture state/boot-guard.sh"
Restart=on-failure
RestartSec=10s
RestartForceExitStatus=75
SuccessExitStatus=75
RestartPreventExitStatus=78
TimeoutStopSec=90`
  const { checks } = await checkInstallation({ unit: { name, text }, env: { KROT_CODEX_SERVICE_NAME: name } })
  expect(checks.find(check => check.message.includes(name))?.status).toBe('ok')
})

test('doctor warns about enabled HTTP MCP servers without default tool approval when cards are off', async () => {
  const codexConfig = `
[mcp_servers."needs-approval"]
url = "https://mcp.example.test/private"
default_tools_approval_mode = "prompt"
[mcp_servers.missing]
url = "https://mcp.example.test/missing"
enabled = true
[mcp_servers.approved]
url = "https://mcp.example.test/approved"
default_tools_approval_mode = "approve"
[mcp_servers.disabled]
url = "https://mcp.example.test/disabled"
enabled = false
[mcp_servers.local]
command = "fixture-mcp"
`
  const warnings = (checks: Awaited<ReturnType<typeof runDoctor>>) => checks.filter(check =>
    check.status === 'warning' && check.message.includes('default_tools_approval_mode = "approve"'))
  const approvalsOff: Record<string, string>[] = [{}, { KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'never' }]
  for (const env of approvalsOff) {
    const { checks } = await checkInstallation({ codexConfig, env })
    const messages = warnings(checks).map(check => check.message).join('\n')
    expect(messages).toContain('needs-approval')
    expect(messages).toContain('missing')
    expect(messages).not.toMatch(/mcp\.example\.test|approved|disabled|fixture-mcp/)
  }
  for (const mode of ['standard', 'risky']) {
    const { checks } = await checkInstallation({ codexConfig, env: { KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: mode } })
    expect(warnings(checks)).toEqual([])
  }
})

test('doctor verifies a private setup without reading Telegram updates', async () => {
  const { checks, calls } = await checkInstallation()
  expect(checks.every(check => check.status === 'ok')).toBe(true)
  expect(calls).toEqual(['getMe', 'getWebhookInfo'])
})

test('doctor warns with the chattr hint when the owner instructions are not protected', async () => {
  const { checks, codexHome, lockCheck } = await checkInstallation({ instructionsProtected: false })
  const path = join(codexHome, 'AGENTS.md')
  expect(lockCheck).toHaveBeenCalledWith(codexHome)
  const lockLines = checks.filter(check => check.message.startsWith(OWNER_INSTRUCTIONS_CHECK_PREFIX))
  expect(lockLines).toEqual([{
    status: 'warning',
    message: expect.stringContaining(`${path}: NOT protected.`),
  }])
  expect(lockLines[0]?.message).toContain('sudo chattr +i ')
})

test('doctor reports a mutable AGENTS.override.md as an error even when AGENTS.md is protected', async () => {
  const { checks, codexHome } = await checkInstallation({ mutableOverride: true })
  const lockLines = checks.filter(check => check.message.startsWith(OWNER_INSTRUCTIONS_CHECK_PREFIX))
  expect(lockLines).toHaveLength(2)
  expect(lockLines[0]).toMatchObject({ status: 'ok', message: expect.stringContaining('AGENTS.md: protected') })
  expect(lockLines[1]?.status).toBe('error')
  expect(lockLines[1]?.message).toContain('AGENTS.override.md exists and is not owner-locked – Codex reads it instead of AGENTS.md')
  expect(lockLines[1]?.message).toContain(`sudo chattr +i ${join(codexHome, 'AGENTS.override.md')}`)
})

test('doctor reports the lock check as informational in proxy mode without probing the bridge home', async () => {
  const { checks, lockCheck } = await checkInstallation({
    mutableOverride: true, env: { KROT_CODEX_PROXY: process.execPath, KROT_CODEX_APPROVALS: '1' },
  })
  expect(lockCheck).not.toHaveBeenCalled()
  expect(checks.filter(check => check.message.startsWith(OWNER_INSTRUCTIONS_CHECK_PREFIX))).toEqual([{
    status: 'info', message: `${OWNER_INSTRUCTIONS_CHECK_PREFIX}lock check does not apply in proxy mode`,
  }])
})

test('doctor flags an unexpected bot and a webhook that blocks polling', async () => {
  const { checks } = await checkInstallation({ botId: 100002, webhook: 'https://example.com/private' })
  const failures = checks.filter(check => check.status === 'error').map(check => check.message).join('\n')
  expect(failures).toContain('TELEGRAM_EXPECTED_BOT_ID')
  expect(failures).toContain('webhook')
  expect(failures).not.toContain('example.com')
})

test('doctor requires an explicit owner and hides sensitive network errors', async () => {
  const { checks } = await checkInstallation({ omitOwner: true, networkError: true })
  const failures = checks.filter(check => check.status === 'error').map(check => check.message).join('\n')
  expect(failures).toContain('TELEGRAM_ALLOWED_USER_IDS')
  expect(failures).toContain('getMe')
  expect(JSON.stringify(checks)).not.toContain(token)
})

test('[R02] doctor shows whether the working bubble streams the agent thoughts', async () => {
  const line = async (env: Record<string, string>) => {
    const { checks } = await checkInstallation({ env })
    const found = checks.filter(check => check.message.startsWith('Мысли агента'))
    expect(found).toHaveLength(1)
    expect(found[0]!.status).toBe('ok')
    return found[0]!.message
  }
  const on = await line({ TELEGRAM_STATUS_THOUGHTS: '1' })
  expect(on).toContain('включены')
  expect(on).toContain('секреты')
  const off = await line({})
  expect(off).toContain('выключены')
  expect(off).toContain('TELEGRAM_STATUS_THOUGHTS=1')
  expect(await line({ TELEGRAM_STATUS_THOUGHTS: 'off' })).toContain('выключены')
})

test('[R01] doctor reports the active approval mode, including never', async () => {
  const mode = async (approvals: Record<string, string>) => {
    const { checks } = await checkInstallation({ env: approvals })
    return checks.filter(check => check.message.startsWith('Режим подтверждений:'))
  }
  const never = await mode({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'never' })
  expect(never).toHaveLength(1)
  expect(never[0]!.status).toBe('ok')
  expect(never[0]!.message).toContain('never')
  expect(never[0]!.message).toContain('без карточек')
  const unset = await mode({})
  expect(unset[0]!.message).toContain('never')
  const standard = await mode({ KROT_CODEX_APPROVALS: '1' })
  expect(standard[0]!.message).toContain('standard')
  expect((await mode({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'standard' }))[0]!.message).toContain('standard')
  const risky = await mode({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'risky' })
  expect(risky[0]!.status).toBe('ok')
  expect(risky[0]!.message).toContain('risky')
  const { checks } = await checkInstallation({ env: { KROT_CODEX_APPROVAL_MODE: 'risky' } })
  expect(checks.filter(check => check.status === 'error').map(check => check.message).join('\n'))
    .toContain('KROT_CODEX_APPROVAL_MODE=risky укажите KROT_CODEX_APPROVALS=1')
})

test('[R02] doctor shows the automatic inbound reaction and the agent reaction palette', async () => {
  const line = async (env: Record<string, string>) => {
    const { checks } = await checkInstallation({ env })
    return checks.filter(check => check.message.startsWith('Реакции:'))
  }
  const off = await line({ KROT_ACK_REACTION: 'off' })
  expect(off).toHaveLength(1)
  expect(off[0]!.status).toBe('ok')
  expect(off[0]!.message).toContain('KROT_ACK_REACTION=off')
  expect(off[0]!.message).toContain('👍 ❤ 🔥 🎉 😁 🤔 👏 🙏 💯 🤝')
  const unset = await line({})
  expect(unset[0]!.message).toContain('KROT_ACK_REACTION=off')
  expect((await line({ KROT_ACK_REACTION: 'eyes' }))[0]!.message).toContain('KROT_ACK_REACTION=eyes')
  expect((await line({ KROT_REACTION_PALETTE: '🔥,👍' }))[0]!.message).toContain('🔥 👍')
  const { checks } = await checkInstallation({ env: { KROT_REACTION_PALETTE: '🔥,🦖' } })
  expect(checks.filter(check => check.status === 'error').map(check => check.message).join('\n'))
    .toContain('KROT_REACTION_PALETTE')
})

test('[R01] doctor fails a proxy setup whose approval mode is never, as startup does, without probing the proxy', async () => {
  const probed: string[] = []
  const probe = async (workspace: string): Promise<{ status: 'ok'; message: string }> => {
    probed.push(workspace)
    return { status: 'ok', message: 'proxy ok' }
  }
  const proxyEnv = { KROT_CODEX_PROXY: process.execPath, KROT_CODEX_APPROVALS: '1' }
  const never = await checkCodex({ ...proxyEnv, KROT_CODEX_APPROVAL_MODE: 'never' }, import.meta.dir, probe)
  expect(never.status).toBe('error')
  expect(never.message).toContain('never')
  expect(probed).toEqual([])
  expect((await checkCodex(proxyEnv, import.meta.dir, probe)).status).toBe('ok')
  expect(probed).toEqual([import.meta.dir])
})

test('[R17] doctor checks the Codex hooks pack only when KROT_CODEX_HOOKS=1', async () => {
  const hooksCheck = (checks: Array<{ status: string; message: string }>) => checks.find(check => check.message.includes('Хуки Codex'))
  expect(hooksCheck((await checkInstallation()).checks)).toBeUndefined()
  const codexHome = join(tmpdir(), `krotov-doctor-no-codex-${process.pid}`)
  const { checks } = await checkInstallation({ env: { KROT_CODEX_HOOKS: '1', CODEX_HOME: codexHome } })
  expect(hooksCheck(checks)?.status).toBe('error')
  expect(hooksCheck(checks)?.message).toContain('--hooks')
})

test('[R17] doctor warns and completes the other checks when gh is missing', async () => {
  const spawn = Bun.spawnSync
  const probe = spyOn(Bun, 'spawnSync').mockImplementation(argv => {
    if (Array.isArray(argv) && argv[0] === 'git') return spawn(['/bin/printf', '%s\n', import.meta.dir])
    throw Object.assign(new Error('gh executable is missing'), { code: 'ENOENT' })
  })
  try {
    const { checks, calls } = await checkInstallation({ env: { KROT_CODEX_HOOKS: '1' } })
    expect(probe.mock.calls.at(-1)?.[0]).toEqual(['gh', 'api', 'repos/{owner}/{repo}/rules/branches/main'])
    expect(checks.find(check => check.message.includes('(gh api)'))?.status).toBe('warning')
    expect(calls).toEqual(['getMe', 'getWebhookInfo'])
  } finally {
    probe.mockRestore()
  }
})
