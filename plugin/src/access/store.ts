import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** Roles that the state file may hold. The owner exists only in env. */
export type StoredRole = 'member' | 'guest'
export type AccessRole = 'owner' | StoredRole

export const STORED_ROLES: readonly StoredRole[] = ['member', 'guest']

// A Telegram user ID: a positive integer without a leading zero.
const USER_ID = /^[1-9]\d{0,15}$/u
const INVITE_TTL_MS = 10 * 60_000
// 32 symbols (no 0/1/O/I), 10 of them: 50 bits.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const INVITE_LENGTH = 10
const NOTE_MAX = 64

const StoredUserSchema = z.object({
  // z.enum rejects "owner": nothing written to the file can create a second owner.
  role: z.enum(['member', 'guest']),
  note: z.string().max(NOTE_MAX).optional(),
  added_at: z.string(),
  added_by: z.string(),
}).strict()

const InviteSchema = z.object({
  role: z.enum(['member', 'guest']),
  expires_at: z.string(),
}).strict()

// A group or supergroup ID: negative, no leading zero.
const GROUP_ID = /^-[1-9]\d{0,19}$/u
const PENDING_CHAT_CAP = 20

const ApprovedChatSchema = z.object({
  mode: z.enum(['members', 'open']),
  title: z.string().max(NOTE_MAX).optional(),
  topics: z.enum(['per-topic', 'shared']).default('per-topic'),
  approved_at: z.string(),
  approved_by: z.string(),
}).strict()

const PendingChatSchema = z.object({
  title: z.string().max(NOTE_MAX).optional(),
  added_by: z.string(),
  added_at: z.string(),
}).strict()

// guest_mode and any later keys belong to later slices: kept as is on write.
const AccessFileSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string().regex(USER_ID), StoredUserSchema).default({}),
  invites: z.record(z.string().regex(/^[0-9a-f]{64}$/u), InviteSchema).default({}),
  chats: z.record(z.string().regex(GROUP_ID), ApprovedChatSchema).default({}),
  pending_chats: z.record(z.string().regex(GROUP_ID), PendingChatSchema).default({}),
}).passthrough()

type AccessFile = z.infer<typeof AccessFileSchema>
type StoredUser = z.infer<typeof StoredUserSchema>
export type ApprovedChat = z.infer<typeof ApprovedChatSchema>
export type PendingChat = z.infer<typeof PendingChatSchema>
export type ChatMode = ApprovedChat['mode']
export type ChatResult =
  | { ok: true; was?: 'approved' | 'pending'; title?: string }
  | { ok: false; reason: AccessRefusal | 'full' }

export function isGroupId(value: string): boolean {
  return GROUP_ID.test(value)
}

export interface AccessEntry {
  id: string
  role: AccessRole
  source: 'env' | 'state'
  note?: string
  added_at?: string
  added_by?: string
}

export type AccessRefusal = 'bad_id' | 'owner' | 'env' | 'exists' | 'unknown' | 'degraded' | 'write_failed'
export type AccessResult = { ok: true; previous?: StoredRole } | { ok: false; reason: AccessRefusal }

export interface AccessStoreOptions {
  stateDir: string
  /** The single owner from TELEGRAM_ALLOWED_USER_IDS. */
  ownerId: string
  /** KROT_MEMBER_USER_IDS: members managed only in env. */
  envMembers: readonly string[]
  now?: () => number
  warn?: (message: string) => void
  /** Called after every saved change (users, roles, groups), so queued public work can be rechecked. */
  onChange?: () => void
}

export function isUserId(value: string): boolean {
  return USER_ID.test(value)
}

export function cleanNote(value: string | undefined): string | undefined {
  const clean = value?.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, NOTE_MAX).trim()
  return clean ? clean : undefined
}

