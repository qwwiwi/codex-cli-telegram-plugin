import { appendAudit, type AuditRecord } from './audit.js'
import type { AccessButton } from './controller.js'
import { type AccessStore, type ChatMode, type ChatResult, isGroupId } from './store.js'

/** Owner group card buttons: `krot:chat:<members|open|deny>:<group id>`. */
export const CHAT_CALLBACK = /^krot:chat:(members|open|deny):(-[1-9]\d{0,19})$/u

/** A my_chat_member update: the bot's own membership in a chat changed. */
export interface ChatMemberEvent {
  chatId: number
  chatType: string
  title?: string | undefined
  /** Who changed the bot's membership (added or removed it). */
  fromId: number
  oldStatus: string
  newStatus: string
}

export interface GroupControllerOptions {
  store: AccessStore
  stateDir: string
  ownerId: string
  send: (chatId: string, text: string, keyboard?: AccessButton[][]) => Promise<void>
  leave: (chatId: string) => Promise<void>
  now?: () => number
  warn?: (message: string) => void
}

const PENDING_TTL_MS = 24 * 3_600_000
const PRESENT = new Set(['creator', 'administrator', 'member', 'restricted'])

const USAGE = [
  'Команды групп:',
  '/chats — список одобренных и ожидающих групп',
  '/chats remove <id группы> — снять одобрение и выйти из группы',
].join('\n')

const MODE_LABEL: Readonly<Record<ChatMode, string>> = {
  members: 'только люди из списка /users',
  open: 'все, незнакомые — как гости',
}

function named(title: string | undefined, id: string): string {
  return title ? '«' + title + '» (' + id + ')' : id
}

/**
 * Groups the bot is in: the owner's approval card for a new group, the bot's
 * own my_chat_member updates, `/chats`, and leaving a group nobody approved
 * within 24 hours. Nothing here forwards a message to Codex.
 */
export class GroupController {
  private readonly now: () => number

  constructor(private readonly options: GroupControllerOptions) {
    this.now = options.now ?? Date.now
  }

  async memberUpdate(event: ChatMemberEvent): Promise<void> {
    if (event.chatType === 'private') return
    const chatId = String(event.chatId)
    const joined = PRESENT.has(event.newStatus) && !PRESENT.has(event.oldStatus)
    const gone = event.newStatus === 'left' || event.newStatus === 'kicked'
    if (event.chatType === 'channel') {
      if (joined) await this.leave(chatId, String(event.fromId), 'channel')
      return
    }
    if (event.chatType !== 'group' && event.chatType !== 'supergroup') return
    if (gone) {
      const result = this.options.store.removeChat(chatId)
      if (!result.ok) {
        if (result.reason !== 'unknown') this.options.warn?.('Could not drop a group from access.json')
        return
      }
      this.audit({ event: 'chat.remove', user_id: String(event.fromId), chat_id: chatId, reason: event.newStatus })
      const what = result.was === 'approved' ? 'Доступ к группе снят.' : 'Запрос на эту группу закрыт.'
      await this.toOwner('Меня убрали из группы ' + named(result.title ?? event.title, chatId) + '. ' + what)
      return
    }
    if (!joined || this.options.store.chat(chatId)) return
    const adder = String(event.fromId)
    const role = this.options.store.roleOf(adder)
    // A stranger can add any bot to any group; no card, so strangers cannot spam the owner.
    if (role === undefined) {
      await this.leave(chatId, adder, 'unknown_adder')
      return
    }
    const result = this.options.store.addPendingChat(chatId, { title: event.title, added_by: adder })
    if (!result.ok) {
      await this.leave(chatId, adder, result.reason === 'full' ? 'pending_full' : result.reason)
      await this.toOwner('Меня добавили в группу ' + named(event.title, chatId) + ', но запрос не сохранился ('
        + result.reason + '), поэтому я вышел.')
      return
    }
    this.audit({ event: 'chat.pending', user_id: adder, role, chat_id: chatId })
    await this.toOwner([
      'Меня добавили в группу ' + named(event.title, chatId),
      'Добавил: ' + adder + ' (' + role + ')',
      'Кто сможет звать меня в этой группе? Без ответа я выйду из группы через 24 часа.',
    ].join('\n'), [[
      { text: 'Только из списка', callback_data: 'krot:chat:members:' + chatId },
      { text: 'Все (гости)', callback_data: 'krot:chat:open:' + chatId },
      { text: 'Отклонить', callback_data: 'krot:chat:deny:' + chatId },
    ]])
  }

