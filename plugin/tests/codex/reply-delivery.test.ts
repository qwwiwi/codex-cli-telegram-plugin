import { expect, test } from 'bun:test'
import { deliverReplyPart, type PartStatus } from '../../src/codex/reply-delivery.js'

test('skips confirmed parts and interrupted sends, and retries proven pre-send failures', async () => {
  const saved = new Map<string, PartStatus>([['text:0', 'sent'], ['file:0', 'sending']])
  const invoke = (key: string, send: () => Promise<object>) => deliverReplyPart(
    saved.get(key), state => { if (state) saved.set(key, state); else saved.delete(key) }, send,
  )
  const calls: string[] = []
  const send = async (label: string) => { calls.push(label); return { message_id: 17 } }
  expect((await invoke('text:0', () => send('old text'))).state).toBe('sent')
  expect((await invoke('file:0', () => send('uncertain file'))).state).toBe('uncertain')
  await expect(invoke('file:1', async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  })).rejects.toThrow('offline')
  expect(saved.has('file:1')).toBe(false)
  expect((await invoke('file:1', () => send('new file'))).state).toBe('sent')
  expect(calls).toEqual(['new file'])
})
