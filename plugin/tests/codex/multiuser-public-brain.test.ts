// Integration (v0.5 on the M5 Brain base): with KROT_MULTIUSER=1 a member's message in an approved group
// goes gate → public intake → public lane → the role's own runner, never the owner's inbox or main
// thread, carries no owner main summary, and Brain journals it as foreign (no text, no owner origin).

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import type { BrainPort, TurnOutcome, TurnStartInput, TurnTicket } from '../../../codex-brain/src/contract.js'
import { accessSettings } from '../../src/access/env.js'
import { gateInbound } from '../../src/access/gate.js'
import { AccessStore } from '../../src/access/store.js'
import { MEMORY_REFUSED } from '../../src/codex/brain-commands.js'
import { sideInstructions } from '../../src/codex/parallel.js'
import { frameUserMessage, ownerProvenance, publicRoleInstructions, userProvenance } from '../../src/codex/provenance.js'
import { publicBrainKey, publicIntake } from '../../src/codex/public-intake.js'
import { PublicLane, type PublicRunner } from '../../src/codex/public-lane.js'
import type { PublicTurnProfile } from '../../src/codex/session.js'

const OWNER = 1001
const MEMBER = 2002
const GROUP = -100777
const BOT_ID = 9009
const SCOPE = 'tg-9009-1001'
const OWNER_TASK = 'Секретная задача владельца: перевод денег'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

class PublicRunnerFake implements PublicRunner {
  readonly calls: Array<{ text: string; profile: PublicTurnProfile }> = []
  async runPublic(text: string, profile: PublicTurnProfile): ReturnType<PublicRunner['runPublic']> {
    this.calls.push({ text, profile })
    profile.onThread?.('public-thread-1')
    return { status: 'completed', text: 'Четыре.', threadId: 'public-thread-1', toolItems: 0 }
  }
  async stopPublic(): Promise<boolean> { return false }
}

