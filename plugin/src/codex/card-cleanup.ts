import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteInRoot } from '../autonomy/store.js'
import type { TelegramApi } from '../channel/tools.js'
import type { Logger } from '../log.js'
import { object } from './rpc.js'

type CardKind = 'approval' | 'question'
const filename = 'codex-pending-cards.json'

export class CardCleanup {
  private readonly pending = new Map<number, CardKind>()

  constructor(private readonly root: string, private readonly ownerChat: string, private readonly log: Logger) {
    try {
      const { chat, entries } = object(JSON.parse(readFileSync(join(root, filename), 'utf8')))
      if (chat !== ownerChat || !Array.isArray(entries)) return
      for (const pair of entries.slice(-100)) {
        if (Array.isArray(pair) && Number.isSafeInteger(pair[0]) && pair[0] > 0 &&
            (pair[1] === 'approval' || pair[1] === 'question')) this.pending.set(pair[0], pair[1])
      }
    } catch { /* Older installs have no pending-card file. */ }
  }

  remember(id: number, kind: CardKind): void {
    this.pending.set(id, kind)
    if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!)
    this.save()
  }

  forget(id: number): void {
    if (this.pending.delete(id)) this.save()
  }

  async recover(api: Pick<TelegramApi, 'editMessageText'>): Promise<void> {
    for (const [id, kind] of [...this.pending]) {
      try {
        await api.editMessageText(this.ownerChat, id, kind === 'approval'
          ? '🔐 Запрос подтверждения\n\nМост перезапущен, запрос закрыт.'
          : '❔ Вопрос закрыт после перезапуска моста. При необходимости отправь уточнение ещё раз.',
        { reply_markup: { inline_keyboard: [] } })
        this.forget(id)
      } catch (error) {
        if (typeof error === 'object' && error && 'description' in error &&
            /message to edit not found|message is not modified/i.test(String(error.description))) this.forget(id)
        else this.log.warn('Could not close a pre-restart Telegram card')
      }
    }
  }

  private save(): void {
    try { atomicWriteInRoot({ root: this.root }, filename,
      JSON.stringify({ chat: this.ownerChat, entries: [...this.pending] }) + '\n') }
    catch { this.log.warn('Could not persist pending Telegram card IDs') }
  }
}
