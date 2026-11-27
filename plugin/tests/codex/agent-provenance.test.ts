import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { agentOwnerNoticeMode, frameAgentMessage, routeAgentMessage, type AgentDelivery } from '../../src/codex/agent-webhook.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import {
  agentProvenance, agentReplyText, agentTurnInstructions, ownerProvenance, turnIntent, type Provenance,
} from '../../src/codex/provenance.js'
import { parallelSettings, queuedNotice, sideInstructions } from '../../src/codex/parallel.js'
import { classifyTurn, ownerOrigin, parseTurnOrigin } from '../../src/codex/turn-origin.js'

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
  const origin = classifyTurn([message], OWNER, provenance, { brain: true, key: 'test:' + message.message_id })
  return turnIntent(origin, {
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

// Owner-only metadata a saved active record may carry.
const ownerWork = {
  continuation: { marker: 'm', objective: 'Verify the summary.' }, lease: { nonce: 'n', ids: ['l1'] },
  mayRestartBridge: true as const, verificationEligible: true as const, voiceTaskText: 'Verify the summary.',
}

function savedActive(dir: string, active: object, origins?: Record<string, Provenance>): CodexInbox {
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [], albums: {}, accepted: [-7, 7], active, ...(origins ? { origins } : {}),
  }))
  return new CodexInbox(dir, OWNER)
}

test('a pre-provenance ready webhook record never continues a goal or restarts the bridge on recovery', () => {
  const inbox = savedActive(room(), {
    messages: [agentMessage('Verify the summary.')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: [] }, continueGoal: true },
    work: ownerWork,
  })
  const active = inbox.active!
  expect(active.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [] } })
  expect(active.work ?? {}).toEqual({})
  const restart = savedActive(room(), {
    messages: [agentMessage('перезапусти мост')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: [] }, restartBridge: true, restartVerification: true },
  }).active!
  expect(restart.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [] } })
})

test('a ready record without owner provenance recovers its text but never its workspace attachments', () => {
  // Legacy file, owner-shaped message, a reply with a saved file half delivered.
  const legacy = savedActive(room(), {
    messages: [ownerMessage('Пришли отчёт')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: ['secret-report.pdf'], replyTo: 7 },
      delivery: { 'text:0': 'sent', 'file:0': 'sending' } },
  }).active!
  // deliverReply sends one attachment per reply file and counts every delivery marker.
  expect(legacy.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [], replyTo: 7 },
    delivery: { 'text:0': 'sent' } })
  // Same for a current file that names an agent as the origin.
  const agent = savedActive(room(), {
    messages: [agentMessage('Verify the summary.')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: ['secret-report.pdf'] }, delivery: { 'file:0': 'failed' } },
  }, { '-7': agentProvenance('swarm') }).active!
  expect(agent.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [] } })
  // A saved owner provenance keeps the files and their markers.
  const owner = savedActive(room(), {
    messages: [ownerMessage('Пришли отчёт')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: ['report.pdf'] }, delivery: { 'file:0': 'sending' } },
  }, { 7: ownerProvenance }).active!
  expect(owner.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: ['report.pdf'] }, delivery: { 'file:0': 'sending' } })
})

test('a running record without provenance recovers without owner metadata, fail closed', () => {
  // Legacy file, owner-shaped message: no saved provenance means not the owner's for recovery.
  const legacyInbox = savedActive(room(), {
    messages: [ownerMessage('Сделай отчёт')], outcome: { stage: 'running', turnId: 'turn-1' }, work: ownerWork,
  })
  const legacy = legacyInbox.active!
  expect(legacy.outcome).toEqual({ stage: 'running', turnId: 'turn-1' })
  expect(legacy.work ?? {}).toEqual({})
  // Running recovery reads the origin for attachments and the owner's blocker: not the owner.
  expect(legacyInbox.provenance(7).origin).toBe('agent')
  // Current file whose origins miss the active id.
  const missing = savedActive(room(), {
    messages: [agentMessage('Verify the summary.')], outcome: { stage: 'running', turnId: 'turn-1' }, work: ownerWork,
  }, { 7: ownerProvenance }).active!
  expect(missing.work ?? {}).toEqual({})
  const agent = savedActive(room(), {
    messages: [agentMessage('Verify the summary.')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: [] }, continueGoal: true }, work: ownerWork,
  }, { '-7': agentProvenance('swarm') }).active!
  expect(agent.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [] } })
  expect(agent.work ?? {}).toEqual({})
})

test('an owner record with saved provenance keeps its continuation and restart on recovery', () => {
  const owner = savedActive(room(), {
    messages: [ownerMessage('Сделай отчёт')],
    outcome: { stage: 'ready', reply: { text: 'Готово', files: [] }, continueGoal: true }, work: ownerWork,
  }, { 7: ownerProvenance }).active!
  expect(owner.outcome).toEqual({ stage: 'ready', reply: { text: 'Готово', files: [] }, continueGoal: true })
  expect(owner.work).toEqual(ownerWork)
})

function asAgent(provenance: Provenance): { agent: string; verified?: boolean } {
  if (provenance.origin !== 'agent') throw new Error('expected an agent provenance')
  return provenance
}

