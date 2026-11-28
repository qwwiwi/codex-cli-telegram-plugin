// Reply masking regressions: a value whose match ends in characters the
// marker keeps (seam span), a legacy migration whose pending part masking cannot cut, a plain reply the cutter
// cannot pack, and the origin of a legacy outbox reply re-split after redaction.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { sendTextReply, type SendMessageOpts, type TelegramApi } from '../../src/channel/tools.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { newPlan, nextPiece, resumePlan } from '../../src/codex/reply-plan.js'
import { mainOrigin, storedOrigin } from '../../src/codex/turn-origin.js'
import { maskPiece } from '../../src/format/visible.js'
import { createLogger } from '../../src/log.js'
import { Outbox } from '../../src/safety/outbox.js'
import { createSafeTelegramApi, redactOutboundText } from '../../src/safety/safe-telegram-api.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const quiet = new Writable({ write(_chunk, _encoding, done) { done() } })
const log = createLogger('mask-fix2-test', { stream: quiet })

// ─── F1: the seam maps through the whole match, its kept suffix included ─────

// Piece 0 ends right after `MASKME`; `MASKME]` is registered after it went. The marker `[REDACTED]` keeps the `]`,
// so a seam mapped through the narrowed edit only lands after that `]` and the next piece starts with `] tail`.
const SEAM_TEXT = 'x '.repeat(1997) + 'MASKME] tail'
const SEAM_VALUE = 'MASKME]'

test('[F1] a re-plan after the first piece never sends the rest of a value whose marker keeps its last char', () => {
  const plan = newPlan({ text: SEAM_TEXT, entities: [] })
  expect(SEAM_TEXT.slice(0, plan.cuts[0]).endsWith('MASKME')).toBe(true)
  const resumed = resumePlan(plan, 1, [SEAM_VALUE])
  const pending = resumed.text.slice(resumed.cuts[0])
  expect(pending.startsWith(']')).toBe(false)
  expect(pending).toBe('[REDACTED] tail')
  const next = nextPiece(plan, 1, [SEAM_VALUE])
  expect(next?.piece.text).toBe('[REDACTED] tail')
})

test('[F1] the retry seam check masks the piece through the whole match: no `] tail`', () => {
  const plan = newPlan({ text: SEAM_TEXT, entities: [] })
  const cut = plan.cuts[0] ?? 0
  const piece = maskPiece({ text: SEAM_TEXT.slice(cut), entities: [] }, [SEAM_VALUE], SEAM_TEXT.slice(0, cut))
  expect(piece.text).toBe('[REDACTED] tail')
})

test('[F1] the outbox handed a whole plan never sends `] tail` after the sent piece', async () => {
  const wire: string[] = []
  const raw: TelegramApi = {
    ...fakeTelegramChat().raw,
    async sendMessage(_chat, text) {
      wire.push(text)
      return { message_id: 100 + wire.length }
    },
  }
  const safe = createSafeTelegramApi(raw, log, [SEAM_VALUE])
  const outbox = new Outbox({ stateDir: tempDir('krot-fix2-outbox-'), log, now: () => 0, secrets: [SEAM_VALUE],
    sendFn: (chat, text, opts) => safe.sendMessage(chat, text, opts) })
  outbox.enqueuePlan('1', newPlan({ text: SEAM_TEXT, entities: [] }), 1, { ownerReply: true }, 0)
  await outbox.flushDue(10_000)
  expect(wire).toEqual(['[REDACTED] tail'])
})

// ─── F2: a migrated plan masking cannot cut is saved masked ─────────────────

test('[F2] a legacy plan whose masked pending part cannot be cut is saved masked, never as saved', () => {
  const dir = tempDir('krot-fix2-inbox-')
  const message = { message_id: 7, date: 1, text: 'Пришли', chat: { id: 42, type: 'private', first_name: 'O' },
    from: { id: 42, is_bot: false, first_name: 'O' } }
  writeFileSync(join(dir, 'codex-inbox.json'), JSON.stringify({
    ready: [], albums: {}, accepted: [7], origins: { 7: { origin: 'owner' } },
    active: { messages: [message], outcome: { stage: 'ready', reply: { text: 'Hello MASKME', files: [] },
      delivery: { rich: 'fallback', 'text:0': 'sent' }, textPlan: ['Hello\n\n', 'MASKME' + ' '.repeat(3994)] } },
  }))
  const inbox = new CodexInbox(dir, 42, ['MASKME'])
  const file = readFileSync(join(dir, 'codex-inbox.json'), 'utf8')
  expect(file).not.toContain('MASKME')
  const plan = inbox.replyPlan(7)
  expect(plan?.text).toBe('Hello\n\n[REDACTED]' + ' '.repeat(3994))
  // The sent piece keeps its receipt; the masked rest is one pending piece.
  expect(plan?.cuts).toEqual([7, 7 + 10 + 3994])
})

// ─── F3: a plain reply the cutter cannot pack still goes ───────────────────

test('[F3] a plain reply the cutter cannot pack goes as one masked document', async () => {
  const documents: Array<{ body: string; opts: object }> = []
  const messages: string[] = []
  const api: TelegramApi = {
    ...fakeTelegramChat().raw,
    async sendMessage(_chat, text) {
      messages.push(text)
      return { message_id: 10 + messages.length }
    },
    async sendDocument(_chat, filePath, opts) {
      documents.push({ body: readFileSync(filePath, 'utf8'), opts })
      return { message_id: 90 }
    },
  }
  const sentIds: number[] = []
  const text = 'A MASKME\n\n' + ' '.repeat(8000) + 'B'
  await sendTextReply(api, '42', text, 'text', { replyTo: 5, threadId: 3, secrets: ['MASKME'] }, sentIds)
  expect(messages).toEqual([])
  expect(documents).toHaveLength(1)
  expect(documents[0]?.body).toBe('A [REDACTED]\n\n' + ' '.repeat(8000) + 'B')
  expect(documents[0]?.opts).toEqual({ filename: 'reply.txt', reply_to_message_id: 5, message_thread_id: 3 })
  expect(sentIds).toEqual([90])
})

// ─── F4: a legacy reply re-split after redaction keeps its origin ─────────

test('[F4] an unversioned reply redacted across its parts keeps its origin', () => {
  const dir = tempDir('krot-fix2-legacy-')
  const origin = storedOrigin(mainOrigin('main'))
  const opts: SendMessageOpts = { parse_mode: 'HTML', ownerReply: true }
  writeFileSync(join(dir, 'outbox.json'), JSON.stringify([
    { id: 'a', chatId: '1', text: 'Ключ MAS', opts: { ...opts, reply_to_message_id: 9 }, notBefore: 0, attempts: 0,
      origin },
    { id: 'b', chatId: '1', text: 'KME хвост', opts, notBefore: 0, attempts: 0, origin },
  ]))
  const outbox = new Outbox({ stateDir: dir, log, now: () => 0, secrets: ['MASKME'],
    sendFn: async () => ({ message_id: 1 }), redact: (text, parseMode) => redactOutboundText(text, parseMode, ['MASKME']) })
  const items = outbox.snapshot()
  expect(items).toHaveLength(1)
  expect(items[0]?.plan.text).toBe('Ключ [REDACTED] хвост')
  expect(items[0]?.origin).toEqual(origin)
})
