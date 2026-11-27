import type { TelegramApi } from '../channel/tools.js'
import { redactSecrets } from '../safety/redact.js'

const stages: Record<string, string> = {
  turn: 'Готовлю ответ',
  commandExecution: 'Выполняю команду',
  fileChange: 'Работаю с файлом',
  mcpToolCall: 'Вызываю инструмент',
  webSearch: 'Ищу источники',
  plan: 'Уточняю план',
  agentMessage: 'Готовлю ответ',
  contextCompaction: 'Сжимаю контекст',
}

export class CodexMirror {
  private messageId: number | undefined
  private last = ''
  private pending = ''
  private updating = false
  private stage = ''
  private readonly commands = new Map<string, string>()

  constructor(private telegram: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>, private chatId: string,
    private secrets: readonly string[] = [], private agentName = 'Codex') {}

  event(kind: string, item?: Record<string, unknown>): void {
    if (!Object.hasOwn(stages, kind)) return
    if (kind === 'commandExecution' && typeof item?.id === 'string' && typeof item.command === 'string') {
      const command = redactSecrets(item.command.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), this.secrets)
        .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()
      const chars = Array.from(command)
      if (command) this.commands.set(item.id, chars.length > 140 ? chars.slice(0, 139).join('') + '…' : command)
      if (this.commands.size > 14) {
        const oldest = this.commands.keys().next().value
        if (oldest !== undefined) this.commands.delete(oldest)
      }
    }
    this.stage = stages[kind]!
    this.render()
  }

  finish(text: string): void {
    this.commands.clear()
    this.stage = text
    this.render()
  }

  private render(): void {
    this.pending = [this.stage, ...Array.from(this.commands.values(), command => '▸ ' + command)].join('\n')
    if (this.updating) return
    this.updating = true
    void this.flush()
  }

  private async flush(): Promise<void> {
    while (this.last !== this.pending) {
      this.last = this.pending
      const text = '📡 ' + this.agentName + ' · ' + this.last
      try {
        if (this.messageId === undefined) {
          const result = await this.telegram.sendMessage(this.chatId, text, { disable_notification: true })
          if (result.message_id > 0) this.messageId = result.message_id
        } else {
          await this.telegram.editMessageText(this.chatId, this.messageId, text, {})
        }
      } catch {
        // Progress display is best effort and must never block the turn.
      }
    }
    this.updating = false
  }
}
