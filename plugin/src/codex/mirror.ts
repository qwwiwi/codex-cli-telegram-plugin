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
  private terminal = ''
  private readonly partial = new Map<string, string>()
  private nextPaint: ReturnType<typeof setTimeout> | undefined

  constructor(private telegram: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>, private chatId: string,
    private secrets: readonly string[] = [], private agentName = 'Codex') {}

  event(kind: string): void {
    if (Object.hasOwn(stages, kind)) this.update(stages[kind]!)
  }

  update(text: string): void {
    this.stage = text
    this.render()
  }

  output(itemId: string, delta: string, completed?: string): void {
    const seen = this.partial.has(itemId)
    const data = ((this.partial.get(itemId) ?? '') + (completed === undefined ? delta :
      seen ? '\n' : completed + '\n')).replace(/\r\n?/g, '\n')
    const end = data.lastIndexOf('\n')
    // Do not display fragments that may be part of a secret split across deltas.
    if (completed !== undefined) this.partial.delete(itemId)
    else {
      this.partial.set(itemId, data.slice(end + 1).slice(-4096))
      if (this.partial.size > 16) this.partial.delete(this.partial.keys().next().value!)
    }
    if (end < 0) return
    const visible = redactSecrets(data.slice(0, end + 1), this.secrets)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    this.terminal = (this.terminal + visible).split('\n').slice(-14).join('\n').slice(-2100)
    if (!this.nextPaint) {
      this.nextPaint = setTimeout(() => { this.nextPaint = undefined; this.render() }, 1000)
      this.nextPaint.unref()
    }
  }

  private render(): void {
    this.pending = [this.stage, this.terminal.trimEnd()].filter(Boolean).join('\n\n')
    if (this.updating) return
    this.updating = true
    void this.flush().finally(() => { this.updating = false })
  }

  private async flush(): Promise<void> {
    while (this.last !== this.pending) {
      this.last = this.pending
      const text = '📡 ' + this.agentName + ' · ' + this.last
      try {
        if (this.messageId === undefined) {
          const result = await this.telegram.sendMessage(this.chatId, text, { disable_notification: true })
          this.messageId = result.message_id
        } else {
          await this.telegram.editMessageText(this.chatId, this.messageId, text, {})
        }
      } catch {
        // Progress display is best effort and must never block the turn.
      }
    }
  }
}
