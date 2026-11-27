import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaySchema, SnapshotMetaSchema } from '../../../codex-brain/src/contract.js'
import { remember } from '../../../codex-brain/src/permit/remember.js'
import { scopePaths } from '../../../codex-brain/src/store/paths.js'
import { CodexRpc } from '../../src/codex/rpc.js'
import { CodexSession } from '../../src/codex/session.js'

const day = DaySchema.parse('2026-01-12')
const roots: string[] = []
const openSessions: CodexSession[] = []
afterEach(() => {
  for (const session of openSessions.splice(0)) session.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const owner = { message_id: 7, from: { id: 42 }, chat: { type: 'private', id: 42 }, text: 'Поправка: отчёт по пятницам' }

async function fixture() {
  const { createBrainBridge } = await import('../../src/codex/brain-bridge.js')
  const root = mkdtempSync(join(tmpdir(), 's6-brain-'))
  roots.push(root)
  const bridge = createBrainBridge({
    brainHome: join(root, 'brain'), scope: 'test', legacyRoot: join(root, 'learning'),
    clock: { now: () => new Date(day + 'T12:00:00Z') },
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
  expect(bridge.notice(notice.saved)).toMatchObject({ text: '💾 Сохранено: Friday reports', buttons: [[{ label: 'Забыть' }]] })
  expect(await bridge.facts.indexText()).toBe('- reports · correction · Friday reports\n')
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

test("a reply keeps the owner's words, pasted quotes and forwards stay isolated, captions count, unclear voice stays in the main thread", async () => {
  const { classifyBrainOrigin } = await import('../../src/codex/brain-origin.js')
  for (const message of [{ ...owner, reply_to_message: { text: 'An older bot answer' } }, { ...owner, quote: {} }, { ...owner, external_reply: {} }]) {
    expect(classifyBrainOrigin(message, 42)).toEqual({ origin: 'owner-direct', inputKind: 'text', isolate: false })
  }
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

test('owner lists, opens, edits, confirms forget, pins and closes a task with revision checks', async () => {
  const { bridge } = await fixture()
  await bridge.facts.writer({ turnId: 'fixture' }).put({ ...fact, source: 'tg-command' })
  await bridge.facts.writer({ turnId: 'fixture' }).put({
    ...fact, id: 'task-1', kind: 'task', status: 'open', source: 'tg-command',
  })
  expect((await bridge.memoryCommand({ args: 'forget reports', ownerPrivateChat: false })).text).toContain('личном')
  expect((await bridge.memoryCommand(cmd('list'))).text).toContain('reports')
  const card = await bridge.memoryCommand(cmd('show reports'))
  expect(card.text).toContain('tg-command')
  const oldForget = (await bridge.memoryCommand(cmd('forget reports'))).buttons[0]![0]!.data
  expect(await bridge.facts.get('reports')).not.toBeNull()
  await bridge.memoryCommand(cmd('edit reports r1 Weekly reports'))
  expect((await bridge.memoryCommand(cmd('', oldForget))).text).toContain('этот факт изменился')
  expect(await bridge.facts.get('reports')).toMatchObject({ body: 'Weekly reports' })
  const confirm = (await bridge.memoryCommand(cmd('forget reports'))).buttons[0]![0]!.data
  await bridge.memoryCommand(cmd('', confirm))
  expect(await bridge.facts.get('reports')).toBeNull()
  await bridge.memoryCommand(cmd('pin standing rule'))
  expect(await bridge.facts.list('pinned')).toHaveLength(1)
  expect((await bridge.memoryCommand(cmd('tasks'))).text).toContain('task-1')
  await bridge.memoryCommand(cmd('done task-1'))
  expect(await bridge.facts.get('task-1')).toMatchObject({ status: 'done' })
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
  expect((await bridge.memoryCommand(cmd('forget user/reports'))).buttons).toHaveLength(1)
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
