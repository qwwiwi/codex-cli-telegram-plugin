import { randomUUID } from 'node:crypto'
import type { Message } from 'grammy/types'

const continuationMarker = /(?:^|\r?\n)KROT_CONTINUE_[a-f0-9-]{36}\s*$/u
export type ContinuationContext = { marker: string; objective: string; statusQuestion?: string }

export const followUpInstructions = 'Новая реплика владельца из Telegram во время текущей задачи. ' +
  'Если он задаёт вопрос или просит статус, ответь сразу отдельной публичной репликой «Ответ в чате: …» ' +
  'и продолжай текущую задачу с того же места. Уточнения и изменения задачи примени по смыслу. ' +
  'Отдельное действие, не относящееся к текущей задаче, выполни после её завершения.'

export function normalizeChatReply(text: string): string {
  return text.replace(/^\s*(?:Ответ\s+в\s+чате\s*:|\*\*Ответ\s+в\s+чате(?:\s*:\*\*|\*\*\s*:))\s*/iu, '')
}

export function automaticContinuation(ownerText: string, statusQuestion?: string) {
  const marker = 'KROT_CONTINUE_' + randomUUID()
  const objective = Array.from(ownerText).length <= 4000 ? ownerText :
    'Доведи до проверенного результата исходную задачу, сформулированную владельцем в предыдущем ходе этого диалога.'
  return {
    objective,
    context: { marker, objective, ...(statusQuestion ? { statusQuestion } : {}) },
    instructions: 'Заканчивай ход итогом, когда задача готова, или явно сообщи о реальном блокере. ' +
      'Если для уже принятой задачи объективно нужен следующий ход Codex и ты можешь продолжать сам, ' +
      'кратко напиши о прогрессе и поставь отдельной последней строкой ' + marker +
      '. Это запустит продолжение в том же диалоге. Используй эту строку только как команду продолжить.',
    take(text: string): string | undefined {
      return takeContinuation(text, { marker, objective })
    },
  }
}

export function takeContinuation(text: string, context: ContinuationContext): string | undefined {
  const match = continuationMarker.exec(text)
  if (!match || match[0].trim() !== context.marker) return undefined
  return text.slice(0, match.index).trimEnd()
}

export function hideContinuationMarker(text: string): string {
  return text.replace(continuationMarker, '')
}

