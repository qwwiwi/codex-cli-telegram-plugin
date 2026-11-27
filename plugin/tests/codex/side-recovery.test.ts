import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { frameAgentMessage, startAgentWebhook, type AgentDelivery } from '../../src/codex/agent-webhook.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { agentProvenance, ownerProvenance } from '../../src/codex/provenance.js'
import { bridgeOrigin } from '../../src/codex/turn-origin.js'
import { recoverInterruptedWork, type RecoveryDeps, type RecoveryNotice } from '../../src/codex/side-recovery.js'
import type { Logger } from '../../src/log.js'
import { workerBody, workerSender } from '../fixtures/agent-webhook/worker-payload.js'

const OWNER = 42
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function message(id: number, text: string): Message {
  return {
    message_id: id, date: 1, text,
    chat: { id: OWNER, type: 'private', first_name: 'Telegram' },
    from: { id: OWNER, is_bot: false, first_name: 'Telegram' },
  }
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

// Telegram rejects every notice, as it does for a quote of a synthetic negative id.
function failingDeps() {
  const notices: RecoveryNotice[] = []
  const letters: Parameters<RecoveryDeps['deadLetter']>[0][] = []
  const deps: RecoveryDeps = {
    send: async notice => {
      notices.push(notice)
      throw Object.assign(new Error('Bad Request: message to be replied not found'), { error_code: 400 })
    },
    deadLetter: record => { letters.push(record) },
    log: silent,
  }
  return { deps, notices, letters }
}

function crashedInbox(setup: (inbox: CodexInbox) => void): { dir: string; inbox: CodexInbox } {
  const dir = mkdtempSync(join(tmpdir(), 'krot-side-recovery-'))
  dirs.push(dir)
  setup(new CodexInbox(dir, OWNER))
  // The bridge process died here; a new one reads the same file.
  return { dir, inbox: new CodexInbox(dir, OWNER) }
}

test('F3: crash before turn/start answered – plain notice, record cleared and the queue drains despite Telegram failing', async () => {
  const { inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(-5, frameAgentMessage('Verify the summary.', 'swarm')), agentProvenance('swarm'))
    inbox.receive(message(6, 'следующая задача'), ownerProvenance)
  })
  const { deps, notices, letters } = failingDeps()
  await recoverInterruptedWork(inbox, deps)
  expect(notices.length).toBe(1)
  expect(notices[0]!.replyTo).toBeUndefined()
  expect(notices[0]!.text).toContain('swarm')
  expect(inbox.uncertainFollowUp).toBeUndefined()
  expect(letters).toEqual([{ agent: 'swarm', messageId: -5, stage: 'unconfirmed',
    text: frameAgentMessage('Verify the summary.', 'swarm') }])
  expect(inbox.take()?.[0]?.message_id).toBe(6)
})

test('F3: crash after turn/start – the side job survives the restart and is settled without blocking', async () => {
  const { dir, inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(-8, frameAgentMessage('Собери отчёт', 'swarm')), agentProvenance('swarm'))
    inbox.startSide(-8, 'side-thread', bridgeOrigin('side-thread'))
    inbox.receive(message(9, 'следующая задача'), ownerProvenance)
  })
  expect(inbox.sideJobs.map(job => ({ id: job.id, thread: job.thread }))).toEqual([{ id: -8, thread: 'side-thread' }])
  expect(inbox.provenance(-8)).toEqual(agentProvenance('swarm'))
  const { deps, notices, letters } = failingDeps()
  await recoverInterruptedWork(inbox, deps)
  expect(notices.length).toBe(1)
  expect(notices[0]!.replyTo).toBeUndefined()
  expect(letters.map(letter => [letter.messageId, letter.stage])).toEqual([[-8, 'interrupted']])
  expect(inbox.sideJobs).toEqual([])
  expect(new CodexInbox(dir, OWNER).sideJobs).toEqual([])
  expect(inbox.take()?.[0]?.message_id).toBe(9)
})

test('off mode retains the lost agent message without sending a recovery notice', async () => {
  const { inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(-5, frameAgentMessage('Verify the summary.', 'swarm')), agentProvenance('swarm'))
  })
  const { deps, notices, letters } = failingDeps()
  await recoverInterruptedWork(inbox, { ...deps, notifyAgent: false })
  expect(notices).toEqual([])
  expect(letters.map(letter => letter.messageId)).toEqual([-5])
  expect(inbox.uncertainFollowUp).toBeUndefined()
})

test('F3: an owner side job is quoted, and a finished side job leaves no record', async () => {
  const { inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(11, 'Отдельный вопрос'), ownerProvenance)
    inbox.startSide(11, 'side-a', bridgeOrigin('side-a'))
    inbox.beginFollowUp(message(12, 'Готово'), ownerProvenance)
    inbox.startSide(12, 'side-b', bridgeOrigin('side-b'))
    inbox.finishSide(12)
  })
  const notices: RecoveryNotice[] = []
  await recoverInterruptedWork(inbox, { send: async notice => { notices.push(notice) }, deadLetter: () => {}, log: silent })
  expect(notices.map(notice => notice.replyTo)).toEqual([11])
  expect(inbox.sideJobs).toEqual([])
})

