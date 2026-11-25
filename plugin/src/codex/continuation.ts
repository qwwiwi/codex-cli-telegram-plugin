import { randomUUID } from 'node:crypto'

const continuationMarker = /(?:^|\r?\n)KROT_CONTINUE_[a-f0-9-]{36}\s*$/u
export type ContinuationContext = { marker: string; objective: string }

export const followUpInstructions = 'Новая реплика владельца из Telegram во время текущей задачи. ' +
  'Если он задаёт вопрос или просит статус, ответь сразу отдельной публичной репликой «Ответ в чате: …» ' +
  'и продолжай текущую задачу с того же места. Уточнения и изменения задачи примени по смыслу. ' +
  'Отдельное действие, не относящееся к текущей задаче, выполни после её завершения.'

export function automaticContinuation(ownerText: string) {
  const marker = 'KROT_CONTINUE_' + randomUUID()
  const objective = Array.from(ownerText).length <= 4000 ? ownerText :
    'Доведи до проверенного результата исходную задачу, сформулированную владельцем в предыдущем ходе этого диалога.'
  return {
    objective,
    context: { marker, objective },
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
