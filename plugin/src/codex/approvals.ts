import { randomUUID } from 'node:crypto'
import type { TelegramApi } from '../channel/tools.js'
import { escapeHtml } from '../format/html.js'
import { redactSecrets } from '../safety/redact.js'
import { permissionDecisionKeyboard, renderPermissionCard } from '../telegram/permission-gate-ui.js'
import type { ApprovalDecision, ApprovalRequest } from './session.js'
import type { CardCleanup } from './card-cleanup.js'

export const APPROVAL_CALLBACK = /^krot:approve:([a-f0-9-]{36}):([ad])$/
const MAX_PENDING_APPROVALS = 4
const emptyKeyboard = { inline_keyboard: [] }

type Pending = {
  messageId?: number
  summary: string
  timer: ReturnType<typeof setTimeout>
  finish: (decision: ApprovalDecision) => void
}

export class ApprovalCards {
  private readonly pending = new Map<string, Pending>()

  get isPending(): boolean {
    return this.pending.size > 0
  }

  constructor(
    private readonly ownerId: number,
    private readonly telegram: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>,
    private readonly secrets: ReadonlyArray<string>,
    private readonly timeoutMs: number = 120_000,
    private readonly cleanup?: CardCleanup,
  ) {}

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.resolve('cancel')
    const operation = request.cwd ? request.cwd + '\n' + request.target : request.target
    // A redacted or shortened operation is not enough for informed approval.
    if (this.pending.size >= MAX_PENDING_APPROVALS || operation.length > 3000
        || redactSecrets(operation, this.secrets) !== operation
        || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(operation)) {
      return Promise.resolve('decline')
    }

    const tool = { network: 'Сетевой доступ', stdin: 'Ввод в терминал', command: 'Bash', file: 'Edit', mcp: 'MCP' }[request.kind]
    const reason = redactSecrets((request.reason?.trim().slice(0, 400) ?? '').replace(
      /\bgit config\/hook execution surface needs confirmation\b/giu,
      'Команда Git может запускать скрипты или менять настройки их запуска.',
    ), this.secrets)
    const notice = redactSecrets(request.notice?.trim().slice(0, 400) ?? '', this.secrets)
    const pendingReason = [reason || 'Действие требует твоего подтверждения.', notice].filter(Boolean).join('\n\n')
    const preview = renderPermissionCard(tool, pendingReason, operation)
    const summary = '🔐 <b>Запрос подтверждения</b>' + (reason ? '\n\nПричина: ' + escapeHtml(reason) : '')
    if (preview.length > 4000) return Promise.resolve('decline')

    const id = randomUUID()
    return new Promise(resolve => {
      const cancel = () => this.complete(id, 'cancel', 'Запрос закрыт.')
      const request: Pending = {
        summary,
        finish: decision => {
          signal?.removeEventListener('abort', cancel)
          resolve(decision)
        },
        timer: setTimeout(() => this.complete(id, 'decline', 'Время подтверждения истекло.'), this.timeoutMs),
      }
      this.pending.set(id, request)
      signal?.addEventListener('abort', cancel, { once: true })
      const keyboard = permissionDecisionKeyboard('krot:approve:' + id + ':a', 'krot:approve:' + id + ':d')
      void this.telegram.sendMessage(String(this.ownerId), preview, { parse_mode: 'HTML', reply_markup: keyboard })
        .then(({ message_id }) => {
          this.cleanup?.remember(message_id, 'approval')
          if (this.pending.get(id) === request) request.messageId = message_id
          else this.edit(message_id, summary, 'Запрос уже закрыт.')
        })
        .catch(() => this.complete(id, 'decline', 'Карточку доставить не удалось.'))
    })
  }

  resolve(data: string, from: number, chat: number, messageId: number): boolean {
    if (from !== this.ownerId || chat !== this.ownerId) return false
    const match = APPROVAL_CALLBACK.exec(data)
    const id = match?.[1]
    if (!id || this.pending.get(id)?.messageId !== messageId) return false
    const allowed = match?.[2] === 'a'
    this.complete(id, allowed ? 'accept' : 'decline', allowed ? '✅ Разрешено' : '❌ Запрещено')
    return true
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.complete(id, 'cancel', 'Запрос закрыт.')
  }

  private complete(id: string, decision: ApprovalDecision, status: string): void {
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    request.finish(decision)
    if (request.messageId !== undefined) this.edit(request.messageId, request.summary, status)
  }

  private edit(id: number, summary: string, status: string): void {
    void this.telegram.editMessageText(String(this.ownerId), id, summary + '\n\n<b>' + status + '</b>', {
      parse_mode: 'HTML', reply_markup: emptyKeyboard,
    }).then(() => this.cleanup?.forget(id)).catch(() => undefined)
  }
}
