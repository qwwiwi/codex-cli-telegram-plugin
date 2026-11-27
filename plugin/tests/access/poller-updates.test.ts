import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'grammy'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { TelegramPoller } from '../../src/telegram/poller.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function requested(extraUpdates?: ReadonlyArray<'my_chat_member'>): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'krot-poller-'))
  dirs.push(dir)
  let seen: readonly string[] = []
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  const poller = new TelegramPoller({
    bot: {} as unknown as Bot,
    config: {} as unknown as AppConfig,
    statePaths: { updateOffset: join(dir, 'offset') } as unknown as StatePaths,
    log: quiet,
    onUpdate: async () => {},
    ...(extraUpdates ? { extraUpdates } : {}),
  }, { getUpdates: async params => { seen = params.allowed_updates ?? []; return [] } })
  await poller.pollOnce()
  return seen
}

test('[S2] my_chat_member is requested only when the multi-user flag asks for it', async () => {
  expect(await requested()).not.toContain('my_chat_member')
  const withFlag = await requested(['my_chat_member'])
  expect(withFlag).toContain('my_chat_member')
  expect(withFlag).toContain('message')
})
