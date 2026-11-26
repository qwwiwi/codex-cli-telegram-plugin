import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { frameAgentMessage } from '../../src/codex/agent-webhook.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { agentProvenance, ownerProvenance } from '../../src/codex/provenance.js'
import { recoverInterruptedWork, type RecoveryDeps, type RecoveryNotice } from '../../src/codex/side-recovery.js'
import type { Logger } from '../../src/log.js'

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
    inbox.startSide(-8, 'side-thread')
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

test('F3: an owner side job is quoted, and a finished side job leaves no record', async () => {
  const { inbox } = crashedInbox(inbox => {
    inbox.beginFollowUp(message(11, 'Отдельный вопрос'), ownerProvenance)
    inbox.startSide(11, 'side-a')
    inbox.beginFollowUp(message(12, 'Готово'), ownerProvenance)
    inbox.startSide(12, 'side-b')
    inbox.finishSide(12)
  })
  const notices: RecoveryNotice[] = []
  await recoverInterruptedWork(inbox, { send: async notice => { notices.push(notice) }, deadLetter: () => {}, log: silent })
  expect(notices.map(notice => notice.replyTo)).toEqual([11])
  expect(inbox.sideJobs).toEqual([])
})
