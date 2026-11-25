import { randomUUID } from 'node:crypto'
import type { TelegramApi } from '../channel/tools.js'
import { isAffirmativeLabel, parseLeaseMarker, type ParsedLeaseMarker } from '../autonomy/grant.js'
import { redactSecrets } from '../safety/redact.js'
import { object } from './rpc.js'
import type { CardCleanup } from './card-cleanup.js'

export const QUESTION_CALLBACK = /^krot:q:([a-f0-9-]{36}):([0-9]|x|d)$/
const questionMarker = /(?:^|\r?\n)(KROT_QUESTION_[a-f0-9-]{36}) (\{[^\r\n]*\})\s*$/u
type Answer = Record<string, { answers: string[] }>
type Choice = { label: string; description?: string }
type Pending = { id: string; messageId?: number; answer: (choices?: string[], affirmativeTap?: boolean) => void; options: string[];
  other: boolean; selected?: Set<number>; paint: () => void }
type GrantLease = (intent: ParsedLeaseMarker, cardId: string, messageId: number) => Promise<string>

export function questionFallback() {
  const marker = 'KROT_QUESTION_' + randomUUID()
  return {
    instructions: 'Если без ответа владельца нельзя продолжить, используй инструмент запроса ответа с вариантами. ' +
      'Если нужен множественный выбор или инструмента нет, выведи последней отдельной строкой ' + marker +
      ' {"question":"короткий вопрос","options":["вариант 1","вариант 2"],"multiSelect":false}. ' +
      'Для выбора нескольких вариантов используй эту карточку и поставь multiSelect: true. Не запрашивай пароли и токены.',
    take(text: string): unknown[] | undefined {
      const match = questionMarker.exec(text)
      if (match?.[1] !== marker || !match[2] || match[2].length > 4000) return
      try {
        const request = object(JSON.parse(match[2]))
        if (typeof request.question !== 'string' || !request.question.trim()) return
        const options = Array.isArray(request.options) ? request.options.filter(label => typeof label === 'string').slice(0, 6) : []
        return [{ id: 'fallback', question: request.question, isOther: true, multiSelect: request.multiSelect === true,
          options: options.map(label => ({ label })) }]
      } catch { return undefined }
    },
  }
}

export function hideQuestionMarker(text: string): string {
  return text.replace(questionMarker, '')
}

export class QuestionCards {
  private current: Pending | undefined

  constructor(
    private readonly chat: string,
    private readonly api: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>,
    private readonly secrets: ReadonlyArray<string>,
    private readonly options = { timeoutMs: 120_000, previewChars: 1000 },
    private readonly cleanup?: CardCleanup,
    private readonly grantLease?: GrantLease,
  ) {}

  get isPending(): boolean { return this.current !== undefined }

  async ask(raw: unknown, signal?: AbortSignal): Promise<Answer> {
    const answers: Answer = Object.create(null)
    if (!Array.isArray(raw)) return answers
    for (const question of raw.slice(0, 4).map(object)) {
      if (signal?.aborted) break
      if (typeof question.id !== 'string' || typeof question.question !== 'string' || question.isSecret) continue
      const options = Array.isArray(question.options) ? question.options.slice(0, 6).map(object).flatMap(option =>
        typeof option.label === 'string' ? [{ label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        }] : []) : []
      const answer = await this.show(question.question, options, question.isOther === true || options.length === 0,
        question.multiSelect === true, signal)
      if (answer === undefined) break
      answers[question.id] = { answers: answer }
    }
    return answers
  }

  resolve(data: string, messageId: number): boolean {
    const match = QUESTION_CALLBACK.exec(data)
    const current = this.current
    if (!match || !current || current.id !== match[1] || current.messageId !== messageId) return false
    if (match[2] === 'x') current.answer()
    else if (match[2] === 'd') {
      if (!current.selected?.size) return false
      current.answer(current.options.filter((_, index) => current.selected!.has(index)))
    } else {
      const index = Number(match[2])
      const value = current.options[index]
      if (value === undefined) return false
      if (current.selected) {
        if (!current.selected.delete(index)) current.selected.add(index)
        current.paint()
      } else current.answer([value], isAffirmativeLabel(value))
    }
    return true
  }

