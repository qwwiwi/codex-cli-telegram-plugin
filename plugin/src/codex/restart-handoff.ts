import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteInRoot } from '../autonomy/store.js'
import type { CodexInbox } from './inbox.js'

const filename = 'bridge-restart-handoff.json'
const verificationIdOffset = 2 ** 48
const identifier = /^[a-z0-9_-]{1,128}$/iu
const verificationInput = 'Служебное событие Telegram-моста. После запланированного перезапуска мост ' +
  'подключился к новому локальному Codex App Server и восстановил этот диалог. ' +
  'Проверь, что контекст исходного поручения доступен в этом диалоге. Ограничь проверку чтением ' +
  'и коротко сообщи владельцу, что удалось подтвердить.'

type Verification = { threadId: string; ownerMessageId: number }
type Handoff = Verification & {
  v: 1; invocation: string; ownerId: number; phase: 'pending' | 'queued' | 'cancelled'
}

function verificationMessageId(handoff: Handoff): number {
  const hash = createHash('sha256').update(handoff.invocation + ':' + handoff.ownerMessageId).digest()
  return -verificationIdOffset - 1 - hash.readUIntBE(0, 6)
}

export function isRestartVerificationMessage(id: number): boolean {
  return Number.isSafeInteger(id) && id < -verificationIdOffset && id >= -2 * verificationIdOffset
}

export class BridgeRestartHandoff {
  constructor(private root: string, private invocation: string, private ownerId: number) {
    if (!identifier.test(invocation)) throw new Error('Invalid bridge invocation identity')
  }

  request(threadId: string | null, ownerMessageId: number): boolean {
    if (!threadId || !identifier.test(threadId) || !Number.isSafeInteger(ownerMessageId) || ownerMessageId <= 0) return false
    const latest = this.read()
    if (latest?.ownerMessageId === ownerMessageId) {
      return latest.threadId === threadId && latest.phase === 'pending' && latest.invocation === this.invocation
    }
    if (latest && (latest.ownerMessageId > ownerMessageId ||
        (latest.phase === 'pending' && latest.invocation !== this.invocation))) return false
    this.write({ v: 1, invocation: this.invocation, ownerId: this.ownerId, phase: 'pending', threadId, ownerMessageId })
    return true
  }

  pending(): Handoff | undefined {
    const handoff = this.read()
    if (handoff?.phase === 'pending' && handoff.invocation !== this.invocation) return handoff
    return undefined
  }

  recover(inbox: Pick<CodexInbox, 'receive'>): 'none' | 'full' | 'queued' {
    const handoff = this.pending()
    if (!handoff) return 'none'
    const first_name = 'Telegram'
    const queued = inbox.receive({
      message_id: verificationMessageId(handoff), date: Math.floor(Date.now() / 1000), text: verificationInput,
      chat: { id: this.ownerId, type: 'private', first_name },
      from: { id: this.ownerId, is_bot: false, first_name },
    }, true)
    if (queued === 'full') return 'full'
    this.write({ ...handoff, phase: 'queued' })
    return 'queued'
  }

  verification(messageId: number): Verification | undefined {
    if (!isRestartVerificationMessage(messageId)) return undefined
    const handoff = this.read()
    if (!handoff || handoff.phase === 'cancelled' || handoff.invocation === this.invocation ||
        verificationMessageId(handoff) !== messageId) return undefined
    return { threadId: handoff.threadId, ownerMessageId: handoff.ownerMessageId }
  }

  cancel(): void {
    const handoff = this.read()
    if (handoff && handoff.phase !== 'cancelled') this.write({ ...handoff, phase: 'cancelled' })
  }

  private read(): Handoff | undefined {
    let data: string
    try { data = readFileSync(join(this.root, filename), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const saved = JSON.parse(data) as Partial<Handoff> | null
    if (saved?.v !== 1 || typeof saved.invocation !== 'string' || !identifier.test(saved.invocation) ||
        !['pending', 'queued', 'cancelled'].includes(saved.phase ?? '') ||
        typeof saved.threadId !== 'string' || !identifier.test(saved.threadId) ||
        typeof saved.ownerId !== 'number' || !Number.isSafeInteger(saved.ownerId) || saved.ownerId <= 0 ||
        typeof saved.ownerMessageId !== 'number' || !Number.isSafeInteger(saved.ownerMessageId) || saved.ownerMessageId <= 0) {
      throw new Error('Invalid bridge restart handoff')
    }
    return saved.ownerId === this.ownerId ? saved as Handoff : undefined
  }

  private write(handoff: Handoff): void {
    atomicWriteInRoot({ root: this.root }, filename, JSON.stringify(handoff) + '\n')
  }
}
