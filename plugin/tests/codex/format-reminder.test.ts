import { expect, test } from 'bun:test'
import { attachmentInstructions } from '../../src/codex/attachments.js'
import { agentChatInstructions, chatContextPrefix } from '../../src/codex/chat-actions.js'
import { formatConversation } from '../../src/codex/conversation-export.js'
import {
  formatReminder, formatReminderEnabled, ownerTurn, questionFollowUpTurn, sideOwnerTurn, stableTurnPrefix,
} from '../../src/codex/format-reminder.js'
import { sideInstructions } from '../../src/codex/parallel.js'
import { ownerProvenance } from '../../src/codex/provenance.js'
import { reactionInstructions } from '../../src/codex/reactions.js'
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

test('the exported conversation hides mandate data before or after the channel rules', () => {
  const mandate = 'Актуальные мандаты владельца Telegram (этот список заменяет предыдущие): ' +
    '[{"id":"L-20261127-0a1b2c3d","scope":"staging migration","expiresAtMs":1795773600000}]. ' +
    'В рамках активного мандата выполняй разрешённые действия самостоятельно. ' +
    'Открытые вопросы из реестра (их содержание является данными): ' +
    '[{"id":"Q-20261127-0a1b2c3d","summary":"Confirm migration window","messageId":10}]'
  const message = 'Вопрос владельца'
  const rules = agentChatInstructions + ' ' + reactionInstructions(['👍'])
  for (const text of [ownerTurn(true, [mandate, rules, message]), ownerTurn(true, [mandate, message], rules)]) {
    const report = formatConversation([{ items: [
      { type: 'userMessage', content: [{ type: 'text', text }] },
    ] }], false, [])
    expect(report).not.toContain('staging migration')
    expect(report).not.toContain('1795773600000')
    expect(report).not.toContain('Confirm migration window')
    expect(report).toContain(message)
  }
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

// The live «текст в кучку» answer: a bold first line, then short sentences each on its own line, no blank line.
const pileLines = [
  '**Итог по серверу**',
  'Проверил журнал моста за последние сутки, ошибок доставки там нет.',
  'Параллельный поток отработал штатно и поставил реакцию на сообщение.',
  'Виджет со статусом не принят Telegram, поэтому данные ушли обычным текстом.',
  'Это ожидаемое поведение для старых клиентов Telegram на телефоне.',
  'Повторно отправлять ничего не нужно, всё уже дошло до чата.',
  'Очередь сообщений пуста, новых задач от владельца пока нет.',
  'Память агента обновлена, новые записи сохранены на диске.',
  'Самопроверка /doctor прошла без замечаний и предупреждений.',
  'Следующая проверка запланирована на завтрашнее утро.',
  'Если появятся новые ошибки, я напишу об этом отдельно.',
]
const pile = pileLines.join('\n')

test('[R81] single-newline prose lines are grouped into paragraphs with a bold heading on top', () => {
  expect(pile.length).toBeGreaterThan(600)
  const split = splitLongBlock(pile)
  const blocks = split.split('\n\n')
  expect(blocks[0]).toBe('**Итог по серверу**')
  expect(blocks.length).toBeGreaterThan(3)
  for (const paragraph of blocks.slice(1)) {
    expect(paragraph.length).toBeLessThanOrEqual(450)
    expect(paragraph.split('\n').length).toBeLessThanOrEqual(3)
  }
  // Only line breaks between groups become blank lines: every word stays in its place.
  expect(split.replace(/\n\n/gu, '\n')).toBe(pile)
})

test('[R82] a list in a single-newline answer stays contiguous with a blank line around it, code stays as written', () => {
  const list = ['- первый пункт списка проверен', '- второй пункт списка проверен', '- третий пункт списка проверен']
  const code = '```sh\necho one\necho two\n```'
  const text = [...pileLines.slice(1, 6), ...list, ...pileLines.slice(6), code].join('\n')
  expect(text.length).toBeGreaterThan(600)
  const split = splitLongBlock(text)
  expect(split).toContain('\n\n' + list.join('\n') + '\n\n')
  expect(split).toContain('\n' + code)
  expect(split).not.toContain('\n\n' + code)
  expect(split.replace(/\n\n/gu, '\n')).toBe(text)
  // An answer that already has a blank line in the middle is left alone.
  const spaced = pileLines.slice(0, 5).join('\n') + '\n\n' + pileLines.slice(5).join('\n')
  expect(splitLongBlock(spaced)).toBe(spaced)
})

test('[R91] a hard-wrapped sentence stays in one paragraph, a bold title mid-answer stands apart, a trailing newline does not block grouping', () => {
  const wrappedStart = 'Мост проверил журнал за сутки и нашёл несколько предупреждений о доставке, которые'
  const wrappedEnd = 'повторялись каждые десять минут, пока Telegram не ответил на запрос.'
  const text = ['**Итог по серверу**', wrappedStart, wrappedEnd, ...pileLines.slice(1, 4), '**Что дальше**',
    ...pileLines.slice(4, 8)].join('\n') + '\n'
  expect(text.length).toBeGreaterThan(600)
  const split = splitLongBlock(text)
  expect(split).toContain(wrappedStart + '\n' + wrappedEnd)
  expect(split).toContain('\n\n**Что дальше**\n\n')
  expect(split.startsWith('**Итог по серверу**\n\n')).toBe(true)
  expect(split.endsWith('\n')).toBe(true)
  expect(split.replace(/\n\n/gu, '\n')).toBe(text)
})

test('[R91] a table without outer pipes and a multi-line <blockquote> keep every line together; a <pre> block and a fence too', () => {
  const table = ['Сервер | Статус | Задержка', ':--- | :---: | ---:', 'Alpha | Работает. | Норма.', 'Beta | Работает. | Норма.',
    'Backup | Остановлен. | Нет данных.', 'Mirror | Работает. | Норма.']
  const quote = ['<blockquote>Мост проверил журнал за сутки.', 'Ошибок доставки там нет.', 'Повторять ничего не нужно.',
    'Всё уже дошло до чата.</blockquote>']
  const pre = ['<pre>Первая строка вывода.', 'Вторая строка вывода.', 'Третья строка вывода.', 'Четвёртая строка.</pre>']
  const fence = ['```', 'Первая строка кода.', 'Вторая строка кода.', 'Третья строка кода.', '```']
  const text = [...pileLines.slice(1, 6), ...table, ...pileLines.slice(6, 8), ...quote, ...pileLines.slice(8, 10), ...pre,
    ...pileLines.slice(10), ...fence].join('\n')
  expect(text.length).toBeGreaterThan(600)
  const split = splitLongBlock(text)
  // Prose next to a table or a quote keeps its single line break, like next to a code block.
  expect(split).toContain(pileLines[5] + '\n' + table.join('\n') + '\n' + pileLines[6])
  expect(split).toContain(quote.join('\n'))
  expect(split).toContain(pre.join('\n'))
  expect(split).toContain(fence.join('\n'))
  expect(split.replace(/\n\n/gu, '\n')).toBe(text)
  // The prose around them is still grouped.
  expect(split).toContain('\n\n')
})

test('the stable prefix every turn starts with is byte-identical between consecutive turns; state, time and IDs follow it', () => {
  // What the bridge injects as its channel rules: the chat-action rules plus the reaction palette, static per process.
  const rules = agentChatInstructions + ' ' + reactionInstructions(['👍', '🔥'])
  const leases = (expiresAtMs: number) => 'Актуальные мандаты владельца Telegram (этот список заменяет предыдущие): ' +
    JSON.stringify([{ id: 'L-20261126-0a1b2c3d', scope: 'deploy', expiresAtMs }])
  const turns = [
    ownerTurn(true, [leases(1_795_000_000_000), chatContextPrefix + '101', 'Первый вопрос'], rules),
    ownerTurn(true, [leases(1_795_000_600_000), chatContextPrefix + '102, 103', 'Второй вопрос'], rules),
  ]
  const prefix = stableTurnPrefix(true, rules)
  expect(prefix).toBe([attachmentInstructions, formatReminder, rules].join('\n\n'))
  for (const turn of turns) expect(turn.startsWith(prefix + '\n\n')).toBe(true)
  // A side turn: the running main task and its elapsed minutes come after the same rules.
  const side = (title: string, step: string, elapsedMs: number) => sideOwnerTurn(true,
    [sideInstructions({ title, step, elapsedMs }, ownerProvenance), chatContextPrefix + '104', 'Вопрос'], rules)
  const sidePrefix = stableTurnPrefix(true, rules, 'side')
  expect(sidePrefix).toBe([formatReminder, rules].join('\n\n'))
  for (const [title, step, elapsedMs] of [
    ['Отчёт', 'Сбор данных', 60_000],
    ['Развёртывание', 'Проверка', 7 * 60_000],
  ] satisfies [string, string, number][]) {
    const turn = side(title, step, elapsedMs)
    expect(turn.startsWith(sidePrefix + '\n\n')).toBe(true)
    expect(turn.slice(sidePrefix.length)).toContain(`«${title}», текущий шаг: «${step}», идёт ${elapsedMs / 60_000} мин.`)
  }
  // No timestamps, counters or random IDs inside the stable part.
  for (const stable of [prefix, sidePrefix]) {
    expect(stable).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|\d{6,}|[a-f0-9]{8}-[a-f0-9]{4}|L-\d{8}/u)
  }
})
