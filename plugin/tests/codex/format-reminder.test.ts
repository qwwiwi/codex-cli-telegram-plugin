import { expect, test } from 'bun:test'
import { attachmentInstructions } from '../../src/codex/attachments.js'
import { formatConversation } from '../../src/codex/conversation-export.js'
import {
  formatReminder, formatReminderEnabled, ownerTurn, questionFollowUpTurn, sideOwnerTurn,
} from '../../src/codex/format-reminder.js'
import { splitLongBlock } from '../../src/format/paragraphs.js'

const occurrences = (text: string, part: string): number => text.split(part).length - 1

// Twelve sentences of about 75 characters each: one 900-character block without blank lines.
const sentences = Array.from({ length: 12 }, (_, index) =>
  `Пункт ${index + 1} проверен на сервере, журнал чистый и повторный запуск прошёл без ошибок.`)
const longBlock = sentences.join(' ')

test('[R02] the format reminder is present once per turn and byte-identical across turns', () => {
  const first = ownerTurn(true, ['Актуальные мандаты владельца Telegram: нет', 'Первый вопрос'])
  const second = ownerTurn(true, ['', 'Память прошлых задач (JSON).\n[]', 'Совсем другой второй вопрос'])
  const prefix = attachmentInstructions + '\n\n' + formatReminder + '\n\n'
  for (const turn of [first, second]) {
    expect(turn.startsWith(prefix)).toBe(true)
    expect(occurrences(turn, formatReminder)).toBe(1)
  }
  // Static text only: the reminder carries no counters, dates or IDs that could differ between turns.
  expect(formatReminder).not.toMatch(/KROT_|\d{4}-\d{2}|[a-f0-9]{8}-/u)
  // Compact: a short reminder keeps every turn cheap.
  expect(formatReminder.length).toBeLessThanOrEqual(400)
})

test('[R02] KROT_FORMAT_REMINDER=off leaves the reminder out of the turn', () => {
  const turn = ownerTurn(false, ['Вопрос'])
  expect(turn).toBe(attachmentInstructions + '\n\nВопрос')
  expect(turn).not.toContain(formatReminder)
})

test('[R02] question follow-ups and parallel owner turns carry the format reminder once, and none when it is off', () => {
  const followUp = questionFollowUpTurn(true, 'Мандаты: нет', [{ id: 'q1', answer: 'Да' }])
  expect(followUp.startsWith(attachmentInstructions + '\n\n' + formatReminder + '\n\n')).toBe(true)
  expect(occurrences(followUp, formatReminder)).toBe(1)
  expect(followUp).toEndWith('Ответы владельца на твой вопрос из карточки Telegram:\n[{"id":"q1","answer":"Да"}]')
  expect(questionFollowUpTurn(true, '', [])).not.toContain('\n\n\n')
  const side = sideOwnerTurn(true, ['Параллельная задача', '', 'Вопрос владельца'])
  expect(side).toBe(formatReminder + '\n\nПараллельная задача\n\nВопрос владельца')
  // A side reply is delivered without files: no attachment rule in its turn.
  expect(side).not.toContain(attachmentInstructions)
  expect(questionFollowUpTurn(false, 'Мандаты: нет', ['Да'])).not.toContain(formatReminder)
  expect(sideOwnerTurn(false, ['Вопрос'])).toBe('Вопрос')
})

test('[R02] KROT_FORMAT_REMINDER is on unless set to off and rejects other values', () => {
  expect(formatReminderEnabled(undefined)).toBe(true)
  expect(formatReminderEnabled('')).toBe(true)
  expect(formatReminderEnabled('on')).toBe(true)
  expect(formatReminderEnabled(' OFF ')).toBe(false)
  expect(() => formatReminderEnabled('maybe')).toThrow('KROT_FORMAT_REMINDER')
})

test('[R02] the exported conversation hides the format reminder', () => {
  const report = formatConversation([{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: ownerTurn(true, ['Вопрос владельца']) }] },
  ] }], false, [])
  expect(report).toContain('Вопрос владельца')
  expect(report).not.toContain(formatReminder)
})

