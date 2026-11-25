import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeProxy, runDoctor } from '../scripts/doctor.js'
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

async function checkInstallation(options: { botId?: number; webhook?: string; omitOwner?: boolean; networkError?: boolean } = {}) {
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
