import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SendWidgetParams } from '../../src/channel/tools.js'
import { AgentChatActions } from '../../src/codex/chat-actions.js'
import {
  AgentComponents, COMPONENT_NAMES, componentFallbackText, componentInstructions, componentTools, finalAfterComponents,
} from '../../src/codex/components.js'
import { createLogger } from '../../src/log.js'
import { WidgetPreSendError } from '../../src/safety/pre-send-error.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { fakeTelegramChat, settledWithin } from './fake-telegram-chat.js'

const OWNER = '123'
const packs = join(import.meta.dir, '../../vendor/html-components/telegram/packs')
const pack = (name: string, file: 'schema.json' | 'example.json'): unknown =>
  JSON.parse(readFileSync(join(packs, name, file), 'utf8'))

type Call = [string, ...unknown[]]
const unexpected = async (): Promise<never> => { throw new Error('Unexpected Telegram call') }

// A component bridge over a recording fake: widgets get ids from 77 up.
function bridge(api: Partial<{
  sendWidget: (chat: string, params: SendWidgetParams) => Promise<{ message_id: number }>
  sendMessage: (chat: string, text: string, opts: object) => Promise<{ message_id: number }>
  deleteMessage: (chat: string, id: number) => Promise<void>
}> = {}, order: string[] = []) {
  const calls: Call[] = []
  let next = 76
  const components = new AgentComponents({
    sendWidget: api.sendWidget ?? (async (chat, params) => {
      order.push('widget')
      calls.push(['widget', chat, params])
      return { message_id: ++next }
    }),
    sendMessage: api.sendMessage ?? (async (chat, text, opts) => {
      order.push('text')
      calls.push(['text', chat, text, opts])
      return { message_id: ++next }
    }),
    deleteMessage: api.deleteMessage ?? (async (chat, id) => { calls.push(['delete', chat, id]) }),
  }, OWNER, { beforeSend: async () => { order.push('hud') } })
  const pins: number[] = []
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, setMessageReaction: unexpected,
    async pinChatMessage(_chat, id) { pins.push(id) }, unpinChatMessage: unexpected,
  }, OWNER, { components })
  return { actions, calls, order, pins }
}

function parsed(result: { contentItems: [{ text: string }] }): Record<string, unknown> {
  return JSON.parse(result.contentItems[0].text) as Record<string, unknown>
}

// Deterministic data that fits the line-area schema but whose full chart is over the widget budget.
function oversizeLineArea(): Record<string, unknown> {
  let seed = 7
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
  const alphabet = 'абвгдежзиклмнопрстуфхцчшщэюяABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
  const word = (length: number): string => Array.from({ length }, () => alphabet[next() % alphabet.length]).join('')
  return {
    title: word(48),
    labels: Array.from({ length: 12 }, () => word(14)),
    series: Array.from({ length: 3 }, () => ({
      label: word(18), values: Array.from({ length: 12 }, () => (next() % 199_998) - 99_999 + (next() % 100) / 100),
    })),
  }
}

test('[R12][R13] the Codex thread is offered send_component, update_component and component_schema over the vendored packs', () => {
  expect(componentTools.map(tool => tool.name)).toEqual(['send_component', 'update_component', 'component_schema'])
  const send = componentTools[0]
  expect(send.inputSchema.properties.component.enum).toContain('kpi')
  expect(send.inputSchema.properties.component.enum).toHaveLength(16)
})

test('[R12][R13] the model sends a component: the vendored pack renders a widget after the HUD card has landed', async () => {
  const { actions, calls, order, pins } = bridge()
  const data = pack('kpi', 'example.json')
  const result = await actions.component('c1', 'send_component', { component: 'kpi', data }, () => true)
  expect(result.success).toBe(true)
  expect(parsed(result)).toEqual({ tool: 'send_component', ok: true, message_ids: [77], delivery: 'widget' })
  expect(order).toEqual(['hud', 'widget'])
  const [, chat, params] = calls[0] as [string, string, SendWidgetParams]
  expect(chat).toBe(OWNER)
  expect(params.html).toContain('<main class="kpi">')
  expect(params.caption).toContain('Итоги практикума')
  // The widget is a known message now: the model can pin it with telegram_action.
  expect((await actions.call('pin', { action: 'pin', target: 77 }, () => true)).success).toBe(true)
  expect(pins).toEqual([77])
  // A replayed tool call does not send a second widget.
  await actions.component('c1', 'send_component', { component: 'kpi', data }, () => true)
  expect(calls).toHaveLength(1)
})

