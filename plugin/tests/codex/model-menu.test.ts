import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EditOpts, InlineKeyboardLike, SendMessageOpts } from '../../src/channel/tools.js'
import { ControlState } from '../../src/codex/control-state.js'
import { MODEL_MENU_CALLBACK, ModelMenu, modelKeyboard, type CodexModel } from '../../src/codex/model-menu.js'

const OWNER = 83956
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const models: CodexModel[] = [
  { name: 'gpt-mini', default: false, efforts: ['low', 'medium'], defaultEffort: 'medium' },
  { name: 'gpt-main', default: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  { name: 'gpt-plain', default: false, efforts: [] },
]

type Sent = { id: number; text: string; keyboard: InlineKeyboardLike | undefined }

function fixture(list: CodexModel[] = models) {
  const root = mkdtempSync(join(tmpdir(), 'krot-model-menu-'))
  dirs.push(root)
  const controls = new ControlState(root, false)
  const messages: Sent[] = []
  let next = 500
  const telegram = {
    async sendMessage(_chat: string, text: string, options: SendMessageOpts) {
      messages.push({ id: ++next, text, keyboard: options.reply_markup })
      return { message_id: next }
    },
    async editMessageText(_chat: string, id: number, text: string, options: EditOpts) {
      const message = messages.find(m => m.id === id)
      if (!message) throw new Error('message to edit not found')
      message.text = text
      message.keyboard = options.reply_markup
    },
  }
  const create = (efforts = true) =>
    new ModelMenu({ ownerId: OWNER, chat: String(OWNER), telegram, controls, models: async () => list, efforts })
  const buttons = (message: Sent | undefined) => (message?.keyboard?.inline_keyboard ?? []).flat()
  const tap = (menu: ModelMenu, message: Sent, label: string, from = OWNER) => {
    const button = buttons(message).find(b => b.text.replace(/^✓ /, '') === label)
    if (!button?.callback_data) throw new Error('no button ' + label)
    return menu.answer({ data: button.callback_data, fromId: from, chatId: from, chatType: 'private', messageId: message.id })
  }
  return { root, controls, messages, create, buttons, tap }
}

test('[R71] model keyboard lists every model, default first, current marked, two per row', () => {
  const keyboard = modelKeyboard(models, 'gpt-mini', 'a1b2c3d4')
  expect(keyboard.inline_keyboard.map(row => row.map(b => b.text))).toEqual([
    ['gpt-main', '✓ gpt-mini'],
    ['gpt-plain'],
  ])
  for (const button of keyboard.inline_keyboard.flat()) {
    expect(button.callback_data).toMatch(MODEL_MENU_CALLBACK)
    expect(Buffer.byteLength(button.callback_data!)).toBeLessThanOrEqual(64)
  }
})

test('[R71] /cc model menu marks the configured model, or the default one when none is chosen', async () => {
  const { messages, create, controls } = fixture()
  const menu = create()
  await menu.open()
  expect(messages[0]!.keyboard!.inline_keyboard.flat().map(b => b.text)).toEqual(['✓ gpt-main', 'gpt-mini', 'gpt-plain'])
  controls.selectModel('gpt-plain')
  await menu.open()
  expect(messages[1]!.keyboard!.inline_keyboard.flat().map(b => b.text)).toEqual(['gpt-main', 'gpt-mini', '✓ gpt-plain'])
})

test('[R72] tapping a model sets it for the next turns and persists it like /cc model', async () => {
  const { root, messages, create, controls, tap } = fixture()
  const menu = create()
  await menu.open()
  expect(await tap(menu, messages[0]!, 'gpt-mini')).toBe('Модель: gpt-mini')
  expect(controls.model).toBe('gpt-mini')
  expect(new ControlState(root, false).model).toBe('gpt-mini')
  // The same message turns into a short confirmation.
  expect(messages).toHaveLength(1)
  expect(messages[0]!.text).toContain('Модель для следующих запросов: gpt-mini')
})

test('[R72] the /cc model <name> text command keeps its validation', async () => {
  const { create, controls } = fixture()
  const menu = create()
  expect(await menu.choose('gpt-plain')).toBe('Модель для следующих запросов: gpt-plain')
  expect(controls.model).toBe('gpt-plain')
  expect(await menu.choose('nonexistent')).toBe('Такой модели нет в списке /cc model.')
  expect(controls.model).toBe('gpt-plain')
  expect(await menu.choose('default')).toBe('Модель для следующих запросов: gpt-main')
  expect(controls.model).toBe('gpt-main')
})

test('[R73] a callback from anyone but the owner in the private chat is refused', async () => {
  const { messages, create, controls, buttons } = fixture()
  const menu = create()
  await menu.open()
  const data = buttons(messages[0]).find(b => b.text === 'gpt-mini')!.callback_data!
  expect(await menu.answer({ data, fromId: 777, chatId: 777, chatType: 'private', messageId: messages[0]!.id })).toBeUndefined()
  expect(await menu.answer({ data, fromId: OWNER, chatId: -100, chatType: 'supergroup', messageId: messages[0]!.id })).toBeUndefined()
  expect(controls.model).toBeUndefined()
  expect(messages[0]!.text).not.toContain('gpt-mini')
})

test('[R74] buttons from before a restart answer that the menu is stale', async () => {
  const { messages, create, controls, tap } = fixture()
  const before = create()
  await before.open()
  const restarted = create()
  expect(await tap(restarted, messages[0]!, 'gpt-mini')).toBe('Меню устарело, открой /cc заново')
  expect(await restarted.answer({ data: 'krot:cm:zz:9', fromId: OWNER, chatId: OWNER, chatType: 'private', messageId: 1 }))
    .toBe('Меню устарело, открой /cc заново')
  expect(controls.model).toBeUndefined()
})

test('[R75] the effort row offers only the efforts the chosen model supports, current marked', async () => {
  const { root, messages, create, controls, tap, buttons } = fixture()
  const menu = create()
  await menu.open()
  await tap(menu, messages[0]!, 'gpt-mini')
  expect(buttons(messages[0]).map(b => b.text)).toEqual(['низкое', '✓ среднее'])
  expect(await tap(menu, messages[0]!, 'низкое')).toBe('Усилие: низкое')
  expect(controls.effort).toBe('low')
  expect(new ControlState(root, false).effort).toBe('low')
  expect(messages[0]!.text).toContain('gpt-mini')
  expect(messages[0]!.text).toContain('низкое')

  // A model without effort options gets no effort row.
  await menu.open()
  await tap(menu, messages[1]!, 'gpt-plain')
  expect(buttons(messages[1])).toEqual([])
})

test('[R75] switching to a model that lacks the chosen effort drops it back to the model default', async () => {
  const { messages, create, controls, tap, buttons } = fixture()
  controls.selectModel('gpt-main')
  controls.selectEffort('xhigh')
  const menu = create()
  await menu.open()
  await tap(menu, messages[0]!, 'gpt-mini')
  expect(controls.effort).toBeUndefined()
  expect(buttons(messages[0]).map(b => b.text)).toEqual(['низкое', '✓ среднее'])
  // A remaining effort button whose model is no longer current is stale.
  await menu.open()
  await tap(menu, messages[1]!, 'gpt-main')
  const high = buttons(messages[1]).find(b => b.text === 'высокое')!.callback_data!
  await menu.choose('gpt-mini')
  expect(await menu.answer({ data: high, fromId: OWNER, chatId: OWNER, chatType: 'private', messageId: messages[1]!.id }))
    .toBe('Меню устарело, открой /cc заново')
  expect(controls.effort).toBeUndefined()
})

test('[R77] behind the root relay, which refuses an effort on turn/start, no effort row is offered', async () => {
  const { messages, create, controls, tap, buttons } = fixture()
  const menu = create(false)
  await menu.open()
  await tap(menu, messages[0]!, 'gpt-main')
  expect(controls.model).toBe('gpt-main')
  expect(buttons(messages[0])).toEqual([])
  expect(messages[0]!.text).toBe('Модель для следующих запросов: gpt-main')
})

test('[R72] a model switch saves the model and its effort in one write, so a failed write never pairs them wrongly', async () => {
  const { root, controls, create } = fixture()
  controls.selectModel('gpt-main')
  controls.selectEffort('xhigh')
  // A second write would fail (disk full after the first one).
  const writes: Array<[string | undefined, string | undefined]> = []
  const selectEffort = controls.selectEffort.bind(controls)
  controls.selectEffort = (effort: string | undefined) => {
    writes.push([controls.model, effort])
    throw new Error('disk full')
  }
  const menu = create()
  // gpt-mini has no xhigh: the effort falls back to the model default together with the switch.
  await menu.choose('gpt-mini').catch(() => undefined)
  controls.selectEffort = selectEffort
  const saved = new ControlState(root, false)
  expect([saved.model, saved.effort]).toEqual(['gpt-mini', undefined])
  expect([controls.model, controls.effort]).toEqual(['gpt-mini', undefined])
  expect(writes).toEqual([])
})

test('the model/list result is cached for at most 10 minutes and refreshed when the model menu is opened', async () => {
  const { messages, tap } = fixture()
  let now = Date.UTC(2026, 10, 26, 10)
  let calls = 0
  const root = mkdtempSync(join(tmpdir(), 'krot-model-cache-'))
  dirs.push(root)
  const telegram = {
    async sendMessage(_chat: string, text: string, options: SendMessageOpts) {
      messages.push({ id: messages.length + 1, text, keyboard: options.reply_markup })
      return { message_id: messages.length }
    },
    async editMessageText() {},
  }
  const menu = new ModelMenu({
    ownerId: OWNER, chat: String(OWNER), telegram, controls: new ControlState(root, false), efforts: true,
    models: async () => { calls++; return models }, now: () => now,
  })
  await menu.choose('gpt-mini')
  await menu.choose('gpt-main')
  expect(calls).toBe(1)
  now += 9 * 60_000
  await menu.choose('gpt-mini')
  expect(calls).toBe(1)
  now += 60_000
  await menu.choose('gpt-mini')
  expect(calls).toBe(2)
  // A tap on /cc → «Модель» always asks the App Server again, and the buttons reuse that fresh list.
  await menu.open()
  expect(calls).toBe(3)
  const message = messages.at(-1)
  if (!message) throw new Error('model menu did not send a message')
  expect(await tap(menu, message, 'gpt-plain')).toBe('Модель: gpt-plain')
  expect(calls).toBe(3)
})

test('a wall-clock rollback does not extend the model/list cache lifetime', async () => {
  const { controls } = fixture()
  const telegram = { async sendMessage() { return { message_id: 1 } }, async editMessageText() {} }
  let calls = 0
  const menu = new ModelMenu({
    ownerId: OWNER, chat: String(OWNER), telegram, controls, efforts: true,
    models: async () => { calls++; return models },
  })
  const wallClock = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const monotonicClock = spyOn(performance, 'now').mockReturnValue(1000)
  try {
    await menu.choose('gpt-mini')
    wallClock.mockReturnValue(1_799_999_000_000)
    monotonicClock.mockReturnValue(1000 + 10 * 60_000 - 1)
    await menu.choose('gpt-mini')
    expect(calls).toBe(1)
    monotonicClock.mockReturnValue(1000 + 10 * 60_000)
    await menu.choose('gpt-mini')
    expect(calls).toBe(2)
  } finally {
    monotonicClock.mockRestore()
    wallClock.mockRestore()
  }
})
