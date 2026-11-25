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
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    expect(address.address).toBe('127.0.0.1')
    const submit = (chatId: number, token = 'synthetic-test-secret') => fetch(
      'http://127.0.0.1:' + address.port + '/hooks/agent', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'idempotency-key': 's-job' },
        body: JSON.stringify({ message: 'do this', chatId, agentId: 'dashi-channel' }),
      },
    )
    expect((await submit(123, 'bad')).status).toBe(401)
    expect((await submit(99)).status).toBe(403)
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
