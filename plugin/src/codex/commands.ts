import type { AppConfig } from '../config.js'

const specs = [
  { command: 'help', description: 'справка по командам' },
  { command: 'status', description: 'снимок плагина и сессии' },
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
  { command: 'edit', description: 'заменить текст выбранного ответа example-agentа' },
  { command: 'get', description: 'передать example-agentу вложение из цитаты' },
] as const

export function codexCommands(config: AppConfig, learningEnabled = false) {
  return specs.filter(({ command }) =>
    (command !== 'memory' || learningEnabled) &&
    (!(command in config.commands) || config.commands[command as keyof AppConfig['commands']]))
}

export function parseCodexCommand(text: string | undefined, username: string) {
  const match = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text ?? '')
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return undefined
  const name = match[1]!.toLowerCase()
  const args = match[3]?.trim() ?? ''
  if (name === 'cc') {
    switch (args.toLowerCase()) {
      case 'compact': return { name: 'compact', args: '' }
      case 'status':
      case 'context': return { name: 'status', args: '' }
      case 'clear': return { name: 'reset', args: '' }
    }
  }
  return { name, args }
}
