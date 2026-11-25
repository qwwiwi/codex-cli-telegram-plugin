import { expect, test } from 'bun:test'
import type { Server } from 'node:http'
import { createConnection } from 'node:net'
import { startExternalTasks } from '../../src/codex/external.js'
import { QuestionCards } from '../../src/codex/questions.js'

function post(server: Server, route: string, value: unknown, token = 'task-test-token', signal?: AbortSignal) {
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing local address')
  return fetch('http://127.0.0.1:' + address.port + '/hooks/' + route, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(value), ...(signal ? { signal } : {}),
  })
}

function close(server: Server) {
  return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
}

test('legacy question waits for the owner card and preserves the original response keys', async () => {
  const marker = '[LEASE: production] Выбрать режим?'
  let grant = false
  let shown!: (card: { body: string; choose: string }) => void
  const card = new Promise<{ body: string; choose: string }>(resolve => { shown = resolve })
  const cards = new QuestionCards('123', {
    async sendMessage(_chat, body, options) {
      const choose = options.reply_markup?.inline_keyboard[0]?.[0]?.callback_data
      if (choose) shown({ body, choose })
      return { message_id: 7 }
    },
    async editMessageText() {},
  }, [], { timeoutMs: 2000, previewChars: 1000 }, undefined, async () => { grant = true; return 'Granted' })
  const server = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted', {
    token: 'policy-test-token', request: async () => 'decline',
  }, { ask: { timeoutMs: 2000, request: (questions, signal) => cards.ask(questions, signal) } })
  try {
    const questions = [{ header: 'Режим', question: marker, multiSelect: false,
      options: [{ label: 'Да', description: 'Первый режим', preview: 'Предпросмотр' },
        { label: 'Нет', description: 'Второй режим' }] }]
    const payload = { session_id: 'session', tool_use_id: 'ask_1', questions }
    const route = 'ask-user-question/request'
    expect((await post(server, route, payload, 'policy-test-token')).status).toBe(401)
    const response = post(server, route, payload)
    const result = await Promise.race([card, response.then(async unexpected => {
      throw new Error('Question returned before owner answer: ' + unexpected.status)
    })])
    expect(result.body).toContain('Предпросмотр')
    expect(result.body).toContain('Режим')
    expect((await post(server, 'ask-user-question/answer', {
      request_id: 'aabbc', action: 'choose', selected_option_index: 0, user_id: 123, chat_id: '123',
    })).status).toBe(403)
    expect(cards.resolve(result.choose, 7)).toBe(true)
    expect(await (await response).json()).toEqual({ status: 'answered', updatedInput: { questions, answers: { [marker]: 'Да' } } })
    expect(grant).toBe(false)
    expect(await (await post(server, route, payload)).json()).toEqual({
      status: 'answered', updatedInput: { questions, answers: { [marker]: 'Да' } },
    })
  } finally { cards.cancel(); await close(server) }
})

test('legacy question respects the caller deadline and disabled relay', async () => {
  const payload = { session_id: 'session', tool_use_id: 'ask_2', timeout_ms: 20,
    questions: [{ header: 'Time', question: 'Continue?', multiSelect: false,
      options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Finish now' }] }] }
  const disabled = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted')
  try {
    expect(await (await post(disabled, 'ask-user-question/request', payload)).json()).toEqual({ status: 'pass_through' })
  } finally { await close(disabled) }
  const enabled = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted', undefined, {
    ask: { timeoutMs: 2000, request: async (_questions, signal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return {}
    } },
  })
  try {
    expect(await (await post(enabled, 'ask-user-question/request', payload)).json()).toMatchObject({ status: 'timeout' })
  } finally { await close(enabled) }
})

test('a disconnected legacy caller cannot keep a question open beyond its deadline', async () => {
  let start!: () => void
  let cancel!: (name: string | undefined) => void
  const started = new Promise<void>(resolve => { start = resolve })
  const cancelled = new Promise<string | undefined>(resolve => { cancel = resolve })
  const server = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted', undefined, {
    ask: { timeoutMs: 100, request: async (_questions, signal) => {
      if (!signal.aborted) {
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
          start()
        })
      }
      cancel(signal.reason?.name)
      return {}
    } },
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const body = JSON.stringify({ session_id: 'session', tool_use_id: 'ask_3',
      questions: [{ header: 'Confirm', question: 'Continue?', multiSelect: false,
        options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Finish now' }] }],
    })
    const socket = createConnection(address.port, '127.0.0.1')
    socket.write('POST /hooks/ask-user-question/request HTTP/1.1\r\nHost: localhost\r\n' +
      'Authorization: Bearer task-test-token\r\nContent-Type: application/json\r\n' +
      'Content-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body)
    await started
    socket.destroy()
    expect(['AbortError', 'TimeoutError']).toContain(await cancelled ?? '')
  } finally { await close(server) }
})

test('legacy Bash approval uses only the policy bearer and declines a potentially truncated preview', async () => {
  const requested: unknown[] = []
  const server = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted', {
    token: 'policy-test-token',
    request: async () => { throw Error('Legacy approval must not enter the native policy bridge') },
    legacy: { timeoutMs: 2000, request: async approval => { requested.push(approval); return 'accept' } },
  })
  try {
    const route = 'permission/request'
    const payload = { session_id: 'session', tool_use_id: 'bash_1', tool_name: 'Bash',
      preview: 'printf test', reason: 'YAML policy', timeout_ms: 1000 }
    expect((await post(server, route, payload)).status).toBe(401)
    const approve = (value: unknown) => post(server, route, value, 'policy-test-token')
    expect(await (await approve({ ...payload, preview: 'x'.repeat(400) })).json()).toMatchObject({ status: 'deny' })
    expect(await (await approve({ ...payload, tool_name: 'Edit', preview: '/workspace/file' })).json()).toMatchObject({ status: 'deny' })
    expect(await (await approve(payload)).json()).toEqual({ status: 'allow' })
    expect(requested).toEqual([{ kind: 'command', target: 'printf test', reason: 'YAML policy' }])
  } finally { await close(server) }
})

test('legacy read receipts are limited to a known owner message and fallback cannot post arbitrary text', async () => {
  const reactions: number[] = []
  const server = await startExternalTasks(0, 'task-test-token', '123', () => 'accepted', {
    token: 'policy-test-token', request: async () => 'decline',
  }, { react: async id => { if (id !== 4) return false; reactions.push(id); return true } })
  try {
    const body = { chat_id: '123', message_id: '4' }
    expect((await post(server, 'react', body, 'policy-test-token')).status).toBe(401)
    expect((await post(server, 'react', { ...body, chat_id: '456' })).status).toBe(403)
    expect((await post(server, 'react', { ...body, emoji: '👍' })).status).toBe(400)
    expect((await post(server, 'react', { ...body, message_id: true })).status).toBe(400)
    expect((await post(server, 'react', { ...body, message_id: 20 })).status).toBe(403)
    expect(await (await post(server, 'react', body)).json()).toEqual({ status: 'reacted' })
    expect(reactions).toEqual([4])
    const fallback = await post(server, 'fallback-reply', { chat_id: '123', text: 'Send without a turn?' })
    expect(fallback.status).toBe(503)
    expect(await fallback.json()).toEqual({ status: 'fallback_reply_unavailable' })
  } finally { await close(server) }
})