test('[R12][R13] the model edits its component: a new widget replaces the old one, other messages are refused', async () => {
  const { actions, calls } = bridge()
  actions.remember(12, false)
  await actions.component('send', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  const update = await actions.component('update', 'update_component', {
    message_id: 77, component: 'kpi', data: { title: 'Итоги недели', metrics: [{ label: 'Занятий', value: 14 }] },
  }, () => true)
  expect(parsed(update)).toEqual({ tool: 'update_component', ok: true, message_ids: [78], delivery: 'widget', replaced: 77 })
  expect(calls.map(call => call[0])).toEqual(['widget', 'widget', 'delete'])
  expect(calls[2]).toEqual(['delete', OWNER, 77])
  expect((calls[1]![2] as SendWidgetParams).caption).toContain('Итоги недели')

  const owner = await actions.component('owner', 'update_component', {
    message_id: 12, component: 'kpi', data: pack('kpi', 'example.json'),
  }, () => true)
  const replaced = await actions.component('old', 'update_component', {
    message_id: 77, component: 'kpi', data: pack('kpi', 'example.json'),
  }, () => true)
  expect(owner.success).toBe(false)
  expect(replaced.success).toBe(false)
  expect(calls).toHaveLength(3)
})

test('[R13] component_schema returns the vendored schema and example and sends nothing', async () => {
  const { actions, calls, order } = bridge()
  const result = await actions.component('s1', 'component_schema', { component: 'line-area' }, () => true)
  expect(result.success).toBe(true)
  expect(parsed(result)).toEqual({
    tool: 'component_schema', ok: true, message_ids: [], component: 'line-area',
    schema: pack('line-area', 'schema.json'), example: pack('line-area', 'example.json'),
  })
  expect((await actions.component('s2', 'component_schema', { component: 'nope' }, () => true)).success).toBe(false)
  expect(calls).toEqual([])
  expect(order).toEqual([])
})

test('[R13] oversize chart data falls back to the static variant of the widget', async () => {
  const { actions, calls } = bridge()
  const result = await actions.component('big', 'send_component', { component: 'line-area', data: oversizeLineArea() }, () => true)
  expect(parsed(result)).toEqual({ tool: 'send_component', ok: true, message_ids: [77], delivery: 'widget', variant: 'static' })
  const [, , params] = calls[0] as [string, string, SendWidgetParams]
  expect(params.html).toContain('<main class="line-area">')
  expect(Buffer.byteLength(params.html)).toBeLessThanOrEqual(32768)
})

test('[R13] a component the widget cannot show reaches the owner once as plain text', async () => {
  const invalid = bridge()
  const metrics = Array.from({ length: 5 }, (_, i) => ({ label: 'Метрика ' + i, value: i }))
  const text = await invalid.actions.component('bad', 'send_component', { component: 'kpi', data: { title: 'Итоги', metrics } }, () => true)
  expect(parsed(text)).toMatchObject({ tool: 'send_component', ok: true, message_ids: [77], delivery: 'text' })
  expect(String(parsed(text).hint)).toContain('INVALID_DATA')
  expect(invalid.order).toEqual(['hud', 'text'])
  expect(String(invalid.calls[0]![2])).toContain('Итоги')
  expect(String(invalid.calls[0]![2])).toContain('Метрика 4')

  const refused = bridge({
    async sendWidget() { throw Object.assign(new Error('Bad Request: widget rejected'), { error_code: 400 }) },
  })
  const fallback = await refused.actions.component('400', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  expect(parsed(fallback)).toMatchObject({ ok: true, delivery: 'text' })
  expect(refused.calls.map(call => call[0])).toEqual(['text'])

  // A failure after Telegram may have taken the widget: no text copy, the model must not resend.
  const unknown = bridge({
    async sendWidget() { throw Object.assign(new Error('Internal Server Error'), { error_code: 502 }) },
  })
  const ambiguous = await unknown.actions.component('502', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  expect(parsed(ambiguous)).toMatchObject({ ok: false, delivery: 'unknown' })
  expect(unknown.calls).toEqual([])
})

test('[R12] a component is not sent after the turn stopped', async () => {
  const { actions, calls } = bridge()
  const result = await actions.component('late', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => false)
  expect(result.success).toBe(false)
  expect(calls).toEqual([])
})

test('[R12] a component widget waits in the chat send queue of the rate limiter', async () => {
  const chat = fakeTelegramChat()
  chat.hold('HUD')
  const api = createRateLimitedTelegramApi(chat.raw, createLogger('components-test'), { jitterMaxMs: 0 })
  const card = api.sendMessage(OWNER, 'HUD A', {})
  await Bun.sleep(1)
  const widget = api.sendWidget(OWNER, { html: '<main class="kpi"></main>', caption: 'kpi' })
  await Bun.sleep(1)
  expect(await settledWithin(widget, 20)).toBe('pending')
  expect(chat.rawCalls).toEqual(['HUD A'])
  chat.releaseAll()
  await card
  await widget
  expect(chat.texts()).toEqual(['HUD A', 'widget: kpi'])
})

test('[R13] the component list is exactly the vendored packs', () => {
  const names: string[] = [...COMPONENT_NAMES]
  expect(names.sort()).toEqual(readdirSync(packs).sort())
})

test('[R12] widget html that carries a configured secret is refused before Telegram, the caption is redacted', async () => {
  const sent: SendWidgetParams[] = []
  const chat = fakeTelegramChat()
  const api = createSafeTelegramApi({
    ...chat.raw, async sendWidget(_chat, params) { sent.push(params); return { message_id: 9 } },
  }, createLogger('components-test'), ['owner-secret-value'])
  await expect(api.sendWidget(OWNER, { html: '<main>owner-secret-value</main>', caption: 'kpi' }))
    .rejects.toBeInstanceOf(WidgetPreSendError)
  expect(sent).toEqual([])
  await api.sendWidget(OWNER, { html: '<main class="kpi"></main>', caption: 'kpi owner-secret-value' })
  expect(sent).toHaveLength(1)
  expect(sent[0]!.html).toBe('<main class="kpi"></main>')
  expect(sent[0]!.caption).not.toContain('owner-secret-value')
})

test('[R12] a rate-limited widget gets no text copy while the flood wait runs', async () => {
  const limited = bridge({
    async sendWidget() {
      throw Object.assign(new Error('Too Many Requests: retry after 30'), { error_code: 429, parameters: { retry_after: 30 } })
    },
  })
  const result = await limited.actions.component('429', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  expect(parsed(result)).toMatchObject({ ok: false, message_ids: [] })
  expect(limited.order).toEqual(['hud'])
  expect(limited.calls).toEqual([])
})

test('[R12] a component stopped while it waits for the HUD card is never sent', async () => {
  let current = true
  const calls: string[] = []
  const components = new AgentComponents({
    async sendWidget() { calls.push('widget'); return { message_id: 5 } },
    async sendMessage() { calls.push('text'); return { message_id: 6 } },
    async deleteMessage() { calls.push('delete') },
  }, OWNER, { beforeSend: async () => { current = false } })
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, setMessageReaction: unexpected,
    pinChatMessage: unexpected, unpinChatMessage: unexpected,
  }, OWNER, { components })
  const result = await actions.component('stop', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => current)
  expect(result.success).toBe(false)
  expect(calls).toEqual([])
})

test('[R12][R13] a configured secret with an HTML-escaped character in the model data never reaches the widget transport', async () => {
  const secret = 'owner&secret-value'
  const widgets: SendWidgetParams[] = []
  const texts: string[] = []
  const chat = fakeTelegramChat()
  const api = createSafeTelegramApi({
    ...chat.raw,
    async sendWidget(_chat, params) { widgets.push(params); return { message_id: 9 } },
    async sendMessage(_chat, text) { texts.push(text); return { message_id: 10 } },
  }, createLogger('components-test'), [secret])
  const components = new AgentComponents(api, OWNER, { redact: text => redactSecrets(text, [secret]) })
  const data = { title: `Ключ ${secret}`, metrics: [{ label: 'Занятий', value: 12 }] }
  const outcome = await components.run('send_component', { component: 'kpi', data }, () => true)
  // The renderer escapes `&` to `&amp;`, so only the raw model fields still show the secret.
  expect(widgets).toEqual([])
  expect(outcome).toMatchObject({ ok: true, delivery: 'text' })
  expect(texts).toHaveLength(1)
  expect(texts[0]).not.toContain(secret)
  expect(texts[0]).toContain('Занятий')
})

test('[R12] a turn stopped while Telegram refuses the widget gets no text copy', async () => {
  let current = true
  const calls: string[] = []
  const components = new AgentComponents({
    async sendWidget() {
      calls.push('widget')
      current = false
      throw Object.assign(new Error('Bad Request: widget rejected'), { error_code: 400 })
    },
    async sendMessage() { calls.push('text'); return { message_id: 6 } },
    async deleteMessage() { calls.push('delete') },
  }, OWNER)
  const outcome = await components.run('send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true, () => current)
  expect(outcome.ok).toBe(false)
  expect(outcome.message_ids).toEqual([])
  expect(calls).toEqual(['widget'])
})

test('[R12] a flood wait from a widget holds every later send until its deadline', async () => {
  let clock = 1_000_000
  const sentAt: Array<[string, number]> = []
  const chat = fakeTelegramChat()
  const api = createRateLimitedTelegramApi({
    ...chat.raw,
    async sendWidget() {
      throw Object.assign(new Error('Too Many Requests: retry after 30'), { error_code: 429, parameters: { retry_after: 30 } })
    },
    async sendMessage(chatId, text) { sentAt.push([`${chatId}:${text}`, clock]); return { message_id: 1 } },
  }, createLogger('components-test'), {
    jitterMaxMs: 0, now: () => clock, sleep: async ms => { clock += Math.max(ms, 1) },
  })
  const start = clock
  await expect(api.sendWidget(OWNER, { html: '<main class="kpi"></main>', caption: 'kpi' })).rejects.toMatchObject({ error_code: 429 })
  await api.sendMessage(OWNER, 'after', {})
  await api.sendMessage('456', 'other chat', {})
  expect(sentAt.map(([what]) => what)).toEqual([`${OWNER}:after`, '456:other chat'])
  for (const [, at] of sentAt) expect(at - start).toBeGreaterThanOrEqual(30_000)
})

test('[R12][R13] component message IDs stay out of the persisted target cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-component-targets-'))
  try {
    let next = 76
    const components = new AgentComponents({
      async sendWidget() { return { message_id: ++next } },
      async sendMessage() { return { message_id: ++next } },
      async deleteMessage() {},
    }, OWNER)
    const pins: number[] = []
    const api = {
      sendMessage: unexpected, editMessageText: unexpected, setMessageReaction: unexpected,
      async pinChatMessage(_chat: string, id: number) { pins.push(id) }, unpinChatMessage: unexpected,
    }
    const actions = new AgentChatActions(api, OWNER, { root, components })
    actions.remember(12, true)
    await actions.component('c1', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
    // Known for this run: the model may pin its widget.
    expect((await actions.call('pin', { action: 'pin', target: 77 }, () => true)).success).toBe(true)
    expect(pins).toEqual([77])
    const saved = JSON.parse(readFileSync(join(root, 'codex-chat-targets.json'), 'utf8')) as { targets: [number, unknown][] }
    expect(saved.targets.map(([id]) => id)).toEqual([12])
    const restarted = new AgentChatActions(api, OWNER, { root, components })
    expect((await restarted.call('pin2', { action: 'pin', target: 77 }, () => true)).success).toBe(false)
    expect((await restarted.call('pin3', { action: 'pin', target: 12 }, () => true)).success).toBe(true)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('[R12][R13] a send_component replayed after 1,000 schema calls in the same turn posts no second widget', async () => {
  const { actions, calls } = bridge()
  const data = pack('kpi', 'example.json')
  await actions.component('send', 'send_component', { component: 'kpi', data }, () => true)
  for (let i = 0; i < 1000; i++) await actions.component(`schema-${i}`, 'component_schema', { component: 'kpi' }, () => true)
  const replay = await actions.component('send', 'send_component', { component: 'kpi', data }, () => true)
  expect(parsed(replay)).toMatchObject({ ok: true, message_ids: [77], delivery: 'widget' })
  expect(calls.map(call => call[0])).toEqual(['widget'])
})

// The shape of a Telegram error description: an UPPER_SNAKE code after the HTTP status. The code below is an example of
// that shape, not a claim about a real Bot API code.
const TELEGRAM_CODE = 'INPUT_WIDGET_REPLY_NOT_ALLOWED'
const refusal = (code: string) =>
  Object.assign(new Error(`Call to 'sendWidget' failed! (400: Bad Request: ${code})`), { error_code: 400 })

test('[R12][R13] a Telegram error code survives redaction in the widget refusal hint, real secrets stay masked', async () => {
  expect(redactSecrets(`Bad Request: ${TELEGRAM_CODE}`)).toBe(`Bad Request: ${TELEGRAM_CODE}`)
  expect(redactSecrets('MESSAGE_TOO_LONG_FOR_THIS_CHAT_TYPE')).toBe('MESSAGE_TOO_LONG_FOR_THIS_CHAT_TYPE')
  // Mixed case, digits or no underscore: still masked by the long-token rule.
  for (const secret of ['AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'ABCDEFGHIJKLMNOPQRSTUVWXYZAB', 'ABCD_EFGH_1234567890_WXYZ_QRST',
    'abcd_efgh_ijkl_mnop_qrst_uvwx']) {
    expect(redactSecrets(`key ${secret} end`)).not.toContain(secret)
  }
  expect(redactSecrets('123456789:AAHfakefakefakefakefakefakefakefake12')).toBe('[REDACTED]')

  const refused = bridge({ async sendWidget() { throw refusal(TELEGRAM_CODE) } })
  const result = await refused.actions.component('code', 'send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  expect(parsed(result)).toMatchObject({ ok: true, delivery: 'text' })
  expect(String(parsed(result).hint)).toContain(TELEGRAM_CODE)
})

test('[R12][R13] a widget refused as not allowed with a reply target is sent once more without the reply', async () => {
  const attempts: Array<number | undefined> = []
  const notAllowed = bridge({
    async sendWidget(_chat, params) {
      attempts.push(params.reply_to_message_id)
      if (params.reply_to_message_id !== undefined) throw refusal(TELEGRAM_CODE)
      return { message_id: 90 }
    },
  })
  notAllowed.actions.remember(1321, false)
  const sent = await notAllowed.actions.component('reply', 'send_component',
    { component: 'progress', data: { title: 'Демо', label: 'Выполнено задач', value: 75 }, target: 1321 }, () => true)
  expect(parsed(sent)).toMatchObject({ ok: true, message_ids: [90], delivery: 'widget' })
  expect(attempts).toEqual([1321, undefined])
  expect(notAllowed.calls).toEqual([])

  // Any other refusal, or a refusal without a reply target, gets no second widget attempt.
  const other: Array<number | undefined> = []
  const rejected = bridge({
    async sendWidget(_chat, params) { other.push(params.reply_to_message_id); throw refusal('WIDGET_HTML_INVALID') },
  })
  rejected.actions.remember(1321, false)
  await rejected.actions.component('other', 'send_component',
    { component: 'progress', data: { title: 'Демо', label: 'Выполнено задач', value: 75 }, target: 1321 }, () => true)
  const bare = bridge({ async sendWidget(_chat, params) { other.push(params.reply_to_message_id); throw refusal(TELEGRAM_CODE) } })
  await bare.actions.component('bare', 'send_component',
    { component: 'progress', data: { title: 'Демо', label: 'Выполнено задач', value: 75 } }, () => true)
  expect(other).toEqual([1321, undefined])
  expect(rejected.calls.map(call => call[0])).toEqual(['text'])
  expect(bare.calls.map(call => call[0])).toEqual(['text'])
})

test('[R12][R13] after a text fallback the owner gets exactly one message: a repeat of the fallback text or an empty final is dropped', async () => {
  // undefined stands for the fallback text itself, repeated by the model with different spacing.
  for (const planned of [undefined, '', '  \n']) {
    const chat = fakeTelegramChat()
    chat.owner('voice')
    const components = new AgentComponents({
      ...chat.raw, async sendWidget() { throw refusal(TELEGRAM_CODE) },
    }, OWNER)
    const actions = new AgentChatActions({
      sendMessage: unexpected, editMessageText: unexpected, setMessageReaction: unexpected,
      pinChatMessage: unexpected, unpinChatMessage: unexpected,
    }, OWNER, { components })
    actions.remember(101, false)
    const key = JSON.stringify(['thread', 'turn-1', 'call-1'])
    const result = await actions.component(key, 'send_component',
      { component: 'progress', data: { title: 'Агент · Демо', label: 'Выполнено задач', value: 75 }, target: 101 }, () => true)
    expect(parsed(result)).toMatchObject({ delivery: 'text' })
    // The tool result tells the model to end the turn without a final message.
    expect(String(parsed(result).hint)).toContain('пустым финальным ответом')
    expect(actions.componentDelivery(['turn-1'])).toBe('text')
    const final = planned ?? '  ' + (chat.texts()[1] ?? '').replace(/\n/g, '\n\n') + '\n'
    // The bridge decides on the final answer: what it sends lands in the chat.
    if (finalAfterComponents(final, actions.componentDelivery(['turn-1']), actions.componentTexts(['turn-1'])) === 'send') {
      await chat.raw.sendMessage(OWNER, final, {})
    }
    expect(chat.texts()).toHaveLength(2)
    expect(chat.texts()[0]).toBe('voice')
    expect(chat.texts()[1]).toContain('Выполнено задач')
  }
  expect(componentInstructions).toContain('пустым финальным ответом')
})

test('[R12][R13] a widget fallback whose text an interim reply of the same turn already delivered reuses that message', async () => {
  const chat = fakeTelegramChat()
  const components = new AgentComponents({ ...chat.raw, async sendWidget() { throw refusal(TELEGRAM_CODE) } }, OWNER)
  const actions = new AgentChatActions({ ...chat.raw, pinChatMessage: unexpected, unpinChatMessage: unexpected }, OWNER, { components })
  const data = { title: 'Демо', label: 'Выполнено задач', value: 75 }
  const same = componentFallbackText('progress', data, undefined, text => redactSecrets(text))
  let firstTurn = true
  const [reply, widget] = await Promise.all([
    actions.call(JSON.stringify(['thread', 'turn-1', 'reply-1']), { action: 'reply', text: same }, () => firstTurn),
    actions.component(JSON.stringify(['thread', 'turn-1', 'call-1']), 'send_component', { component: 'progress', data }, () => firstTurn),
  ])
  expect(parsed(reply)).toMatchObject({ ok: true })
  const replyId = (parsed(reply).message_ids as number[])[0]
  expect(chat.texts()).toEqual([same])
  expect(parsed(widget)).toMatchObject({ ok: true, delivery: 'text', message_ids: [replyId] })
  expect(actions.componentDelivery(['turn-1'])).toBe('text')
  // A reply of a turn that is over, or one with a different text, is not reused.
  firstTurn = false
  await actions.call(JSON.stringify(['thread', 'turn-2', 'reply-2']), { action: 'reply', text: 'Другое' }, () => true)
  await actions.component(JSON.stringify(['thread', 'turn-2', 'call-2']), 'send_component', { component: 'progress', data }, () => true)
  expect(chat.texts()).toEqual([same, 'Другое', same])
})

test('[R12][R13] after a text fallback a distinct short final, such as a rollback result, still reaches the owner', async () => {
  const chat = fakeTelegramChat()
  const components = new AgentComponents({ ...chat.raw, async sendWidget() { throw refusal(TELEGRAM_CODE) } }, OWNER)
  const actions = new AgentChatActions({
    sendMessage: unexpected, editMessageText: unexpected, setMessageReaction: unexpected,
    pinChatMessage: unexpected, unpinChatMessage: unexpected,
  }, OWNER, { components })
  await actions.component(JSON.stringify(['thread', 'turn-1', 'call-1']), 'send_component',
    { component: 'progress', data: { title: 'Миграция', label: 'Выполнено шагов', value: 40 } }, () => true)
  expect(actions.componentDelivery(['turn-1'])).toBe('text')
  const rollback = 'Откатил миграцию. База снова на версии 12.'
  expect(finalAfterComponents(rollback, 'text')).toBe('send')
  expect(finalAfterComponents(rollback, actions.componentDelivery(['turn-1']), actions.componentTexts(['turn-1']))).toBe('send')
  expect(finalAfterComponents('Telegram не отобразил виджет, данные пришли текстом.', 'text')).toBe('send')
})

test('[R12][R13] the final answer after a component: an empty one is dropped, real answers still go out', () => {
  // A delivered widget and an empty final: nothing more, no "no answer" notice.
  expect(finalAfterComponents('', 'widget')).toBe('drop')
  expect(finalAfterComponents('Виджет показывает прогресс курса.', 'widget')).toBe('send')
  // After a text fallback a question, a long answer or several paragraphs are content, not a failure report.
  expect(finalAfterComponents('Показать данные ещё и таблицей?', 'text')).toBe('send')
  expect(finalAfterComponents('Итог: ' + 'данные '.repeat(60), 'text')).toBe('send')
  expect(finalAfterComponents('Первая строка.\nВторая строка.\nТретья строка.', 'text')).toBe('send')
  // No component in the turn: the bridge keeps its usual handling of an empty answer.
  expect(finalAfterComponents('', undefined)).toBe('send')
  // Only the given turns count; a component of another turn or a non-component key does not.
  const { actions } = bridge()
  expect(actions.componentDelivery(['turn-1'])).toBeUndefined()
})

test('[R85] a widget Telegram refuses is logged at warn with its error code and redacted description, no payload', async () => {
  const token = '123456789:' + 'A'.repeat(35)
  const warnings: Array<[string, Record<string, unknown> | undefined]> = []
  const components = new AgentComponents({
    async sendWidget() {
      throw Object.assign(new Error(`Call to 'sendWidget' failed! (400: Bad Request: WIDGET_HTML_INVALID ${token})`),
        { error_code: 400, description: `Bad Request: WIDGET_HTML_INVALID ${token}` })
    },
    async sendMessage() { return { message_id: 6 } },
    async deleteMessage() {},
  }, OWNER, { log: { warn: (message, context) => { warnings.push([message, context]) } } })
  const outcome = await components.run('send_component', { component: 'kpi', data: pack('kpi', 'example.json') }, () => true)
  expect(outcome.delivery).toBe('text')
  expect(warnings).toHaveLength(1)
  const [message, context] = warnings[0]!
  expect(message).toContain('widget')
  expect(context).toMatchObject({ component: 'kpi', error: { code: 400 } })
  const logged = JSON.stringify(context)
  expect(logged).toContain('WIDGET_HTML_INVALID')
  expect(logged).not.toContain(token)
  // The rendered widget never reaches the log.
  expect(logged).not.toContain('<')
})

test('[R13] a diagram the widget refuses reaches the owner as a numbered flow, never node kinds or index pairs', async () => {
  // The live payload: a flowchart with return edges (3→2, 4→2, 2→1), which the flowchart pack rejects as cyclic.
  const labels = ['Ты пишешь боту', 'Плагин на сервере', 'Codex ведёт задачу', 'Модель OpenAI', 'Файлы и команды', 'Ответ в Telegram']
  const data = {
    title: 'Как Тиранда отвечает в Telegram',
    nodes: labels.map(label => ({ label, kind: 'step' })),
    edges: [[0, 1], [1, 2], [2, 3], [3, 2], [2, 4], [4, 2], [2, 1], [1, 5]].map(([source, target]) => ({ source, target })),
  }
  const { actions, calls } = bridge()
  const result = await actions.component('flow', 'send_component', { component: 'flowchart', data }, () => true)
  expect(parsed(result)).toMatchObject({ ok: true, delivery: 'text' })
  expect(calls.map(call => call[0])).toEqual(['text'])
  expect(calls[0]![2]).toBe([
    'Как Тиранда отвечает в Telegram',
    '1. Ты пишешь боту → Плагин на сервере',
    '2. Плагин на сервере → Codex ведёт задачу, Ответ в Telegram',
    '3. Codex ведёт задачу → Модель OpenAI, Файлы и команды, Плагин на сервере',
    '4. Модель OpenAI → Codex ведёт задачу',
    '5. Файлы и команды → Codex ведёт задачу',
    '6. Ответ в Telegram',
  ].join('\n'))
  // A plain chain in node order reads as numbered steps; edge labels of an architecture graph stay with their arrow.
  const chain = { title: 'Путь', nodes: labels.slice(0, 3).map(label => ({ label, kind: 'step' })),
    edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }] }
  expect(componentFallbackText('flowchart', chain, undefined, text => text))
    .toBe('Путь\n1. Ты пишешь боту\n2. Плагин на сервере\n3. Codex ведёт задачу')
  expect(componentFallbackText('architecture', pack('architecture', 'example.json') as Record<string, unknown>, undefined,
    text => text)).not.toMatch(/^\d+ \d+$|→ \d/mu)
  // The model is told why a flowchart with return edges is refused and what to use instead.
  expect(componentInstructions).toContain('flowchart')
  expect(componentInstructions).toContain('без возвратов')
})
