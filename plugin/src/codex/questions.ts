import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TelegramApi } from '../channel/tools.js'
import { isAffirmativeLabel, parseLeaseMarker, stripLeaseMarkerForDisplay, type ParsedLeaseMarker } from '../autonomy/grant.js'
import { atomicWriteInRoot } from '../autonomy/store.js'
import type { Logger } from '../log.js'
import { redactSecrets } from '../safety/redact.js'
import { object } from './rpc.js'
import type { CardCleanup } from './card-cleanup.js'

export const QUESTION_CALLBACK = /^krot:q:([a-f0-9-]{36}):([0-9]|x|d)$/
const questionMarker = /(?:^|\r?\n)(KROT_QUESTION_[a-f0-9-]{36}) (\{[^\r\n]*\})\s*$/u
type Answer = Record<string, { answers: string[] }>
type Choice = { label: string; description?: string }
export type UnansweredQuestion = { messageId: number; askedAtMs: number; snippet: string; reason: 'timeout' | 'restart' }
type CardState = 'open' | 'closed' | UnansweredQuestion['reason']
type StoredQuestion = Omit<UnansweredQuestion, 'reason'> & { body: string; state: CardState; reported: boolean }
type QuestionOptions = {
  timeoutMs: number
  previewChars: number
  persistence?: { root: string; log: Logger }
  onUnanswered?: (question: UnansweredQuestion) => void | Promise<void>
}
type Pending = { id: string; card?: StoredQuestion;
  answer: (choices?: string[], affirmativeTap?: boolean, state?: Exclude<CardState, 'open'>) => void; options: string[];
  other: boolean; selected?: Set<number>; paint: () => void }
