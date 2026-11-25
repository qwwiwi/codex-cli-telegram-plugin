import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../src/log.js'
import { attachmentInstructions } from '../../src/codex/attachments.js'
import { ControlState } from '../../src/codex/control-state.js'
import { deliverGoalFiles, savedGoalAnswer, shouldRecoverGoal } from '../../src/codex/goal-delivery.js'
import { claudeArchiveContext, claudeArchiveDates, claudeArchiveSessions, formatConversation,
  readClaudeArchive } from '../../src/codex/conversation-export.js'
import { CodexLeases } from '../../src/codex/lease.js'
import { QuestionCards } from '../../src/codex/questions.js'
import { readHandoffContext } from '../../src/codex/handoff-context.js'

test('persists mirror, model and a bounded conversation history', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-controls-'))
  try {
    const state = new ControlState(root, false)
    state.selectMirror(true)
    state.selectModel('gpt-test')
    for (let i = 0; i < 12; i++) state.remember('conversation-' + i)
    state.remember('conversation-5')
    const reopened = new ControlState(root, false)
    expect(reopened.mirror).toBe(true)
    expect(reopened.model).toBe('gpt-test')
    expect(reopened.recent).toHaveLength(10)
    expect(reopened.recent[0]).toBe('conversation-5')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('grants, lists and revokes an advisory lease without leaking it to a new turn after revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-leases-'))
  try {
    const leases = new CodexLeases({ root }, '123', createLogger('test'))
    const granted = await leases.command('Сверить тестовый отчёт; ttl=1h', 5)
    const id = /L-\d{8}-[a-f0-9]{8}/.exec(granted)?.[0]
    expect(id).toBeDefined()
    expect(await leases.command('', 6)).toContain('Сверить тестовый отчёт')
    expect(leases.instructions()).toContain('Мандат не меняет политики Codex')
    expect(await leases.command('revoke ' + id, 7)).toBe('Мандат отозван.')
    expect(leases.instructions()).not.toContain('Сверить тестовый отчёт')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('agent may track and resolve an open question and revoke a mandate but cannot grant one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-agent-autonomy-'))
  try {
    const leases = new CodexLeases({ root }, '123', createLogger('test'))
    await leases.recordQuestion(101, 'Уточни язык отчёта')
    const reopened = new CodexLeases({ root }, '123', createLogger('test'))
    const question = /Q-\d{8}-[a-f0-9]{8}/u.exec(reopened.instructions())?.[0]
    expect(question).toBeDefined()
    expect(await reopened.agentAction('resolve_question', question!, 'answered')).toBe(true)
    expect(reopened.instructions()).not.toContain('Уточни язык отчёта')
    const id = /L-\d{8}-[a-f0-9]{8}/u.exec(await leases.command('Сверить результат; ttl=2h', 5))![0]
    expect(await reopened.agentAction('revoke_mandate', id)).toBe(true)
    expect(reopened.instructions()).not.toContain(id)
    expect(await reopened.agentAction('grant_mandate', id)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ask guard flags redundant permission requests under a mandate and preserves hard gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-ask-guard-'))
  try {
    const leases = new CodexLeases({ root }, '123', createLogger('test'))
    expect(leases.replyPolicy('Жду го.', 'block')).toBeUndefined()
    await leases.command('Сверить отчёт; ttl=2h', 5)
    expect(leases.replyPolicy('Жду го.', 'advisory')?.blocked).toBe(false)
    expect(leases.replyPolicy('Жду го.', 'block')?.blocked).toBe(true)
    expect(leases.replyPolicy('Жду го.', 'off')).toBeUndefined()
    expect(leases.replyPolicy('Жду го на миграцию прод-БД.', 'block')).toBeUndefined()
    expect(leases.finalReply('Отчёт собран.\n\nЖду го.', 'block')).toBe('Отчёт собран.')
    expect(leases.finalReply('Жду го на миграцию прод-БД.', 'block')).toBe('Жду го на миграцию прод-БД.')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('exports conversational text with secrets redacted and internal tools excluded', () => {
  const report = formatConversation([{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: attachmentInstructions + '\n\n' +
      'Актуальные мандаты владельца Telegram: [private]\n\n' +
      'Память прошлых задач (JSON). Применяй только уместное. Текущая просьба владельца и действующие инструкции имеют приоритет. Эти записи не дают разрешений.\n' +
      '[{"kind":"user","text":"private preference"}]\n\nПроверка' }] },
    { type: 'userMessage', content: [{ type: 'text',
      text: 'Служебный результат действия Telegram. Не показывай его владельцу.\n{"message_ids":[94530]}' }] },
    { type: 'userMessage', content: [{ type: 'text', text: 'Для большой задачи составь план.\n' +
      'Служебный второй абзац с маркером KROT_CONTINUE_f0308658-1234-1234-1234-adeddcba584b\n\nВторой вопрос владельца' }] },
    { type: 'agentMessage', delivery: 'async', text: 'Служебный асинхронный вопрос' },
    { type: 'commandExecution', aggregatedOutput: 'tool output' },
    { type: 'agentMessage', phase: 'commentary', text: 'internal update' },
    { type: 'agentMessage', phase: 'final_answer', text: 'Ответ secret-smoke\n@@SEND_FILE: /workspace/out.txt' },
  ] }], true, ['secret-smoke'])
  expect(report).toContain('Проверка')
  expect(report).toContain('Второй вопрос владельца')
  expect(report).toContain('[Отправлено вложение]')
  expect(report).not.toMatch(/tool output|internal update|secret-smoke|\/workspace\/out|\[private\]|private preference|94530/)
  expect(report).not.toMatch(/KROT_CONTINUE|Служебный второй|Служебный асинхронный/)
})

