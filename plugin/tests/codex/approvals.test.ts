import { expect, test } from 'bun:test'
import type { SendMessageOpts } from '../../src/channel/tools.js'
import { ApprovalCards } from '../../src/codex/approvals.js'
import { CardCleanup } from '../../src/codex/card-cleanup.js'
import { createLogger } from '../../src/log.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a new bridge closes persisted buttons once without replaying the old request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-card-cleanup-'))
  try {
    const log = createLogger('test')
    const first = new CardCleanup(root, '123', log)
    first.remember(70, 'approval')
    first.remember(71, 'question')
    first.forget(70)
    const edits: unknown[] = []
    const api = { async editMessageText(_chat: string, id: number, text: string, options: unknown) {
      edits.push([id, text, options])
    } }
    await new CardCleanup(root, '123', log).recover(api)
    await new CardCleanup(root, '123', log).recover(api)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toEqual([71, '❔ Вопрос закрыт после перезапуска моста. При необходимости отправь уточнение ещё раз.',
      { reply_markup: { inline_keyboard: [] } }])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

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

test('a resolved server request closes only its own Telegram card', async () => {
  const { cards, edits } = fixture()
  const first = new AbortController()
  const second = new AbortController()
  const canceled = cards.request({ kind: 'command', target: 'printf first' }, first.signal)
  const pending = cards.request({ kind: 'command', target: 'printf second' }, second.signal)
  await Promise.resolve()
  first.abort()
  expect(await canceled).toBe('cancel')
  expect(cards.isPending).toBe(true)
  expect(edits[0]?.text).toContain('Запрос закрыт')
  second.abort()
  expect(await pending).toBe('cancel')
})

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
    text: '🔐 <b>Запрос подтверждения</b>\n\n<b>✅ Разрешено</b>',
    keyboard: { inline_keyboard: [] },
  })
  expect(cards.resolve(key, 123, 123, 7)).toBe(false)
})

test('renders the legacy confirmation card and escapes the Codex command', async () => {
  const { cards, messages, edits } = fixture()
  const result = cards.request({
    kind: 'command', target: 'printf "<test>"', cwd: '/workspace',
    reason: 'git config/hook execution surface needs confirmation <test>',
    notice: 'Та же команда может один раз выполниться вне песочницы.',
  })
  await Promise.resolve()
  const { text, options } = messages[0]!
  expect(options.parse_mode).toBe('HTML')
  expect(text).toContain('🔐 <b>Запрос подтверждения</b>')
  expect(text).toContain('Инструмент: <code>Bash</code>')
  expect(text).toContain('Причина: Команда Git может запускать скрипты или менять настройки их запуска. &lt;test&gt;')
  expect(text).toContain('Та же команда может один раз выполниться вне песочницы.')
  expect(text).toContain('<pre>/workspace\nprintf "&lt;test&gt;"</pre>')
  const buttons = options.reply_markup!.inline_keyboard[0]!
  expect(buttons.map(button => button.text)).toEqual(['✅ Allow', '❌ Deny'])
  expect(cards.resolve(buttons[1]!.callback_data!, 123, 123, 7)).toBe(true)
  expect(await result).toBe('decline')
  expect(edits[0]).toEqual({
    id: 7,
    text: '🔐 <b>Запрос подтверждения</b>\n\nПричина: Команда Git может запускать скрипты или менять настройки их запуска. &lt;test&gt;\n\n<b>❌ Запрещено</b>',
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
