import { expect, test } from 'bun:test'
import { SideDeliveries, sideEndNotice, sideNoAnswer } from '../../src/codex/side-delivery.js'

const key = (thread: string, turn: string, call: string): string => JSON.stringify([thread, turn, call])
const result = (success: boolean, body: Record<string, unknown>) =>
  ({ success, contentItems: [{ type: 'inputText' as const, text: JSON.stringify(body) }] })

test('[R83] a side turn that only reacted and sent a component fallback ends silently, not with «не вернул ответ»', () => {
  const deliveries = new SideDeliveries()
  deliveries.record(key('side-1', 'turn-1', 'call-1'), result(true, { action: 'react', ok: true, message_ids: [] }))
  // A send_component whose widget fell back to text.
  deliveries.record(key('side-1', 'turn-1', 'call-2'),
    result(true, { tool: 'send_component', ok: true, message_ids: [42], delivery: 'text' }))
  const delivered = deliveries.count('side-1', 'turn-1')
  expect(delivered).toBe(2)
  expect(sideEndNotice('completed', delivered)).toBeUndefined()
})

test('[R84] a side turn that completed with no text and delivered nothing still gets «не вернул ответ»', () => {
  const deliveries = new SideDeliveries()
  // Reads, schemas, refusals and other threads' sends do not count for this thread.
  deliveries.record(key('side-1', 'turn-1', 'call-1'), result(true, { action: 'download', ok: true, message_ids: [] }))
  deliveries.record(key('side-1', 'turn-1', 'call-2'), result(true, { tool: 'component_schema', ok: true, message_ids: [] }))
  deliveries.record(key('side-1', 'turn-1', 'call-3'), result(false, { action: 'reply', ok: false, message_ids: [] }))
  deliveries.record(key('side-2', 'turn-2', 'call-4'), result(true, { action: 'reply', ok: true, message_ids: [7] }))
  deliveries.record('not json', result(true, { action: 'reply', ok: true, message_ids: [8] }))
  expect(deliveries.count('side-1', 'turn-1')).toBe(0)
  expect(deliveries.count('side-1', undefined)).toBe(0)
  expect(sideEndNotice('completed', 0)).toBe('Параллельный поток не вернул ответ. Отправь сообщение ещё раз.')
  expect(sideEndNotice('interrupted', 0)).toBe('Параллельная задача остановлена.')
  expect(sideEndNotice('failed', 3)).toBe('Параллельный поток не вернул ответ. Отправь сообщение ещё раз.')
})

test('[R83] a reply whose text went out before its attachment failed counts as delivered for its own turn', () => {
  const deliveries = new SideDeliveries()
  deliveries.record(key('side-1', 'turn-1', 'call-1'),
    result(false, { action: 'reply', ok: false, message_ids: [42], hint: 'Не удалось отправить вложение.' }))
  expect(deliveries.count('side-1', 'turn-1')).toBe(1)
  expect(sideEndNotice('completed', deliveries.count('side-1', 'turn-1'))).toBeUndefined()
})

test('[R84] a late receipt of an earlier turn on a reused side thread is not counted for the next turn', () => {
  const deliveries = new SideDeliveries()
  // turn-1 finished; its reply result arrives while turn-2 runs on the same thread.
  deliveries.record(key('side-1', 'turn-2', 'call-1'), result(true, { action: 'download', ok: true, message_ids: [] }))
  deliveries.record(key('side-1', 'turn-1', 'call-9'), result(true, { action: 'reply', ok: true, message_ids: [43] }))
  expect(deliveries.count('side-1', 'turn-2')).toBe(0)
  expect(deliveries.count('side-1', 'turn-1')).toBe(1)
  expect(sideEndNotice('completed', deliveries.count('side-1', 'turn-2'))).toBe(sideNoAnswer)
})