function emptyFile(): AccessFile {
  return { version: 1, users: {}, invites: {}, chats: {}, pending_chats: {} }
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * The access list in `<state>/access.json` (written atomically, mode 0600).
 * A missing file means owner only. A file that fails to parse or validate also
 * means owner only, and the store then refuses every write so the broken file
 * stays for the owner to inspect.
 */
export class AccessStore {
  readonly path: string
  private data: AccessFile = emptyFile()
  private readonly envMembers: ReadonlySet<string>
  private readonly now: () => number
  private broken = false

  constructor(private readonly options: AccessStoreOptions) {
    this.path = join(options.stateDir, 'access.json')
    this.now = options.now ?? Date.now
    this.envMembers = new Set(options.envMembers.filter(id => id !== options.ownerId))
    this.load()
  }

  /** True when access.json could not be read: owner only, no writes. */
  get degraded(): boolean { return this.broken }

  roleOf(id: string): AccessRole | undefined {
    if (id === this.options.ownerId) return 'owner'
    if (this.envMembers.has(id)) return 'member'
    return this.data.users[id]?.role
  }

  /** Owner first, then env members, then state users, each by numeric ID. */
  list(): AccessEntry[] {
    const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    const entries: AccessEntry[] = [{ id: this.options.ownerId, role: 'owner', source: 'env' }]
    for (const id of [...this.envMembers].sort(byId)) entries.push({ id, role: 'member', source: 'env' })
    for (const id of Object.keys(this.data.users).sort(byId)) {
      if (id === this.options.ownerId || this.envMembers.has(id)) continue
      const user = this.data.users[id]!
      entries.push({
        id, role: user.role, source: 'state', added_at: user.added_at, added_by: user.added_by,
        ...(user.note ? { note: user.note } : {}),
      })
    }
    return entries
  }

  add(id: string, role: StoredRole, addedBy: string, note?: string): AccessResult {
    const refused = this.refuse(id)
    if (refused) return refused
    if (this.data.users[id]) return { ok: false, reason: 'exists' }
    const cleaned = cleanNote(note)
    const user: StoredUser = {
      role, added_at: new Date(this.now()).toISOString(), added_by: addedBy, ...(cleaned ? { note: cleaned } : {}),
    }
    return this.commit({ ...this.data, users: { ...this.data.users, [id]: user } }, {})
  }

  remove(id: string): AccessResult {
    const refused = this.refuse(id)
    if (refused) return refused
    const current = this.data.users[id]
    if (!current) return { ok: false, reason: 'unknown' }
    const users = { ...this.data.users }
    delete users[id]
    return this.commit({ ...this.data, users }, { previous: current.role })
  }

  setRole(id: string, role: StoredRole): AccessResult {
    const refused = this.refuse(id)
    if (refused) return refused
    const current = this.data.users[id]
    if (!current) return { ok: false, reason: 'unknown' }
    return this.commit({ ...this.data, users: { ...this.data.users, [id]: { ...current, role } } },
      { previous: current.role })
  }

  /** Mints a single-use pairing code; only its SHA-256 is stored. Throws when the store cannot write. */
  createInvite(role: StoredRole): string {
    if (this.broken) throw new Error('access.json is unreadable; fix or remove it first')
    const bytes = randomBytes(INVITE_LENGTH)
    let code = ''
    for (const byte of bytes) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
    const invites = this.liveInvites()
    invites[hashCode(code)] = { role, expires_at: new Date(this.now() + INVITE_TTL_MS).toISOString() }
    const result = this.commit({ ...this.data, invites }, {})
    if (!result.ok) throw new Error('Could not save the invite')
    return code
  }

  /** Consumes a live code and returns its role; grants nothing by itself. */
  redeemInvite(code: string): StoredRole | undefined {
    const normalized = code.trim().toUpperCase()
    if (this.broken || normalized.length !== INVITE_LENGTH) return undefined
    const invites = this.liveInvites()
    const hash = hashCode(normalized)
    const invite = invites[hash]
    if (!invite) return undefined
    delete invites[hash]
    // A code that cannot be marked used is not honoured, so it can never be used twice.
    return this.commit({ ...this.data, invites }, {}).ok ? invite.role : undefined
  }

  /** An approved group; a pending or unknown group is undefined. */
  chat(id: string): ApprovedChat | undefined {
    return this.data.chats[id]
  }

  chats(): Array<ApprovedChat & { id: string }> {
    return Object.entries(this.data.chats).map(([id, chat]) => ({ id, ...chat }))
  }

  /** Groups the bot was added to that wait for the owner's card, oldest first. */
  pendingChats(): Array<PendingChat & { id: string }> {
    return Object.entries(this.data.pending_chats).map(([id, chat]) => ({ id, ...chat }))
      .sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at))
  }

  addPendingChat(id: string, entry: { title?: string | undefined; added_by: string }): ChatResult {
    const refused = this.refuseChat(id)
    if (refused) return refused
    if (this.data.chats[id]) return { ok: false, reason: 'exists' }
    if (!this.data.pending_chats[id] && Object.keys(this.data.pending_chats).length >= PENDING_CHAT_CAP) {
      return { ok: false, reason: 'full' }
    }
    const title = cleanNote(entry.title)
    const pending: PendingChat = {
      added_by: entry.added_by, added_at: new Date(this.now()).toISOString(), ...(title ? { title } : {}),
    }
    return this.commitChat({ ...this.data, pending_chats: { ...this.data.pending_chats, [id]: pending } }, {})
  }

  /** Approves a pending group; a group that is not pending is `unknown`. */
  approveChat(id: string, mode: ChatMode, by: string): ChatResult {
    const refused = this.refuseChat(id)
    if (refused) return refused
    const pending = this.data.pending_chats[id]
    if (!pending) return { ok: false, reason: 'unknown' }
    const pendingChats = { ...this.data.pending_chats }
    delete pendingChats[id]
    const chat: ApprovedChat = {
      mode, topics: 'per-topic', approved_at: new Date(this.now()).toISOString(), approved_by: by,
      ...(pending.title ? { title: pending.title } : {}),
    }
    return this.commitChat({ ...this.data, chats: { ...this.data.chats, [id]: chat }, pending_chats: pendingChats },
      pending.title ? { title: pending.title } : {})
  }

  /** Drops an approved or pending group. */
  removeChat(id: string): ChatResult {
    const refused = this.refuseChat(id)
    if (refused) return refused
    const approved = this.data.chats[id]
    const pending = this.data.pending_chats[id]
    if (!approved && !pending) return { ok: false, reason: 'unknown' }
    const chats = { ...this.data.chats }
    const pendingChats = { ...this.data.pending_chats }
    delete chats[id]
    delete pendingChats[id]
    const title = approved?.title ?? pending?.title
    return this.commitChat({ ...this.data, chats, pending_chats: pendingChats },
      { was: approved ? 'approved' : 'pending', ...(title ? { title } : {}) })
  }

  /** A group upgraded to a supergroup gets a new ID; its approval moves with it. */
  migrateChat(from: string, to: string): ChatResult {
    const refused = this.refuseChat(from) ?? this.refuseChat(to)
    if (refused) return refused
    const approved = this.data.chats[from]
    if (!approved) return { ok: false, reason: 'unknown' }
    const chats = { ...this.data.chats, [to]: approved }
    delete chats[from]
    return this.commitChat({ ...this.data, chats }, { was: 'approved' })
  }

  private refuseChat(id: string): ChatResult | undefined {
    if (!isGroupId(id)) return { ok: false, reason: 'bad_id' }
    if (this.broken) return { ok: false, reason: 'degraded' }
    return undefined
  }

  private commitChat(next: AccessFile, ok: { was?: 'approved' | 'pending'; title?: string }): ChatResult {
    const result = this.commit(next, {})
    return result.ok ? { ok: true, ...ok } : result
  }

  private liveInvites(): Record<string, z.infer<typeof InviteSchema>> {
    const now = this.now()
    return Object.fromEntries(Object.entries(this.data.invites)
      .filter(([, invite]) => Date.parse(invite.expires_at) > now))
  }

  private refuse(id: string): AccessResult | undefined {
    if (!isUserId(id)) return { ok: false, reason: 'bad_id' }
    if (id === this.options.ownerId) return { ok: false, reason: 'owner' }
    if (this.envMembers.has(id)) return { ok: false, reason: 'env' }
    if (this.broken) return { ok: false, reason: 'degraded' }
    return undefined
  }

  private commit(next: AccessFile, ok: { previous?: StoredRole }): AccessResult {
    const temp = this.path + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.path)
    } catch {
      try { if (existsSync(temp)) unlinkSync(temp) } catch { /* best effort: the temp file holds no secret */ }
      this.options.warn?.('Could not write access.json')
      return { ok: false, reason: 'write_failed' }
    }
    this.data = next
    try {
      this.options.onChange?.()
    } catch {
      this.options.warn?.('Could not recheck queued public work after an access change')
    }
    return { ok: true, ...ok }
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.failClosed('access.json is unreadable; only the owner has access')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.failClosed('access.json is not valid JSON; only the owner has access')
      return
    }
    const result = AccessFileSchema.safeParse(parsed)
    if (!result.success) {
      this.failClosed('access.json failed validation; only the owner has access')
      return
    }
    this.data = result.data
  }

  private failClosed(message: string): void {
    this.broken = true
    this.data = emptyFile()
    this.options.warn?.(message)
  }
}