const actionRequest = /(?:^|[^а-яё])(не[\t ]+)?(?:проверь|проверяй|настрой|подключи|поставь|установи|сделай|поправь|исправь|доделай|доделывай|продолжи|продолжай|выполни|выполняй|доведи|перенеси|найди|включи|переключи|обнови|перезапусти|перезапускай|сверь|сверяй|разверни|замени|заменяй|убери|убирай|удали|удаляй|запусти|запускай)(?![а-яё])|\b((?:do not|don't)[\t ]+)?(?:check|configure|install|fix|finish|continue|deploy|enable|update|verify|restart|replace|start)\b/giu
const statusRequest = /(?:что\s+(?:у нас|там|с\s)|как\s+(?:там|ид[её]т|продвигается)|вс[её]\s+готово|какой\s+статус|на\s+каком\s+этапе|что\s+осталось|сколько\s+осталось|what(?:'s| is) (?:the status|left)|how(?:'s| is) (?:it|the work) going)/iu
const statusOnly = /(?:ничего\s+не\s+(?:меняй|делай|запускай)|пока\s+не\s+(?:меняй|запускай|продолжай)|(?:только|просто)\s+(?:скажи|ответь|сообщи|объясни)|\b(?:only|just)\s+(?:tell|explain|answer)\b)/iu
const howTo = /^(?:(?:подскажи|скажи|объясни|расскажи)[, ]+)?как\s|^(?:tell me )?how\s/iu
const repairQuestion = /^\s*(?:а\s+)?почему\s+(?:ты\s+)?не\s+(?:проверил|сделал|продолжил|закончил)(?![а-яё])/iu
const externalBlocker = /(?:доступ запрещ[её]н|доступа нет|нет доступа|не хватает прав|нужен доступ)/iu
const declined = /(?:карточк[аеи]|запрос)\s+(?:отклон[её]н|запрещ[её]н)|(?:approval|request)\s+(?:(?:was|is)\s+)?(?:denied|declined)/iu
const ownerStep = /(?:нужен (?:твой|ваш) вход|чтобы продолжить,\s*(?:введи|войди|открой|нажми)|без (?:твоего|вашего) (?:решения|доступа|входа)|пользователь отменил|нужен\s+(?:один\s+)?запуск\s+из\s+административной\s+сессии|waiting for (?:your approval|you to (?:sign in|log in)))/iu
const acknowledgedGrant = /(?:разрешени[ея]|согласие|разрешил|согласован[оа])[^.!?\n]{0,105}(?:уже (?:есть|дал|выдано|получено)|ранее)|уже (?:разрешил|согласовал)/iu
const remaining = /(?:ещ[её]\s+(?:нужно|надо|предстоит)\s+[а-яё]+ть|остал(?:ось|ся)\s+[а-яё]+ть|оста(?:[её]тся|ются|лось)\s+(?:[а-яё]+\s+){0,3}(?:шаг(?:а|ов)?|действи[ея])\s*:\s*[а-яё]+ть)(?![а-яё])|\b(?:still need to|remaining steps?:)\s+\w+/iu
const afterPrerequisite = /после\s+[^.!?\n]{2,130}\s+можно\s+будет\s+[а-яё]+ть(?![а-яё])/iu
const unfinished = /пока\s+нет|ещ[её]\s+не\s+[а-яё]+|не\s+(?:подтвержден[оаы]?|завершен[оаы]?|проверен[оаы]?|включ[её]н[оаы]?|переключ[её]н[оаы]?)|этого\s+я\s+не\s+(?:сделал|проверил)|мог\s+(?:продолжить|проверить|закончить|сделать)[^.!?\n]{0,135}\s+не\s+(?:сделал|проверил|продолжил)/iu
const optional = /если\s+(?:захочешь|понадобится|хочешь)|по\s+желанию|if (?:needed|you (?:want|prefer))/iu

export function ownerTaskWithdrawn(text: string | undefined): boolean {
  return /(?:^|[.!?]\s+)(?:пока\s+)?(?:не\s+продолжай|отмени(?:\s+(?:эту|текущую)\s+задачу)?|останови(?:сь|\s+(?:эту|текущую)\s+задачу)?|stop|cancel (?:this|the) task)(?=$|[,!.?])/iu.test(text?.trim() ?? '')
}

export function ownerExecutionTask(text: string | undefined): boolean {
  return !!text && !ownerTaskWithdrawn(text) && !statusOnly.test(text) && !howTo.test(text) &&
    Array.from(text.matchAll(actionRequest)).some(match => !match[1] && !match[2])
}

export function ownerStatusCheck(text: string | undefined): boolean {
  return !!text && statusRequest.test(text) && !statusOnly.test(text) && !ownerExecutionTask(text)
}

export function ownerTaskContinuationInput(text: string | undefined): boolean {
  return !!text && !ownerTaskWithdrawn(text) && !statusOnly.test(text) && !howTo.test(text) &&
    !ownerStatusCheck(text) && (ownerExecutionTask(text) || repairQuestion.test(text) ||
      !text.trimEnd().endsWith('?') && !Array.from(text.matchAll(actionRequest)).some(match => match[1] || match[2]))
}

export function directOwnerTask(message: Message, transcript?: string, editing = false): string | undefined {
  if (editing || message.forward_origin) return
  return (message.text ?? message.caption ?? (message.voice ? transcript : undefined))?.trim() || undefined
}

export function ownerTaskBlocked(text: string): boolean {
  return externalBlocker.test(text) || declined.test(text) || ownerStep.test(text)
}

export function unfinishedOwnerTask(objective: string | undefined, report: string, openPlan = false, redundantAsk = false): boolean {
  if (!objective || !report.trim() || ownerTaskWithdrawn(objective) || statusOnly.test(objective) ||
      ownerStep.test(report) || declined.test(report)) return false
  const action = ownerExecutionTask(objective)
  if ((action || repairQuestion.test(objective)) && acknowledgedGrant.test(report) && unfinished.test(report)) return true
  if (externalBlocker.test(report)) return false
  const steps = report.split(/[.!?\n]/u).filter(sentence => !optional.test(sentence))
  return action && (openPlan || redundantAsk || steps.some(sentence =>
    remaining.test(sentence) || (unfinished.test(report) && afterPrerequisite.test(sentence))))
}

export function publicProgress(commentary: string): { milestone: boolean; text: string } | undefined {
  const match = /^\s*((?:✅\s*)?Веха|Ответ в чате):\s*([\s\S]+)$/iu.exec(commentary)
  const text = match?.[2]?.trim()
  if (!text) return
  return { milestone: !/^Ответ в чате$/iu.test(match![1]!),
    text: text.replace(/^([*_~#>\s-]*)(\p{Ll})/u, (_, prefix, letter) => prefix + letter.toLocaleUpperCase('ru')) }
}
