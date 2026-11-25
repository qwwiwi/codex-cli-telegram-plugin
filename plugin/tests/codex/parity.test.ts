import { expect, test } from 'bun:test'
import { startExternalTasks } from '../../src/codex/external.js'
import { CodexMirror } from '../../src/codex/mirror.js'

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
