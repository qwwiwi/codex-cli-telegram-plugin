import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexInbox } from '../../src/codex/inbox.js'
import {
  BridgeRestart, bridgeRestartReply, ownerRequestedBridgeRestart, ownerRequestedRestartVerification,
} from '../../src/codex/restart-bridge.js'

const marker = '[[KROT_SELF_RESTART]]'

test('only an explicit positive owner request authorizes a restart', () => {
  for (const request of ['Перезапустись.', 'Пожалуйста, перезапусти Telegram-мост.', 'Please restart the Telegram bridge.',
    'Когда закончишь, перезапусти мост.', 'Проверь, затем перезапусти мост.']) {
    expect(ownerRequestedBridgeRestart(request)).toBe(true)
  }
  for (const request of ['Не перезапускай мост.', 'Don’t restart the bridge.', 'Как перезапустить мост?',
    'Что значит «перезапусти мост»?', '> Restart the bridge', 'Restart the database.', 'Перезапусти приложение.',
    'Когда закончишь, не перезапускай мост.', 'Пример: «Проверь, затем перезапусти мост».']) {
    expect(ownerRequestedBridgeRestart(request)).toBe(false)
  }
  expect(ownerRequestedBridgeRestart('Перезапусти Codex App Server.', true)).toBe(true)
  expect(ownerRequestedBridgeRestart('Перезапусти Codex App Server.', false)).toBe(false)
})

test('the verification marker requires owner follow-up instructions and a direct backend', () => {
  const marker = '[[KROT_SELF_RESTART_VERIFY]]'
  const reply = 'Готово к перезапуску.\n' + marker
  expect(ownerRequestedRestartVerification('Перезапустись и после перезапуска проверь связь.')).toBe(true)
  expect(ownerRequestedRestartVerification('Restart the bridge and verify the connection.')).toBe(true)
  expect(ownerRequestedRestartVerification('Restart the bridge. After the restart, verify the connection.')).toBe(true)
  expect(ownerRequestedRestartVerification('Перезапустись и не продолжай.')).toBe(false)
  expect(ownerRequestedRestartVerification('Restart the bridge. The runbook says “after restart verify the connection.”')).toBe(false)
  expect(ownerRequestedRestartVerification('Restart the bridge.')).toBe(false)
  expect(bridgeRestartReply(reply, true, false, false).requested).toBe(false)
  expect(bridgeRestartReply(reply, true, false, true)).toEqual({ text: 'Готово к перезапуску.', requested: true, verify: true })
  expect(bridgeRestartReply(reply, true, true, true)).toEqual({ text: 'Готово к перезапуску.', requested: false })
})

test('only an eligible final reply requests a bridge restart', () => {
  expect(bridgeRestartReply('Done\r\n' + marker + '\n', true, false)).toEqual({ text: 'Done', requested: true })
  expect(bridgeRestartReply('Done\n' + marker, true, true)).toEqual({ text: 'Done', requested: false })
  expect(bridgeRestartReply('Done\n' + marker, false, false).requested).toBe(false)
  expect(bridgeRestartReply('Example ' + marker, true, false).requested).toBe(false)
  expect(bridgeRestartReply('Example\n' + marker + '\nMore', true, false).requested).toBe(false)
  expect(bridgeRestartReply(marker, true, false).requested).toBe(false)
})

test('waits for both a delivered owner notice and an idle bridge', async () => {
  const notice = Promise.withResolvers<void>()
  const actions: string[] = []
  let idle = false
  const bridge = new BridgeRestart({
    idle: () => idle,
    notify: () => { actions.push('notice'); return notice.promise },
    restart: () => { actions.push('exit') },
    onNotifyError: () => { actions.push('notice failed') },
  })

  bridge.request()
  await bridge.check()
  expect(actions).toEqual([])

  idle = true
  const checking = bridge.check()
  await bridge.check()
  expect(actions).toEqual(['notice'])

  idle = false
  notice.resolve()
  await checking
  expect(actions).toEqual(['notice'])

  idle = true
  await bridge.check()
  await bridge.check()
  expect(actions).toEqual(['notice', 'exit'])
})

test('a late successful notice cannot restart a cancelled bridge request', async () => {
  const notice = Promise.withResolvers<void>()
  let restarted = false
  const bridge = new BridgeRestart({
    idle: () => true,
    notify: () => notice.promise,
    restart: () => { restarted = true },
    onNotifyError: () => {},
  })

  bridge.request()
  const checking = bridge.check()
  bridge.cancel()
  notice.resolve()
  await checking
  await bridge.check()
  expect(restarted).toBe(false)
})

test('an unsuccessful owner notice leaves the bridge running', async () => {
  let failures = 0
  let exits = 0
  const bridge = new BridgeRestart({
    idle: () => true,
    async notify() { if (failures === 0) throw new Error('Telegram unavailable') },
    restart: () => { exits++ },
    onNotifyError: () => { failures++ },
  })

  bridge.request()
  await bridge.check()
  expect(failures).toBe(1)
  expect(exits).toBe(0)
  await bridge.check()
  expect(exits).toBe(1)
})

test('the inbox recovers the restart request and cancels it without losing delivery state', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-bridge-restart-'))
  try {
    const owner = { id: 100, is_bot: false as const, first_name: 'Owner' }
    const chat = { id: owner.id, type: 'private' as const, first_name: owner.first_name }
    let inbox = new CodexInbox(root, owner.id)
    inbox.receive({ message_id: 7, date: 1, chat, from: owner, text: 'Restart the bridge' })
    inbox.take()
    inbox.start(7, { mayRestartBridge: true, verificationEligible: true, voiceTaskText: 'Restart the bridge' })
    inbox.assignTurn(7, 'turn-7')

    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.work).toEqual({ mayRestartBridge: true, verificationEligible: true, voiceTaskText: 'Restart the bridge' })
    inbox.complete(7, { text: 'Ready to restart', files: [] }, false, true, true)
    inbox.setReplyPart(7, 'text:0', 'sent')

    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.outcome).toMatchObject({ stage: 'ready', restartBridge: true, restartVerification: true })
    inbox.cancelContinuation()

    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.work?.mayRestartBridge).toBeUndefined()
    expect(inbox.active?.work?.verificationEligible).toBeUndefined()
    expect(inbox.active?.outcome).toEqual({
      stage: 'ready', reply: { text: 'Ready to restart', files: [] }, delivery: { 'text:0': 'sent' },
    })
  } finally { rmSync(root, { force: true, recursive: true }) }
})
