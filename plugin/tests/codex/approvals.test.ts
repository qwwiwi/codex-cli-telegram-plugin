import { expect, test } from 'bun:test'
import type { SendMessageOpts } from '../../src/channel/tools.js'
import { ApprovalCards } from '../../src/codex/approvals.js'

function fixture() {
  const messages: { text: string; options: SendMessageOpts }[] = []
  const edits: { id: number; text: string; keyboard: unknown }[] = []
  const cards = new ApprovalCards(123, {
    sendMessage: async (_chat, text, options) => {
      messages.push({ text, options })
      return { message_id: 7 }
    },
    editMessageText: async (_chat, id, text, options) => { edits.push({ id, text, keyboard: options?.reply_markup }) },
  }, ['fake-secret'])
  return { cards, messages, edits }
}

test('one visible Telegram approval is bound to the owner, chat and message', async () => {
  const { cards, messages, edits } = fixture()
  const result = cards.request({ kind: 'command', target: 'printf test', cwd: '/workspace' })
  await Promise.resolve()
  const key = messages[0]!.options.reply_markup!.inline_keyboard[0]![0]!.callback_data!
  expect(messages[0]!.text).toContain('printf test')
  expect(cards.resolve(key, 999, 123, 7)).toBe(false)
  expect(cards.resolve(key, 123, 123, 8)).toBe(false)
  expect(cards.resolve(key, 123, 123, 7)).toBe(true)
  expect(await result).toBe('accept')
  expect(edits[0]).toEqual({
    id: 7,
    text: '🔐 <b>Запрос подтверждения</b>\n\nИнструмент: <code>Bash</code>\nПричина: Действие требует твоего подтверждения.\n\n<b>✅ Разрешено</b>',
    keyboard: { inline_keyboard: [] },
  })
  expect(cards.resolve(key, 123, 123, 7)).toBe(false)
})

test('renders the legacy confirmation card and escapes the Codex command', async () => {
  const { cards, messages, edits } = fixture()
  const result = cards.request({
    kind: 'command', target: 'printf "<test>"', cwd: '/workspace', reason: 'Write outside workspace',
  })
  await Promise.resolve()
  const { text, options } = messages[0]!
  expect(options.parse_mode).toBe('HTML')
  expect(text).toContain('🔐 <b>Запрос подтверждения</b>')
  expect(text).toContain('Инструмент: <code>Bash</code>')
  expect(text).toContain('Причина: Write outside workspace')
  expect(text).toContain('<pre>/workspace\nprintf "&lt;test&gt;"</pre>')
  const buttons = options.reply_markup!.inline_keyboard[0]!
  expect(buttons.map(button => button.text)).toEqual(['✅ Allow', '❌ Deny'])
  expect(cards.resolve(buttons[1]!.callback_data!, 123, 123, 7)).toBe(true)
  expect(await result).toBe('decline')
  expect(edits[0]).toEqual({
    id: 7,
    text: '🔐 <b>Запрос подтверждения</b>\n\nИнструмент: <code>Bash</code>\nПричина: Write outside workspace\n\n<b>❌ Запрещено</b>',
    keyboard: { inline_keyboard: [] },
  })
})

test('does not request approval when a command cannot safely be shown', async () => {
  const { cards, messages } = fixture()
  expect(await cards.request({ kind: 'command', target: 'printf fake-secret' })).toBe('decline')
  expect(messages).toHaveLength(0)
})

test('stale buttons cannot allow a request cancelled by stop', async () => {
  const { cards, messages } = fixture()
  const result = cards.request({ kind: 'command', target: 'printf test' })
  await Promise.resolve()
  const key = messages[0]!.options.reply_markup!.inline_keyboard[0]![0]!.callback_data!
  cards.cancelAll()
  expect(await result).toBe('cancel')
  expect(cards.resolve(key, 123, 123, 7)).toBe(false)
})