test('[R02] a long single block is split into paragraphs at sentence ends', () => {
  const split = splitLongBlock(longBlock)
  const paragraphs = split.split('\n\n')
  expect(paragraphs.length).toBeGreaterThan(1)
  for (const paragraph of paragraphs) {
    expect(paragraph.length).toBeLessThanOrEqual(450)
    expect(paragraph).toMatch(/\.$/u)
    expect(paragraph).not.toContain('\n')
  }
  // Only whitespace between sentences changes: no word is lost, moved or cut.
  expect(paragraphs.join(' ')).toBe(longBlock)
})

test('[R02] a code block, a short answer and an answer with paragraphs are delivered unchanged', () => {
  const code = '```\n' + longBlock + '\n```'
  expect(splitLongBlock(code)).toBe(code)
  const short = sentences.slice(0, 3).join(' ')
  expect(splitLongBlock(short)).toBe(short)
  const paragraphs = sentences.slice(0, 6).join(' ') + '\n\n' + sentences.slice(6).join(' ')
  expect(splitLongBlock(paragraphs)).toBe(paragraphs)
})

test('[R02] the split never cuts a list, a link, inline code or a bold span', () => {
  const list = sentences.map(sentence => '- ' + sentence).join('\n')
  expect(splitLongBlock(list)).toBe(list)
  const listItem = '- ' + longBlock
  expect(splitLongBlock(listItem)).toBe(listItem)
  const protectedSpans = '[Отчёт. Версия 2](https://example.com/a.b) готов. ' +
    '`cfg. Ключ` задан. **Итог. Всё работает.** ' + longBlock
  const split = splitLongBlock(protectedSpans)
  expect(split).not.toBe(protectedSpans)
  expect(split).toContain('[Отчёт. Версия 2](https://example.com/a.b)')
  expect(split).toContain('`cfg. Ключ`')
  expect(split).toContain('**Итог. Всё работает.**')
  expect(split.split('\n\n').join(' ')).toBe(protectedSpans)
})

test('[R02] the split never cuts a single-italic span or an HTML element, including a multi-line <pre> block', () => {
  const spans = '*Итог. Всё работает.* Готово. _Шаг 1. Шаг 2._ Дальше. <pre>cfg. Ключ. Значение.</pre> Ок. ' +
    '<i>Раз. Два.</i> ' + longBlock
  const split = splitLongBlock(spans)
  expect(split).not.toBe(spans)
  for (const span of ['*Итог. Всё работает.*', '_Шаг 1. Шаг 2._', '<pre>cfg. Ключ. Значение.</pre>', '<i>Раз. Два.</i>']) {
    expect(split).toContain(span)
  }
  expect(split.split('\n\n').join(' ')).toBe(spans)
  const pre = longBlock + '\n<pre>\n' + longBlock + '\n</pre>'
  const prose = splitLongBlock(pre)
  expect(prose.endsWith('\n<pre>\n' + longBlock + '\n</pre>')).toBe(true)
  expect(prose.slice(0, -('\n<pre>\n' + longBlock + '\n</pre>').length)).toContain('\n\n')
})

test('[R02] a long prose line before a code block is split and the code stays as written', () => {
  const code = '```sh\necho one. Two\n```'
  const text = longBlock + '\n' + code
  const split = splitLongBlock(text)
  expect(split.endsWith('\n' + code)).toBe(true)
  const prose = split.slice(0, -code.length - 1)
  expect(prose).toContain('\n\n')
  expect(prose.split('\n\n').join(' ')).toBe(longBlock)
})

test('[R02] initials and short abbreviations do not end a sentence', () => {
  const text = 'Встреча с А. С. Петровым прошла в г. Казани, договор подписан. ' + longBlock
  const split = splitLongBlock(text)
  expect(split).toContain('А. С. Петровым прошла в г. Казани')
  expect(split.split('\n\n').join(' ')).toBe(text)
})