// The dead-letter store refuses the write (EACCES); Telegram itself works.
function deniedDeadLetter() {
  const notices: RecoveryNotice[] = []
  const deps: RecoveryDeps = {
    send: async notice => { notices.push(notice) },
    deadLetter: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
    log: silent,
  }
  return { deps, notices }
}

test('a side job whose dead letter cannot be written keeps its record and does not block the queue', async () => {
  const { dir, inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(-8, frameAgentMessage('Собери отчёт', 'swarm')), agentProvenance('swarm'))
    inbox.startSide(-8, 'side-thread', bridgeOrigin('side-thread'))
    inbox.receive(message(9, 'следующая задача'), ownerProvenance)
  })
  const { deps, notices } = deniedDeadLetter()
  await recoverInterruptedWork(inbox, deps)
  // The agent's text is not stored anywhere else yet: the record stays, also on disk.
  expect(inbox.sideJobs.map(job => job.id)).toEqual([-8])
  expect(new CodexInbox(dir, OWNER).sideJobs.map(job => job.id)).toEqual([-8])
  expect(notices.length).toBe(1)
  expect(notices[0]!.text).not.toContain('Текст сохранён')
  expect(inbox.take()?.[0]?.message_id).toBe(9)
  // Next recovery with a working store keeps the text and clears the record.
  const letters: Parameters<RecoveryDeps['deadLetter']>[0][] = []
  await recoverInterruptedWork(new CodexInbox(dir, OWNER), { ...deps, deadLetter: record => { letters.push(record) } })
  expect(letters.map(letter => [letter.messageId, letter.stage])).toEqual([[-8, 'interrupted']])
  expect(new CodexInbox(dir, OWNER).sideJobs).toEqual([])
})

test('an unconfirmed agent follow-up whose dead letter cannot be written is kept without blocking the queue', async () => {
  const { dir, inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(-5, frameAgentMessage('Verify the summary.', 'swarm')), agentProvenance('swarm'))
    inbox.receive(message(6, 'следующая задача'), ownerProvenance)
  })
  const { deps } = deniedDeadLetter()
  await recoverInterruptedWork(inbox, deps)
  expect(inbox.uncertainFollowUp).toBeUndefined()
  expect(new CodexInbox(dir, OWNER).sideJobs.map(job => job.id)).toEqual([-5])
  expect(inbox.take()?.[0]?.message_id).toBe(6)
  const letters: Parameters<RecoveryDeps['deadLetter']>[0][] = []
  await recoverInterruptedWork(new CodexInbox(dir, OWNER), { ...deps, deadLetter: record => { letters.push(record) } })
  expect(letters).toEqual([{ agent: 'swarm', messageId: -5, stage: 'unconfirmed',
    text: frameAgentMessage('Verify the summary.', 'swarm') }])
  expect(new CodexInbox(dir, OWNER).sideJobs).toEqual([])
})

test('a lost worker delivery is reported under its real sender, not the recipient agentId', async () => {
  const delivered: AgentDelivery[] = []
  const server = startAgentWebhook({ hostname: '127.0.0.1', port: 0, token: 'side-recovery-test-token' },
    delivery => { delivered.push(delivery); return 'accepted' }, silent)
  try {
    const response = await fetch('http://127.0.0.1:' + server.port + '/webhook', {
      method: 'POST',
      headers: { authorization: 'Bearer side-recovery-test-token', 'content-type': 'application/json' },
      body: JSON.stringify(workerBody()),
    })
    expect(response.status).toBe(200)
  } finally {
    server.stop(true)
  }
  const delivery = delivered[0]!
  const { inbox } = crashedInbox(inbox => {
    // server.ts keys the provenance on delivery.agentId.
    inbox.beginFollowUp(message(-5, delivery.input), agentProvenance(delivery.agentId))
  })
  const { deps, notices, letters } = failingDeps()
  await recoverInterruptedWork(inbox, deps)
  expect(notices[0]!.text.startsWith('Сообщение от агента ' + workerSender + ' (')).toBe(true)
  expect(letters[0]!.agent).toBe(workerSender)
})

test('an isolated turn survives a restart with its side thread and is recovered only from that thread', async () => {
  const { recoveredTurn } = await import('../../src/codex/inbox.js')
  const { inbox } = crashedInbox(inbox => {
    inbox.receive({ ...message(11, 'переслано'), forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'X' } }, ownerProvenance)
    inbox.take()
    inbox.start(11, bridgeOrigin(null))
    inbox.assignTurn(11, 'side-turn', 'side-thread')
  })
  expect(inbox.active?.outcome).toEqual({ stage: 'running', turnId: 'side-turn', thread: 'side-thread' })
  const asked: string[] = []
  const history = {
    main: async () => { asked.push('main'); return [{ id: 'side-turn', status: 'completed', items: [] }] },
    side: async (thread: string) => { asked.push(thread); return [{ id: 'side-turn', status: 'completed', items: [{ text: 'Side answer' }] }] },
  }
  expect(await recoveredTurn('side-turn', 'side-thread', history)).toMatchObject({ items: [{ text: 'Side answer' }] })
  expect(asked).toEqual(['side-thread'])
  expect(await recoveredTurn('side-turn', 'side-thread', { ...history, side: async () => { throw new Error('gone') } })).toBeUndefined()
  expect(asked).toEqual(['side-thread'])
  expect(await recoveredTurn('main-turn', undefined, history)).toBeUndefined()
  expect(asked).toEqual(['side-thread', 'main'])
})
