import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import { DaySchema, SnapshotMetaSchema } from '../../../codex-brain/src/contract.js'
import { remember } from '../../../codex-brain/src/permit/remember.js'
import { scopePaths } from '../../../codex-brain/src/store/paths.js'
import { RuntimeEnvSchema } from '../../src/config.js'
import { BRAIN_UNAVAILABLE } from '../../src/codex/brain-commands.js'
import { classifyBrainOrigin, hasMemoryCue } from '../../src/codex/brain-origin.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { LearningMemory } from '../../src/codex/learning.js'
import type { MediaInput } from '../../src/codex/media.js'
import { ownerProvenance } from '../../src/codex/provenance.js'
import { CodexRpc } from '../../src/codex/rpc.js'
import { CodexSession } from '../../src/codex/session.js'
import { classifyTurn, ownerWords } from '../../src/codex/turn-origin.js'

const day = DaySchema.parse('2026-01-12')
const roots: string[] = []
const openSessions: CodexSession[] = []
afterEach(() => {
  for (const session of openSessions.splice(0)) session.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const owner = { message_id: 7, from: { id: 42 }, chat: { type: 'private', id: 42 }, text: 'Поправка: отчёт по пятницам' }

async function fixture(options: { reviewButtons?: boolean } = {}) {
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const root = mkdtempSync(join(tmpdir(), 's6-brain-'))
  roots.push(root)
  const bridge = createBrainBridge({
    brainHome: join(root, 'brain'), scope: 'test', legacyRoot: join(root, 'learning'),
    clock: { now: () => new Date(day + 'T12:00:00Z') },
    ...options,
  })
  return { root, bridge }
}

const direct = (n = 1) => ({
  key: 'test:' + n, origin: 'owner-direct' as const, inputKind: 'text' as const,
  input: owner.text, cue: true, sessionId: 'main',
})
const fact = { id: 'reports', kind: 'correction' as const, description: 'Friday reports', body: owner.text }
type Bridge = Awaited<ReturnType<typeof fixture>>['bridge']
const KEY_LINE = /--permit ([0-9a-f]+)/

/** Sends one owner turn through the RPC adapter and returns the turn key put into its text. */
async function sendTurn(bridge: Bridge, turnId: string, text = owner.text): Promise<string> {
  let key = ''
  await bridge.request(async (_, params) => {
    key = KEY_LINE.exec(JSON.stringify(params))?.[1] ?? ''
    return { turn: { id: turnId } }
  }, 'turn/start', { threadId: 'main', input: [{ type: 'text', text }] })
  return key
}

const cmd = (args: string, callback?: string) => ({
  args, ownerPrivateChat: true, ...(callback === undefined ? {} : { callback }),
})

// Bind the production server callbacks without a Telegram poller, as in server-side-brain.test.ts.
const server = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
function section(start: string, end: string): string {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate the server Brain path')
  return server.slice(from, to)
}

const runMainInput = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { brain, first, input, ownerProvenance, classifyBrainOrigin, classifyTurn, hasMemoryCue, ownerWords, questions, onTurn } = deps
  const ownerId = 42, brainScope = 'test', verification = false, stopping = false, epoch = 0, stopEpoch = 0
  const bot = { botInfo: { id: 7 } }
  const messages = [first], sender = ownerProvenance
  ${section('    const brainKey =', '    function brainRecovery(')}
  return (async () => {
    let brainTurn
    ${section("          if (sender.origin === 'agent') {\n            await runAgentTurn(first, input.text, sender, epoch)", '          const isolate = turnOrigin.isolate')}
    ${section('          const voiceError = first.voice', '          const prompt = ownerTurn(')}
    return onTurn(turnOrigin, brainTurn)
  })()
`))

const deliverBrain = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { brain, env, telegram, ticket, BRAIN_UNAVAILABLE } = deps
  const ownerChat = '42', stopping = false, hudAnchor = { settled: async () => {} }
  const warnError = error => { throw error }
  ${section('    async function sendMemory(', '    type BrainExecution =')}
  ${section('    async function recordBrainDelivery(', '    // The «В очереди»')}
  return recordBrainDelivery(ticket, { status: 'delivered' }, undefined, true)
`))

