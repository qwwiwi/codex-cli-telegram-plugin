import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import { codexCommandSet, parseCodexCommand } from '../../src/codex/commands.js'
import { registerOwnerScopedCommands, type CommandScopeApi, type CommandSpec } from '../../src/telegram/command-scope.js'

function recordingLog() {
  const lines: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = []
  const at = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(ctx ? { ctx } : {}) })
  }
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  return { log, lines }
}

function recordingApi() {
  const published: Array<{ commands: CommandSpec[]; scope: unknown }> = []
  const deleted: unknown[] = []
  const api: CommandScopeApi = {
    async deleteMyCommands(options) { deleted.push(options?.scope ?? 'default') },
    async setMyCommands(commands, options) { published.push({ commands: [...commands], scope: options.scope }) },
  }
  return { api, published, deleted }
}

const config = AppConfigSchema.parse({})

test('[R20] start publishes exactly the eight-entry short menu in order, /doctor once', async () => {
  const { log, lines } = recordingLog()
  const set = codexCommandSet(config, false, undefined, log)
  const expected = [
    { command: 'new', description: 'Новая сессия' },
    { command: 'stop', description: 'Прервать задачу' },
    { command: 'status', description: 'Состояние и лимиты' },
    { command: 'goal', description: 'Длинная цель' },
    { command: 'compact', description: 'Сжать контекст' },
    { command: 'cc', description: 'Модель и сессии' },
    { command: 'doctor', description: 'Самопроверка и сверка с GitHub' },
    { command: 'help', description: 'Все команды' },
  ]
  expect(set.menu).toEqual(expected)
  // /doctor is registered on this build: nothing in the default list is skipped.
  expect(lines.some(line => line.msg.includes('not registered'))).toBe(false)
  // /help lists /doctor once, with its long description.
  expect(set.help.filter(spec => spec.command === 'doctor').map(spec => spec.description))
    .toEqual(['самопроверка и сравнение с GitHub; fix — передать агенту'])

  const { api, published, deleted } = recordingApi()
  await registerOwnerScopedCommands(api, set.menu, [42], log)
  expect(deleted).toEqual(['default', { type: 'all_private_chats' }])
  expect(published).toEqual([{ commands: expected, scope: { type: 'chat', chat_id: 42 } }])
})

test('[R20] a command hidden from the menu still dispatches and stays in /help', () => {
  const { log } = recordingLog()
  const set = codexCommandSet(config, false, undefined, log)
  for (const hidden of ['lease', 'mirror', 'keys', 'reset', 'pin']) {
    expect(set.menu.some(spec => spec.command === hidden)).toBe(false)
    expect(set.accepts(parseCodexCommand('/' + hidden, 'examplebot')!.name)).toBe(true)
    expect(set.help.some(spec => spec.command === hidden)).toBe(true)
  }
  // A command switched off in config stays refused, menu or not.
  const off = codexCommandSet(AppConfigSchema.parse({ commands: { stop: false } }), false, undefined, log)
  expect(off.accepts('stop')).toBe(false)
  expect(off.menu.some(spec => spec.command === 'stop')).toBe(false)
  expect(set.accepts('nonexistent')).toBe(false)
})

test('[R20] KROT_MENU_COMMANDS overrides the default menu', () => {
  const { log, lines } = recordingLog()
  const set = codexCommandSet(config, false, ' /lease, status,STOP,, bogus ,status', log)
  expect(set.menu).toEqual([
    { command: 'lease', description: 'выдать, посмотреть или отозвать мандат' },
    { command: 'status', description: 'Состояние и лимиты' },
    { command: 'stop', description: 'Прервать задачу' },
  ])
  expect(lines.some(line => line.ctx?.command === 'bogus')).toBe(true)
  // An empty value means "not set": the default menu.
  expect(codexCommandSet(config, false, ' , ', log).menu.map(spec => spec.command))
    .toEqual(['new', 'stop', 'status', 'goal', 'compact', 'cc', 'doctor', 'help'])
})
