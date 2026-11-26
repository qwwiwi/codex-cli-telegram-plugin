import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { CodexInbox } from '../../src/codex/inbox.js'
import { queuedNotice } from '../../src/codex/parallel.js'
import { ownerProvenance } from '../../src/codex/provenance.js'
import { QueueNotices } from '../../src/codex/queue-notice.js'
import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { fakeTelegramChat, settledWithin } from './fake-telegram-chat.js'

const owner = { id: 100, is_bot: false as const, first_name: 'Owner' }
const chat = { id: owner.id, type: 'private' as const, first_name: owner.first_name }
const message = (id: number) => ({ message_id: id, date: 1, chat, from: owner }) as Message
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Call = { op: 'send'; text: string; replyTo: number } | { op: 'delete'; id: number }

// A real inbox, a HUD wait the test releases and a recording Telegram; `sendGate` holds sends while set.
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'krot-queue-notice-'))
  const inbox = new CodexInbox(root, owner.id)
  const calls: Call[] = []
  let release: () => void = () => undefined
  const hud = new Promise<void>(resolve => { release = resolve })
  let next = 500
  let sendGate: Promise<void> | undefined
  const notices = new QueueNotices({
    settled: () => hud,
    isQueued: id => inbox.isQueued(id),
    send: async (text, replyTo) => {
      calls.push({ op: 'send', text, replyTo })
      await sendGate
      return { message_id: ++next }
    },
    remove: async id => { calls.push({ op: 'delete', id }) },
  })
  return {
    inbox, calls, notices, release: () => release(),
    holdSends: () => { let open: () => void = () => undefined; sendGate = new Promise(resolve => { open = resolve }); return open },
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  }
}

test('[R94] a message taken while its queue notice waits for the HUD card hears no stale notice', async () => {
  const { inbox, calls, notices, release, cleanup } = harness()
  try {
    inbox.receive(message(1), ownerProvenance)
    inbox.receive(message(2), ownerProvenance)
    expect(inbox.take()?.[0]?.message_id).toBe(1)
    // Message 2 waits; its notice waits for the HUD card.
    const pending = notices.notify(2, queuedNotice('Перепиши лендинг'))
    // The main turn finishes and takes message 2 before the card lands.
    inbox.finish(1)
    expect(inbox.take()?.[0]?.message_id).toBe(2)
    release()
    await pending
    expect(calls).toEqual([])
  } finally { cleanup() }
})

test('[R94] a queue notice is sent while the message waits and deleted when the main turn picks the message up', async () => {
  const { inbox, calls, notices, release, cleanup } = harness()
  try {
    inbox.receive(message(1), ownerProvenance)
    inbox.receive(message(2), ownerProvenance)
    inbox.take()
    release()
    await notices.notify(2, queuedNotice('Перепиши лендинг'))
    expect(calls).toEqual([{ op: 'send', text: 'В очереди: возьму после «Перепиши лендинг».', replyTo: 2 }])
    inbox.finish(1)
    inbox.take()
    await notices.pickedUp(2)
    expect(calls.at(-1)).toEqual({ op: 'delete', id: 501 })
    // A second pickup has nothing left to delete.
    await notices.pickedUp(2)
    expect(calls).toHaveLength(2)
  } finally { cleanup() }
})

test('[R94] a message picked up while its notice is still being sent gets the notice deleted once it lands', async () => {
  const { inbox, calls, notices, release, holdSends, cleanup } = harness()
  try {
    inbox.receive(message(1), ownerProvenance)
    inbox.receive(message(2), ownerProvenance)
    inbox.take()
    release()
    const open = holdSends()
    const pending = notices.notify(2, 'В очереди')
    await wait(0)
    inbox.finish(1)
    inbox.take()
    const removing = notices.pickedUp(2)
    open()
    await pending
    await removing
    expect(calls).toEqual([{ op: 'send', text: 'В очереди', replyTo: 2 }, { op: 'delete', id: 501 }])
  } finally { cleanup() }
})

test('[R94] a notice still queued behind an earlier send is cancelled on pickup and never reaches Telegram', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-queue-notice-'))
  try {
    const inbox = new CodexInbox(root, owner.id)
    const chat = fakeTelegramChat()
    const api = createRateLimitedTelegramApi(chat.raw, createLogger('queue-notice-test'), { jitterMaxMs: 0 })
    const removed: number[] = []
    const notices = new QueueNotices({
      settled: async () => undefined,
      isQueued: id => inbox.isQueued(id),
      send: (text, replyTo, signal) => api.sendMessage(String(owner.id), text,
        { reply_to_message_id: replyTo, disable_notification: true, signal }),
      remove: async id => { removed.push(id); await api.deleteMessage(String(owner.id), id) },
    })
    inbox.receive(message(1), ownerProvenance)
    inbox.receive(message(2), ownerProvenance)
    inbox.take()
    // An earlier send holds the chat's FIFO; the notice queues behind it.
    chat.hold('earlier')
    const earlier = api.sendMessage(String(owner.id), 'earlier', {})
    const pending = notices.notify(2, 'В очереди')
    await Bun.sleep(1)
    inbox.finish(1)
    inbox.take()
    const removing = notices.pickedUp(2)
    chat.releaseAll()
    await earlier
    expect(await settledWithin(pending, 100)).toBe('resolved')
    await removing
    // The notice never left the process: no send slot spent, nothing to delete.
    expect(chat.rawCalls).toEqual(['earlier'])
    expect(removed).toEqual([])
  } finally { rmSync(root, { force: true, recursive: true }) }
})
