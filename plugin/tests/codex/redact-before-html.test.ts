// A configured secret must never reach Telegram, whatever characters it holds. The HTML renderer escapes
// `&`, `<`, `>` and quotes, so an exact-match redaction that runs on the rendered text no longer finds the
// value: every send and edit path redacts the source text before rendering or splitting.

import { expect, test } from 'bun:test'

import { AgentChatActions } from '../../src/codex/chat-actions.js'
import { replyPieces, type PlanStore, type PlanV3 } from '../../src/codex/reply-plan.js'
import { mask, render } from '../../src/format/visible.js'
import { escapeHtml, markdownToTelegramHtml } from '../../src/format/html.js'
import { createLogger } from '../../src/log.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

const OWNER = '123'
const log = createLogger('redact-before-html-test')
// Synthetic, carries every character the renderer escapes.
const secret = `Ow&ner<sec>"ret'-value`
const leaks = [secret, escapeHtml(secret), secret.replace('&', '&amp;')]

function expectNoLeak(texts: readonly string[]): void {
  expect(texts.length).toBeGreaterThan(0)
  for (const text of texts) for (const leak of leaks) expect(text).not.toContain(leak)
  expect(texts.join('\n')).toContain('[REDACTED]')
}

function receipts(): PlanStore {
  let plan: PlanV3 | undefined
  return { replyPart: () => undefined, hasTextReceipt: () => false, replyPlan: () => plan,
    setReplyPlan: (_id, saved) => { plan = saved } }
}

test('the prose reply path redacts the configured secret before HTML rendering and splitting', async () => {
  const chat = fakeTelegramChat()
  const api = createSafeTelegramApi(chat.raw, log, [secret])
  const reply = `**Ключ** ${secret}\n\nВторой абзац ${secret}.\n\n` + 'Длинный текст. '.repeat(400) + secret
  const shown = () => mask(render(markdownToTelegramHtml(redactSecrets(reply, [secret])), 'HTML'), [secret])
  const parts = replyPieces(receipts(), 7, shown, [secret])
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) await api.sendMessage(OWNER, part.text, { entities: part.entities })
  expectNoLeak(chat.texts())
})

test('the safe transport also masks the HTML-escaped form of a configured secret', async () => {
  const chat = fakeTelegramChat()
  const api = createSafeTelegramApi(chat.raw, log, [secret])
  await api.sendMessage(OWNER, markdownToTelegramHtml(`Ключ ${secret}`), { parse_mode: 'HTML' })
  const id = (await chat.raw.sendMessage(OWNER, 'old', {})).message_id
  await api.editMessageText(OWNER, id, markdownToTelegramHtml(`**Ключ** ${secret}`), { parse_mode: 'HTML' })
  expectNoLeak(chat.texts())
})

test('an agent edit of an ordinary text message redacts the secret before HTML rendering', async () => {
  const chat = fakeTelegramChat()
  const edits: string[] = []
  const api = {
    ...chat.raw,
    async editMessageText(chatId: string, id: number, text: string, opts: object) {
      edits.push(text)
      return chat.raw.editMessageText(chatId, id, text, opts)
    },
    pinChatMessage: async () => undefined,
    unpinChatMessage: async () => undefined,
  }
  const id = (await chat.raw.sendMessage(OWNER, 'old reply', {})).message_id
  const actions = new AgentChatActions(api, OWNER, { redact: text => redactSecrets(text, [secret]) })
  actions.remember(id, true)
  const done = actions.receive('k1', '@@TELEGRAM_ACTION ' + JSON.stringify({ action: 'edit', target: id,
    text: `**Новый** ключ ${secret}` }), () => true)
  expect(await done).toBe(true)
  expectNoLeak(edits)
})
