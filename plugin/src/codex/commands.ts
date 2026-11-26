import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'

const specs = [
  { command: 'help', description: 'справка по командам' },
  { command: 'status', description: 'снимок плагина и сессии' },
  { command: 'usage', description: 'расход токенов и динамика за 1, 7 или 30 дней' },
  { command: 'stop', description: 'прервать текущую задачу' },
  { command: 'reset', description: 'сбросить сессию (нужен force)' },
  { command: 'new', description: 'начать новую сессию' },
  { command: 'compact', description: 'сжать контекст диалога Codex' },
  { command: 'keys', description: 'показать панель управления' },
  { command: 'mirror', description: 'ход работы: on | off | status' },
  { command: 'lease', description: 'выдать, посмотреть или отозвать мандат' },
  { command: 'cc', description: 'модель, сессии, экспорт и лимиты Codex' },
  { command: 'goal', description: 'поставить, посмотреть или приостановить длинную цель' },
  { command: 'memory', description: 'управлять предложениями памяти и навыками' },
  { command: 'pin', description: 'закрепить сообщение, на которое ответил' },
  { command: 'unpin', description: 'открепить сообщение, на которое ответил' },
  { command: 'react', description: 'поставить эмодзи на выбранное сообщение' },
  { command: 'edit', description: 'заменить текст выбранного ответа агента' },
  { command: 'get', description: 'передать агенту вложение из цитаты' },
  { command: 'doctor', description: 'самопроверка и сравнение с GitHub; fix — передать агенту' },
] as const

export function codexCommands(config: AppConfig, learningEnabled = false) {
  return specs.filter(({ command }) =>
    (command !== 'memory' || learningEnabled) &&
    (!(command in config.commands) || config.commands[command as keyof AppConfig['commands']]))
}

export interface CodexCommandSpec {
  command: string
  description: string
}

// The Telegram «/» menu shows only the commands needed all the time; every
// other command still works when typed and stays listed in /help.
// KROT_MENU_COMMANDS (comma list) replaces this list; a listed command the
// build does not register is skipped with a log line.
export const DEFAULT_MENU_COMMANDS: readonly string[] = ['new', 'stop', 'status', 'goal', 'compact', 'cc', 'doctor', 'help']

// Short menu labels; a command without one keeps its /help description.
const menuDescriptions: Readonly<Record<string, string>> = {
  new: 'Новая сессия',
  stop: 'Прервать задачу',
  status: 'Состояние и лимиты',
  goal: 'Длинная цель',
  compact: 'Сжать контекст',
  cc: 'Модель и сессии',
  doctor: 'Самопроверка и сверка с GitHub',
  help: 'Все команды',
}

function menuNames(value: string | undefined): readonly string[] {
  const names = (value ?? '').split(',')
    .map(name => name.trim().replace(/^\//u, '').toLowerCase())
    .filter(name => name !== '')
  return names.length > 0 ? [...new Set(names)] : DEFAULT_MENU_COMMANDS
}

/**
 * Splits the commands into what the bot accepts and shows in /help (every
 * enabled command) and what it publishes in the Telegram menu (the short
 * list, in its order). A listed command that is not registered is skipped
 * with a log line. `extra` holds commands registered outside the built-in list.
 */
export function codexCommandSet(
  config: AppConfig,
  learningEnabled: boolean,
  menuEnv: string | undefined,
  log: Pick<Logger, 'info'>,
  extra: readonly CodexCommandSpec[] = [],
) {
  const help: readonly CodexCommandSpec[] = [...codexCommands(config, learningEnabled), ...extra]
  const menu: CodexCommandSpec[] = []
  for (const name of menuNames(menuEnv)) {
    const spec = help.find(item => item.command === name)
    if (!spec) {
      log.info('telegram menu: listed command is not registered, skipped', { command: name })
      continue
    }
    menu.push({ command: spec.command, description: menuDescriptions[spec.command] ?? spec.description })
  }
  return {
    help,
    menu,
    accepts: (name: string): boolean => help.some(spec => spec.command === name),
  }
}

export function codexAgentName(override: string | undefined, previousLabel: string | undefined): string {
  for (const name of [override, previousLabel]) {
    const clean = name?.trim()
    if (clean && clean.length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(clean)) return clean
  }
  return 'Codex'
}

function normalizeAddress(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е')
}

export function stripAgentAddress(text: string, agentName: string): string {
  const phrase = text.trim()
  const name = agentName.trim()
  const suffix = phrase.slice(name.length)
  if (name && /^[,!:\s]/u.test(suffix) &&
      normalizeAddress(phrase.slice(0, name.length)) === normalizeAddress(name)) {
    return suffix.replace(/^[,!:\s]+/u, '')
  }
  return phrase
}

export function isStatusQuestion(text: string, agentName = 'Codex'): boolean {
  const phrase = normalizeAddress(stripAgentAddress(text, agentName)).replace(/[?!.…]+$/u, '').trim()
  return /^(?:статус|как там|как продвигается|как идет работа|(?:ты )?(?:еще )?работаешь|на каком (?:ты )?этапе|что сейчас делаешь)$/u.test(phrase)
}

export function isBuiltInCommand(name: string): boolean {
  return specs.some(spec => spec.command === name)
}

export function parseCodexCommand(text: string | undefined, username: string) {
  const match = /^\/([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text ?? '')
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return undefined
  const name = match[1]!.toLowerCase()
  const args = match[3]?.trim() ?? ''
  if (name === 'cc') {
    switch (args.toLowerCase()) {
      case 'compact': return { name: 'compact', args: '' }
      case 'new': return { name: 'new', args: '' }
      case 'status':
      case 'context': return { name: 'status', args: '' }
      case 'clear': return { name: 'reset', args: '' }
      case 'clear force': return { name: 'reset', args: 'force' }
    }
  }
  return { name, args }
}
