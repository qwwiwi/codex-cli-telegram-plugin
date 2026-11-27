import { randomBytes } from 'node:crypto'

import { parseCodexCommand } from '../codex/commands.js'
import { appendAudit, type AuditRecord } from './audit.js'
import {
  type AccessRefusal, type AccessStore, cleanNote, STORED_ROLES, type StoredRole,
} from './store.js'

export interface AccessButton { text: string; callback_data: string }

/** Owner confirm card buttons: `krot:access:<ok|no>:<request token>`. */
export const ACCESS_CALLBACK = /^krot:access:(ok|no):([0-9a-f]{16})$/u

/** An inbound Telegram message from anyone but the owner. */
export interface InboundIdentity {
  chatId: number
  chatType: string
  fromId: number
  isBot: boolean
  text: string | undefined
  firstName?: string | undefined
  username?: string | undefined
  forwarded: boolean
}

export interface AccessControllerOptions {
  store: AccessStore
  stateDir: string
  ownerId: string
  botUsername: () => string
  /** KROT_START_ID_REPLY: an unknown user's /start gets their ID back. */
  startIdReply: boolean
  send: (chatId: string, text: string, keyboard?: AccessButton[][]) => Promise<void>
  now?: () => number
  warn?: (message: string) => void
}

const DAY_MS = 24 * 3_600_000
const HOUR_MS = 3_600_000
const BAD_CODE_LIMIT = 5
const PAGE_SIZE = 50
// Bounds the in-memory maps that strangers can grow.
const TRACK_CAP = 10_000
const PENDING_CAP = 100

const USAGE = [
  'Команды доступа:',
  '/users list [страница] — список',
  '/users add <id> [member|guest] [заметка] — добавить',
  '/users remove <id> — убрать',
  '/users role <id> <member|guest> — сменить роль',
  '/users invite [member|guest] — одноразовый код на 10 минут',
].join('\n')

const REFUSALS: Readonly<Record<AccessRefusal, string>> = {
  bad_id: 'Нужен числовой Telegram ID (человек узнаёт его, отправив боту /start).',
  owner: 'Это владелец: его роль owner задана в TELEGRAM_ALLOWED_USER_IDS и в чате не меняется.',
  env: 'Этот ID задан в KROT_MEMBER_USER_IDS: менять его можно только там.',
  exists: 'Этот ID уже в списке. Сменить роль: /users role <id> <member|guest>.',
  unknown: 'Такого ID нет в списке.',
  degraded: 'Файл access.json не читается, поэтому доступ сейчас только у владельца. Исправь или убери файл.',
  write_failed: 'Не удалось записать access.json; ничего не изменилось.',
}

interface PendingRequest { userId: string; role: StoredRole; name: string | undefined; expiresAt: number }
interface Failures { count: number; since: number; mutedUntil: number }

function parseRole(value: string | undefined): StoredRole | 'owner' | undefined {
  const role = value?.toLowerCase()
  if (role === 'owner') return 'owner'
  return STORED_ROLES.find(item => item === role)
}

/**
 * Owner-side `/users` and `/start`, plus the `/start` of anyone else. Nothing
 * here forwards a message to Codex: the bridge gate stays owner-only.
 */
