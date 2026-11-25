import { expect, test } from 'bun:test'
import { removeOwnPinService } from '../../src/codex/pin-service.js'

const botId = 4242
const ownerId = 777

function harness(fail = false) {
  const removed: number[] = []
  const warnings: Array<Record<string, unknown>> = []
  return {
    removed, warnings,
    deps: {
      botId,
      remove: async () => {
        if (fail) throw new Error('message can\'t be deleted')
        removed.push(1)
      },
      warn: (_message: string, context: Record<string, unknown>) => { warnings.push(context) },
    },
  }
}

const pin = (fromId: number) => ({ chat: { id: ownerId }, from: { id: fromId }, pinned_message: { message_id: 1 } })

test('deletes the pin service message posted by this bot', async () => {
  const state = harness()
  expect(removeOwnPinService(pin(botId), state.deps)).toBe(true)
  await Bun.sleep(0)
  expect(state.removed).toEqual([1])
})

test('keeps pin service messages of the owner and other bots', async () => {
  const state = harness()
  expect(removeOwnPinService(pin(ownerId), state.deps)).toBe(false)
  expect(removeOwnPinService(pin(9999), state.deps)).toBe(false)
  expect(removeOwnPinService({ chat: { id: ownerId }, pinned_message: { message_id: 1 } }, state.deps)).toBe(false)
  await Bun.sleep(0)
  expect(state.removed).toEqual([])
})

test('a failed delete is logged and does not throw', async () => {
  const state = harness(true)
  expect(removeOwnPinService(pin(botId), state.deps)).toBe(true)
  await Bun.sleep(0)
  expect(state.warnings).toEqual([{ chat_id: String(ownerId), error: 'message can\'t be deleted' }])
})