  /** A group card button. Returns the callback answer, or undefined when the presser is not the owner. */
  async callback(data: string, fromId: number, chatId: number | undefined): Promise<string | undefined> {
    if (String(fromId) !== this.options.ownerId || String(chatId) !== this.options.ownerId) return undefined
    const match = CHAT_CALLBACK.exec(data)
    const id = match?.[2]
    if (!match || !id || !this.options.store.pendingChats().some(chat => chat.id === id)) return 'Запрос уже закрыт.'
    if (match[1] === 'deny') {
      const result = this.options.store.removeChat(id)
      if (!result.ok) return 'Не получилось сохранить: ' + result.reason
      this.audit({ event: 'chat.deny', user_id: this.options.ownerId, chat_id: id })
      await this.leaveQuietly(id)
      return 'Отклонено, выхожу из группы ' + named(result.title, id) + '.'
    }
    const mode: ChatMode = match[1] === 'open' ? 'open' : 'members'
    const result = this.options.store.approveChat(id, mode, 'owner')
    if (!result.ok) return 'Не получилось сохранить: ' + result.reason
    this.audit({ event: 'chat.approve', user_id: this.options.ownerId, chat_id: id, mode })
    return 'Группа ' + named(result.title, id) + ' одобрена: ' + MODE_LABEL[mode] + '.'
  }

  /** `/chats` in the owner's private chat (the caller checks that). */
  async ownerCommand(args: string): Promise<void> {
    const [verb = 'list', id, ...rest] = args.trim().split(/\s+/u).filter(word => word !== '')
    if (verb.toLowerCase() === 'list' && id === undefined) return this.toOwner(this.renderList())
    if (verb.toLowerCase() !== 'remove' || id === undefined || rest.length > 0 || !isGroupId(id)) return this.toOwner(USAGE)
    const result: ChatResult = this.options.store.removeChat(id)
    if (!result.ok) {
      return this.toOwner(result.reason === 'unknown' ? 'Такой группы нет в списке.' : 'Не получилось сохранить: ' + result.reason)
    }
    this.audit({ event: 'chat.remove', user_id: this.options.ownerId, chat_id: id, reason: 'owner' })
    await this.leaveQuietly(id)
    await this.toOwner('Группа ' + named(result.title, id) + ' убрана, я из неё вышел.')
  }

  /** Leaves every group still pending after 24 hours. */
  async sweep(): Promise<void> {
    const now = this.now()
    for (const chat of this.options.store.pendingChats()) {
      if (now - Date.parse(chat.added_at) < PENDING_TTL_MS) continue
      const result = this.options.store.removeChat(chat.id)
      if (!result.ok) {
        this.options.warn?.('Could not drop an expired group request')
        continue
      }
      await this.leave(chat.id, chat.added_by, 'not_approved')
    }
  }

  /** A group became a supergroup: its approval moves to the new ID. */
  async migrate(fromChatId: number, toChatId: number): Promise<void> {
    const result = this.options.store.migrateChat(String(fromChatId), String(toChatId))
    if (!result.ok) {
      if (result.reason !== 'unknown') this.options.warn?.('Could not move a group approval to its new ID')
      return
    }
    this.audit({ event: 'chat.migrate', user_id: this.options.ownerId, chat_id: String(toChatId), reason: String(fromChatId) })
  }

  private renderList(): string {
    const approved = this.options.store.chats().map(chat =>
      chat.id + ' — ' + chat.mode + (chat.title ? ' — ' + chat.title : ''))
    const pending = this.options.store.pendingChats().map(chat =>
      chat.id + ' — ждёт ответа' + (chat.title ? ' — ' + chat.title : '') + ' (добавил ' + chat.added_by + ')')
    if (approved.length === 0 && pending.length === 0) return 'Групп пока нет. Добавь меня в группу, и я пришлю карточку.'
    return ['Группы: ' + approved.length + (pending.length ? ' · ждут ответа: ' + pending.length : ''),
      ...approved, ...pending].join('\n')
  }

  private async leave(chatId: string, userId: string, reason: string): Promise<void> {
    this.audit({ event: 'chat.leave', user_id: userId, chat_id: chatId, reason })
    await this.leaveQuietly(chatId)
  }

  private async leaveQuietly(chatId: string): Promise<void> {
    // The bot may already be gone; nothing else depends on this call.
    await this.options.leave(chatId).catch(() => this.options.warn?.('Could not leave a group'))
  }

  private audit(record: AuditRecord): void {
    if (!appendAudit(this.options.stateDir, record, this.now())) this.options.warn?.('Could not write the access audit line')
  }

  private toOwner(text: string, keyboard?: AccessButton[][]): Promise<void> {
    return this.options.send(this.options.ownerId, text, keyboard)
  }
}
