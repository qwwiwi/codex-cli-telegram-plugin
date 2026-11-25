import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../src/log.js'
import { attachmentInstructions } from '../../src/codex/attachments.js'
import { ControlState } from '../../src/codex/control-state.js'
import { savedGoalAnswer, shouldRecoverGoal } from '../../src/codex/goal-delivery.js'
import { claudeArchiveContext, claudeArchiveDates, claudeArchiveSessions, formatConversation,
  readClaudeArchive } from '../../src/codex/conversation-export.js'
import { CodexLeases } from '../../src/codex/lease.js'
import { QuestionCards } from '../../src/codex/questions.js'

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

test('exports conversational text with secrets redacted and internal tools excluded', () => {
  const report = formatConversation([{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: attachmentInstructions + '\n\n' +
      'Актуальные мандаты владельца Telegram: [private]\n\nПроверка' }] },
    { type: 'commandExecution', aggregatedOutput: 'tool output' },
    { type: 'agentMessage', phase: 'commentary', text: 'internal update' },
    { type: 'agentMessage', phase: 'final_answer', text: 'Ответ secret-smoke\n@@SEND_FILE: /workspace/out.txt' },
  ] }], true, ['secret-smoke'])
  expect(report).toContain('Проверка')
  expect(report).toContain('[Отправлено вложение]')
  expect(report).not.toMatch(/tool output|internal update|secret-smoke|\/workspace\/out|\[private\]/)
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
