// One origin carrier per turn: classified once, persisted with every artifact, required by every owner sink.
import { expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import {
  bridgeOrigin, classifyTurn, mainOrigin, ownerOrigin, ownerWords, parseTurnOrigin, storedOrigin, withTurn,
} from '../../src/codex/turn-origin.js'
import { agentProvenance, ownerProvenance, turnIntent } from '../../src/codex/provenance.js'
import { createOwnerEffects } from '../../src/codex/owner-effects.js'
import { OpenQuestionStore } from '../../src/state/open-question-store.js'
import { Outbox } from '../../src/safety/outbox.js'
import { createLogger } from '../../src/log.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = 42
const chat = { id: OWNER, type: 'private' as const, first_name: 'Owner' }
const from = { id: OWNER, is_bot: false as const, first_name: 'Owner' }
function message(id: number, extra: Partial<Message> = {}): Message {
  return { message_id: id, date: 1, chat, from, ...extra } as Message
}
const photo = [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }]
const quoted = (text: string): Partial<Message> => ({ text, entities: [{ type: 'blockquote', offset: 0, length: text.length }] })

test('O1-11 an album with a pasted quote in a later item is isolated as owner-forward', () => {
  const album = [
    message(10, { media_group_id: 'g', photo, caption: 'Логотип слева' }),
    message(11, { media_group_id: 'g', photo, caption: 'Цитата', caption_entities: [{ type: 'blockquote', offset: 0, length: 6 }] }),
  ]
  const origin = classifyTurn(album, OWNER, ownerProvenance, { brain: true, key: 'test:10' })
  expect(origin).toMatchObject({ origin: 'owner-forward', inputKind: 'forward', isolate: true, role: 'guest', messageId: 10 })
  expect(ownerOrigin(origin)).toBeUndefined()
})

test('O1-11 an album of plain captions is owner-direct and its journal text is the joined captions', () => {
  const album = [
    message(10, { media_group_id: 'g', photo, caption: 'Первый кадр' }),
    message(11, { media_group_id: 'g', photo }),
    message(12, { media_group_id: 'g', photo, caption: 'Третий кадр' }),
  ]
  const origin = classifyTurn(album, OWNER, ownerProvenance, { brain: true, key: 'test:10' })
  expect(origin).toMatchObject({ origin: 'owner-direct', inputKind: 'media', isolate: false, role: 'owner' })
  expect(Object.is(ownerOrigin(origin), origin)).toBe(true)
  expect(ownerWords(album)).toBe('Первый кадр\n\nТретий кадр')
})

test('the role is derived from the input: agent is guest, side is side, an isolated forward is guest', () => {
  const text = message(5, { text: 'Сделай отчёт' })
  expect(classifyTurn([text], OWNER, agentProvenance('peer'), { brain: true, key: 'k' }).role).toBe('guest')
  expect(classifyTurn([text], OWNER, ownerProvenance, { brain: true, key: 'k', side: true }).role).toBe('side')
  expect(classifyTurn([message(5, quoted('чужой текст'))], OWNER, ownerProvenance, { brain: true, key: 'k' }).role).toBe('guest')
  expect(classifyTurn([text], OWNER, ownerProvenance, { brain: true, key: 'k' }).role).toBe('owner')
})

test('O1-15 with Brain off an owner forward runs on the main thread with the owner role', () => {
  const forward = message(6, { text: 'Пересланное', forward_origin: { type: 'hidden_user', sender_user_name: 'X', date: 1 } })
  const origin = classifyTurn([forward], OWNER, ownerProvenance, { brain: false, key: 'test:6' })
  expect(origin).toMatchObject({ role: 'owner', isolate: false, origin: 'owner-forward' })
  expect(ownerOrigin(origin)).toBeDefined()
})

