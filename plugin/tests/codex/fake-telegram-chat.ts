import type { TelegramApi } from '../../src/channel/tools.js'

// A fake Telegram chat behind the raw TelegramApi: `visible` is what the owner
// sees, in landing order. A send whose text starts with a held prefix hangs
// until `releaseAll()`, then lands (at the bottom, as Telegram would place it).
export function fakeTelegramChat() {
  const visible: Array<{ id: number; text: string }> = []
  const rawCalls: string[] = []
  const holds: string[] = []
  const held: Array<() => void> = []
  let next = 100
  const land = (text: string): number => {
    next += 1
    visible.push({ id: next, text })
    return next
  }
  const unused = (): never => { throw new Error('not used by this fake chat') }
  const raw: TelegramApi = {
    async sendMessage(_chat, text) {
      rawCalls.push(text)
      const hold = holds.findIndex(prefix => text.startsWith(prefix))
      if (hold === -1) return { message_id: land(text) }
      holds.splice(hold, 1)
      return new Promise<{ message_id: number }>(resolve => {
        held.push(() => resolve({ message_id: land(text) }))
      })
    },
    async editMessageText(_chat, id, text) {
      const message = visible.find(m => m.id === id)
      if (message === undefined) throw Object.assign(new Error('Bad Request: message to edit not found'), { error_code: 400 })
      message.text = text
    },
    async deleteMessage(_chat, id) {
      const at = visible.findIndex(m => m.id === id)
      if (at !== -1) visible.splice(at, 1)
    },
    async sendWidget(_chat, params) {
      rawCalls.push('widget: ' + params.caption)
      return { message_id: land('widget: ' + params.caption) }
    },
    sendRichMessage: unused,
    setMessageReaction: unused,
    sendChatAction: unused,
    sendDocument: unused,
    sendPhoto: unused,
    downloadFile: unused,
    answerGuestQuery: unused,
  }
  return {
    raw,
    rawCalls,
    /** An inbound message from the owner: it lands without any API call. */
    owner(text: string): void { land(text) },
    /** The owner deletes the visible message whose text starts with `prefix`. */
    ownerDeletes(prefix: string): void {
      const at = visible.findIndex(m => m.text.startsWith(prefix))
      if (at !== -1) visible.splice(at, 1)
    },
    /** The next raw send whose text starts with `prefix` hangs until releaseAll(). */
    hold(prefix: string): void { holds.push(prefix) },
    releaseAll(): void { for (const release of held.splice(0)) release() },
    texts(): string[] { return visible.map(m => m.text) },
  }
}

/** 'resolved' / 'rejected' if `p` settles within `ms`, otherwise 'pending'. */
export async function settledWithin(p: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'pending'> {
  const outcome = p.then(() => 'resolved' as const, () => 'rejected' as const)
  return Promise.race([outcome, Bun.sleep(ms).then(() => 'pending' as const)])
}