type GrantLease = (intent: ParsedLeaseMarker, cardId: string, messageId: number) => Promise<string>
const journalFile = 'codex-pending-questions.json'
const maxSavedCards = 100
const outcomeText: Record<Exclude<CardState, 'open'>, string> = {
  closed: 'Вопрос закрыт.',
  timeout: '⏰ Время ожидания истекло. При необходимости отправь уточнение ещё раз.',
  restart: 'Вопрос закрыт после перезапуска моста. При необходимости отправь уточнение ещё раз.',
}

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
  private readonly retained = new Map<number, StoredQuestion>()
  private suspended = false

  constructor(
    private readonly chat: string,
    private readonly api: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>,
    private readonly secrets: ReadonlyArray<string>,
    private readonly options: QuestionOptions = { timeoutMs: 120_000, previewChars: 1000 },
    private readonly cleanup?: CardCleanup,
    private readonly grantLease?: GrantLease,
  ) {
    const persistence = options.persistence
    if (!persistence) return
    try {
      const { chat, entries } = object(JSON.parse(readFileSync(join(persistence.root, journalFile), 'utf8')))
      if (chat !== this.chat || !Array.isArray(entries)) return
      for (const value of entries.slice(-maxSavedCards)) {
        const { messageId, askedAtMs, snippet, body, state, reported } = object(value)
        if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            typeof askedAtMs !== 'number' || !Number.isSafeInteger(askedAtMs) || askedAtMs <= 0 ||
            typeof body !== 'string' || typeof snippet !== 'string' ||
            (state !== 'open' && state !== 'closed' && state !== 'timeout' && state !== 'restart')) continue
        this.retained.set(messageId, { messageId, askedAtMs, state, reported: reported === true,
          body: redactSecrets(body, this.secrets).slice(0, 3600),
          snippet: redactSecrets(snippet, this.secrets).slice(0, 200) })
      }
    } catch (error) {
      if (object(error).code !== 'ENOENT') persistence.log.warn('Could not read pending Telegram questions')
    }
  }

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
    if (!match || !current || current.id !== match[1] || current.card?.messageId !== messageId) return false
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
    if (!current?.other || messageId === undefined || messageId !== current.card?.messageId || text.length > 2000) return false
    current.answer([...(current.selected ? current.options.filter((_, index) => current.selected!.has(index)) : []), text])
    return true
  }

  cancel(): void { this.current?.answer() }

  suspend(): void {
    this.suspended = true
    this.current?.answer(undefined, false, 'restart')
  }

  async recover(): Promise<void> {
    // The original RPC or bridge waiter is process-local. Only restore the owner-facing record.
    for (const card of [...this.retained.values()]) {
      if (this.suspended) break
      if (card === this.current?.card) continue
      if (card.state === 'open') {
        card.state = 'restart'
        this.persist()
      }
      await this.closeCard(card)
    }
  }

  private persist(): boolean {
    const persistence = this.options.persistence
    if (!persistence) return false
    try {
      atomicWriteInRoot(persistence, journalFile,
        JSON.stringify({ chat: this.chat, entries: [...this.retained.values()] }) + '\n')
      return true
    } catch {
      persistence.log.warn('Could not persist pending Telegram questions')
      return false
    }
  }

  private track(card: StoredQuestion): void {
    if (this.options.persistence) {
      this.retained.set(card.messageId, card)
      if (this.retained.size > maxSavedCards) this.retained.delete(this.retained.keys().next().value!)
      if (this.persist()) return
    }
    this.cleanup?.remember(card.messageId, 'question')
  }

  private forget(messageId: number): void {
    if (this.retained.delete(messageId)) this.persist()
    this.cleanup?.forget(messageId)
  }

  private async closeCard(card: StoredQuestion): Promise<void> {
    const { messageId, askedAtMs, snippet, state } = card
    if (state === 'open') return
    let closed = false
    try {
      await this.api.editMessageText(this.chat, messageId, card.body + '\n\n' + outcomeText[state], {
        reply_markup: { inline_keyboard: [] },
      })
      closed = true
    } catch (error) {
      const description = String(object(error).description ?? '')
      if (/message to edit not found/iu.test(description)) {
        this.forget(messageId)
        return
      }
      closed = /message is not modified/iu.test(description)
      if (!closed) this.options.persistence?.log.warn('Could not close a Telegram question card')
    }
    if (state !== 'closed' && !card.reported && this.options.onUnanswered) {
      try {
        await this.options.onUnanswered({ messageId, askedAtMs, snippet, reason: state })
        card.reported = true
        this.persist()
      } catch {
        this.options.persistence?.log.warn('Could not register an unanswered Telegram question')
        return
      }
    }
    if (closed) this.forget(messageId)
  }

  private show(question: string, choices: Choice[], other: boolean, multiSelect: boolean, signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.suspended || this.current || signal?.aborted) return Promise.resolve(undefined)
    const id = randomUUID()
    const safe = (text: string) => redactSecrets(text, this.secrets)
    const options = choices.map(choice => choice.label)
    const multi = multiSelect && options.length > 1
    const approvals = options.filter(isAffirmativeLabel)
    const marker = this.grantLease && !multiSelect && approvals.length ? parseLeaseMarker(question) : null
    const lease = marker && safe(marker.scope) === marker.scope ? marker : null
    const mandate = lease
      ? 'Мандат: ' + lease.scope + '\nСрок: ' + lease.ttlHours + ' ч.' +
        (lease.supersede ? '\nДействующие мандаты с другим объёмом будут отозваны.' : '')
      : ''
    const mandateInstructions = lease
      ? '\nМандат выдаётся по кнопке ' + approvals.map(label => '«' + label.trim() + '»').join(' или ') + '.\n\n'
      : ''
    const choiceText = (choice: Choice) => safe(choice.label).slice(0, 80) +
      (choice.description ? ' — ' + safe(choice.description).slice(0, this.options.previewChars) : '')
    const details = choices.filter(choice => choice.description).map(choiceText).join('\n').slice(0, 1100)
    const title = '❔ ' + safe(lease?.displayText ?? question).slice(0, 2400 - mandate.length - mandateInstructions.length)
    const body = mandate + mandateInstructions + title +
      (details ? '\n\n' + details : '') +
      (multi ? '\n\nВыбери один или несколько вариантов и нажми «Готово».' : '') +
      (other ? '\n\nЧтобы ввести свой вариант, ответь на эту карточку.' : '')
    const savedChoices = choices.map(choice => '• ' + choiceText(choice)).join('\n').slice(0, 1100)
    const savedBody = (mandate ? mandate + '\n\n' : '') + title + (savedChoices ? '\n\n' + savedChoices : '')
    const snippet = Array.from(safe(stripLeaseMarkerForDisplay(question)).trim()).slice(0, 100).join('') ||
      'Интерактивный вопрос'
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
    return new Promise(resolve => {
      let updates = Promise.resolve()
      let state: CardState = 'open'
      const cancel = () => pending.answer()
      const pending: Pending = { id, options, other, ...(selected ? { selected } : {}), paint: () => {
        updates = updates.then(async () => {
          if (this.current === pending && pending.card) {
            await this.api.editMessageText(this.chat, pending.card.messageId, body, { reply_markup: keyboard() })
          }
        }).catch(() => undefined)
      }, answer: (value, affirmativeTap, outcome = 'closed') => {
        if (this.current !== pending) return
        this.current = undefined
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        state = outcome
        const card = pending.card
        if (card) {
          card.state = outcome
          this.persist()
          if (outcome !== 'restart') void updates.then(() => this.closeCard(card))
        }
        const messageId = card?.messageId
        if (lease && affirmativeTap && messageId !== undefined && this.grantLease) {
          void this.grantLease(lease, id, messageId).catch(() => 'Мандат не выдан. Не удалось сохранить его в реестре.')
            .then(feedback => {
              void this.api.sendMessage(this.chat, feedback, {}).catch(() => undefined)
              resolve(value)
            })
        } else resolve(value)
      } }
      const timer = setTimeout(() => pending.answer(undefined, false, 'timeout'), this.options.timeoutMs)
      this.current = pending
      signal?.addEventListener('abort', cancel, { once: true })
      void this.api.sendMessage(this.chat, body, { reply_markup: keyboard() }).then(({ message_id }) => {
        const card: StoredQuestion = { messageId: message_id, body: savedBody, snippet,
          askedAtMs: Date.now(), state, reported: false }
        pending.card = card
        this.track(card)
        if (state !== 'open' && state !== 'restart') void this.closeCard(card)
      }).catch(() => pending.answer())
    })
  }
}
