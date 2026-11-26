// The notice a queued owner message hears («В очереди: возьму после …»): a silent reply to it, sent once the HUD
// card landed (see hud-anchor.ts) and only if the message still waits in the queue by then. When the main turn picks
// the message up, a notice still waiting in the chat's send queue is cancelled (it never reaches Telegram and spends
// no send slot); one already on the wire is deleted once it lands, so no stale «В очереди» stays.

export interface QueueNoticeDeps {
  /** Resolves once replies may go out (the HUD card of the latest owner message landed). Never rejects. */
  settled(): Promise<void>
  /** Whether the message still waits in the queue. */
  isQueued(messageId: number): boolean
  /**
   * Sends `text` as a silent reply to the message. `signal` aborts on pickup: the rate limiter then drops a send that
   * is still queued (it rejects) and returns the late result of one already on the wire.
   */
  send(text: string, replyTo: number, signal: AbortSignal): Promise<{ message_id: number }>
  /** Deletes a notice message. */
  remove(noticeId: number): Promise<void>
  onError?(error: unknown, message: string): void
}

interface Notice {
  cancel: AbortController
  // The notice's message id (undefined when the send failed or was cancelled before it left).
  id: Promise<number | undefined>
}

export class QueueNotices {
  // Queued message id -> its notice in flight or sent.
  private readonly notices = new Map<number, Notice>()

  constructor(private readonly deps: QueueNoticeDeps) {}

  /** Sends the notice for a queued message unless it was taken during the wait; a send error rejects, a pickup does not. */
  async notify(messageId: number, text: string): Promise<void> {
    await this.deps.settled()
    if (!this.deps.isQueued(messageId)) return
    const cancel = new AbortController()
    const sending = this.deps.send(text, messageId, cancel.signal)
    this.notices.set(messageId, { cancel, id: sending.then(sent => sent.message_id, () => undefined) })
    try { await sending } catch (error) {
      // Cancelled by the pickup: the message no longer waits, so no notice is the right outcome.
      if (!cancel.signal.aborted) throw error
    }
  }

  /** The main turn took the message: its notice is cancelled if still queued, deleted if sent. Never rejects. */
  async pickedUp(messageId: number): Promise<void> {
    const notice = this.notices.get(messageId)
    if (!notice) return
    this.notices.delete(messageId)
    notice.cancel.abort()
    const id = await notice.id
    if (id === undefined) return
    try { await this.deps.remove(id) } catch (error) {
      this.deps.onError?.(error, 'Could not remove a queue notice')
    }
  }
}
