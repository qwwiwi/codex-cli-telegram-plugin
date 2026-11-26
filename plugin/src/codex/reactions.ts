// Emoji reactions in the owner's private chat.
//
//   KROT_ACK_REACTION=off    no automatic reaction on inbound owner messages (default, also when unset)
//   KROT_ACK_REACTION=eyes   the bridge puts 👀 on every inbound owner message (set explicitly only)
//   KROT_REACTION_PALETTE    comma-separated emoji the agent may react with on its own
//                            (telegram_action react); each must be a Telegram reaction.
//
// Typing and the status bubble are separate read/working signals and do not depend on these settings.

import type { TelegramApi } from '../channel/tools.js'

export type AckReaction = 'off' | 'eyes'

// Bot API ReactionTypeEmoji: the emoji a bot may set as a reaction.
// Canonical spelling as the Bot API lists it, without the U+FE0F variation selector.
export const TELEGRAM_REACTIONS: readonly string[] = [
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊',
  '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾',
  '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅',
  '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]
const telegramReactions = new Set(TELEGRAM_REACTIONS)

// The owner's default palette and the one-word meaning the agent is given for each.
const meanings: ReadonlyMap<string, string> = new Map([
  ['👍', 'согласие'], ['❤', 'тепло'], ['🔥', 'круто'], ['🎉', 'праздник'], ['😁', 'шутка'],
  ['🤔', 'задумался'], ['👏', 'браво'], ['🙏', 'спасибо'], ['💯', 'точно'], ['🤝', 'договорились'],
])
export const DEFAULT_REACTION_PALETTE: readonly string[] = [...meanings.keys()]
const paletteLimit = 10

/** Returns the Bot API spelling of a Telegram reaction emoji, or undefined when Telegram does not accept it. */
export function telegramReaction(emoji: string): string | undefined {
  const canonical = emoji.trim().replaceAll('️', '')
  return telegramReactions.has(canonical) ? canonical : undefined
}

/**
 * Parses KROT_REACTION_PALETTE. Unset means the default palette.
 *
 * Throws when the list is empty, longer than ten, repeats an emoji or names one Telegram does not accept.
 */
export function parseReactionPalette(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_REACTION_PALETTE
  const palette: string[] = []
  for (const item of value.split(',')) {
    const emoji = telegramReaction(item)
    if (!emoji) throw new Error(`KROT_REACTION_PALETTE: «${item.trim()}» is not a Telegram reaction emoji`)
    if (palette.includes(emoji)) throw new Error(`KROT_REACTION_PALETTE: «${emoji}» is listed twice`)
    palette.push(emoji)
  }
  if (palette.length > paletteLimit) throw new Error(`KROT_REACTION_PALETTE: at most ${paletteLimit} emoji`)
  return palette
}

// Hints the agent gets back when telegram_action react is refused.
export const reactionHints = {
  palette: (palette: readonly string[]): string => 'Этого эмодзи нет в палитре реакций. Выбери одно из: ' + palette.join(' ') + '.',
  ownerOnly: 'Реакцию можно ставить только на входящее сообщение владельца.',
  once: 'На этом сообщении уже стоит реакция: одна реакция на сообщение.',
} as const

/** The automatic inbound reaction mode. Unset is off, so an upgraded install drops the 👀 too; only eyes keeps it. */
export function ackReactionMode(env: { KROT_ACK_REACTION?: string | undefined }): AckReaction {
  return env.KROT_ACK_REACTION === 'eyes' ? 'eyes' : 'off'
}

/** Puts the automatic reaction on an inbound owner message; returns false without a call when it is off. */
export async function ackInbound(api: Pick<TelegramApi, 'setMessageReaction'>, chat: string, messageId: number,
  mode: AckReaction): Promise<boolean> {
  if (mode === 'off') return false
  await api.setMessageReaction(chat, messageId, '👀')
  return true
}

/** The agent's guidance for its own reactions: the palette with a meaning each, and how rarely to use it. */
export function reactionInstructions(palette: readonly string[]): string {
  const list = palette.map(emoji => meanings.has(emoji) ? `${emoji} — ${meanings.get(emoji)}` : emoji).join(', ')
  return 'Реакция на сообщение владельца: action "react", target — ID его входящего сообщения, emoji — одно из палитры: ' +
    list + '. Выбирай по смыслу диалога (шутка, хорошая новость, благодарность). Ставь редко и только когда это уместно, ' +
    'не на каждое сообщение; одна реакция на сообщение. На свои ответы реакции не ставь.'
}
