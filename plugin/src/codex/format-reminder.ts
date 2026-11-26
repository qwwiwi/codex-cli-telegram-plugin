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

/** Builds an owner turn: the static channel rules first, then the turn's own parts. */
export function ownerTurn(reminder: boolean, parts: readonly string[]): string {
  return [attachmentInstructions, ...(reminder ? [formatReminder] : []), ...parts].join('\n\n')
}