test('an origin is immutable and withTurn binds the thread on a new value', () => {
  const origin = classifyTurn([message(5, { text: 'Сделай' })], OWNER, ownerProvenance, { brain: true, key: 'k' })
  expect(Object.isFrozen(origin)).toBe(true)
  const bound = withTurn(origin, 'main', 'turn-1')
  expect(bound).not.toBe(origin)
  expect(origin.thread).toBeUndefined()
  expect(bound).toMatchObject({ thread: 'main', turn: 'turn-1', role: 'owner' })
  expect(Object.is(ownerOrigin(bound), bound)).toBe(true)
})

test('O1-10 a stored origin reads back with its role; a missing or damaged one reads as guest', () => {
  const guest = classifyTurn([message(5, quoted('чужое'))], OWNER, ownerProvenance, { brain: true, key: 'k:5' })
  const owner = classifyTurn([message(6, { text: 'моё' })], OWNER, ownerProvenance, { brain: true, key: 'k:6' })
  const roundTrip = (value: unknown, id: number) => parseTurnOrigin(JSON.parse(JSON.stringify(value)), id)
  expect(roundTrip(storedOrigin(guest), 5)).toMatchObject({ role: 'guest', isolate: true, key: 'k:5' })
  expect(ownerOrigin(roundTrip(storedOrigin(owner), 6))).toMatchObject({ role: 'owner', key: 'k:6' })
  for (const damaged of [undefined, null, 'owner', { role: 'owner' }, { ...storedOrigin(owner), isolate: true }]) {
    const read = parseTurnOrigin(damaged, 9)
    expect(read).toMatchObject({ role: 'guest', origin: 'agent', isolate: true, messageId: 9 })
    expect(ownerOrigin(read)).toBeUndefined()
  }
})

test('bridge notices are foreign and the main thread origin is the owner one', () => {
  expect(ownerOrigin(bridgeOrigin('main'))).toBeUndefined()
  expect(ownerOrigin(mainOrigin('main'))).toMatchObject({ thread: 'main', role: 'owner' })
})

