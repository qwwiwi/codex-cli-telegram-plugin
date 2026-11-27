import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelegramApi } from '../../src/channel/tools.js'
import { loadAutonomyState, openQuestions } from '../../src/autonomy/store.js'
import { CodexLeases } from '../../src/codex/lease.js'
import { createOwnerEffects, createUnansweredQuestionHandler, type OwnerEffects } from '../../src/codex/owner-effects.js'
import { QuestionCards, type UnansweredQuestion } from '../../src/codex/questions.js'
import { readSavedMainThread } from '../../src/codex/session.js'
import { createLogger } from '../../src/log.js'
import { OpenQuestionStore } from '../../src/state/open-question-store.js'
import type { StoredTurnOrigin } from '../../src/codex/turn-origin.js'

const request = [{ id: 'format', question: '[LEASE: Сверить отчёт] Сохранить отчёт? secret-note',
  options: [{ label: 'Да' }, { label: 'Нет' }], isOther: true }]

function fixture() {
  let affirmative = ''
  const edits: { chat: string; id: number; text: string; keyboard: unknown }[] = []
  const api: Pick<TelegramApi, 'sendMessage' | 'editMessageText'> = {
    async sendMessage(_chat, _text, { reply_markup }) {
      const firstButton = reply_markup?.inline_keyboard[0]?.[0]
      if (firstButton && 'callback_data' in firstButton) affirmative = firstButton.callback_data
      return { message_id: 17 }
    },
    async editMessageText(chat, id, text, { reply_markup }) {
      edits.push({ chat, id, text, keyboard: reply_markup })
    },
  }
  return { api, edits, affirmative: () => affirmative }
}

test('a timed-out question closes and reports the visible card once for reminders', async () => {
  const { api, edits, affirmative } = fixture()
  const reports: UnansweredQuestion[] = []
  let report!: () => void
  const reported = new Promise<void>(resolve => { report = resolve })
  const cards = new QuestionCards('111', api, ['secret-note'], {
    timeoutMs: 1, previewChars: 100,
    onUnanswered: item => { reports.push(item); report() },
  })
  expect(await cards.ask(request)).toEqual({})
  await reported
  expect(cards.resolve(affirmative(), 17)).toBe(false)
  expect(reports).toEqual([{ messageId: 17, askedAtMs: expect.any(Number),
    snippet: 'Сохранить отчёт? [REDACTED]', reason: 'timeout' }])
  expect(edits[0]?.text).toContain('Время ожидания истекло')
  expect(edits[0]?.keyboard).toEqual({ inline_keyboard: [] })
})

test('restart keeps redacted question context without restoring its waiter or mandate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-question-recovery-'))
  const { api, edits, affirmative } = fixture()
  const reports: UnansweredQuestion[] = []
  let grants = 0
  const settings = { timeoutMs: 2000, previewChars: 100, persistence: { root, log: createLogger('test') },
    onUnanswered: (item: UnansweredQuestion) => { reports.push(item) } }
  const grant = async () => { grants++; return 'Мандат выдан.' }
  try {
    const first = new QuestionCards('111', api, ['secret-note'], settings, undefined, grant)
    const signal = new AbortController()
    const pending = first.ask(request, signal.signal)
    await Promise.resolve()
    first.suspend()
    signal.abort()
    expect(await pending).toEqual({})
    expect(edits).toHaveLength(0)
    expect(readFileSync(join(root, 'codex-pending-questions.json'), 'utf8')).not.toContain('secret-note')
    await new QuestionCards('222', api, [], settings).recover()
    expect(edits).toHaveLength(0)

    await new QuestionCards('111', { ...api,
      async editMessageText() { throw new Error('Unavailable') },
    }, [], settings).recover()

    const restarted = new QuestionCards('111', api, ['secret-note'], settings, undefined, grant)
    expect(restarted.isPending).toBe(false)
    expect(restarted.resolve(affirmative(), 17)).toBe(false)
    expect(restarted.reply(17, 'Да')).toBe(false)
    await restarted.recover()
    await new QuestionCards('111', api, [], settings).recover()
    expect(grants).toBe(0)
    expect(reports).toEqual([{ messageId: 17, askedAtMs: expect.any(Number),
      snippet: 'Сохранить отчёт? [REDACTED]', reason: 'restart' }])
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ chat: '111', id: 17, keyboard: { inline_keyboard: [] } })
    expect(edits[0]?.text).toContain('Сохранить отчёт?')
    expect(edits[0]?.text).toContain('Да')
    expect(edits[0]?.text).toContain('отправь уточнение ещё раз')
    expect(edits[0]?.text).not.toContain('secret-note')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('an answered card is not recovered as an unanswered question if its edit failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-question-failed-edit-'))
  const { api, edits, affirmative } = fixture()
  const reports: UnansweredQuestion[] = []
  const settings = { timeoutMs: 2000, previewChars: 100, persistence: { root, log: createLogger('test') },
    onUnanswered: (item: UnansweredQuestion) => { reports.push(item) } }
  try {
    const first = new QuestionCards('111', { ...api,
      async editMessageText() { throw new Error('Unavailable') },
    }, [], settings)
    const pending = first.ask(request)
    await Promise.resolve()
    expect(first.resolve(affirmative(), 17)).toBe(true)
    expect(await pending).toEqual({ format: { answers: ['Да'] } })
    await new QuestionCards('111', api, [], settings).recover()
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toContain('Вопрос закрыт.')
    expect(reports).toHaveLength(0)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('a question of an isolated turn keeps its thread and role through restart, its report and the reminder store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-question-origin-'))
  const { api } = fixture()
  const reports: UnansweredQuestion[] = []
  const settings = { timeoutMs: 2000, previewChars: 100, persistence: { root, log: createLogger('test') },
    onUnanswered: (item: UnansweredQuestion) => { reports.push(item) } }
  const origin: StoredTurnOrigin = { key: 'test:17', messageId: 17, origin: 'owner-forward', inputKind: 'forward',
    isolate: true, role: 'guest', thread: 'side-thread' }
  try {
    const first = new QuestionCards('111', api, [], settings)
    const signal = new AbortController()
    const pending = first.ask(request, signal.signal, origin)
    await Promise.resolve()
    first.suspend()
    signal.abort()
    expect(await pending).toEqual({})
    expect(JSON.parse(readFileSync(join(root, 'codex-pending-questions.json'), 'utf8')).entries[0].origin).toEqual(origin)
    await new QuestionCards('111', api, [], settings).recover()
    expect(reports).toEqual([expect.objectContaining({ messageId: 17, reason: 'restart', origin })])
    const file = join(root, 'open-questions.json')
    new OpenQuestionStore(file, createLogger('test')).set({
      chatId: '111', messageId: 17, askedAtMs: 1, code: 'AQ_CARD', snippet: 'Forwarded question', remindersSent: 0, origin,
    })
    expect(new OpenQuestionStore(file, createLogger('test')).get('111')?.origin).toEqual(origin)
  } finally { rmSync(root, { force: true, recursive: true }) }
})

function recoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'krot-question-upgrade-'))
  const log = createLogger('test')
  const paths = { root, log }
  const chatId = '111'
  const journal = join(root, 'codex-pending-questions.json')
  const threadStateFile = join(root, 'codex-thread.json')
  writeFileSync(threadStateFile, JSON.stringify('main-thread'))
  const questionStore = new OpenQuestionStore(join(root, 'open-questions.json'), log)
  const ownerEffects = createOwnerEffects({
    chatId, questionStore, leases: new CodexLeases(paths, chatId, log),
    brain: { async openQuestions() {} }, controls: { setPendingOwnerTask() {} },
    currentThread: () => 'main-thread', warn: (_error, message) => { throw new Error(message) },
  })
  let effects: OwnerEffects | undefined = ownerEffects
  const { api } = fixture()
  const settings = { timeoutMs: 2000, previewChars: 100,
    persistence: { root, log, legacyMainThread: () => readSavedMainThread(threadStateFile) },
    onUnanswered: createUnansweredQuestionHandler({
      chatId, questionStore, effects: () => effects, syncBrainQuestions() {},
    }),
  }
  return {
    root, journal,
    cards: () => new QuestionCards(chatId, api, [], settings),
    setReady(ready: boolean) { effects = ready ? ownerEffects : undefined },
    ownerQuestions: () => openQuestions(loadAutonomyState(paths, chatId, log)).map(item => item.messageId),
    seed(entries: { messageId: number; origin?: unknown }[]) {
      writeFileSync(journal, JSON.stringify({ chat: chatId, entries: entries.map(entry => ({
        askedAtMs: entry.messageId, snippet: 'Question ' + entry.messageId, body: 'Question',
        state: 'open', reported: false, ...entry,
      })) }))
    },
  }
}

test('restart restores legacy owner cards to open questions and keeps legacy guests out', async () => {
  const recovery = recoveryFixture()
  try {
    recovery.seed([
      { messageId: 101, origin: { thread: 'old-main', role: 'owner' } },
      { messageId: 102, origin: { thread: 'side-thread', role: 'guest' } },
      { messageId: 103 },
      { messageId: 104, origin: { thread: 'main-thread', role: 'owner', isolate: true } },
    ])
    await recovery.cards().recover()
    await recovery.cards().recover()
    expect(recovery.ownerQuestions().sort()).toEqual([101, 103])
  } finally { rmSync(recovery.root, { force: true, recursive: true }) }
})

test('restart keeps a newly saved unattributed card out of owner questions', async () => {
  const recovery = recoveryFixture()
  try {
    const cards = recovery.cards()
    const pending = cards.ask(request)
    await Promise.resolve()
    cards.suspend()
    await pending
    await recovery.cards().recover()
    expect(recovery.ownerQuestions()).toEqual([])
  } finally { rmSync(recovery.root, { force: true, recursive: true }) }
})

test('an owner card stays unreported until owner effects are ready', async () => {
  const recovery = recoveryFixture()
  const origin: StoredTurnOrigin = { key: 'test:101', messageId: 101, origin: 'owner-direct', inputKind: 'text',
    isolate: false, role: 'owner', thread: 'main-thread' }
  try {
    recovery.seed([{ messageId: 101, origin }])
    recovery.setReady(false)
    await recovery.cards().recover()
    expect(JSON.parse(readFileSync(recovery.journal, 'utf8')).entries).toEqual([
      expect.objectContaining({ messageId: 101, state: 'restart', reported: false }),
    ])
    expect(recovery.ownerQuestions()).toEqual([])
    recovery.setReady(true)
    await recovery.cards().recover()
    await recovery.cards().recover()
    expect(recovery.ownerQuestions()).toEqual([101])
    expect(JSON.parse(readFileSync(recovery.journal, 'utf8')).entries).toEqual([])
  } finally { rmSync(recovery.root, { force: true, recursive: true }) }
})
