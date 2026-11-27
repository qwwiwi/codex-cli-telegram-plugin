// S0 phone spike of the secret hand-over design (docs/design/secret-handover-spike.md).
//
// Hidden owner-only `/keytest`: sends a one-time reply-keyboard web_app button that opens the test
// page with rid/pk/exp in the query string. The page answers with `sendData` of a fixed 3968-byte
// test string (fake, no key). The sealed `web_app_data` comes back through the poller's onHandover;
// this module records only the length, whether the bytes match the expected string, and the
// client platform encoded in it, deletes the service message and removes the keyboard.
// Off unless KROT_KEYSPIKE_URL is set. The payload is never logged or passed anywhere.
import { createHash, randomBytes, webcrypto } from 'node:crypto'

import type { Logger } from '../log.js'
import type { WebAppHandover } from '../telegram/handover-seal.js'

/** Exact UTF-8 length of every hand-over envelope in the design (section 6.3). */
export const KEYSPIKE_LENGTH = 3968
const REQUEST_TTL_SEC = 600
// Telegram.WebApp.platform values the page may report; anything else is sent as "unknown".
const PLATFORMS = ['android', 'android_x', 'ios', 'macos', 'tdesktop', 'weba', 'webk', 'web', 'unigram', 'unknown'] as const
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** The fixed test payload for one platform. miniapp/keyspike/app.js builds the same string. */
export function keyspikeTestString(platform: string): string {
  let out = 'ks0.' + platform + '.'
  for (let i = 0; out.length < KEYSPIKE_LENGTH; i++) out += ALPHABET[(i * 7 + 3) % ALPHABET.length]
  return out
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const EXPECTED: ReadonlyArray<{ platform: string, digest: string }> =
  PLATFORMS.map(platform => ({ platform, digest: sha256(keyspikeTestString(platform)) }))

/** KROT_KEYSPIKE_URL: unset or empty turns the spike off; anything but an https URL is a config error. */
export function keyspikeUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('KROT_KEYSPIKE_URL must be an https URL')
  }
  if (url.protocol !== 'https:') throw new Error('KROT_KEYSPIKE_URL must be an https URL')
  return url.toString()
}

export interface KeySpikeKeyboard {
  keyboard: Array<Array<{ text: string, web_app: { url: string } }>>
  one_time_keyboard: true
  resize_keyboard: true
}

export interface KeySpikeRemoveKeyboard {
  remove_keyboard: true
}

export interface KeySpikeApi {
  sendMessage(chatId: string, text: string, markup: KeySpikeKeyboard | KeySpikeRemoveKeyboard): Promise<{ message_id: number }>
  deleteMessage(chatId: string, messageId: number): Promise<void>
}

export interface KeySpikeMessage {
  chat: { id: number, type: string }
  from?: { id: number, is_bot: boolean }
  text?: string
}

export interface KeySpikeOptions {
  url: string
  ownerId: number
  api: KeySpikeApi
  log: Logger
  now?: () => number
}

export class KeySpike {
  private readonly options: KeySpikeOptions

  constructor(options: KeySpikeOptions) {
    this.options = options
  }

  /** Handles `/keytest` from the owner in the private chat. Returns true when the message was consumed. */
  async command(message: KeySpikeMessage): Promise<boolean> {
    const { ownerId, api, log } = this.options
    if (message.chat.type !== 'private' || message.chat.id !== ownerId) return false
    if (!message.from || message.from.is_bot || message.from.id !== ownerId) return false
    if (!/^\/keytest(?:@\w+)?$/u.test((message.text ?? '').trim())) return false
    try {
      const url = await this.buttonUrl()
      await api.sendMessage(String(ownerId),
        'Тест передачи ключа (только фейковые данные). Нажми кнопку ниже: откроется тестовая страница. Кнопка действует 10 минут.',
        { keyboard: [[{ text: 'Открыть тест ключа', web_app: { url } }]], one_time_keyboard: true, resize_keyboard: true })
      log.info('keyspike button sent')
    } catch {
      log.warn('keyspike button could not be sent')
    }
    return true
  }

  /** Consumes one sealed web_app_data submission. Never throws and never logs the payload. */
  async handover(handover: WebAppHandover): Promise<void> {
    const { ownerId, api, log } = this.options
    const { update_id: updateId, message_id: messageId } = handover
    try {
      if (handover.chat_type !== 'private' || handover.chat_id !== ownerId
          || handover.from_is_bot !== false || handover.from_id !== ownerId) {
        log.info('keyspike hand-over dropped', { update_id: updateId, reason: 'not_owner' })
        return
      }
      const chat = String(ownerId)
      const length = Buffer.byteLength(handover.data, 'utf8')
      const digest = length === KEYSPIKE_LENGTH ? sha256(handover.data) : ''
      const platform = EXPECTED.find(expected => expected.digest === digest)?.platform
      const match = platform !== undefined
      let deleted = false
      if (messageId !== undefined) {
        try {
          await api.deleteMessage(chat, messageId)
          deleted = true
        } catch { /* reported below as deleted: false */ }
      }
      let acked = false
      try {
        await api.sendMessage(chat, 'Тест ключа: получено ' + length + ' байт, ' + (match ? 'совпадает' : 'не совпадает')
          + ' с эталоном, платформа: ' + (platform ?? 'не определена') + '. Служебное сообщение '
          + (deleted ? 'удалено.' : 'удалить не удалось.'), { remove_keyboard: true })
        acked = true
      } catch { /* reported below as acked: false */ }
      log.info('keyspike hand-over', {
        update_id: updateId, message_id: messageId, length, match, platform: platform ?? 'none', deleted, acked,
      })
    } catch {
      log.warn('keyspike hand-over failed', { update_id: updateId, message_id: messageId })
    }
  }

  private async buttonUrl(): Promise<string> {
    const now = this.options.now ?? Date.now
    // A fresh P-256 public key, as the vault's request would carry. The spike never decrypts,
    // so the private key is dropped right away.
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const pk = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
    const url = new URL(this.options.url)
    url.searchParams.set('rid', randomBytes(16).toString('base64url'))
    url.searchParams.set('pk', pk)
    url.searchParams.set('exp', String(Math.floor(now() / 1000) + REQUEST_TTL_SEC))
    return url.toString()
  }
}