export class AccessController {
  private readonly now: () => number
  private readonly startReplies = new Map<string, number>()
  private readonly failures = new Map<string, Failures>()
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly options: AccessControllerOptions) {
    this.now = options.now ?? Date.now
  }

  /** Commands typed in the owner's private chat (the caller checks that). */
  async ownerCommand(name: 'users' | 'start', args: string): Promise<void> {
    if (name === 'start') {
      await this.toOwner('Твой Telegram ID: ' + this.options.ownerId + ' (владелец).')
      return
    }
    const [verb = 'list', ...rest] = args.trim().split(/\s+/u).filter(word => word !== '')
    switch (verb.toLowerCase()) {
      case 'list': return this.toOwner(this.renderList(rest[0]))
      case 'add': return this.add(rest[0], rest[1], rest.slice(2).join(' '))
      case 'remove': return this.remove(rest[0])
      case 'role': return this.setRole(rest[0], rest[1])
      case 'invite': return this.invite(rest[0])
      default:
        if (/^\d+$/u.test(verb) && rest.length === 0) return this.toOwner(this.renderList(verb))
        return this.toOwner(USAGE)
    }
  }

  /** A message from anyone but the owner. Only a private, typed /start is answered. */
  async inbound(message: InboundIdentity): Promise<void> {
    if (message.isBot || message.forwarded || message.chatType !== 'private' || message.chatId !== message.fromId) return
    const command = parseCodexCommand(message.text?.trim(), this.options.botUsername())
    if (!command || command.name !== 'start') return
    const userId = String(message.fromId)
    if (this.muted(userId)) return
    const code = command.args.split(/\s+/u)[0] ?? ''
    const role = this.options.store.roleOf(userId)
    if (code === '' || role !== undefined) {
      await this.replyId(userId, role)
      return
    }
    const granted = this.options.store.redeemInvite(code)
    if (!granted) {
      await this.badCode(userId)
      return
    }
    const name = cleanNote([message.firstName, message.username ? '@' + message.username : undefined]
      .filter(Boolean).join(' '))
    const token = this.addPending({ userId, role: granted, name, expiresAt: this.now() + DAY_MS })
    this.audit({ event: 'pairing.redeem', user_id: userId, role: granted })
    await this.toOwner([
      'Запрос доступа по коду приглашения',
      'ID: ' + userId,
      'Имя: ' + (name ?? 'не указано'),
      'Роль: ' + granted,
      'Проверь, что это тот человек, которому ты отправил код.',
    ].join('\n'), [[
      { text: 'Добавить', callback_data: 'krot:access:ok:' + token },
      { text: 'Отклонить', callback_data: 'krot:access:no:' + token },
    ]])
    await this.options.send(userId, 'Код принят. Доступ появится, когда владелец бота подтвердит запрос.')
  }

  /** A confirm-card button. Returns the callback answer, or undefined when the presser is not the owner. */
  async callback(data: string, fromId: number, chatId: number | undefined): Promise<string | undefined> {
    if (String(fromId) !== this.options.ownerId || String(chatId) !== this.options.ownerId) return undefined
    const match = ACCESS_CALLBACK.exec(data)
    const request = match ? this.pending.get(match[2]!) : undefined
    if (!match || !request || request.expiresAt <= this.now()) return 'Запрос уже закрыт.'
    this.pending.delete(match[2]!)
    if (match[1] === 'no') {
      this.audit({ event: 'pairing.deny', user_id: request.userId, role: request.role })
      return 'Запрос ' + request.userId + ' отклонён.'
    }
    const result = this.options.store.add(request.userId, request.role, 'pairing', request.name)
    if (!result.ok) return REFUSALS[result.reason]
    this.audit({ event: 'pairing.confirm', user_id: request.userId, role: request.role })
    this.audit({ event: 'access.change', user_id: request.userId, role: request.role, reason: 'add', by: 'pairing' })
    await this.options.send(request.userId,
      'Владелец подтвердил доступ. Роль: ' + request.role + '. Твой Telegram ID: ' + request.userId + '.')
    return 'Добавлен ' + request.userId + ' (' + request.role + ').'
  }

  private async add(id: string | undefined, roleText: string | undefined, note: string): Promise<void> {
    if (!id) return this.toOwner(USAGE)
    const role = roleText === undefined ? 'member' : parseRole(roleText)
    // Without a known role word the rest is a note: /users add <id> <note>.
    const stored = role ?? 'member'
    const fullNote = role === undefined ? [roleText, note].filter(Boolean).join(' ') : note
    if (stored === 'owner') return this.toOwner(REFUSALS.owner)
    const result = this.options.store.add(id, stored, 'chat', fullNote)
    if (!result.ok) return this.toOwner(REFUSALS[result.reason])
    const audited = this.audit({ event: 'access.change', user_id: id, role: stored, reason: 'add', by: 'owner' })
    await this.toOwner('Добавлен ' + id + ' с ролью ' + stored + '.' + this.auditNote(audited))
  }

  private async remove(id: string | undefined): Promise<void> {
    if (!id) return this.toOwner(USAGE)
    const result = this.options.store.remove(id)
    if (!result.ok) return this.toOwner(REFUSALS[result.reason])
    const audited = this.audit({
      event: 'access.change', user_id: id, ...(result.previous ? { role: result.previous } : {}), reason: 'remove', by: 'owner',
    })
    await this.toOwner('Убран ' + id + '.' + this.auditNote(audited))
  }

  private async setRole(id: string | undefined, roleText: string | undefined): Promise<void> {
    const role = parseRole(roleText)
    if (!id || !role) return this.toOwner(USAGE)
    if (role === 'owner') return this.toOwner(REFUSALS.owner)
    const result = this.options.store.setRole(id, role)
    if (!result.ok) return this.toOwner(REFUSALS[result.reason])
    const audited = this.audit({
      event: 'access.change', user_id: id, role, reason: 'role', by: 'owner',
      ...(result.previous ? { previous_role: result.previous } : {}),
    })
    await this.toOwner('Роль ' + id + ': ' + role + '.' + this.auditNote(audited))
  }

  private async invite(roleText: string | undefined): Promise<void> {
    const role = roleText === undefined ? 'member' : parseRole(roleText)
    if (!role) return this.toOwner(USAGE)
    if (role === 'owner') return this.toOwner(REFUSALS.owner)
    let code: string
    try {
      code = this.options.store.createInvite(role)
    } catch {
      return this.toOwner(this.options.store.degraded ? REFUSALS.degraded : REFUSALS.write_failed)
    }
    this.audit({ event: 'pairing.invite', user_id: this.options.ownerId, role })
    const link = 'https://t.me/' + this.options.botUsername() + '?start=' + code
    await this.toOwner([
      'Код приглашения (роль ' + role + ', одноразовый, 10 минут): ' + code,
      'Ссылка: ' + link,
      'Человек открывает ссылку или отправляет боту /start ' + code + '. Доступ появится только после твоего подтверждения.',
    ].join('\n'))
  }

  private renderList(pageText: string | undefined): string {
    const entries = this.options.store.list()
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
    const page = Math.min(pages, Math.max(1, Number.parseInt(pageText ?? '1', 10) || 1))
    const lines = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(entry =>
      entry.id + ' — ' + entry.role + (entry.source === 'env' ? ' (env)' : '') + (entry.note ? ' — ' + entry.note : ''))
    const header = 'Доступ: ' + entries.length + (pages > 1 ? ' · страница ' + page + ' из ' + pages : '')
    const warning = this.options.store.degraded ? '\n' + REFUSALS.degraded : ''
    return [header + warning, ...lines].join('\n')
  }

  private async replyId(userId: string, role: StoredRole | 'owner' | undefined): Promise<void> {
    if (role === undefined && !this.options.startIdReply) return
    const now = this.now()
    const last = this.startReplies.get(userId)
    if (last !== undefined && now - last < DAY_MS) return
    if (!this.track(this.startReplies, userId, now, at => now - at >= DAY_MS)) return
    await this.options.send(userId, role === undefined
      ? 'Твой Telegram ID: ' + userId + '. Передай его владельцу бота, чтобы получить доступ.'
      : 'Твой Telegram ID: ' + userId + '. Роль: ' + role + '.')
  }

  private async badCode(userId: string): Promise<void> {
    const now = this.now()
    // Bad codes count within one hour from the first; an expired mute is already gone (see muted()).
    const current = this.failures.get(userId)
    const fresh = !current || now - current.since >= HOUR_MS
    const count = (fresh ? 0 : current.count) + 1
    const since = fresh ? now : current.since
    const mutedUntil = count >= BAD_CODE_LIMIT ? now + HOUR_MS : 0
    if (!this.track(this.failures, userId, { count, since, mutedUntil },
      item => item.mutedUntil <= now && now - item.since >= HOUR_MS)) return
    this.audit({ event: 'pairing.bad_code', user_id: userId })
    if (mutedUntil) {
      this.audit({ event: 'pairing.lockout', user_id: userId, reason: 'bad_codes' })
      return
    }
    await this.options.send(userId, 'Код не подошёл или истёк. Попроси у владельца новый.')
  }

  private muted(userId: string): boolean {
    const failures = this.failures.get(userId)
    if (!failures || failures.mutedUntil === 0) return false
    if (failures.mutedUntil > this.now()) return true
    this.failures.delete(userId)
    return false
  }

  /** Sets a stranger-keyed entry; prunes stale ones at the cap and refuses when still full. */
  private track<T>(map: Map<string, T>, key: string, value: T, stale: (item: T) => boolean): boolean {
    if (!map.has(key) && map.size >= TRACK_CAP) {
      for (const [other, item] of map) if (stale(item)) map.delete(other)
      if (map.size >= TRACK_CAP) return false
    }
    map.set(key, value)
    return true
  }

  private addPending(request: PendingRequest): string {
    const now = this.now()
    for (const [token, item] of this.pending) if (item.expiresAt <= now || item.userId === request.userId) this.pending.delete(token)
    if (this.pending.size >= PENDING_CAP) this.pending.delete(this.pending.keys().next().value!)
    const token = randomBytes(8).toString('hex')
    this.pending.set(token, request)
    return token
  }

  private audit(record: AuditRecord): boolean {
    const ok = appendAudit(this.options.stateDir, record, this.now())
    if (!ok) this.options.warn?.('Could not write the access audit line')
    return ok
  }

  private auditNote(ok: boolean): string {
    return ok ? '' : '\nВнимание: строка аудита не записана.'
  }

  private toOwner(text: string, keyboard?: AccessButton[][]): Promise<void> {
    return this.options.send(this.options.ownerId, text, keyboard)
  }
}