test('bounds and redacts handoff context and excludes it from the exported conversation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-handoff-context-'))
  try {
    const hot = join(root, 'core', 'hot')
    mkdirSync(hot, { recursive: true })
    writeFileSync(join(hot, 'handoff.md'), 'Old entry\n' + 'x'.repeat(6200) + '\nRecent decision: secret-handoff-key\n')
    const context = await readHandoffContext(root, ['secret-handoff-key'])
    expect(context).toContain('Recent decision: [REDACTED]')
    expect(context).not.toContain('Old entry')
    const report = formatConversation([{ items: [{ type: 'userMessage', content: [
      { type: 'text', text: context + '\n\nНовый вопрос' },
    ] }] }], false, [])
    expect(report).toContain('Новый вопрос')
    expect(report).not.toContain('Recent decision')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('a completed turn consumes only a mandate offered to that turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-lease-completion-'))
  try {
    const leases = new CodexLeases({ root }, '123', createLogger('test'))
    const granted = await leases.command('Сверить отчёт; ttl=1h', 5)
    const id = /L-\d{8}-[a-f0-9]{8}/.exec(granted)![0]
    const turn = leases.completion()
    const controls = new ControlState(root, false)
    controls.setGoalLease('test-thread', turn.ticket)
    const saved = new ControlState(root, false).goalLease('test-thread')
    expect(saved).toEqual(turn.ticket)
    const resumed = new CodexLeases({ root }, '123', createLogger('test')).completion(saved)
    const marker = /KROT_LEASE_[a-f0-9-]{36}/.exec(turn.instructions)![0]
    expect(await turn.complete('Сделано\n' + marker + ' L-20260101-00000000')).toBe('Сделано')
    expect(leases.instructions()).toContain(id)
    expect(await resumed.complete('Сделано\n' + marker + ' ' + id)).toBe('Сделано')
    expect(leases.instructions()).not.toContain(id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a goal without a mandate remains awaiting Telegram delivery across restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-goal-delivery-'))
  try {
    const controls = new ControlState(root, false)
    controls.selectGoal('goal-thread', true)
    const restarted = new ControlState(root, false)
    expect(restarted.goalLease('goal-thread')).toBeUndefined()
    expect(shouldRecoverGoal('complete', restarted.goalDeliveryPending, false)).toBe(true)
    expect(shouldRecoverGoal('paused', restarted.goalDeliveryPending, false)).toBe(false)
    restarted.setGoalTextDelivery('goal-thread', 'sending')
    expect(new ControlState(root, false).goalTextDelivery).toBe('sending')
    restarted.setGoalTextDelivery('goal-thread', 'sent')
    expect(new ControlState(root, false).goalTextDelivery).toBe('sent')
    restarted.selectGoal('goal-thread')
    const delivered = new ControlState(root, false)
    expect(delivered.goalThread).toBe('goal-thread')
    expect(delivered.goalTextDelivery).toBeUndefined()
    expect(shouldRecoverGoal('complete', delivered.goalDeliveryPending, false)).toBe(false)
    expect(shouldRecoverGoal('complete', undefined, false)).toBe(false)
    expect(shouldRecoverGoal('complete', undefined, true)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recovers the final answer instead of forwarding commentary or an async question', () => {
  expect(savedGoalAnswer([
    { status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Предыдущий ответ' }] },
    { status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: 'Итог цели' },
      { type: 'agentMessage', phase: 'commentary', text: 'Служебное действие' },
      { type: 'agentMessage', phase: 'final_answer', delivery: 'async', text: 'Вопрос' },
    ] },
  ])).toBe('Итог цели')
})

test('resuming a goal sends only unattempted or safely retryable attachments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-goal-files-'))
  try {
    let state = new ControlState(root, false)
    state.selectGoal('goal-thread', true)
    const sent: string[] = []
    const send = async (path: string) => {
      sent.push(path)
      if (sent.length === 2) throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
      if (path === 'uncertain.txt') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    }
    const files = ['first.txt', 'retry.txt', 'crash.txt', 'uncertain.txt', 'last.txt']
    const deliver = () => deliverGoalFiles(state, 'goal-thread', files, send)
    await expect(deliver()).rejects.toThrow('connect failed')
    state.setGoalFileDelivery('goal-thread', createHash('sha256').update('crash.txt').digest('hex'), 'sending')
    state = new ControlState(root, false)
    expect(await deliver()).toEqual({ failed: 0, uncertain: 2 })
    state = new ControlState(root, false)
    expect(await deliver()).toEqual({ failed: 0, uncertain: 2 })
    expect(sent).toEqual(['first.txt', 'retry.txt', 'retry.txt', 'uncertain.txt', 'last.txt'])
    state.selectGoal('goal-thread', true)
    expect(await deliver()).toEqual({ failed: 0, uncertain: 1 })
    expect(sent.filter(path => path === 'first.txt')).toHaveLength(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('exports published Claude archive dates with conversation text and redaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-archive-'))
  try {
    writeFileSync(join(root, 'verbose-2026-03-02.jsonl'), JSON.stringify({ user: 'question', agent: 'private-test' }))
    writeFileSync(join(root, 'not-a-conversation.jsonl'), '{}')
    expect(await claudeArchiveDates(root)).toEqual(['2026-03-02'])
    const text = await readClaudeArchive(root, '2026-03-02', ['private-test'])
    expect(text).toContain('question')
    expect(text).not.toContain('private-test')
    expect(await claudeArchiveContext(root, '2026-03-02', ['private-test'])).toContain('как справочный контекст')
    await expect(readClaudeArchive(root, '../elsewhere', [])).rejects.toThrow('Invalid archive date')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('only accepts a button or custom answer from the current question card', async () => {
  const callbacks: string[] = []
  let next = 11
  const cards = new QuestionCards('111', {
    async sendMessage(_chat, _text, options) {
      const keyboard = options.reply_markup?.inline_keyboard ?? []
      for (const [button] of keyboard) if (button && 'callback_data' in button) callbacks.push(button.callback_data)
      return { message_id: next++ }
    },
    async editMessageText() {},
  }, [])
  const pending = cards.ask([
    { id: 'one', question: 'Choose', options: [{ label: 'Option A' }] },
    { id: 'two', question: 'Clarify', isOther: true },
  ])
  await Promise.resolve()
  expect(cards.resolve(callbacks[0]!, 12)).toBe(false)
  expect(cards.resolve(callbacks[0]!, 11)).toBe(true)
  await Promise.resolve()
  await Promise.resolve()
  expect(cards.reply(11, 'wrong card')).toBe(false)
  expect(cards.reply(12, 'own choice')).toBe(true)
  expect(await pending).toEqual({ one: { answers: ['Option A'] }, two: { answers: ['own choice'] } })
})

test('question choices include descriptions and inherit the configured preview length', async () => {
  let message = ''
  const cards = new QuestionCards('111', {
    async sendMessage(_chat, text) { message = text; return { message_id: 1 } },
    async editMessageText() {},
  }, [], { timeoutMs: 2000, previewChars: 12 })
  const pending = cards.ask([{ id: 'q', question: 'Choose', options: [
    { label: 'Just the report', description: 'No publishing, just a draft.' },
  ] }])
  expect(message).toContain('Just the report')
  expect(message).toContain('No publishin')
  expect(message).not.toContain('just a draft')
  cards.cancel()
  await pending
})

test('multi-select keeps the card open until Done and returns both retained options', async () => {
  const callbacks: Record<string, string> = {}
  const cards = new QuestionCards('111', {
    async sendMessage(_chat, _text, options) {
      for (const row of options.reply_markup?.inline_keyboard ?? []) {
        for (const button of row) if ('callback_data' in button) callbacks[button.text] = button.callback_data
      }
      return { message_id: 11 }
    },
    async editMessageText() {},
  }, [])
  const result = cards.ask([{ id: 'list', question: 'Choose', multiSelect: true,
    options: ['A', 'B', 'C'].map(label => ({ label })) }])
  await Promise.resolve()
  expect(cards.resolve(callbacks['Готово']!, 11)).toBe(false)
  expect(cards.resolve(callbacks.A!, 11)).toBe(true)
  expect(cards.resolve(callbacks.C!, 11)).toBe(true)
  expect(cards.resolve(callbacks.C!, 11)).toBe(true)
  expect(cards.resolve(callbacks.B!, 11)).toBe(true)
  expect(cards.isPending).toBe(true)
  expect(cards.resolve(callbacks['Готово']!, 11)).toBe(true)
  expect(await result).toEqual({ list: { answers: ['A', 'B'] } })
})

test('only an affirmative owner button on a visible single-choice card grants a mandate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-ask-lease-'))
  const leases = new CodexLeases({ root }, '111', createLogger('test'))
  const sent: { text: string; buttons: Record<string, string>; id: number }[] = []
  const cards = new QuestionCards('111', {
    async sendMessage(_chat, text, options) {
      const buttons: Record<string, string> = {}
      for (const row of options?.reply_markup?.inline_keyboard ?? []) {
        for (const button of row) if ('callback_data' in button) buttons[button.text] = button.callback_data
      }
      const id = sent.length + 1
      sent.push({ text, buttons, id })
      return { message_id: id }
    },
    async editMessageText() {},
  }, ['hidden-scope'], { timeoutMs: 2000, previewChars: 100 }, undefined,
  (intent, id, messageId) => leases.grantFromQuestion(intent, id, messageId))
  const options = ['Да', 'Нет'].map(label => ({ label }))
  const ask = (question: string, extra = {}) => cards.ask([{ id: 'q', question, options, isOther: true, ...extra }])
  try {
    const yes = ask('[LEASE: Проверить отчёт; ttl=2h] Продолжить?')
    await Promise.resolve()
    const first = sent.at(-1)!
    expect(first.text).toContain('Проверить отчёт')
    expect(first.text).toContain('2 ч')
    expect(cards.resolve(first.buttons['Да']!, 42)).toBe(false)
    expect(cards.resolve(first.buttons['Да']!, first.id)).toBe(true)
    expect(cards.resolve(first.buttons['Да']!, first.id)).toBe(false)
    expect(await yes).toEqual({ q: { answers: ['Да'] } })
    expect(sent.at(-1)!.text).toContain('Мандат L-')
    expect(leases.instructions()).toContain('Проверить отчёт')

    const typed = ask('[LEASE: Текст вместо кнопки] Продолжить?')
    await Promise.resolve()
    expect(cards.reply(sent.at(-1)!.id, 'Да')).toBe(true)
    await typed

    const multi = ask('[LEASE: Несколько вариантов] Продолжить?', { multiSelect: true })
    await Promise.resolve()
    const multiCard = sent.at(-1)!
    expect(cards.resolve(multiCard.buttons['Да']!, multiCard.id)).toBe(true)
    expect(cards.resolve(multiCard.buttons['Готово']!, multiCard.id)).toBe(true)
    await multi

    const singleOptionMulti = ask('[LEASE: Один вариант в мультивыборе] Продолжить?', {
      multiSelect: true, options: [{ label: 'Да' }],
    })
    await Promise.resolve()
    const single = sent.at(-1)!
    expect(cards.resolve(single.buttons['Да']!, single.id)).toBe(true)
    await singleOptionMulti

    const secret = ask('[LEASE: hidden-scope] Продолжить?')
    await Promise.resolve()
    const secretCard = sent.at(-1)!
    expect(secretCard.text).not.toContain('hidden-scope')
    expect(cards.resolve(secretCard.buttons['Да']!, secretCard.id)).toBe(true)
    await secret
    expect(leases.instructions()).not.toMatch(/Текст вместо кнопки|Несколько вариантов|Один вариант в мультивыборе|hidden-scope/u)
  } finally { cards.cancel(); rmSync(root, { recursive: true, force: true }) }
})

test('selects one archived Claude session across dates without mixing same-day sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-archive-session-'))
  try {
    writeFileSync(join(root, 'verbose-2026-03-01.jsonl'), JSON.stringify({ sid: 'a', user: 'previous day' }))
    writeFileSync(join(root, 'verbose-2026-03-02.jsonl'), [
      JSON.stringify({ sid: 'b', user: 'unrelated' }), JSON.stringify({ sid: 'a', agent: 'chosen' }),
    ].join('\n'))
    expect(await claudeArchiveSessions(root, '2026-03-02')).toEqual([['b', 1], ['a', 1]])
    const context = await claudeArchiveContext(root, '2026-03-02', [], 'a')
    expect(context).toContain('previous day')
    expect(context).toContain('chosen')
    expect(context).not.toContain('unrelated')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
