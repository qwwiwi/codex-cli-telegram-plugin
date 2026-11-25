import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelegramApi } from '../../src/channel/tools.js'
import { QuestionCards, type UnansweredQuestion } from '../../src/codex/questions.js'
import { createLogger } from '../../src/log.js'

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