  reply(messageId: number | undefined, text: string): boolean {
    const current = this.current
    if (!current?.other || messageId === undefined || messageId !== current.messageId || text.length > 2000) return false
    current.answer([...(current.selected ? current.options.filter((_, index) => current.selected!.has(index)) : []), text])
    return true
  }

  cancel(): void { this.current?.answer() }

  private show(question: string, choices: Choice[], other: boolean, multiSelect: boolean, signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.current || signal?.aborted) return Promise.resolve(undefined)
    const id = randomUUID()
    const safe = (text: string) => redactSecrets(text, this.secrets)
    const options = choices.map(choice => choice.label)
    const multi = multiSelect && options.length > 1
    const approvals = options.filter(isAffirmativeLabel)
    const marker = this.grantLease && !multiSelect && approvals.length ? parseLeaseMarker(question) : null
    const lease = marker && safe(marker.scope) === marker.scope ? marker : null
    const mandate = lease
      ? 'Мандат: ' + lease.scope + '\nСрок: ' + lease.ttlHours + ' ч.' +
        (lease.supersede ? '\nДействующие мандаты с другим объёмом будут отозваны.' : '') +
        '\nМандат выдаётся по кнопке ' + approvals.map(label => '«' + label.trim() + '»').join(' или ') + '.\n\n'
      : ''
    const details = choices.flatMap(choice => choice.description ? [
      safe(choice.label).slice(0, 80) + ' — ' + safe(choice.description).slice(0, this.options.previewChars),
    ] : []).join('\n').slice(0, 1100)
    const body = mandate + '❔ ' + safe(lease?.displayText ?? question).slice(0, 2400 - mandate.length) +
      (details ? '\n\n' + details : '') +
      (multi ? '\n\nВыбери один или несколько вариантов и нажми «Готово».' : '') +
      (other ? '\n\nЧтобы ввести свой вариант, ответь на эту карточку.' : '')
    const callback = 'krot:q:' + id + ':'
    const selected = multi ? new Set<number>() : undefined
    const keyboard = () => {
      const rows = options.map((label, index) => [{
        text: (selected?.has(index) ? '✓ ' : '') + safe(label).slice(0, 58), callback_data: callback + index,
      }])
      rows.push([...(multi ? [{ text: 'Готово', callback_data: callback + 'd' }] : []),
        { text: '✕ Отменить', callback_data: callback + 'x' }])
      return { inline_keyboard: rows }
    }
    const close = (messageId: number) => {
      void this.api.editMessageText(this.chat, messageId, body + '\n\nВопрос закрыт.', {
        reply_markup: { inline_keyboard: [] },
      }).then(() => this.cleanup?.forget(messageId)).catch(() => undefined)
    }
    return new Promise(resolve => {
      let updates = Promise.resolve()
      const cancel = () => pending.answer()
      const pending: Pending = { id, options, other, ...(selected ? { selected } : {}), paint: () => {
        updates = updates.then(async () => {
          if (this.current === pending && pending.messageId !== undefined) {
            await this.api.editMessageText(this.chat, pending.messageId, body, { reply_markup: keyboard() })
          }
        }).catch(() => undefined)
      }, answer: (value, affirmativeTap) => {
        if (this.current !== pending) return
        this.current = undefined
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (pending.messageId !== undefined) void updates.then(() => close(pending.messageId!))
        const messageId = pending.messageId
        if (lease && affirmativeTap && messageId !== undefined && this.grantLease) {
          void this.grantLease(lease, id, messageId).catch(() => 'Мандат не выдан. Не удалось сохранить его в реестре.')
            .then(feedback => {
              void this.api.sendMessage(this.chat, feedback, {}).catch(() => undefined)
              resolve(value)
            })
        } else resolve(value)
      } }
      const timer = setTimeout(() => pending.answer(), this.options.timeoutMs)
      this.current = pending
      signal?.addEventListener('abort', cancel, { once: true })
      void this.api.sendMessage(this.chat, body, { reply_markup: keyboard() }).then(({ message_id }) => {
        this.cleanup?.remember(message_id, 'question')
        if (this.current === pending) pending.messageId = message_id
        else close(message_id)
      }).catch(() => pending.answer())
    })
  }
}