const runLegacyMemory = new Function('deps', 'args', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { send, sendMemory, learning } = deps
  const brain = { enabled: false }
  const legacyForget = new Map(), randomUUID = () => 'fixture-callback'
  ${section('    async function handleMemory(', '    async function handleCommand(')}
  return handleMemory(args)
`))

function voiceMessage(message_id: number): Message.VoiceMessage {
  return {
    message_id, date: Date.parse(day + 'T12:00:00Z') / 1000,
    chat: { type: 'private', id: 42, first_name: 'Owner' },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    voice: { file_id: 'voice', file_unique_id: 'voice', duration: 1 },
  }
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false
  if (!('message_id' in value) || typeof value.message_id !== 'number') return false
  if (!('date' in value) || typeof value.date !== 'number') return false
  if (!('chat' in value)) return false
  const chat = value.chat
  return typeof chat === 'object' && chat !== null && 'id' in chat && typeof chat.id === 'number'
}

function telegramMessage(json: unknown): Message {
  const parsed: unknown = JSON.parse(JSON.stringify(json))
  if (!isMessage(parsed)) throw new Error('bad fixture')
  return parsed
}

async function mainInput(bridge: Bridge, first: Message, input: MediaInput, asked: unknown[],
  onTurn: (origin: ReturnType<typeof classifyTurn>, execution: ReturnType<Bridge['execution']>) => Promise<void>): Promise<void> {
  await runMainInput({ brain: bridge, first, input, ownerProvenance, classifyBrainOrigin, classifyTurn,
    hasMemoryCue, ownerWords, questions: { ask: async (questions: unknown) => { asked.push(questions); return {} } }, onTurn })
}

test('two direct owner voices need no question and each can save immediately', async () => {
  const { root, bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  const inbox = new CodexInbox(root, 42)
  expect(inbox.receive(voiceMessage(1), ownerProvenance)).toBe('accepted')
  expect(inbox.receive(voiceMessage(2), ownerProvenance)).toBe('accepted')
  const asked: unknown[] = []
  const transcripts = [owner.text, 'Запомни: ' + 'длинное указание '.repeat(125)]
  for (const [index, transcript] of transcripts.entries()) {
    const id = index + 1
    const first = inbox.take()?.[0]
    if (!first) throw new Error('Expected a queued voice message')
    expect(first.message_id).toBe(id)
    await mainInput(bridge, first, { kind: 'input', text: transcript, images: [], ownerTranscript: transcript },
      asked, async (origin, turn) => {
        expect(asked).toEqual([])
        expect(origin).toMatchObject({ origin: 'owner-direct', inputKind: 'voice', role: 'owner', isolate: false })
        inbox.start(id, origin)
        await turn.run(async () => {
          const key = await sendTurn(bridge, 'turn-' + id, transcript)
          expect((await remember({ ...bridge, permitKey: key }, { input: { ...fact, id: 'voice-' + id } })).outcome).toBe('fact')
        })
        inbox.finish(id)
      })
  }
  expect(inbox.take()).toBeUndefined()
  expect(await bridge.facts.list()).toHaveLength(2)
  expect(await bridge.proposals.list()).toEqual([])
  expect((await bridge.journal.reader.fold(day)).map(entry => entry.input)).toEqual(transcripts)
})

const botReply = {
  message_id: 2, date: 1, chat: voiceMessage(1).chat,
  from: { id: 7, is_bot: true, first_name: 'Bridge bot' }, text: 'Previous answer',
}
const foreignOrigin = { type: 'hidden_user', date: 1, sender_user_name: 'Someone else' }
const replyCases: { name: string; direct: boolean; reply: Record<string, unknown> }[] = [
  { name: 'this bot', direct: true, reply: { reply_to_message: botReply } },
  { name: 'this bot forwarding a message', direct: false, reply: { reply_to_message: { ...botReply, forward_origin: foreignOrigin } } },
  { name: 'an external reply', direct: false, reply: { external_reply: { origin: foreignOrigin } } },
  { name: 'a quote of foreign content', direct: false, reply: {
    reply_to_message: { ...botReply, entities: [{ type: 'blockquote', offset: 0, length: botReply.text.length }] },
    quote: { text: botReply.text, position: 0 },
  } },
  { name: 'a quote without a reply target', direct: false, reply: { quote: { text: 'Unknown source', position: 0 } } },
  { name: 'another user', direct: false, reply: {
    reply_to_message: { ...botReply, from: { id: 8, is_bot: false, first_name: 'Another user' } },
  } },
  { name: 'another bot', direct: false, reply: {
    reply_to_message: { ...botReply, from: { id: 9, is_bot: true, first_name: 'Another bot' } },
  } },
]

for (const { name, direct, reply } of replyCases) {
  for (const inputKind of ['text', 'voice']) {
    test(`owner ${inputKind} reply to ${name} is ${direct ? 'direct' : 'non-direct'}`, async () => {
      const { bridge } = await fixture()
      const { message_id, date, chat, from, voice } = voiceMessage(1)
      const base = { message_id, date, chat, from,
        ...(inputKind === 'voice' ? { voice } : { text: owner.text }) }
      const incoming = telegramMessage({ ...base, ...reply })
      const input: MediaInput = { kind: 'input', text: owner.text, images: [],
        ...(inputKind === 'voice' ? { ownerTranscript: owner.text } : {}) }
      await bridge.sessionStarted('main', 'owner')
      await mainInput(bridge, incoming, input, [], async (origin, turn) => {
        expect(origin).toMatchObject({ origin: direct ? 'owner-direct' : 'owner-forward', inputKind })
        await turn.run(async () => {
          const permit = await sendTurn(bridge, 'reply-turn')
          expect(permit.length > 0).toBe(direct)
        })
      })
    })
  }
}

test.each(['forwarded', 'foreign reply', 'failed transcription'])('%s voice keeps its Brain origin and has no write permit', async scenario => {
  const { bridge } = await fixture()
  let first: Message = voiceMessage(1)
  if (scenario === 'forwarded') {
    first.forward_origin = { type: 'hidden_user', date: 1, sender_user_name: 'Someone else' }
  }
  if (scenario === 'foreign reply') {
    const parsed: unknown = JSON.parse(JSON.stringify({
      ...first, reply_to_message: { ...voiceMessage(2), from: { id: 9, is_bot: true, first_name: 'Bot' } },
    }))
    if (!isMessage(parsed)) throw new Error('Expected a Telegram reply message fixture')
    first = parsed
  }
  const asked: unknown[] = []
  const input: MediaInput = { kind: 'input', text: owner.text, images: [],
    ...(scenario === 'failed transcription' ? {} : { ownerTranscript: owner.text }) }
  await mainInput(bridge, first, input, asked, async (origin, turn) => {
    expect(asked).toEqual([])
    const forwarded = scenario === 'forwarded'
    expect(origin).toMatchObject({
      origin: 'owner-forward', inputKind: forwarded ? 'forward' : 'voice',
      role: forwarded ? 'guest' : 'owner', isolate: forwarded,
    })
    await bridge.sessionStarted('main', forwarded ? 'guest' : 'owner')
    await turn.run(async () => {
      expect(await sendTurn(bridge, 'turn-1')).toBe('')
      expect(await bridge.permits.get('turn-1')).toBeNull()
    })
  })
  if (scenario === 'failed transcription') {
    expect(await bridge.journal.reader.fold(day)).toMatchObject([{ error: 'Автоматическая расшифровка недоступна.' }])
  }
})

test.each([
  { name: 'default', setting: undefined }, { name: 'off', setting: 'off' }, { name: 'on', setting: 'on' },
])(
  'post-turn save notice respects $name and gives a forget command when shown', async ({ setting }) => {
    const { bridge } = await fixture()
    const env = RuntimeEnvSchema.parse({ TELEGRAM_BOT_TOKEN: 'test-token', KROT_BRAIN_SAVE_NOTICE: setting })
    await bridge.sessionStarted('main', 'owner')
    const turn = bridge.execution('owner', direct())
    await turn.run(async () => {
      const key = await sendTurn(bridge, 'turn-1')
      expect((await remember({ ...bridge, permitKey: key }, { input: fact })).outcome).toBe('fact')
    })
    if (!turn.ticket) throw new Error('the owner turn has no ticket')
    await bridge.turnAnswered(turn.ticket, 'Done')
    const sent: Array<{ text: string; options: object }> = []
    const telegram = { sendMessage: async (_chat: string, text: string, options: object) => { sent.push({ text, options }) } }
    await deliverBrain({ brain: bridge, env, telegram, ticket: turn.ticket, BRAIN_UNAVAILABLE })
    if (setting === 'on') {
      expect(sent).toEqual([{ text: '💾 Сохранено: Friday reports\n/memory forget reports', options: {} }])
    } else {
      expect(sent).toEqual([])
    }
    expect((await bridge.memoryCommand(cmd('list'))).text).toContain('Friday reports')
    expect(await bridge.journal.reader.fold(day)).toMatchObject([{ status: 'delivered' }])
  },
)

test('binds before the fake app server receives turn/start', async () => {
  const { bridge } = await fixture()
  const turn = bridge.execution('owner', direct())
  const rpc = Object.create(CodexRpc.prototype) as CodexRpc
  rpc.request = async (method, params) => {
    if (method === 'thread/start') {
      expect(await bridge.sessions.claim('main', new Date(day + 'T12:00:00Z'))).toMatchObject({ role: 'owner' })
      expect(params).toEqual({})
      return { thread: { id: 'main' } }
    }
    expect(method).toBe('turn/start')
    expect(await bridge.journal.reader.fold(day)).toMatchObject([{ key: 'test:1', status: 'bound' }])
    return { turn: { id: 'turn-1' } }
  }
  bridge.attach({ rpc })
  await turn.run(async () => {
    // Only the session's main-open path makes a new thread the owner's.
    await bridge.mainOpen(() => rpc.request('thread/start', {}))
    await rpc.request('turn/start', { threadId: 'main', input: [{ type: 'text', text: 'run' }] })
    expect(await bridge.permits.get('turn-1')).toMatchObject({ origin: 'owner-direct', cue: true })
  })
  expect(await bridge.permits.get('turn-1')).toBeNull()
})

test('Telegram failure after answered retries the same exchange after restart', async () => {
  const { root, bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  const ticket = (await bridge.turnStarting(direct()))!
  await bridge.turnStarted(ticket, 'turn-1')
  await bridge.turnAnswered(ticket, 'Answer')
  expect(await bridge.journal.reader.fold(day)).toMatchObject([{ status: 'answered' }])
  await bridge.turnDelivered(ticket, { status: 'failed', error: 'Telegram refused' })
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const restarted = createBrainBridge({ brainHome: join(root, 'brain'), scope: 'test' })
  const recovered = (await restarted.recover(ticket.key, day))!
  await restarted.turnDelivered(recovered, { status: 'delivered' })
  expect(await restarted.journal.reader.fold(day)).toMatchObject([{ status: 'delivered', reply: 'Answer' }])
})

test('typed correction saves a fact and receipt, forwarded correction becomes a proposal', async () => {
  const { bridge } = await fixture()
  const { classifyBrainOrigin, hasMemoryCue } = await import('../../src/codex/brain-origin.js')
  await bridge.sessionStarted('main', 'owner')
  expect(hasMemoryCue(owner.text)).toBe(true)
  const typed = classifyBrainOrigin(owner, 42)
  const turn = bridge.execution('owner', { ...direct(), ...typed })
  const ticket = await turn.run(async () => {
    const key = await sendTurn(bridge, 'turn-1')
    expect((await remember({ ...bridge, permitKey: key }, { input: fact })).outcome).toBe('fact')
    if (!turn.ticket) throw new Error('the owner turn has no ticket')
    await bridge.turnAnswered(turn.ticket, 'Done')
    return turn.ticket
  })
  const notice = await bridge.turnDelivered(ticket, { status: 'delivered' })
  expect(notice.saved).toMatchObject([{ id: 'reports', revision: 1 }])
  expect(bridge.notice(notice.saved)).toEqual({ text: '💾 Сохранено: Friday reports\n/memory forget reports', buttons: [] })
  expect(await bridge.facts.indexText()).toBe('- reports · correction · Friday reports\n')
  expect(await bridge.proposals.list()).toEqual([])
  const forwarded = classifyBrainOrigin({ ...owner, forward_origin: {} }, 42)
  const ref = (await bridge.turnStarting({ ...direct(2), ...forwarded }))!
  await bridge.turnStarted(ref, 'turn-2')
  expect(await bridge.permits.get('turn-2')).toBeNull()
  expect((await remember(bridge, { input: { ...fact, id: 'forwarded' } })).outcome).toBe('proposal')
  expect(await bridge.facts.get('forwarded')).toBeNull()
  expect(await bridge.proposals.list()).toHaveLength(1)
})

test('each owner turn gets a fresh key: only its hash is stored, no caller without it writes, replies are scrubbed', async () => {
  const { root } = await fixture()
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const shared = ['fixture-env-secret']
  const bridge = createBrainBridge({
    brainHome: join(root, 'keyed'), scope: 'test', secrets: shared, issuedKeys: shared,
    clock: { now: () => new Date(day + 'T12:00:00Z') },
  })
  await bridge.sessionStarted('main', 'owner')
  const keys: string[] = []
  for (const n of [1, 2]) {
    const turn = bridge.execution('owner', direct(n))
    await turn.run(async () => {
      const key = await sendTurn(bridge, `turn-${n}`)
      keys.push(key)
      const permit = await bridge.permits.get(`turn-${n}`)
      expect(permit?.key_hash).toBe(createHash('sha256').update(key).digest('hex'))
      expect(JSON.stringify(permit)).not.toContain(key)
      expect((await remember(bridge, { input: { ...fact, id: `borrowed-${n}` } })).outcome).toBe('proposal')
      expect((await remember({ ...bridge, permitKey: 'f'.repeat(36) }, { input: { ...fact, id: `wrong-${n}` } })).outcome).toBe('proposal')
      if (turn.ticket) await bridge.turnAnswered(turn.ticket, `Saved with ${key}`)
    })
  }
  expect(keys[0]).toMatch(/^[0-9a-f]{36}$/)
  expect(keys[1]).toMatch(/^[0-9a-f]{36}$/)
  expect(keys[1]).not.toBe(keys[0])
  expect(await bridge.facts.list()).toEqual([])
  const journalText = JSON.stringify(await bridge.journal.reader.fold(day))
  for (const key of keys) {
    expect(journalText).not.toContain(key)
    expect(shared).toContain(key)
  }
  expect(journalText).toContain('Saved with [REDACTED]')
  expect(shared).toContain('fixture-env-secret')
})

test('pasted quotes and forwards stay isolated, captions count, unclear voice stays in the main thread', async () => {
  const { classifyBrainOrigin } = await import('../../src/codex/brain-origin.js')
  for (const message of [{ ...owner, forward_origin: {} }, { ...owner, is_automatic_forward: true }, { ...owner, entities: [{ type: 'blockquote' }] }]) {
    expect(classifyBrainOrigin(message, 42)).toEqual({ origin: 'owner-forward', inputKind: 'forward', isolate: true })
  }
  const photo = { message_id: 8, from: { id: 42 }, chat: { type: 'private', id: 42 }, caption: 'Поправка: логотип слева' }
  expect(classifyBrainOrigin(photo, 42)).toEqual({ origin: 'owner-direct', inputKind: 'media', isolate: false })
  expect(classifyBrainOrigin({ ...photo, caption: undefined }, 42)).toEqual({ origin: 'owner-forward', inputKind: 'media', isolate: false })
  expect(classifyBrainOrigin({ ...owner, text: undefined, voice: {} }, 42)).toEqual({ origin: 'owner-forward', inputKind: 'voice', isolate: false })
  expect(classifyBrainOrigin({ ...owner, chat: { ...owner.chat, type: 'group' } }, 42)).toMatchObject({ origin: 'agent', isolate: true })
  expect(classifyBrainOrigin(owner, 42, { agent: true })).toMatchObject({ origin: 'agent', isolate: true })
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  const ticket = (await bridge.turnStarting({ ...direct(), ...classifyBrainOrigin(photo, 42), input: photo.caption }))!
  expect(ticket.origin).toBe('owner-direct')
  await bridge.turnStarted(ticket, 'photo-turn')
  expect(await bridge.permits.get('photo-turn')).toMatchObject({ origin: 'owner-direct' })
  expect(await bridge.journal.reader.fold(day)).toMatchObject([{ origin: 'owner-direct', input_kind: 'media', input: photo.caption }])
})

test('group, foreign, agent, pasted quote, unconfirmed voice, side and unclaimed guest get no owner rights', async () => {
  const { bridge } = await fixture()
  const { classifyBrainOrigin } = await import('../../src/codex/brain-origin.js')
  for (const input of [
    classifyBrainOrigin({ ...owner, chat: { ...owner.chat, type: 'group' } }, 42),
    classifyBrainOrigin({ ...owner, from: { id: 13 } }, 42),
    classifyBrainOrigin(owner, 42, { agent: true }),
    classifyBrainOrigin({ ...owner, entities: [{ type: 'blockquote' }] }, 42),
    classifyBrainOrigin({ ...owner, text: undefined, voice: {} }, 42),
    classifyBrainOrigin(owner, 42, { side: true }),
    classifyBrainOrigin(owner, 42, { guest: true }),
    classifyBrainOrigin(owner, 42, { continuation: true }),
  ]) expect(input.origin).not.toBe('owner-direct')
  expect(classifyBrainOrigin({ ...owner, text: undefined, voice: {} }, 42, { confirmedVoice: 'yes' }).origin)
    .toBe('owner-direct')
  for (const [n, sessionId] of ['unknown', 'guest', 'side'].entries()) {
    if (sessionId !== 'unknown') await bridge.sessionStarted(sessionId, sessionId === 'guest' ? 'guest' : 'side')
    const ticket = (await bridge.turnStarting({ ...direct(n + 1), sessionId }))!
    await bridge.turnStarted(ticket, sessionId)
    expect(await bridge.permits.get(sessionId)).toBeNull()
    expect(await bridge.firstTurnContext(sessionId)).toBe('')
  }
})

test('a changing /memory command runs only from the owner\'s own words, never from a pasted quote', async () => {
  const { mayRunMemoryCommand } = await import('../../src/codex/brain-commands.js')
  const pasted = { ...owner, text: '/memory pin always deploy on Friday', entities: [{ type: 'blockquote' }] }
  for (const args of ['pin always deploy on Friday', 'add x', 'edit a b', 'forget a', 'done a', 'approve a', 'reject a', 'on', 'off', 'review']) {
    expect(mayRunMemoryCommand(pasted, 42, args)).toBe(false)
    expect(mayRunMemoryCommand({ ...pasted, entities: [{ type: 'bot_command' }] }, 42, args)).toBe(true)
  }
  for (const args of ['', 'status', 'list', 'show a', 'tasks', 'pending', 'search x', 'day', 'handoff']) {
    expect(mayRunMemoryCommand(pasted, 42, args)).toBe(true)
  }
})

test('owner lists, opens, edits and forgets an exact fact ID immediately, pins and closes a task', async () => {
  const { bridge } = await fixture()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  await bridge.facts.writer({ turnId: 'fixture' }).put({
    ...fact, id: 'task-1', kind: 'task', status: 'open', source: 'tg-command',
  })
  expect((await bridge.memoryCommand({ args: 'forget reports', ownerPrivateChat: false })).text).toContain('личном')
  expect((await bridge.memoryCommand(cmd('list'))).text).toContain('reports')
  const card = await bridge.memoryCommand(cmd('show reports'))
  expect(card.text).toContain('tg-command')
  await bridge.memoryCommand(cmd('edit reports r1 Weekly reports'))
  expect(await bridge.memoryCommand(cmd('forget reports task-1'))).toEqual({ text: 'Укажите один ID записи.', buttons: [] })
  expect(await bridge.memoryCommand(cmd('forget unknown'))).toEqual({ text: 'Запись не найдена.', buttons: [] })
  expect(await bridge.facts.get('reports')).toMatchObject({ body: 'Weekly reports' })
  expect(await bridge.memoryCommand(cmd('forget reports'))).toEqual({ text: 'Запись удалена.', buttons: [] })
  expect(await bridge.facts.get('reports')).toBeNull()
  expect(card.text).toContain('/memory forget reports')
  expect(card.buttons.flat().map(button => button.label)).toEqual(['Изменить'])
  await bridge.memoryCommand(cmd('pin standing rule'))
  expect(await bridge.facts.list('pinned')).toHaveLength(1)
  expect((await bridge.memoryCommand(cmd('tasks'))).text).toContain('task-1')
  await bridge.memoryCommand(cmd('done task-1'))
  expect(await bridge.facts.get('task-1')).toMatchObject({ status: 'done' })
})

test('forget keeps a fact edited between lookup and deletion', async () => {
  const { bridge } = await fixture()
  const writer = bridge.facts.writer({ turnId: 'fixture' })
  await writer.put({ ...fact, source: 'tg-command' })
  const get = bridge.facts.get.bind(bridge.facts)
  const lookup = spyOn(bridge.facts, 'get').mockImplementationOnce(async id => {
    const before = await get(id)
    await writer.put({ ...fact, body: 'Concurrent edit', source: 'tg-command' }, 1)
    return before
  })
  try {
    expect(await bridge.memoryCommand(cmd('forget reports'))).toEqual({ text: 'этот факт изменился, откройте заново.', buttons: [] })
    expect(await bridge.facts.get('reports')).toMatchObject({ body: 'Concurrent edit', revision: 2 })
  } finally { lookup.mockRestore() }
})

test('text approval refuses a proposal after a same-day owner edit', async () => {
  const { bridge } = await fixture()
  const writer = bridge.facts.writer({ turnId: 'fixture' })
  await writer.put({ ...fact, source: 'tg-command' })
  const result = await remember(bridge, { input: { ...fact, body: 'Proposed update' } })
  if (result.outcome !== 'proposal') throw new Error('Expected a proposal')
  const { id } = result.proposal
  expect((await bridge.memoryCommand(cmd('pending'))).text).toContain(id)
  expect((await bridge.memoryCommand(cmd('edit reports r1 Owner edit'))).text).toBe('Запись изменена.')

  expect((await bridge.memoryCommand(cmd('approve ' + id))).text).toBe('этот факт изменился, откройте заново.')
  expect(await bridge.facts.get(fact.id)).toMatchObject({ body: 'Owner edit', revision: 2 })
  expect(await bridge.proposals.get(id)).not.toBeNull()
})

test('text approval updates a fact when the proposed revision is current', async () => {
  const { bridge } = await fixture()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  const result = await remember(bridge, { input: { ...fact, body: 'Proposed update' } })
  if (result.outcome !== 'proposal') throw new Error('Expected a proposal')

  expect((await bridge.memoryCommand(cmd('approve ' + result.proposal.id))).text).toBe('Предложение принято.')
  expect(await bridge.facts.get(fact.id)).toMatchObject({ body: 'Proposed update', revision: 2 })
})

test('text approval keeps existing facts when a legacy proposal has no pinned revision', async () => {
  const { bridge } = await fixture()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  await bridge.proposals.add({ id: 'legacy-update', fact: { ...fact, body: 'Proposed update' },
    from: 'remember', reason: 'no-permit', created: day + 'T12:00:00Z' })

  expect((await bridge.memoryCommand(cmd('approve legacy-update'))).text).toBe('этот факт изменился, откройте заново.')
  expect(await bridge.facts.get(fact.id)).toMatchObject({ body: fact.body, revision: 1 })
})

test('button approval still checks the revision shown on the pending page', async () => {
  const { bridge } = await fixture({ reviewButtons: true })
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  const result = await remember(bridge, { input: { ...fact, body: 'Proposed update' } })
  if (result.outcome !== 'proposal') throw new Error('Expected a proposal')
  expect((await bridge.memoryCommand(cmd('edit reports r1 Owner edit'))).text).toBe('Запись изменена.')
  const accept = (await bridge.memoryCommand(cmd('pending'))).buttons[0]?.[0]
  if (!accept) throw new Error('Expected an accept button')

  expect((await bridge.memoryCommand(cmd('', accept.data))).text).toBe('Предложение принято.')
  expect(await bridge.facts.get(fact.id)).toMatchObject({ body: 'Proposed update', revision: 3 })
})

test.each([{ name: 'default', setting: undefined }, { name: 'off', setting: 'off' }, { name: 'on', setting: 'on' }])(
  'pending review respects $name and keeps both pages reachable', async ({ setting }) => {
    const env = RuntimeEnvSchema.parse({ TELEGRAM_BOT_TOKEN: 'test-token', KROT_BRAIN_REVIEW_BUTTONS: setting })
    const { bridge } = await fixture({ reviewButtons: env.KROT_BRAIN_REVIEW_BUTTONS === 'on' })
    for (let n = 1; n <= 7; n++) {
      await bridge.proposals.add({ id: `p-${n}`, fact: { ...fact, id: `fact-${n}` }, from: 'remember',
        reason: 'not-owner-direct', origin: 'owner-forward', created: day + 'T12:00:00.000Z' })
    }
    const first = await bridge.memoryCommand(cmd('pending'))
    const second = await bridge.memoryCommand(cmd('pending 2'))
    expect(first.text).toContain('p-1 · Friday reports')
    expect(first.text).not.toContain('p-7')
    expect(second.text).toContain('p-7 · Friday reports')
    if (setting === 'on') {
      expect(first.buttons.at(-1)?.map(button => button.label)).toEqual(['Далее'])
      expect(second.buttons.map(row => row.map(button => button.label))).toEqual([['Принять p-7', 'Отклонить p-7'], ['Назад']])
      const reject = second.buttons[0]?.[1]
      if (!reject) throw new Error('Expected a reject button')
      expect((await bridge.memoryCommand(cmd('', reject.data))).text).toBe('Предложение отклонено.')
    } else {
      expect(first.buttons).toEqual([])
      expect(second.buttons).toEqual([])
      for (const page of [first, second]) {
        expect(page.text).toContain('/memory approve ID')
        expect(page.text).toContain('/memory reject ID')
      }
      expect(first.text).toContain('/memory pending 2')
      expect(second.text).toContain('/memory pending 1')
    }
    expect((await bridge.memoryCommand(cmd('approve p-1'))).text).toBe('Предложение принято.')
    expect((await bridge.memoryCommand(cmd('reject p-2'))).text).toBe('Предложение отклонено.')
    expect(await bridge.facts.get('fact-1')).not.toBeNull()
    expect(await bridge.proposals.get('p-2')).toBeNull()
  },
)

test('legacy /memory forget deletes directly and sends plain text', async () => {
  const { root } = await fixture()
  const learning = new LearningMemory(root, 1, [], async () => JSON.stringify({ entries: [
    { kind: 'user', key: 'reports', text: 'Friday reports', evidence: [0], triggers: [] },
  ] }), true)
  learning.observe('Friday reports', 'Done')
  expect(await learning.review()).toBe(1)
  const sent: string[] = []
  await runLegacyMemory({ learning, send: async (text: string) => { sent.push(text) },
    sendMemory: async () => { throw new Error('Unexpected memory card') } }, 'forget user/reports')
  expect(sent).toEqual(['Удалено · user/reports'])
  expect(learning.context('reports')).toBe('')
  const reopened = new LearningMemory(root, 1, [], async () => '')
  expect(reopened.context('reports')).toBe('')
})

test('with hooks absent, first owner turn gets HOT and status explains degraded handoff', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  expect(await bridge.firstTurnContext('main')).toContain('Friday reports')
  expect((await bridge.memoryCommand(cmd(''))).text).toContain('degraded: no handoff inside a turn')
})

test('with working hooks, an owner thread the hook skipped gets first-turn HOT from the bridge once', async () => {
  const { bridge } = await fixture()
  bridge.setHooks({ hooks: 'managed', precompact: 'installed' })
  await bridge.sessionStarted('main', 'owner')
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  expect(await bridge.firstTurnContext('main')).toContain('Friday reports')
  expect(await bridge.firstTurnContext('main')).toBe('')
})

/** A Codex session on the fake app server wired to the bridge the way server.ts wires it. */
async function wired(saved?: string) {
  const { root, bridge } = await fixture()
  const stateFile = join(root, 'thread.json')
  if (saved !== undefined) writeFileSync(stateFile, JSON.stringify(saved) + '\n')
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile, env: process.env,
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    onMain: id => bridge.registerOwnerMain(id),
    aroundMainOpen: open => bridge.mainOpen(open),
  }, () => {})
  openSessions.push(session)
  bridge.attach(session)
  await session.initialize()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  /** One owner-direct turn on the main thread; the fake app server echoes the text Codex received. */
  const ownerTurn = (n: number) => bridge.execution('owner', { ...direct(n), sessionId: '' }).run(() => session.run(owner.text))
  return { bridge, session, ownerTurn }
}

test('O1-1 a pre-M5 thread resumed by the goal restore outside any execution is the owner thread on the next turn', async () => {
  const { bridge, session, ownerTurn } = await wired('legacy-thread')
  expect(await session.goal()).toBeNull()
  expect(await bridge.sessions.resolve('legacy-thread')).toMatchObject({ role: 'owner', scope: 'test' })
  const result = await ownerTurn(1)
  expect(result.text).toContain('Friday reports')
  expect(result.text).toMatch(KEY_LINE)
})

test('O1-2 /cc resume of an unregistered thread and inbox recovery through previousTurnIdle register the owner thread', async () => {
  const resumed = await wired()
  await resumed.session.resume('chosen-thread')
  expect(await resumed.bridge.sessions.resolve('chosen-thread')).toMatchObject({ role: 'owner' })
  expect((await resumed.ownerTurn(1)).text).toMatch(KEY_LINE)
  const recovered = await wired('saved-thread')
  await recovered.session.previousTurnIdle()
  expect(await recovered.bridge.sessions.resolve('saved-thread')).toMatchObject({ role: 'owner' })
  expect((await recovered.ownerTurn(2)).text).toMatch(KEY_LINE)
})

test('O1-4 a forked goal thread and an archive thread opened outside an execution are registered as owner', async () => {
  const forked = await wired()
  const thread = await forked.session.fork()
  expect(await forked.bridge.sessions.resolve(thread)).toMatchObject({ role: 'owner' })
  const archive = await wired()
  await archive.session.openArchive('Контекст из архива')
  const opened = archive.session.currentThread
  expect(opened).not.toBeNull()
  expect(await archive.bridge.sessions.resolve(opened ?? '')).toMatchObject({ role: 'owner' })
})

test('O1-5 an owner execution opening a side thread registers it guest, and guest or side entries are never upgraded', async () => {
  const { bridge } = await fixture()
  await bridge.execution('owner', direct()).run(() =>
    bridge.request(async () => ({ thread: { id: 'opened-side' } }), 'thread/start', {}))
  expect(await bridge.sessions.resolve('opened-side')).toMatchObject({ role: 'guest' })
  await bridge.execution('owner', direct(2)).run(() =>
    bridge.request(async () => ({ thread: { id: 'forked-side' } }), 'thread/fork', { threadId: 'main' }))
  expect(await bridge.sessions.resolve('forked-side')).toMatchObject({ role: 'guest' })
  // thread/resume registers nothing.
  await bridge.execution('owner', direct(3)).run(() =>
    bridge.request(async () => ({ thread: { id: 'legacy' } }), 'thread/resume', { threadId: 'legacy' }))
  expect(await bridge.sessions.resolve('legacy')).toBeNull()
  await bridge.sessionStarted('side', 'side')
  for (const [id, role] of [['opened-side', 'guest'], ['side', 'side']] as const) {
    await expect(bridge.registerOwnerMain(id)).rejects.toThrow(id)
    expect(await bridge.sessions.resolve(id)).toMatchObject({ role })
  }
  expect(await bridge.registerOwnerMain('main')).toBe(true)
  expect(await bridge.registerOwnerMain('main')).toBe(true)
  expect(await bridge.sessions.resolve('main')).toMatchObject({ role: 'owner' })
})

test('ten owner turns add identical empty memory bytes after the boundary', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  // What the bridge actually transmits, minus the per-turn key line it appends after the owner's text.
  const transmitted: string[] = []
  for (let i = 0; i < 11; i++) {
    await bridge.execution('owner', direct(i + 1)).run(() => bridge.request(async (_, params) => {
      const [first]: unknown[] = Array.isArray(params.input) ? params.input : []
      const text = typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string' ? first.text : ''
      transmitted.push(text.split('\n\nBrain turn key: ')[0] ?? '')
      return { turn: { id: `turn-${i}` } }
    }, 'turn/start', { threadId: 'main', input: [{ type: 'text', text: 'run' }] }))
  }
  expect(transmitted[0]).toContain('Friday reports')
  const hashes = new Set(transmitted.slice(1).map(text => createHash('sha256').update(text).digest('hex')))
  expect([...hashes]).toEqual([createHash('sha256').update('run').digest('hex')])
})

test('legacy entries and skill triggers migrate once as proposals and old commands still work', async () => {
  const { bridge, root } = await fixture()
  mkdirSync(join(root, 'learning'))
  writeFileSync(join(root, 'learning', 'learning.json'), JSON.stringify({
    exchanges: [{ user: 'Question', assistant: 'Answer' }],
    pending: [{ kind: 'user', key: 'reports', text: 'Sunday reports', triggers: [] }],
    approved: [{ kind: 'skill', key: 'weekly', text: 'Make a chart', triggers: ['weekly checklist'] }],
  }))
  // A legacy "approved" entry may be auto-saved model output: it waits for the owner like any proposal.
  expect(await bridge.migrate()).toEqual({ facts: 0, proposals: 2, exchanges: 1 })
  expect(await bridge.facts.get('legacy-skill-weekly')).toBeNull()
  expect(await bridge.facts.list()).toEqual([])
  expect(await bridge.migrate()).toEqual({ facts: 0, proposals: 0, exchanges: 0 })
  await bridge.memoryCommand(cmd('approve skill/weekly'))
  expect((await bridge.facts.get('legacy-skill-weekly'))?.body).toContain('weekly checklist')
  expect((await bridge.memoryCommand(cmd('pending'))).text).toContain('Sunday reports')
  await bridge.memoryCommand(cmd('approve user/reports'))
  expect(await bridge.facts.get('legacy-user-reports')).toMatchObject({ body: 'Sunday reports' })
  expect(await bridge.memoryCommand(cmd('forget user/reports'))).toEqual({ text: 'Запись удалена.', buttons: [] })
  expect(await bridge.facts.get('legacy-user-reports')).toBeNull()
  expect(await bridge.migrate()).toEqual({ facts: 0, proposals: 0, exchanges: 0 })
})

test('off survives restart and leaves legacy-shaped app-server requests untouched', async () => {
  const { root, bridge } = await fixture()
  await bridge.memoryCommand(cmd('off'))
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const restarted = createBrainBridge({ brainHome: join(root, 'brain'), scope: 'test' })
  expect(restarted.enabled).toBe(false)
  expect(await restarted.turnStarting(direct())).toBeNull()
  const params = { threadId: 'main', input: [{ type: 'text', text: 'original' }] }
  await restarted.execution('owner', direct()).run(() => restarted.request(async (_, sent) => {
    expect(sent).toBe(params)
    return { turn: { id: 'original' } }
  }, 'turn/start', params))
  expect(await restarted.journal.reader.fold(day)).toEqual([])
  await restarted.memoryCommand(cmd('on'))
  expect(restarted.enabled).toBe(true)
})

test('store failure leaves the model answer available and reports unsaved memory', async () => {
  const { root } = await fixture()
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const blocked = join(root, 'file')
  writeFileSync(blocked, 'not a directory')
  const bridge = createBrainBridge({ brainHome: blocked, scope: 'test' })
  const turn = bridge.execution('owner', direct())
  const answer = await turn.run(() => bridge.request(async () => ({ turn: { id: 'ran' } }),
    'turn/start', { threadId: 'main' }))
  expect(answer).toEqual({ turn: { id: 'ran' } })
  expect(turn.unavailable).toBe(true)
})

test('the latest completed compaction exports a fresh handoff for the next owner turn', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.firstTurnContext('main')
  await bridge.openQuestions('main', ['First question'])
  await bridge.compactionSeen({ sessionId: 'main', phase: 'started' })
  await bridge.compactionSeen({ sessionId: 'main', phase: 'completed' })
  await bridge.openQuestions('main', ['Replacement question'])
  await bridge.planUpdated({ sessionId: 'main', turnId: 'prior', steps: [{ step: 'Next action', status: 'pending' }] })
  await bridge.compactionSeen({ sessionId: 'main', phase: 'started' })
  await bridge.compactionSeen({ sessionId: 'main', phase: 'completed' })
  const text = await bridge.firstTurnContext('main')
  expect(text).toContain('Replacement question')
  expect(text).toContain('Next action')
  expect(text).not.toContain('First question')
  expect(await bridge.firstTurnContext('main')).toBe('')
  expect((await bridge.memoryCommand(cmd('handoff'))).text).toContain('Replacement question')
})

test('a rejected first turn/start keeps the degraded handoff and the retry delivers the same payload', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.firstTurnContext('main')
  await bridge.openQuestions('main', ['Pending question'])
  await bridge.compactionSeen({ sessionId: 'main', phase: 'started' })
  await bridge.compactionSeen({ sessionId: 'main', phase: 'completed' })
  const sent: string[] = []
  const params = { threadId: 'main', input: [{ type: 'text', text: 'run' }] }
  await bridge.execution('owner', direct()).run(async () => {
    await expect(bridge.request(async (_, body) => {
      sent.push(JSON.stringify(body))
      throw new Error('fixture rejected the turn')
    }, 'turn/start', params)).rejects.toThrow('fixture rejected the turn')
    expect((await bridge.status()).last_handoff_delivery).toBeNull()
    await bridge.request(async (_, body) => {
      sent.push(JSON.stringify(body))
      return { turn: { id: 'turn-2' } }
    }, 'turn/start', params)
  })
  const withoutKey = sent.map(text => text.replace(/[0-9a-f]{36}/g, 'KEY'))
  expect(withoutKey).toHaveLength(2)
  expect(withoutKey[0]).toContain('Pending question')
  expect(withoutKey[1]).toBe(withoutKey[0])
  expect((await bridge.status()).last_handoff_delivery).not.toBeNull()
  expect(await bridge.firstTurnContext('main')).toBe('')
})

test('a concurrent guest turn cannot borrow the live owner permit', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.sessionStarted('side', 'side')
  await bridge.execution('owner', direct()).run(async () => {
    await bridge.request(async () => ({ turn: { id: 'owner-turn' } }), 'turn/start', { threadId: 'main' })
    expect(await bridge.permits.get('owner-turn')).not.toBeNull()
    await bridge.execution('side', { ...direct(2), origin: 'agent' }).run(() =>
      bridge.request(async () => {
        expect(await bridge.permits.live(bridge.clock.now())).toEqual([])
        expect((await remember(bridge, { input: fact })).outcome).toBe('proposal')
        return { turn: { id: 'side-turn' } }
      }, 'turn/start', { threadId: 'side' }))
    expect(await bridge.facts.list()).toEqual([])
  })
})

test('a replay cannot raise the origin of an existing forwarded exchange', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.turnStarting({ ...direct(), origin: 'owner-forward', inputKind: 'forward' })
  const replay = (await bridge.turnStarting(direct()))!
  await bridge.turnStarted(replay, 'replayed')
  expect(replay.origin).toBe('owner-forward')
  expect(await bridge.permits.get('replayed')).toBeNull()
})

test('a guest startup classified as terminal never reaches turn/start', async () => {
  const { bridge } = await fixture()
  let starts = 0
  const turn = bridge.execution('guest', { ...direct(), origin: 'agent' })
  await turn.run(async () => {
    const opened = await bridge.request(async () => {
      const session_id = ++starts === 1 ? 'wrong' : 'guest'
      if (starts === 1) {
        await bridge.sessions.register({ session_id, role: 'terminal', scope: 'local', registered: day + 'T12:00:00Z' })
      }
      return { thread: { id: session_id } }
    }, 'thread/start', {})
    const thread = opened.thread as { id: string }
    await bridge.request(async (_, params) => {
      expect(params.threadId).toBe('guest')
      expect(await bridge.firstTurnContext('guest')).toBe('')
      return { turn: { id: 'guest-turn' } }
    }, 'turn/start', { threadId: thread.id })
  })
  expect(starts).toBe(2)
  expect(await bridge.permits.live(bridge.clock.now())).toEqual([])
})

test('the default Brain menu exposes memory and rollback restores the release menu', async () => {
  const { codexCommandSet } = await import('../../src/codex/commands.js')
  const { AppConfigSchema } = await import('../../src/config.js')
  const config = AppConfigSchema.parse({})
  const log = { info() {} }
  expect(codexCommandSet(config, false, undefined, log, [], true).menu.map(item => item.command)).toContain('memory')
  expect(codexCommandSet(config, false, undefined, log).menu.map(item => item.command)).not.toContain('memory')
})

test('plain edit and pin address the existing fact through its revision', async () => {
  const { bridge } = await fixture()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  expect((await bridge.memoryCommand(cmd('edit reports Revised report rule'))).text).toBe('Запись изменена.')
  expect((await bridge.memoryCommand(cmd('pin reports'))).text).toBe('Запись закреплена.')
  expect(await bridge.facts.get('reports')).toMatchObject({ body: 'Revised report rule', kind: 'pinned', revision: 3 })
  expect(await bridge.facts.list()).toHaveLength(1)
})

test('the bridge and the hook pack flag the same memory cues', async () => {
  const { hasMemoryCue: bridgeCue } = await import('../../src/codex/brain-origin.js')
  const { hasMemoryCue: hookCue } = await import('../../../codex-hooks/src/prompt.js')
  for (const text of ['Поправка: отчёт по пятницам', 'correction: use tabs', 'Так не работает', 'Запомните это', 'remember this',
    'не надо так', 'я же просила', 'Это неправильно']) {
    expect([text, bridgeCue(text), hookCue(text)]).toEqual([text, true, true])
  }
  for (const text of ['Отчёт готов', 'I remembered it', 'с поправками']) {
    expect([text, bridgeCue(text), hookCue(text)]).toEqual([text, false, false])
  }
})

test('O1-12 an owner photo caption gets a write permit only with a memory cue', async () => {
  const { bridge } = await fixture()
  const { hasMemoryCue } = await import('../../src/codex/brain-origin.js')
  await bridge.sessionStarted('main', 'owner')
  for (const [n, caption] of [[1, 'Логотип слева'], [2, 'Запомни: логотип слева']] as const) {
    const ticket = (await bridge.turnStarting({ ...direct(n), inputKind: 'media', input: caption, cue: hasMemoryCue(caption) }))!
    expect(ticket.origin).toBe('owner-direct')
    await bridge.turnStarted(ticket, 'photo-' + n)
  }
  expect(await bridge.permits.get('photo-1')).toBeNull()
  expect(await bridge.permits.get('photo-2')).toMatchObject({ origin: 'owner-direct', cue: true })
})

test('O1-13 in degraded mode a rejected turn/start keeps the memory delta for the accepted retry', async () => {
  const { bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.firstTurnContext('main')
  appendFileSync(bridge.journal.paths.delta,
    JSON.stringify({ seq: 1, id: 'reports', action: 'changed', at: day + 'T12:00:00Z' }) + '\n')
  const sent: string[] = []
  const params = { threadId: 'main', input: [{ type: 'text', text: 'run' }] }
  await bridge.execution('owner', direct()).run(async () => {
    await expect(bridge.request(async (_, body) => {
      sent.push(JSON.stringify(body))
      throw new Error('fixture rejected the turn')
    }, 'turn/start', params)).rejects.toThrow('fixture rejected the turn')
    await bridge.request(async (_, body) => {
      sent.push(JSON.stringify(body))
      return { turn: { id: 'turn-2' } }
    }, 'turn/start', params)
  })
  expect(sent).toHaveLength(2)
  expect(sent[0]).toContain('fact reports changed')
  expect(sent[1]).toContain('fact reports changed')
  // Accepted once: the next turn does not repeat it.
  await bridge.execution('owner', direct(3)).run(() => bridge.request(async (_, body) => {
    sent.push(JSON.stringify(body))
    return { turn: { id: 'turn-3' } }
  }, 'turn/start', params))
  expect(sent[2]).not.toContain('fact reports changed')
})

async function deltaFixture() {
  const { root, bridge } = await fixture()
  await bridge.sessionStarted('main', 'owner')
  await bridge.firstTurnContext('main')
  const paths = scopePaths(join(root, 'brain'), 'test')
  const meta = paths.snapshotMeta('main')
  const stash = join(paths.snapshotDir, 'main.bridge.delta.json')
  function append(seq: number, id: string) {
    appendFileSync(paths.delta, JSON.stringify({ seq, id, action: 'changed', at: day + 'T12:00:00Z' }) + '\n')
  }
  function send(n: number, accept = true) {
    let text = ''
    const request = bridge.execution('owner', direct(n)).run(() => bridge.request(async (_, body) => {
      const first: unknown = Array.isArray(body.input) ? body.input[0] : undefined
      if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') text = first.text
      if (!accept) throw new Error('fixture rejected the turn')
      return { turn: { id: 'turn-' + n } }
    }, 'turn/start', { threadId: 'main', input: [{ type: 'text', text: 'run' }] }))
    return request.then(() => text)
  }
  return {
    bridge, meta, stash, append, send,
    cursor: () => SnapshotMetaSchema.parse(JSON.parse(readFileSync(meta, 'utf8'))).delta_seen,
  }
}

test('the delta cursor waits until the pending stash is written', async () => {
  const delta = await deltaFixture()
  delta.append(1, 'reports')
  // An atomic rename onto a directory fails, simulating an interrupted stash write.
  mkdirSync(delta.stash)
  const first = await delta.send(1)
  expect(delta.cursor()).toBe(0)
  expect(first.includes('fact reports changed')).toBe(false)
  rmdirSync(delta.stash)
  expect((await delta.send(2)).includes('fact reports changed')).toBe(true)
  expect(delta.cursor()).toBe(1)
  expect(existsSync(delta.stash)).toBe(false)
})

test('retry joins stashed and fresh deltas once after a cursor interruption', async () => {
  const delta = await deltaFixture()
  const originalMeta = readFileSync(delta.meta, 'utf8')
  delta.append(1, 'reports')
  await expect(delta.send(1, false)).rejects.toThrow('fixture rejected the turn')
  expect(readFileSync(delta.stash, 'utf8')).toContain('fact reports changed')
  // Recreate the durable state after a crash following the stash write and preceding the cursor write.
  writeFileSync(delta.meta, originalMeta)
  delta.append(2, 'schedule')
  const text = await delta.send(2)
  expect(text.match(/fact reports changed/gu)).toHaveLength(1)
  expect(text.includes('read it before use\n\nmemory update: fact schedule changed')).toBe(true)
  expect(delta.cursor()).toBe(2)
})

test('working hooks leave a pending bridge delta for the next degraded turn', async () => {
  const delta = await deltaFixture()
  delta.append(1, 'reports')
  await expect(delta.send(1, false)).rejects.toThrow('fixture rejected the turn')
  delta.bridge.setHooks({ hooks: 'managed', precompact: 'installed' })
  expect((await delta.send(2)).includes('fact reports changed')).toBe(false)
  expect(existsSync(delta.stash)).toBe(true)
  delta.bridge.setHooks({ hooks: 'none', precompact: 'not-installed' })
  expect((await delta.send(3)).includes('fact reports changed')).toBe(true)
  expect(existsSync(delta.stash)).toBe(false)
})
