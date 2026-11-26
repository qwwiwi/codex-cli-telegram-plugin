import { expect, test } from 'bun:test'
import { codexEnvironment, exactSecrets } from '../../src/codex/environment.js'

test('[R19i] Codex receives only allowlisted environment, including tool credentials it needs', () => {
  for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'GH_CONFIG_DIR', 'GBRAIN_BEARER']) {
    expect(codexEnvironment.test(name)).toBe(true)
  }
  for (const name of ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'KROT_AGENT_WEBHOOK_TOKEN', 'GBRAIN_BEARER_X']) {
    expect(codexEnvironment.test(name)).toBe(false)
  }
})

test('F6: every credential forwarded to Codex is also redacted by its exact value', () => {
  const env = { GBRAIN_BEARER: 'opaque0value1without2pattern', KROT_AGENT_WEBHOOK_TOKEN: 'webhook-value', PATH: '/bin' }
  expect(exactSecrets(env)).toContain('opaque0value1without2pattern')
  expect(exactSecrets(env)).toContain('webhook-value')
  expect(exactSecrets(env)).not.toContain('/bin')
})
