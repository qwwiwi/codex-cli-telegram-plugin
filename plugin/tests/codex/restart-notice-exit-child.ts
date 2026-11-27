// Child process of restart-notice-exit.test.ts: one stop notice through the production Telegram stack
// (createTelegramStack + ownerNoticeSender, as server.ts wires them) against a fake Bot API, then the
// script ends. The parent measures how long this process stays alive after the notice settled.
import { Bot } from 'grammy'

import { createLogger } from '../../src/log.js'
import { RestartNotices } from '../../src/codex/restart-notice.js'
import { createTelegramStack, ownerNoticeSender } from '../../src/codex/telegram-stack.js'

const [apiRoot, stateDir, scenario, waitMs] = process.argv.slice(2)
if (!apiRoot || !stateDir || !scenario || !waitMs) throw new Error('usage: child <apiRoot> <stateDir> <scenario> <waitMs>')

const TOKEN = '123456:TEST-token'
const OWNER = '42'
const bot = new Bot(TOKEN, { client: { apiRoot } })
const log = createLogger('restart-notice-exit-child')
const { reliableTelegram } = createTelegramStack({ bot, token: TOKEN, log, secrets: [], deadLetter: () => undefined })

// A long flood wait from an earlier send: the notice then waits for rate capacity, not for HTTP.
if (scenario === 'cooldown') await reliableTelegram.sendMessage(OWNER, 'earlier message', {}).catch(() => undefined)

const notices = new RestartNotices({
  stateDir, waitMs: Number(waitMs), send: ownerNoticeSender(reliableTelegram, OWNER, []),
})
notices.boot({ crashed: false, safe: false })
await notices.stopping()
process.stdout.write('settled\n')
