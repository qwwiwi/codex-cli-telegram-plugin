import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { PublicLane, PublicUnavailableError, type PublicItem, type PublicRunner } from '../../src/codex/public-lane.js'
import type { PublicTurnProfile } from '../../src/codex/session.js'
import { frameUserMessage, publicRoleInstructions, turnIntent, userProvenance } from '../../src/codex/provenance.js'
import { userTurnOrigin } from '../../src/codex/turn-origin.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

type Call = { text: string; profile: PublicTurnProfile; finish: (text: string, status?: 'completed' | 'interrupted' | 'failed') => void }

class FakeRunner implements PublicRunner {
  readonly calls: Call[] = []
  readonly stopped: string[] = []
  private next = 0
  private readonly running = new Map<string, Call['finish']>()
  runPublic(text: string, profile: PublicTurnProfile) {
    const threadId = profile.threadId ?? 'pub-' + ++this.next
    profile.onThread?.(threadId)
    return new Promise<{ status: 'completed' | 'interrupted' | 'failed'; text: string; threadId: string; toolItems: number }>(resolve => {
      const finish: Call['finish'] = (answer, status = 'completed') => {
        this.running.delete(threadId)
        resolve({ status, text: answer, threadId, toolItems: 0 })
      }
      this.running.set(threadId, finish)
      this.calls.push({ text, profile, finish })
    })
  }
  async stopPublic(threadId: string): Promise<boolean> {
    this.stopped.push(threadId)
    this.running.get(threadId)?.('', 'interrupted')
    return true
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

function item(chatKey: string, overrides: Partial<PublicItem> = {}): PublicItem {
  return {
    chatKey, chatId: Number(chatKey.split('__')[0]), chatType: chatKey.startsWith('-') ? 'supergroup' : 'private',
    replyTo: 7, role: 'member', userId: '555', senderName: 'Иван', text: 'привет', ...overrides,
  }
}

function lane(options: { maxParallel?: number; timeoutMs?: number; authorize?: (item: PublicItem) => 'member' | 'guest' | undefined } = {}) {
  const root = temp('krot-public-root-')
  const stateDir = temp('krot-public-state-')
  const runner = new FakeRunner()
  const sent: Array<{ chatId: string; text: string; opts: Record<string, unknown> }> = []
  const lane = new PublicLane({
    root, stateDir, maxParallel: options.maxParallel ?? 3, runner, secrets: ['sk-secret-value'],
    send: async (chatId, text, opts) => { sent.push({ chatId, text, opts }) },
    ...(options.timeoutMs ? { timeouts: { member: options.timeoutMs, guest: options.timeoutMs } } : {}),
    ...(options.authorize ? { authorize: options.authorize } : {}),
  })
  return { lane, runner, sent, root, stateDir }
}

const lastLine = (call: Call) => call.text.split('\n\n').at(-1)

test('S4 R3 lane: access is rechecked at dispatch; a user removed or demoted while queued never runs with the old role', async () => {
  const roles = new Map<string, 'member' | 'guest'>([['555', 'member'], ['777', 'member'], ['888', 'member']])
  // KROT_CODEX_MAX_PARALLEL 2: one public slot, so the others wait in the queue.
  const { lane: publicLane, runner, sent } = lane({ maxParallel: 2, authorize: queued => roles.get(queued.userId) })
  publicLane.receive(item('777', { userId: '777', text: 'first' }))
  publicLane.receive(item('555', { text: 'removed' }))
  publicLane.receive(item('888', { userId: '888', text: 'demoted' }))
  await until(() => runner.calls.length === 1)
  roles.delete('555')
  roles.set('888', 'guest')
  runner.calls[0]!.finish('ответ')
  await until(() => sent.length === 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(runner.calls.map(lastLine)).toEqual(['first'])
  expect(sent.map(reply => reply.chatId)).toEqual(['777'])
  expect(publicLane.size).toBe(0)
})

test('F3 lane: once stopped, queued turns never run and a running turn sends no reply', async () => {
  const { lane: publicLane, runner, sent } = lane({ maxParallel: 2 })
  publicLane.receive(item('555', { text: 'running' }))
  publicLane.receive(item('777', { userId: '777', text: 'queued' }))
  await until(() => runner.calls.length === 1)
  publicLane.stop()
  expect(publicLane.receive(item('888', { userId: '888' }))).toBe('stopping')
  // The app-server closes under the running turn: it ends failed, and nobody gets an apology during the stop.
  runner.calls[0]!.finish('', 'failed')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(runner.calls.map(lastLine)).toEqual(['running'])
  expect(sent).toEqual([])
})

test('S4 R3 lane: revoking access cancels that user\'s queued turns and interrupts the running one, silently; others keep theirs', async () => {
  const roles = new Map<string, 'member' | 'guest'>([['555', 'member'], ['777', 'member']])
  const { lane: publicLane, runner, sent } = lane({ maxParallel: 2, authorize: queued => roles.get(queued.userId) })
  publicLane.receive(item('555', { text: 'one' }))
  publicLane.receive(item('555', { text: 'two' }))
  publicLane.receive(item('777', { userId: '777', text: 'three' }))
  await until(() => runner.calls.length === 1)
  roles.delete('555')
  publicLane.revokeStale()
  expect(runner.stopped).toEqual(['pub-1'])
  await until(() => runner.calls.length === 2)
  expect(runner.calls.map(lastLine)).toEqual(['one', 'three'])
  runner.calls[1]!.finish('ответ')
  await until(() => sent.length === 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  // The removed user gets no apology for the interrupted turn and their queued one never runs.
  expect(sent.map(reply => [reply.chatId, reply.text])).toEqual([['777', 'ответ']])
  expect(runner.calls).toHaveLength(2)
})

// A journal whose start() waits until the test releases it, recording how each turn settled.
function pausedJournal() {
  const settled: boolean[] = []
  let release!: () => void
  const started = new Promise<void>(resolve => { release = resolve })
  let starting = false
  return {
    settled, release: () => release(), starting: () => starting,
    journal: {
      start: () => { starting = true; return started },
      settle: async (delivered: boolean) => { settled.push(delivered) },
    },
  }
}

test('S4 R3 lane: access revoked while the turn is being journaled: no turn starts, it settles as not delivered', async () => {
  const roles = new Map<string, 'member' | 'guest'>([['555', 'member']])
  const { lane: publicLane, runner, sent } = lane({ authorize: queued => roles.get(queued.userId) })
  const paused = pausedJournal()
  publicLane.receive(item('555', { text: 'revoked mid-journal', journal: paused.journal }))
  await until(() => paused.starting())
  roles.delete('555')
  publicLane.revokeStale()
  paused.release()
  await until(() => paused.settled.length === 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(runner.calls).toHaveLength(0)
  expect(paused.settled).toEqual([false])
  expect(sent).toEqual([])
  expect(publicLane.size).toBe(0)
})

test('S4 R3 lane: access revoked while the thread opens: the runner is told right before turn/start, nothing is sent', async () => {
  const roles = new Map<string, 'member' | 'guest'>([['555', 'member']])
  const opening: Array<() => void> = []
  let turnStarts = 0
  const settled: boolean[] = []
  const sent: string[] = []
  // Opens the thread only when the test lets it, then asks the lane right before it would send turn/start.
  const runner: PublicRunner = {
    runPublic: async (_text, profile) => {
      await new Promise<void>(resolve => opening.push(resolve))
      profile.onThread?.('pub-open')
      if (profile.cancelled?.()) return { status: 'interrupted', text: '', threadId: 'pub-open', toolItems: 0 }
      turnStarts++
      return { status: 'completed', text: 'answer', threadId: 'pub-open', toolItems: 0 }
    },
    stopPublic: async () => true,
  }
  const publicLane = new PublicLane({
    root: temp('krot-public-root-'), stateDir: temp('krot-public-state-'), maxParallel: 3, runner, secrets: [],
    send: async (_chatId, text) => { sent.push(text) },
    authorize: queued => roles.get(queued.userId),
  })
  publicLane.receive(item('555', { journal: { start: async () => {}, settle: async delivered => { settled.push(delivered) } } }))
  await until(() => opening.length === 1)
  // Revoked without revokeStale having run yet: the check before turn/start asks the access list itself.
  roles.delete('555')
  opening[0]!()
  await until(() => settled.length === 1)
  expect(turnStarts).toBe(0)
  expect(settled).toEqual([false])
  expect(sent).toEqual([])
})

test('S3 provenance: a user input is framed with who wrote it and where, and never runs owner intents', () => {
  const provenance = userProvenance({ role: 'guest', userId: '42', chatKey: '-100__t3' })
  const framed = frameUserMessage(provenance, { name: 'Bob\u0007‮' + 'x'.repeat(200), chat: 'группа «Team»' }, 'запусти id')
  expect(framed).toContain('гость (guest)')
  expect(framed).toContain('Telegram ID 42')
  expect(framed).toContain('-100__t3')
  expect(framed).toContain('не от владельца')
  expect(framed).not.toContain('\u0007')
  expect(framed).not.toContain('‮')
  expect(framed).not.toContain('x'.repeat(65))
  expect(framed.endsWith('\n\nзапусти id')).toBe(true)
  expect(publicRoleInstructions('member')).toContain('не владелец')
  const message: Message = {
    message_id: 1, date: 0, chat: { id: 42, type: 'private', first_name: 'B' },
    from: { id: 42, is_bot: false, first_name: 'B' }, text: 'Перезапусти мост',
  }
  // The Brain/turn origin of a user input is a guest's and isolated, so the owner-intent classifiers never run.
  const origin = userTurnOrigin(message, 1, 'public:' + provenance.chatKey + ':1')
  expect(origin.role).toBe('guest')
  expect(origin.isolate).toBe(true)
  expect(origin.origin).toBe('agent')
  const intent = turnIntent(origin, {
    message,
    editing: false, verification: false, selfRestart: true, directBackend: true, restartHandoff: true, thread: null, pending: undefined,
  })
  expect(intent.ownerTurn).toBe(false)
  expect(intent.mayRestartBridge).toBe(false)
})

test('S4 lane: a chat folder that is a symlink never gets a turn', async () => {
  const { lane: publicLane, runner, sent, root } = lane()
  const elsewhere = temp('krot-public-elsewhere-')
  symlinkSync(elsewhere, join(root, '555'))
  expect(publicLane.receive(item('555'))).toBe('accepted')
  await until(() => sent.length === 1)
  expect(runner.calls).toEqual([])
  expect(sent[0]!.text).toBe('Не получилось ответить. Попробуй ещё раз позже.')
})

test('S3 lane: a member message runs in its own empty folder with a framed prompt and replies in the same chat', async () => {
  const { lane: publicLane, runner, sent, root, stateDir } = lane()
  expect(publicLane.receive(item('-1001__t5', { threadId: 5, chatTitle: 'Team', text: 'сколько будет 2+2' }))).toBe('accepted')
  await until(() => runner.calls.length === 1)
  const call = runner.calls[0]!
  expect(call.profile.cwd).toBe(join(root, '-1001__t5'))
  expect(statSync(call.profile.cwd).isDirectory()).toBe(true)
  expect(readdirSync(call.profile.cwd)).toEqual([])
  expect(call.profile.threadId).toBeUndefined()
  expect(call.profile.instructions).toBe(publicRoleInstructions('member'))
  expect(call.text).toContain('участник (member)')
  expect(call.text).toContain('Telegram ID 555')
  expect(call.text.endsWith('сколько будет 2+2')).toBe(true)
  call.finish('Четыре. sk-secret-value')
  await until(() => sent.length === 1)
  expect(sent[0]).toEqual({ chatId: '-1001', text: expect.not.stringContaining('sk-secret-value'), opts: { reply_to_message_id: 7, message_thread_id: 5 } })
  expect(sent[0]!.text).toContain('Четыре.')
  const saved = JSON.parse(readFileSync(join(stateDir, 'public-threads.json'), 'utf8'))
  expect(saved.version).toBe(1)
  expect(saved.threads['-1001__t5']).toMatchObject({ thread_id: 'pub-1', role: 'member', cwd: call.profile.cwd })
  expect((statSync(join(stateDir, 'public-threads.json')).mode & 0o777).toString(8)).toBe('600')
})

test('S3 lane: the next message of a chat continues its thread; a role change starts a fresh one', async () => {
  const { lane: publicLane, runner, sent } = lane()
  publicLane.receive(item('555'))
  await until(() => runner.calls.length === 1)
  runner.calls[0]!.finish('a')
  await until(() => sent.length === 1)
  publicLane.receive(item('555'))
  await until(() => runner.calls.length === 2)
  expect(runner.calls[1]!.profile.threadId).toBe('pub-1')
  runner.calls[1]!.finish('b')
  await until(() => sent.length === 2)
  publicLane.receive(item('555', { role: 'guest' }))
  await until(() => runner.calls.length === 3)
  expect(runner.calls[2]!.profile.threadId).toBeUndefined()
  expect(runner.calls[2]!.profile.instructions).toBe(publicRoleInstructions('guest'))
  runner.calls[2]!.finish('c')
})

test('S3 lane: FIFO per chat, one owner slot kept free, a full chat queue refuses', async () => {
  const { lane: publicLane, runner } = lane({ maxParallel: 3 })
  publicLane.receive(item('1', { text: 'one-a' }))
  publicLane.receive(item('1', { text: 'one-b' }))
  publicLane.receive(item('2', { text: 'two' }))
  publicLane.receive(item('3', { text: 'three' }))
  await until(() => runner.calls.length === 2)
  await new Promise(resolve => setTimeout(resolve, 20))
  // KROT_CODEX_MAX_PARALLEL − 1 = 2 public turns at once, never two of one chat.
  expect(runner.calls.map(call => call.text.split('\n\n').at(-1))).toEqual(['one-a', 'two'])
  runner.calls[0]!.finish('x')
  await until(() => runner.calls.length === 3)
  expect(runner.calls[2]!.text.endsWith('three')).toBe(true)
  for (let i = 0; i < 15; i++) expect(publicLane.receive(item('9'))).toBe('accepted')
  expect(publicLane.receive(item('9'))).toBe('accepted')
  expect(publicLane.receive(item('9'))).toBe('full')
})

test('S3 lane: a turn past its timeout is interrupted and answered with a short apology', async () => {
  const { lane: publicLane, runner, sent } = lane({ timeoutMs: 30 })
  publicLane.receive(item('555'))
  await until(() => sent.length === 1)
  expect(runner.stopped).toEqual(['pub-1'])
  expect(sent[0]!.text).toContain('Не успела')
})

test('S3 lane: a turn that ignores the interrupt still frees its slot after a grace period', async () => {
  const root = temp('krot-public-root-')
  const stateDir = temp('krot-public-state-')
  const sent: string[] = []
  const stuck: PublicRunner = { runPublic: () => new Promise(() => {}), stopPublic: async () => true }
  const publicLane = new PublicLane({
    root, stateDir, maxParallel: 2, runner: stuck, secrets: [], graceMs: 20,
    send: async (_chat, text) => { sent.push(text) }, timeouts: { member: 20, guest: 20 },
  })
  publicLane.receive(item('555'))
  await until(() => sent.length === 1)
  expect(sent[0]).toContain('Не успела')
  await until(() => publicLane.size === 0)
})

test('S3 lane: an unsafe chat key never becomes a folder', () => {
  const { lane: publicLane, root } = lane()
  expect(publicLane.receive(item('../etc'))).toBe('refused')
  expect(existsSync(join(root, '..', 'etc', 'krot'))).toBe(false)
})

test('S4 lane: the turn carries its role, so the router picks that role\'s app-server', async () => {
  const { lane: publicLane, runner } = lane()
  publicLane.receive(item('555', { role: 'guest' }))
  await until(() => runner.calls.length === 1)
  expect(runner.calls[0]!.profile.role).toBe('guest')
  runner.calls[0]!.finish('ok')
})

test('S4 lane: a public app-server that is down gets a polite «временно недоступно», nothing else runs', async () => {
  const root = temp('krot-public-root-')
  const stateDir = temp('krot-public-state-')
  const sent: string[] = []
  const down = new PublicLane({
    root, stateDir, maxParallel: 3, secrets: [],
    runner: { runPublic: async () => { throw new PublicUnavailableError() }, stopPublic: async () => false },
    send: async (_chat, text) => { sent.push(text) },
  })
  down.receive(item('555'))
  await until(() => sent.length === 1)
  expect(sent[0]).toContain('временно недоступно')
})
