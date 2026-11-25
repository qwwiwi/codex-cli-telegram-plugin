import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import { codexCommands, parseCodexCommand } from '../../src/codex/commands.js'

test('hides disabled commands and resolves supported legacy aliases', () => {
  const config = AppConfigSchema.parse({ commands: { stop: false, new: false } })
  expect(codexCommands(config).map(x => x.command)).toEqual([
    'help', 'status', 'reset', 'compact', 'keys', 'mirror', 'lease', 'cc', 'goal', 'pin', 'unpin', 'react', 'edit', 'get',
  ])
  expect(parseCodexCommand('/CC@ExampleBot Context', 'examplebot')).toEqual({
    name: 'status', args: '',
  })
  expect(parseCodexCommand('/cc clear', 'examplebot')).toEqual({ name: 'reset', args: '' })
  expect(parseCodexCommand('/stop@anotherbot', 'examplebot')).toBeUndefined()
})
