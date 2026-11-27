import { attachmentInstructions } from './attachments.js'

// Short per-turn Telegram format reminder (KROT_FORMAT_REMINDER, default on), in the owner's language
// like every other service rule of this bridge. Static text: every owner turn carries the same bytes
// right after the static attachment rule, so the turn starts with a fixed prefix and the already
// cached thread history before it is never touched.
export const formatReminder =
  'Формат ответа в Telegram: заголовок на отдельной строке, до и после него пустая строка. ' +
  'Абзацы по 1–3 предложения, не длиннее 450 знаков, между абзацами пустая строка. ' +
  'Каждый пункт списка на своей строке. Жирным выделяй только ключевые числа и итоговую строку.'

/** Reads KROT_FORMAT_REMINDER: unset, empty or "on" enables the reminder, "off" disables it. */
export function formatReminderEnabled(value: string | undefined): boolean {
  const mode = (value ?? '').trim().toLowerCase()
  if (mode === '' || mode === 'on') return true
  if (mode === 'off') return false
  throw new Error('KROT_FORMAT_REMINDER must be on or off')
}

/**
 * The stable prefix every owner turn starts with: the attachment rule (owner turns only), the format reminder and
 * the bridge's static channel rules (`rules`: the chat-action and reaction rules, fixed per process). It never
 * carries state, times, counters or IDs, so it is byte-identical from turn to turn and the prompt-cache prefix
 * never breaks inside it; mandates, message IDs and the running task come after it.
 */
export function stableTurnPrefix(reminder: boolean, rules: string, kind: 'owner' | 'side' = 'owner'): string {
  return [...(kind === 'owner' ? [attachmentInstructions] : []), ...(reminder ? [formatReminder] : []), rules]
    .filter(Boolean).join('\n\n')
}

/** Builds an owner turn: the stable prefix first, then the turn's own parts. */
export function ownerTurn(reminder: boolean, parts: readonly string[], rules = ''): string {
  return [stableTurnPrefix(reminder, rules), ...parts].join('\n\n')
}

/** The main-thread turn that carries the owner's answers from a question card: an owner turn too. */
export function questionFollowUpTurn(reminder: boolean, instructions: string, answers: unknown): string {
  return ownerTurn(reminder, [instructions, 'Ответы владельца на твой вопрос из карточки Telegram:\n' + JSON.stringify(answers)]
    .filter(Boolean))
}

/** A parallel (side) owner turn. Its reply is delivered without files, so it carries no attachment rule. */
export function sideOwnerTurn(reminder: boolean, parts: readonly string[], rules = ''): string {
  return [stableTurnPrefix(reminder, rules, 'side'), ...parts].filter(Boolean).join('\n\n')
}
