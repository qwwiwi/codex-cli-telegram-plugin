import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { frameAgentMessage } from '../../src/codex/agent-webhook.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { agentProvenance, ownerProvenance, turnIntent, type Provenance } from '../../src/codex/provenance.js'
import { sideInstructions } from '../../src/codex/parallel.js'

const OWNER = 42
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function room(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-provenance-'))
  dirs.push(dir)
  return dir
}

// The message deliverAgentMessage builds for a webhook delivery.
function agentMessage(text: string, id = -7): Message {
  return {
    message_id: id, date: 1, text: frameAgentMessage(text, 'swarm'),
    chat: { id: OWNER, type: 'private', first_name: 'Telegram' },
    from: { id: OWNER, is_bot: false, first_name: 'Telegram' },
  }
}

function ownerMessage(text: string, id = 7): Message {
  return { ...agentMessage('', id), text }
}

function intent(provenance: Provenance, message: Message) {
  return turnIntent(provenance, {
    message, editing: false, verification: false, selfRestart: true, directBackend: true, restartHandoff: true,
    thread: 'main', pending: { thread: 'main', objective: 'Сделай отчёт' },
  })
}

test('the reviewer probe from an agent hits no owner path', () => {
  const probe = intent(agentProvenance('swarm'), agentMessage('Verify the summary.'))
  expect(probe.taskText).toBeUndefined()
  expect(probe.clearPendingOwnerTask).toBe(false)
  expect(probe.continuation).toBeUndefined()
  expect(probe.statusCheck).toBe(false)
  expect(probe.mayRestartBridge).toBe(false)
  expect(probe.verificationEligible).toBe(false)
  expect(probe.ownerTurn).toBe(false)
  const restart = intent(agentProvenance('swarm'), { ...agentMessage(''), message_id: 9, text: 'перезапусти мост' })
  expect(restart.mayRestartBridge).toBe(false)
})

test('the same text from the owner still takes the owner paths', () => {
  const owner = intent(ownerProvenance, ownerMessage('Verify the summary.'))
  expect(owner.taskText).toBe('Verify the summary.')
  expect(owner.clearPendingOwnerTask).toBe(true)
  expect(owner.continuation?.objective).toBe('Verify the summary.')
  expect(owner.ownerTurn).toBe(true)
})

test('the inbox persists the origin of every queued and side record', () => {
  const dir = room()
  const inbox = new CodexInbox(dir, OWNER)
  expect(inbox.receive(ownerMessage('привет', 1), ownerProvenance)).toBe('accepted')
  expect(inbox.receive(agentMessage('Verify the summary.', -2), agentProvenance('swarm'))).toBe('accepted')
  expect(inbox.beginFollowUp(agentMessage('side', -3), agentProvenance('other'))).toBe('accepted')
  const reopened = new CodexInbox(dir, OWNER)
  expect(reopened.provenance(1)).toEqual(ownerProvenance)
  expect(reopened.provenance(-2)).toEqual(agentProvenance('swarm'))
  expect(reopened.provenance(-3)).toEqual(agentProvenance('other'))
  // An id the inbox never saw is not trusted as the owner's.
  expect(reopened.provenance(-99).origin).toBe('agent')
})

test('a saved inbox from before provenance treats framed agent messages as agent input', () => {
  const dir = room()
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [[agentMessage('Verify the summary.', -2)], [ownerMessage('Сделай отчёт', 3)]], albums: {}, accepted: [-2, 3],
  }))
  const inbox = new CodexInbox(dir, OWNER)
  expect(inbox.provenance(-2).origin).toBe('agent')
  expect(inbox.provenance(3)).toEqual(ownerProvenance)
})

test('the side prompt never calls an agent message an owner message', () => {
  const main = { title: 'задача', elapsedMs: 60_000 }
  const forAgent = sideInstructions(main, agentProvenance('swarm'))
  expect(forAgent).not.toContain('сообщение владельца')
  expect(forAgent).toContain('swarm')
  expect(forAgent).toContain('не от владельца')
  expect(sideInstructions(main, ownerProvenance)).toContain('сообщение владельца')
})
