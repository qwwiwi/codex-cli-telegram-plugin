import { expect, test } from 'bun:test'
import { usageCommand } from '../../src/codex/usage-command.js'

test('a scan runs once, invalid arguments are not forwarded and a failed scan can retry', async () => {
  const days: string[] = []
  const replies: string[] = []
  let reject!: (error: Error) => void
  const handle = usageCommand(async period => {
    days.push(period)
    if (days.length === 1) return new Promise<string>((_, fail) => { reject = fail })
    return 'Токены за период'
  }, async text => { replies.push(text) })
  await handle('--invalid')
  const running = handle('')
  await handle('1')
  reject(new Error('private process details'))
  await running
  await handle('30')
  expect(days).toEqual(['7', '30'])
  expect(replies[0]).toContain('/usage 7')
  expect(replies[1]).toContain('уже собирается')
  expect(replies[2]).toContain('Не удалось')
  expect(replies[2]).not.toContain('private')
  expect(replies[3]).toBe('Токены за период')
})