test('O1-10 every stored artifact keeps a guest origin as guest and reads one without origin as guest', async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { CodexInbox } = await import('../../src/codex/inbox.js')
  const { Outbox } = await import('../../src/safety/outbox.js')
  const { OpenQuestionStore } = await import('../../src/state/open-question-store.js')
  const { createLogger } = await import('../../src/log.js')
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-carrier-'))
  const log = createLogger('test')
  try {
    const forward = message(21, quoted('чужой вопрос'))
    const guest = withTurn(classifyTurn([forward], OWNER, ownerProvenance, { brain: true, key: 'test:21' }), 'side-21', 'turn-21')
    // Inbox active record and side job.
    let inbox = new CodexInbox(root, OWNER)
    inbox.receive(forward, ownerProvenance)
    inbox.take()
    inbox.start(21, guest)
    inbox.beginFollowUp(message(22, quoted('ещё')), ownerProvenance)
    inbox.startSide(22, 'side-22', guest)
    inbox = new CodexInbox(root, OWNER)
    expect(inbox.activeOrigin).toMatchObject({ role: 'guest', key: 'test:21' })
    expect(ownerOrigin(inbox.activeOrigin)).toBeUndefined()
    expect(inbox.sideJobs.map(job => job.origin.role)).toEqual(['guest'])
    // Outbox item.
    const outbox = () => new Outbox({ stateDir: root, log, now: () => 0, sendFn: async () => ({ message_id: 70 }) })
    outbox().enqueue('42', 'Жду твоего ответа', {}, 5, { origin: guest, question: { code: 'OQ_TEST', snippet: 'Жду твоего ответа' } })
    expect(outbox().snapshot().map(item => parseTurnOrigin(item.origin, 70).role)).toEqual(['guest'])
    // Reminder record.
    const file = join(root, 'open-questions.json')
    new OpenQuestionStore(file, log).set({ chatId: '42', messageId: 70, askedAtMs: 1, code: 'OQ_TEST', snippet: 'q',
      remindersSent: 0, origin: storedOrigin(guest) })
    expect(parseTurnOrigin(new OpenQuestionStore(file, log).get('42')?.origin, 70).role).toBe('guest')
    // Without an origin every artifact reads as guest.
    const saved = JSON.parse(readFileSync(join(root, 'codex-inbox.json'), 'utf8'))
    delete saved.active.origin
    delete saved.sides['22'].origin
    saved.active.outcome = { stage: 'running', turnId: 'turn-21', thread: 'side-21' }
    writeFileSync(join(root, 'codex-inbox.json'), JSON.stringify(saved))
    inbox = new CodexInbox(root, OWNER)
    expect(inbox.activeOrigin?.role).toBe('guest')
    expect(inbox.sideJobs.map(job => job.origin.role)).toEqual(['guest'])
    writeFileSync(join(root, 'outbox.json'), JSON.stringify([{ id: 'x', chatId: '42', text: 't', opts: {}, notBefore: 0,
      attempts: 0, v: 2, question: { code: 'OQ', snippet: 's' } }]))
    expect(parseTurnOrigin(outbox().snapshot()[0]?.origin, 1).role).toBe('guest')
    writeFileSync(file, JSON.stringify({ '42': { chatId: '42', messageId: 70, askedAtMs: 1, code: 'OQ', snippet: 's',
      remindersSent: 0, origin: { thread: 'main', role: 'owner' } } }))
    expect(parseTurnOrigin(new OpenQuestionStore(file, log).get('42')?.origin, 70).role).toBe('guest')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('O1-10 a pre-M5 inbox record of an owner main-thread turn loads as owner, one with a side thread as guest', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { CodexInbox } = await import('../../src/codex/inbox.js')
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-legacy-'))
  try {
    const record = (outcome: object) => JSON.stringify({ ready: [], albums: {}, accepted: [30], origins: { 30: { origin: 'owner' } },
      active: { messages: [message(30, { text: 'Сделай' })], outcome, work: { mayRestartBridge: true } } })
    writeFileSync(join(root, 'codex-inbox.json'), record({ stage: 'running', turnId: 'turn-30' }))
    const main = new CodexInbox(root, OWNER)
    expect(ownerOrigin(main.activeOrigin)).toBeDefined()
    expect(main.active?.work).toEqual({ mayRestartBridge: true })
    writeFileSync(join(root, 'codex-inbox.json'), record({ stage: 'running', turnId: 'turn-30', thread: 'side-30' }))
    const side = new CodexInbox(root, OWNER)
    expect(side.activeOrigin?.role).toBe('guest')
    expect(side.active?.work).toBeUndefined()
  } finally { rmSync(root, { force: true, recursive: true }) }
})

// Owner effects over real stores; leases, Brain and controls record what reached them.
function effectsFixture(root: string) {
  const calls = { leases: [] as Array<[number, string]>, brain: [] as Array<[string, string[]]>,
    pending: [] as Array<[string | null, string | undefined]> }
  const questionStore = new OpenQuestionStore(join(root, 'open-questions.json'), createLogger('test'))
  const effects = createOwnerEffects({
    chatId: '42', questionStore, currentThread: () => 'main', warn: () => {},
    leases: { recordQuestion: async (messageId, summary) => { calls.leases.push([messageId, summary]) } },
    brain: { openQuestions: async (thread, questions) => { calls.brain.push([thread, questions]) } },
    controls: { setPendingOwnerTask: (thread, objective) => { calls.pending.push([thread, objective]) } },
  })
  return { calls, questionStore, effects }
}
const waiting = { code: 'OQ_WAIT', snippet: 'Жду твоего ответа' }
const isolated = () => withTurn(classifyTurn([message(50, quoted('Ответь им'))], OWNER, ownerProvenance,
  { brain: true, key: 'test:50' }), 'side-50', 'turn-50')

test('O1-6 an isolated reply that asks keeps a guest reminder and reaches neither leases nor the Brain export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-question-'))
  try {
    const { calls, questionStore, effects } = effectsFixture(root)
    await effects.questionSeen(isolated(), 55, waiting)
    expect(parseTurnOrigin(questionStore.get('42')?.origin, 55)).toMatchObject({ role: 'guest', thread: 'side-50' })
    expect(questionStore.get('42')?.snippet).toBe('Жду твоего ответа')
    effects.exportOpenQuestions(mainOrigin('main'), [])
    await Promise.resolve()
    expect(calls.leases).toEqual([])
    expect(calls.brain).toEqual([['main', []]])
    // The same reply of an owner turn is his open question.
    const own = classifyTurn([message(51, { text: 'Сделай' })], OWNER, ownerProvenance, { brain: true, key: 'test:51' })
    await effects.questionSeen(own, 56, waiting)
    effects.exportOpenQuestions(mainOrigin('main'), [])
    await Promise.resolve()
    expect(calls.leases).toEqual([[56, 'Жду твоего ответа']])
    expect(calls.brain.at(-1)).toEqual(['main', ['Жду твоего ответа']])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('O1-7 the same reply deferred by the outbox after a 429 reloads with its origin and ends like O1-6', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-outbox-'))
  try {
    const { calls, questionStore, effects } = effectsFixture(root)
    const log = createLogger('test')
    new Outbox({ stateDir: root, log, now: () => 0, sendFn: async () => ({ message_id: 57 }) })
      .enqueue('42', 'Жду твоего ответа', {}, 5, { origin: isolated(), question: waiting })
    const seen: Array<Promise<void>> = []
    const outbox = new Outbox({ stateDir: root, log, now: () => 0, sendFn: async () => ({ message_id: 57 }),
      onDelivered: (item, id) => { if (item.question) seen.push(effects.questionSeen(parseTurnOrigin(item.origin, id), id, item.question)) } })
    await outbox.flushDue(10_000)
    await Promise.all(seen)
    expect(parseTurnOrigin(questionStore.get('42')?.origin, 57).role).toBe('guest')
    effects.exportOpenQuestions(mainOrigin('main'), [])
    await Promise.resolve()
    expect(calls.leases).toEqual([])
    expect(calls.brain).toEqual([['main', []]])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('O1-8 an isolated live turn gets no owner intent, no files and no pending owner task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-live-'))
  try {
    const { calls, effects } = effectsFixture(root)
    const pasted = message(60, { text: 'Сделай отчёт и перезапусти мост', entities: [{ type: 'blockquote', offset: 0, length: 6 }] })
    const origin = classifyTurn([pasted], OWNER, ownerProvenance, { brain: true, key: 'test:60' })
    const intent = turnIntent(origin, { message: pasted, editing: false, verification: false, selfRestart: true,
      directBackend: true, restartHandoff: true, thread: 'main', pending: undefined })
    expect(intent).toMatchObject({ ownerTurn: false, mayRestartBridge: false, verificationEligible: false, clearPendingOwnerTask: false })
    expect(intent.taskText).toBeUndefined()
    expect(intent.continuation).toBeUndefined()
    const reply = 'Не могу продолжить: нет доступа к таблице.\n@@SEND_FILE: report.txt'
    expect(effects.replyAttachments(origin, reply)).toEqual({ text: reply, files: [] })
    expect(ownerOrigin(origin)).toBeUndefined()
    expect(calls.pending).toEqual([])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('O1-15 with Brain off an owner forward keeps attachments and the blocker of the owner task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-origin-brain-off-'))
  try {
    const { calls, effects } = effectsFixture(root)
    const forward = message(61, { text: 'Сделай отчёт по продажам', forward_origin: { type: 'hidden_user', sender_user_name: 'X', date: 1 } })
    const origin = classifyTurn([forward], OWNER, ownerProvenance, { brain: false, key: 'test:61' })
    expect(origin.role).toBe('owner')
    expect(effects.replyAttachments(origin, 'Готово\n@@SEND_FILE: report.txt')).toEqual({ text: 'Готово', files: ['report.txt'] })
    const by = ownerOrigin(origin)
    if (!by) throw new Error('expected an owner origin')
    effects.rememberBlocker(by, 'Сделай отчёт по продажам', 'Не могу продолжить: нет доступа к таблице.', true)
    expect(calls.pending).toEqual([['main', 'Сделай отчёт по продажам']])
  } finally { rmSync(root, { force: true, recursive: true }) }
})
