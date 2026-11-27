import { isUserId } from './store.js'

export interface AccessSettings {
  /** KROT_MULTIUSER=1: the access store and /users are on. Off by default. */
  enabled: boolean
  /** KROT_MEMBER_USER_IDS: members that only env can add or remove. */
  envMembers: string[]
  /** KROT_START_ID_REPLY: /start from an unknown user replies with their ID (on by default). */
  startIdReply: boolean
}

type AccessEnv = Readonly<Record<string, string | undefined>>

/**
 * Parses the multi-user env; throws on an unknown KROT_MULTIUSER value and,
 * with the flag on, on any public setting it does not understand.
 */
export function accessSettings(env: AccessEnv): AccessSettings {
  const flag = env.KROT_MULTIUSER?.trim() ?? ''
  if (flag !== '' && flag !== '0' && flag !== '1') throw new Error('KROT_MULTIUSER must be 1, 0 or unset')
  // Flag off is exactly the single-owner bridge: the public settings are neither read nor validated.
  if (flag !== '1') return { enabled: false, envMembers: [], startIdReply: true }
  const reply = env.KROT_START_ID_REPLY?.trim().toLowerCase() ?? ''
  if (reply !== '' && reply !== 'on' && reply !== 'off') throw new Error('KROT_START_ID_REPLY must be on, off or unset')
  const envMembers = (env.KROT_MEMBER_USER_IDS ?? '').split(',').map(id => id.trim()).filter(id => id !== '')
  const bad = envMembers.find(id => !isUserId(id))
  if (bad !== undefined) throw new Error('KROT_MEMBER_USER_IDS must be a comma list of numeric Telegram user IDs')
  return { enabled: true, envMembers: [...new Set(envMembers)], startIdReply: reply !== 'off' }
}

/**
 * With the flag on, TELEGRAM_ALLOWED_USER_IDS stays the single owner; extra
 * people go to KROT_MEMBER_USER_IDS or /users. With the flag off the existing
 * startup check keeps its own message.
 */
export function assertSingleOwnerEnv(allowedUserIds: readonly number[], enabled: boolean): void {
  if (enabled && allowedUserIds.length > 1) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS holds only the owner; list other people in KROT_MEMBER_USER_IDS or add them with /users add')
  }
}
