import { expect, test } from 'bun:test'
import { CodexRpc } from '../../src/codex/rpc.js'

test('a timed-out worker probe keeps the connection usable', async () => {
  let closed = false
  const rpc = new CodexRpc(process.cwd(), process.env, () => {}, () => { closed = true }, [process.execPath, '-e', `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'ping') console.log(JSON.stringify({ id: request.id, result: { ok: true } }));
    });
  `])
  try {
    await expect(rpc.request('thread/read', {}, 20)).rejects.toThrow('did not answer')
    expect(await rpc.request('ping', {})).toEqual({ ok: true })
    expect(closed).toBe(false)
  } finally { rpc.close() }
})