class BrainFake implements Pick<BrainPort, 'turnStarting' | 'turnDelivered'> {
  readonly started: TurnStartInput[] = []
  readonly delivered: Array<{ ticket: TurnTicket; outcome: TurnOutcome }> = []
  async turnStarting(input: TurnStartInput): Promise<TurnTicket | null> {
    this.started.push(input)
    return { key: input.key, sessionId: input.sessionId, ref: 'j:2026-11-27#1', origin: input.origin }
  }
  async turnDelivered(ticket: TurnTicket, outcome: TurnOutcome) {
    this.delivered.push({ ticket, outcome })
    return { saved: [], unavailable: false }
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

test('[S3/M5] KROT_MULTIUSER=1: a member group message reaches the public lane, without the owner main summary, and Brain journals it as foreign', async () => {
  const stateDir = temp('krot-mu-state-')
  const access = accessSettings({ KROT_MULTIUSER: '1', KROT_MEMBER_USER_IDS: String(MEMBER) })
  expect(access.enabled).toBe(true)
  const store = new AccessStore({ stateDir, ownerId: String(OWNER), envMembers: access.envMembers })
  expect(store.addPendingChat(String(GROUP), { title: 'Team', added_by: String(OWNER) }).ok).toBe(true)
  expect(store.approveChat(String(GROUP), 'members', String(OWNER)).ok).toBe(true)

  const text = '@krot_bot сколько будет 2+2'
  const message: Message = {
    message_id: 42, date: 1_800_000_000,
    chat: { id: GROUP, type: 'supergroup', title: 'Team' },
    from: { id: MEMBER, is_bot: false, first_name: 'Иван' },
    text, entities: [{ type: 'mention', offset: 0, length: '@krot_bot'.length }],
  }
  const decision = gateInbound({
    messageId: message.message_id, chatId: GROUP, chatType: 'supergroup', fromId: MEMBER, isBot: false,
    text, entities: message.entities, forwarded: false,
  }, {
    ownerId: String(OWNER), botId: BOT_ID, botUsername: 'krot_bot',
    roleOf: id => store.roleOf(id), chat: id => store.chat(id),
  })
  if (decision.kind !== 'placeholder') throw new Error('expected the public lane, got ' + decision.kind)
  expect(decision.role).toBe('member')

  const runner = new PublicRunnerFake()
  const sent: Array<{ chatId: string; text: string }> = []
  const lane = new PublicLane({
    root: temp('krot-mu-public-'), stateDir, maxParallel: 3, runner, secrets: [],
    send: async (chatId, reply) => { sent.push({ chatId, text: reply }) },
  })
  const brain = new BrainFake()
  const outcome = await publicIntake({
    lane, brain, ownerId: OWNER, scope: SCOPE, botUsername: 'krot_bot',
    send: async (chatId, reply) => { sent.push({ chatId, text: reply }) },
    warn: () => undefined,
  }, message, decision)
  expect(outcome).toBe('accepted')
  await until(() => brain.delivered.length === 1)

  // Reached the public lane: one turn on the role's own runner, in its own folder, with the public instructions.
  expect(runner.calls).toHaveLength(1)
  const call = runner.calls[0]!
  expect(call.profile.role).toBe('member')
  expect(call.profile.instructions).toBe(publicRoleInstructions('member'))
  expect(call.profile.threadId).toBeUndefined()
  expect(sent).toEqual([{ chatId: String(GROUP), text: 'Четыре.' }])

  // No owner main summary: the prompt is exactly the framed member text, nothing of the owner's side-turn header.
  const provenance = userProvenance({ role: 'member', userId: String(MEMBER), chatKey: decision.chatKey })
  expect(call.text).toBe(frameUserMessage(provenance, { name: 'Иван', chat: 'группа «Team»' }, text))
  const ownerHeader = sideInstructions({ title: OWNER_TASK, elapsedMs: 60_000 }, ownerProvenance)
  expect(call.text).not.toContain(OWNER_TASK)
  expect(call.text).not.toContain(ownerHeader.split('\n')[0]!)

  // Brain journals it as foreign: origin agent (never owner-direct), no text, no memory cue, its own key.
  expect(brain.started).toEqual([{
    sessionId: 'unbound', key: publicBrainKey(SCOPE, decision.chatKey, 42), origin: 'agent', inputKind: 'text', cue: false,
  }])
  expect(brain.started[0]!.key.startsWith(SCOPE + ':public:')).toBe(true)
  expect(brain.delivered[0]!.outcome).toEqual({ status: 'delivered' })
})

test('F1 KROT_MULTIUSER=1: an admitted member\'s /memory gets the fixed refusal before any inference or journal entry', async () => {
  const stateDir = temp('krot-mu-state-')
  const store = new AccessStore({ stateDir, ownerId: String(OWNER), envMembers: [String(MEMBER)] })
  const runner = new PublicRunnerFake()
  const lane = new PublicLane({ root: temp('krot-mu-public-'), stateDir, maxParallel: 3, runner, secrets: [], send: async () => undefined })
  const brain = new BrainFake()
  for (const text of ['/memory', '/memory list', '/memory@krot_bot forget all']) {
    const sent: Array<{ chatId: string; text: string }> = []
    const message: Message = {
      message_id: 43, date: 1_800_000_000, chat: { id: MEMBER, type: 'private', first_name: 'Иван' },
      from: { id: MEMBER, is_bot: false, first_name: 'Иван' }, text,
    }
    const decision = gateInbound({
      messageId: message.message_id, chatId: MEMBER, chatType: 'private', fromId: MEMBER, isBot: false, text, forwarded: false,
    }, { ownerId: String(OWNER), botId: BOT_ID, botUsername: 'krot_bot', roleOf: id => store.roleOf(id), chat: id => store.chat(id) })
    if (decision.kind !== 'placeholder') throw new Error('expected the public lane, got ' + decision.kind)
    const outcome = await publicIntake({
      lane, brain, ownerId: OWNER, scope: SCOPE, botUsername: 'krot_bot',
      send: async (chatId, reply) => { sent.push({ chatId, text: reply }) },
      warn: () => undefined,
    }, message, decision)
    expect(outcome).toBe('memory_refused')
    expect(sent).toEqual([{ chatId: String(MEMBER), text: MEMORY_REFUSED }])
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(runner.calls).toEqual([])
  expect(brain.started).toEqual([])
})
