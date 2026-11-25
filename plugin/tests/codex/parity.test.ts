import { expect, test } from 'bun:test'
import { startExternalTasks } from '../../src/codex/external.js'
import { CodexMirror } from '../../src/codex/mirror.js'
import { Outbox } from '../../src/safety/outbox.js'
import { createLogger } from '../../src/log.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('an outbox question keeps its metadata and receives the eventual Telegram ID', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'krot-outbox-receipt-'))
  try {
    const sent: unknown[] = []
    const settings = { stateDir, log: createLogger('test'), now: () => 0,
      sendFn: async () => ({ message_id: 57 }) }
    new Outbox(settings).enqueue('123', 'Жду твоего ответа', {}, 20, { code: 'OQ_TEST', snippet: 'Жду твоего ответа' })
    const outbox = new Outbox({ ...settings, onDelivered: (item, id) => sent.push([item.question, id]) })
    await outbox.flushDue(19_999)
    expect(sent).toEqual([])
    await outbox.flushDue(20_000)
    expect(sent).toEqual([[{ code: 'OQ_TEST', snippet: 'Жду твоего ответа' }, 57]])
    expect(outbox.size()).toBe(0)
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})

test('external task endpoint requires its bearer and owner, and uses the caller key for deduplication', async () => {
  const jobs = new Map<number, string>()
  const server = await startExternalTasks(0, 'synthetic-test-secret', '123', (message, id) => {
    if (jobs.has(id)) return 'duplicate'
    jobs.set(id, message)
    return 'accepted'
  }, undefined, { agentId: 'example-agent' })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    expect(address.address).toBe('127.0.0.1')
    for (const route of ['/health', '/healthz']) {
      expect(await (await fetch('http://127.0.0.1:' + address.port + route)).json()).toEqual({ status: 'ok' })
    }
    const submit = (chatId: number, token = 'synthetic-test-secret', agentId?: string) => fetch(
      'http://127.0.0.1:' + address.port + '/hooks/agent', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'idempotency-key': 's-job' },
        body: JSON.stringify({ message: 'do this', chatId, agentId }),
      },
    )
    expect((await submit(123, 'bad')).status).toBe(401)
    expect((await submit(99)).status).toBe(403)
    expect((await submit(123, undefined, 'other-agent')).status).toBe(404)
    expect((await submit(123, undefined, 'example-agent')).status).toBe(200)
    expect((await submit(123)).status).toBe(200)
    expect((await submit(123)).status).toBe(200)
    expect([...jobs.values()]).toEqual(['do this'])
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})

test('mirror retains bounded terminal output and redacts a secret split across deltas', async () => {
  const messages: string[] = []
  const mirror = new CodexMirror({
    async sendMessage(_chat, text) { messages.push(text); return { message_id: 1 } },
    async editMessageText(_chat, _id, text) { messages.push(text) },
  }, '123', ['hidden-test-key'])
  mirror.event('commandExecution')
  mirror.output('tool', 'first line\nhidden-test-')
  mirror.output('tool', 'key\nlast line\n')
  mirror.update('Готово')
  await Bun.sleep(0)
  expect(messages.at(-1)).toContain('first line')
  expect(messages.at(-1)).toContain('last line')
  expect(messages.join('\n')).not.toContain('hidden-test-key')
})

test('accepts a legacy listener task for the configured owner and deduplicates retries by task ID', async () => {
  const jobs = new Map<number, string>()
  const server = await startExternalTasks(0, 'test-agent', '123', (message, id) => {
    if (jobs.has(id)) return 'duplicate'
    jobs.set(id, message)
    return 'accepted'
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const submit = (value: object, secret = 'test-agent') => fetch(
      'http://127.0.0.1:' + address.port + '/hooks/agent', {
        method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      },
    )
    const task = { _task_id: 47, from_agent: 'example-sender', title: 'Отчёт', body: 'Проверь очередь.', context: 'Тест.' }
    expect((await submit(task, 'wrong')).status).toBe(401)
    expect((await submit({ ...task, chatId: 456 })).status).toBe(400)
    expect((await submit({ ...task, _task_id: 'no-id' })).status).toBe(400)
    expect(await (await submit(task)).json()).toEqual({ status: 'accepted', task_id: '47' })
    expect(await (await submit({ ...task, body: 'Повтор.' })).json()).toEqual({ status: 'accepted', task_id: '47' })
    expect(jobs.size).toBe(1)
    expect([...jobs.values()][0]).toContain('Проверь очередь.')
  } finally { server.close() }
})

test('policy confirmations use a separate loopback credential and never enqueue a task', async () => {
  const seen: unknown[] = []
  const server = await startExternalTasks(0, 'tasks-only', '123', () => { throw Error('Unexpected queued task') }, {
    token: 'policy-only',
    request: async approval => { seen.push(approval); return 'accept' },
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing local address')
    const target = { kind: 'command', target: 'printf test', cwd: '/workspace', reason: 'yaml' }
    const send = (token: string, value: unknown, path = '/hooks/permission/request') =>
      fetch('http://127.0.0.1:' + address.port + path, { method: 'POST',
        headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(value) })
    expect((await send('tasks-only', target)).status).toBe(401)
    expect((await send('policy-only', { ...target, kind: 'unknown' })).status).toBe(400)
    expect(await (await send('policy-only', target)).json()).toEqual({ decision: 'accept' })
    expect((await send('policy-only', { message: 'task', chatId: 123 }, '/hooks/agent')).status).toBe(401)
    expect(seen).toEqual([target])
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }
})
