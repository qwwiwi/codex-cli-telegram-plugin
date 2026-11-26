// The status card of a parallel (side) turn: the moment a message is routed to a side turn the owner sees a small
// silent reply to it («Параллельно: слушаю голосовое…» while a voice is transcribed, then «Параллельно: думаю…»),
// edited in place with the side turn's progress (throttled, newest line wins) and deleted once the side turn has
// delivered its answer or ended. One message per side turn; Telegram errors never reach the side turn.

import type { Message } from 'grammy/types'

import type { EditOpts, SendMessageOpts } from '../channel/tools.js'
import { redactSecrets } from '../safety/redact.js'
import { object, type CodexEvent } from './rpc.js'
import { activityCall } from './work-status.js'

export const sideListening = 'Параллельно: слушаю голосовое…'
export const sideLooking = 'Параллельно: смотрю вложение…'
export const sideThinking = 'Параллельно: думаю…'
const defaultEditIntervalMs = 3_000
const lineMax = 120

export interface StatusCardApi {
  sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<{ message_id: number }>
  editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void>
  deleteMessage(chatId: string, messageId: number): Promise<void>
}

export interface SideStatusOptions {
  /** Minimum time between two edits of the card; later lines wait and the newest one wins. */
  editIntervalMs?: number
  onError?: (error: unknown, message: string) => void
}

/** The first stage the owner sees: a voice is transcribed and media is read before the side turn thinks. */
export function sideFirstStage(message: Pick<Message, 'voice' | 'audio' | 'video_note' | 'video' | 'photo' |
  'document' | 'animation' | 'sticker'>): string {
  if (message.voice || message.audio || message.video_note) return sideListening
  if (message.photo || message.document || message.video || message.animation || message.sticker) return sideLooking
  return sideThinking
}

/** A plain-text progress line for a side thread's event: the tool item that just started, redacted. */
export function sideActivityLine(event: CodexEvent, secrets: readonly string[]): string | undefined {
  if (event.method !== 'item/started') return undefined
  const call = activityCall(object(object(event.params).item), text => redactSecrets(text, secrets))
  const html = call?.humanized ?? call?.detail
  if (!html) return undefined
  const line = redactSecrets(html.replace(/<[^>]*>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&'), secrets).replace(/\s+/gu, ' ').trim()
  return line.length > lineMax ? line.slice(0, lineMax - 1) + '…' : line || undefined
}

export class SideStatusCard {
  private readonly editIntervalMs: number
  private text = ''
  private shown = ''
  private messageId: number | undefined
  private sending: Promise<void> | undefined
  private editing: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastEdit = 0
  private closed = false

  constructor(private readonly api: StatusCardApi, private readonly chat: string, private readonly replyTo: number | undefined,
    private readonly options: SideStatusOptions = {}) {
    this.editIntervalMs = options.editIntervalMs ?? defaultEditIntervalMs
  }

  /** Shows `text`: the first call sends the card, later calls edit it at most once per interval. */
  show(text: string): void {
    if (this.closed || text === this.text) return
    this.text = text
    if (!this.sending) {
      this.sending = this.send()
      return
    }
    if (this.messageId !== undefined) this.scheduleEdit()
  }

  /** Removes the card; waits for a send or an edit in flight so nothing is left behind. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.sending
    await this.editing
    if (this.messageId === undefined) return
    try { await this.api.deleteMessage(this.chat, this.messageId) } catch (error) {
      this.options.onError?.(error, 'Could not remove a parallel turn status card')
    }
  }

  private async send(): Promise<void> {
    const text = this.text
    const sendCard = (replyTo: number | undefined) => this.api.sendMessage(this.chat, text, {
      ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }), disable_notification: true,
    })
    try {
      const sent = await sendCard(this.replyTo).catch((error: unknown) => {
        // The owner deleted the message meanwhile: the card goes out without the quote.
        const description = String(object(error).description ?? (error instanceof Error ? error.message : ''))
        if (this.replyTo === undefined || !/message to be replied not found|reply message not found/iu.test(description)) throw error
        return sendCard(undefined)
      })
      this.messageId = sent.message_id
      this.shown = text
      this.lastEdit = Date.now()
      if (!this.closed && this.text !== this.shown) this.scheduleEdit()
    } catch (error) {
      this.options.onError?.(error, 'Could not send a parallel turn status card')
    }
  }

  private scheduleEdit(): void {
    if (this.timer || this.closed) return
    const delay = Math.max(0, this.lastEdit + this.editIntervalMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.startEdit()
    }, delay)
  }

  // One edit in flight at most; `this.text` is the one pending value. A line that arrives during a slow edit waits
  // for it, and only the newest one is edited in afterwards; once the card is closed nothing pending is sent.
  private startEdit(): void {
    if (this.editing || this.closed || this.messageId === undefined || this.text === this.shown) return
    const text = this.text
    const id = this.messageId
    this.lastEdit = Date.now()
    this.editing = (async () => {
      try {
        await this.api.editMessageText(this.chat, id, text, {})
        this.shown = text
      } catch (error) {
        this.options.onError?.(error, 'Could not update a parallel turn status card')
      } finally {
        this.editing = undefined
        if (!this.closed && this.text !== text) this.scheduleEdit()
      }
    })()
  }
}