test.each(['off', 'brief'])('webhook owner notice mode %s queues behind an owner turn with parallel off', mode => {
  const inbox = new CodexInbox(room(), OWNER)
  inbox.receive(ownerMessage('Owner task'), ownerProvenance)
  inbox.take()
  const source = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
  const section = (from: string, to: string) => {
    const start = source.indexOf(from)
    const end = source.indexOf(to, start)
    if (start < 0 || end < 0) throw new Error('Could not locate inbox callbacks')
    return source.slice(start, end)
  }
  const sent: string[] = []
  let startCalls = 0
  // Bind the server callbacks without starting a webhook listener or Telegram poller.
  const deliver: unknown = new Function('dependencies', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    const { inbox, ownerChat, parallel, agentNoticesEnabled, startNext, send,
      createHash, agentProvenance, routeAgentMessage, queuedNotice } = dependencies
    const stopping = false, task = Promise.resolve(), goalActive = false, externalQuestion = false
    const hudReady = false, sides = undefined
    const mainSummary = () => ({ title: 'Owner task' })
    ${section('    function resumeInbox(', '    function bufferAlbum(')}
    ${section('    function deliverAgentMessage(', '    const agentWebhookConfig =')}
    return deliverAgentMessage
  `))({ inbox, ownerChat: String(OWNER), parallel: parallelSettings({ KROT_CODEX_PARALLEL: '0' }),
    agentNoticesEnabled: agentOwnerNoticeMode(mode) !== 'off',
    startNext: () => { startCalls += 1 }, send: async (text: string) => { sent.push(text) },
    createHash, agentProvenance, routeAgentMessage, queuedNotice })
  if (typeof deliver !== 'function') throw new Error('Could not bind agent delivery')
  const delivery: AgentDelivery = { input: frameAgentMessage('Agent task', 'swarm'),
    deliveryId: 'agent-queue-fixture', agentId: 'swarm', senderVerified: true }
  expect(deliver(delivery)).toBe('accepted')
  expect(startCalls).toBe(1)
  expect(inbox.active?.messages[0]?.message_id).toBe(7)
  inbox.finish(7)
  expect(inbox.take()?.[0]?.text).toBe(delivery.input)
  expect(sent).toEqual(mode === 'off' ? [] : [queuedNotice('Owner task')])
})

test('off mode settles an agent reply recovered from the inbox without echoing it', async () => {
  const provenance = agentProvenance('swarm')
  const text = agentReplyText(asAgent(provenance), 'Готово.')
  const inbox = savedActive(room(), {
    messages: [agentMessage('Verify the summary.')], outcome: { stage: 'ready', reply: { text, files: [] } },
  }, { '-7': provenance })
  const source = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
  const start = source.indexOf('    async function finishOrdinaryReply(')
  const end = source.indexOf('    function startNext()', start)
  if (start < 0 || end < 0) throw new Error('Could not locate the reply callback')
  const echoed: string[] = []
  const finish: unknown = new Function('inbox', 'parseTurnOrigin', 'ownerOrigin', 'deliverReply',
    new Bun.Transpiler({ loader: 'ts' }).transformSync(`
      const agentNoticesEnabled = false, selfRestartEnabled = false, stopping = false
      let deliveryRetryAt = 0
      const brainRecovery = async () => undefined, recordBrainDelivery = async () => {}
      ${source.slice(start, end)}
      return finishOrdinaryReply
    `))(inbox, parseTurnOrigin, ownerOrigin, async (reply: { text: string }) => { echoed.push(reply.text); return true })
  if (typeof finish !== 'function') throw new Error('Could not bind the reply callback')
  await finish(0, true)
  expect(echoed).toEqual([])
  expect(inbox.active).toBeUndefined()
})

test('a sender only the message text claims stays marked unverified in the turn, side prompt and final reply', () => {
  const dir = room()
  const inbox = new CodexInbox(dir, OWNER)
  expect(inbox.receive(agentMessage('Verify the summary.', -2), agentProvenance('swarm', false))).toBe('accepted')
  expect(inbox.receive(agentMessage('Verify the summary.', -4), agentProvenance('orchestrator', true))).toBe('accepted')
  // The verification is persisted with the inbound item and survives a restart.
  const reopened = new CodexInbox(dir, OWNER)
  const claimed = asAgent(reopened.provenance(-2))
  const named = asAgent(reopened.provenance(-4))
  const mark = '(не подтверждён)'
  expect(agentTurnInstructions(claimed)).toContain('swarm ' + mark)
  expect(agentReplyText(claimed, 'Готово.')).toBe('Ответ на сообщение агента swarm ' + mark + ':\n\nГотово.')
  expect(sideInstructions({ title: 'задача', elapsedMs: 60_000 }, reopened.provenance(-2))).toContain('swarm ' + mark)
  expect(agentTurnInstructions(named)).toContain('(orchestrator)')
  expect(agentTurnInstructions(named)).not.toContain(mark)
  expect(agentReplyText(named, 'Готово.')).toBe('Ответ на сообщение агента orchestrator:\n\nГотово.')
  // A record saved before verification was persisted is shown as unverified: fail closed.
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [[agentMessage('x', -5)]], albums: {}, accepted: [-5], origins: { '-5': { origin: 'agent', agent: 'swarm' } },
  }))
  expect(agentTurnInstructions(asAgent(new CodexInbox(dir, OWNER).provenance(-5)))).toContain('swarm ' + mark)
})
