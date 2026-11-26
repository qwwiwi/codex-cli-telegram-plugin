import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodex, probeProxy, runDoctor } from '../scripts/doctor.js'
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

async function checkInstallation(options: { botId?: number; webhook?: string; omitOwner?: boolean; networkError?: boolean; env?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'krotov-doctor-'))
  try {
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'))
    const calls: string[] = []
    const checks = await runDoctor({
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_EXPECTED_BOT_ID: '100001',
      TELEGRAM_ALLOWED_USER_IDS: options.omitOwner ? undefined : '200001',
      TELEGRAM_ALLOWED_CHAT_IDS: '200001',
      TELEGRAM_WORKSPACE_ROOT: join(root, 'workspace'),
      TELEGRAM_STATE_DIR: join(root, 'state'),
      ...options.env,
    }, {
      checkCodex: () => ({ status: 'ok', message: 'Codex CLI готов' }),
      telegram: async (method) => {
        calls.push(method)
        if (options.networkError) throw new Error(token)
        return method === 'getMe'
          ? { id: options.botId ?? 100001 }
          : { url: options.webhook ?? '' }
      },
    })
    return { checks, calls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('doctor verifies a private setup without reading Telegram updates', async () => {
  const { checks, calls } = await checkInstallation()
  expect(checks.every(check => check.status === 'ok')).toBe(true)
  expect(calls).toEqual(['getMe', 'getWebhookInfo'])
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
