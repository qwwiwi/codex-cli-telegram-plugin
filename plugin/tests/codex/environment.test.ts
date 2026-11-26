import { expect, test } from 'bun:test'
import { codexEnvironment } from '../../src/codex/environment.js'

test('Codex receives only allowlisted environment, including tool credentials it needs', () => {
  for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'GH_CONFIG_DIR', 'GBRAIN_BEARER']) {
    expect(codexEnvironment.test(name)).toBe(true)
  }
  for (const name of ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'KROT_AGENT_WEBHOOK_TOKEN', 'GBRAIN_BEARER_X']) {
    expect(codexEnvironment.test(name)).toBe(false)
  }
})
