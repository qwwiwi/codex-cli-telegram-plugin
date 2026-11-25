import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexInbox } from '../../src/codex/inbox.js'
import { BridgeRestartHandoff, isRestartVerificationMessage } from '../../src/codex/restart-handoff.js'

const ownerId = 100

test('a verification request queues once after restart and keeps the original thread binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-restart-handoff-'))
  try {
    const origin = new BridgeRestartHandoff(root, 'first-invocation', ownerId)
    const inbox = new CodexInbox(root, ownerId)
    expect(origin.request('thread-7', 7)).toBe(true)
    expect(origin.recover(inbox)).toBe('none')
    expect(inbox.size).toBe(0)

    const restarted = new BridgeRestartHandoff(root, 'second-invocation', ownerId)
    expect(restarted.pending()).toMatchObject({ threadId: 'thread-7', ownerMessageId: 7 })
    expect(restarted.recover(inbox)).toBe('queued')
    expect(restarted.request('thread-7', 7)).toBe(false)
    expect(restarted.recover(inbox)).toBe('none')

    const recovered = new CodexInbox(root, ownerId)
    const id = recovered.take()?.[0]?.message_id
    expect(typeof id).toBe('number')
    expect(isRestartVerificationMessage(id!)).toBe(true)
    expect(restarted.verification(id!)).toEqual({ threadId: 'thread-7', ownerMessageId: 7 })
    expect(origin.verification(id!)).toBeUndefined()
    recovered.finish(id!)
    expect(recovered.take()).toBeUndefined()
    expect(new BridgeRestartHandoff(root, 'third-invocation', ownerId).recover(recovered)).toBe('none')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('retrying after an interrupted queue acknowledgement does not duplicate verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-retry-restart-handoff-'))
  try {
    const origin = new BridgeRestartHandoff(root, 'first-invocation', ownerId)
    origin.request('thread-7', 7)
    const statePath = join(root, 'bridge-restart-handoff.json')
    const beforeQueue = readFileSync(statePath, 'utf8')
    const restarted = new BridgeRestartHandoff(root, 'second-invocation', ownerId)
    expect(restarted.recover(new CodexInbox(root, ownerId))).toBe('queued')

    // The inbox was saved but the process exited before saving the acknowledgement.
    writeFileSync(statePath, beforeQueue)
    const inbox = new CodexInbox(root, ownerId)
    expect(restarted.recover(inbox)).toBe('queued')
    expect(inbox.size).toBe(1)
    expect(restarted.pending()).toBeUndefined()
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('a cancelled verification cannot be enqueued or executed after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-cancel-restart-handoff-'))
  try {
    const origin = new BridgeRestartHandoff(root, 'first-invocation', ownerId)
    const inbox = new CodexInbox(root, ownerId)
    origin.request('thread-7', 7)
    origin.cancel()
    const restarted = new BridgeRestartHandoff(root, 'second-invocation', ownerId)
    expect(restarted.recover(inbox)).toBe('none')
    expect(restarted.request('thread-7', 7)).toBe(false)

    restarted.request('thread-8', 8)
    const third = new BridgeRestartHandoff(root, 'third-invocation', ownerId)
    expect(third.recover(inbox)).toBe('queued')
    third.cancel()
    const id = inbox.take()?.[0]?.message_id
    expect(typeof id).toBe('number')
    expect(third.verification(id!)).toBeUndefined()
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('a different Telegram owner cannot inherit a pending verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-reassigned-restart-handoff-'))
  try {
    const origin = new BridgeRestartHandoff(root, 'first-invocation', ownerId)
    origin.request('thread-7', 7)
    const inbox = new CodexInbox(root, ownerId + 1)
    const restarted = new BridgeRestartHandoff(root, 'second-invocation', ownerId + 1)
    expect(restarted.pending()).toBeUndefined()
    expect(restarted.recover(inbox)).toBe('none')
    expect(inbox.size).toBe(0)
  } finally { rmSync(root, { force: true, recursive: true }) }
})
