import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from 'grammy'
import type { BotFullInfo, Update } from 'grammy/types'

import { getStatePaths, loadConfig, RuntimeEnvSchema } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { TelegramPoller } from '../../src/telegram/poller.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('[S3] the poller reports each successful getUpdates round for the health mark', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-poller-'))
  temporary.push(root)
  const env = { TELEGRAM_BOT_TOKEN: '100001:fake-token', TELEGRAM_EXPECTED_BOT_ID: '100001', TELEGRAM_STATE_DIR: root }
  const config = loadConfig(env)
  const paths = getStatePaths(config, RuntimeEnvSchema.parse(env))
  ensureStateDirs(paths)
  // Only the fields the poller reads; a preset botInfo keeps start() off the network.
  const botInfo = { id: 100001, is_bot: true, first_name: 'Test', username: 'test_bot' } as unknown as BotFullInfo
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo })
  let rounds = 0
  let successes = 0
  let poller: TelegramPoller | undefined
  poller = new TelegramPoller({
    bot, config, statePaths: paths, log: createLogger('test'), onUpdate: async () => undefined,
    onPollSuccess: () => { successes++ },
  }, {
    getUpdates: async (): Promise<Update[]> => {
      rounds++
      if (rounds === 1) throw new Error('network down')
      if (rounds === 3) void poller?.stop()
      return []
    },
    sleep: async () => undefined,
  })
  await poller.start()
  expect(successes).toBe(2)
})
