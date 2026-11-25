import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import { codexAgentName, codexCommands, isStatusQuestion, parseCodexCommand } from '../../src/codex/commands.js'

test('hides disabled commands and resolves supported legacy aliases', () => {
  const config = AppConfigSchema.parse({ commands: { stop: false, new: false } })
  expect(codexCommands(config).map(x => x.command)).toEqual([
    'help', 'status', 'reset', 'compact', 'keys', 'mirror', 'lease', 'cc', 'goal', 'pin', 'unpin', 'react', 'edit', 'get',
  ])
  expect(parseCodexCommand('/CC@ExampleBot Context', 'examplebot')).toEqual({
    name: 'status', args: '',
  })
  expect(parseCodexCommand('/cc clear', 'examplebot')).toEqual({ name: 'reset', args: '' })
  expect(parseCodexCommand('/cc clear force', 'examplebot')).toEqual({ name: 'reset', args: 'force' })
  expect(parseCodexCommand('/cc new', 'examplebot')).toEqual({ name: 'new', args: '' })
  expect(parseCodexCommand('/stop@anotherbot', 'examplebot')).toBeUndefined()
  expect(parseCodexCommand('/team:daily-report@ExampleBot с аргументом', 'examplebot'))
    .toEqual({ name: 'team:daily-report', args: 'с аргументом' })
})

test('only standalone status questions can bypass the active turn', () => {
  for (const text of ['Ты ещё работаешь?', 'На каком ты этапе?', 'Что сейчас делаешь?']) {
    expect(isStatusQuestion(text)).toBe(true)
  }
  for (const text of ['Как там сайт?', 'Как там? Добавь проверку.', 'Проверь, работает ли бот', 'Статус репозитория']) {
    expect(isStatusQuestion(text)).toBe(false)
  }
  expect(isStatusQuestion('example-agent, как там?', 'example-agent')).toBe(true)
  expect(isStatusQuestion('Полярная звезда, как там?', 'Полярная звезда')).toBe(true)
  expect(isStatusQuestion('example-agent, как там?', 'Полярная звезда')).toBe(false)
  expect(codexAgentName('  Полярная звезда  ', 'example-agent')).toBe('Полярная звезда')
  expect(codexAgentName('bad\nname', 'example-agent')).toBe('example-agent')
  expect(codexAgentName(undefined, undefined)).toBe('Codex')
})
