// Per-chat memory of a question the agent left OPEN for the owner.
//
// WHY IT EXISTS: a reply that ends on «жду го» puts the turn on hold until the
// owner answers. If he never does (asleep, scrolled past, notification
// swallowed), nobody is left watching — the agent's turn is over and the bash
// watchdog only sees the tmux screen, so it cannot know the last outgoing
// message was a question. This store is the half of the fix that remembers.
//
// ONE RECORD PER CHAT, deliberately: the newest question is the only one worth
// reminding about, and a queue would mean nagging about asks the conversation
// has already moved past. A later question overwrites the earlier one; a
// question-free reply or any inbound text from the owner clears it.
//
// Shape and failure policy copied from `thread-store.ts`: the in-memory Map is
// authoritative, the file only lets the record survive a `systemctl restart`.
// Nothing here throws — a lost reminder is a nicety, and it must never break
// the live reply path that called us.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

import type { Logger } from '../log.js'

export interface OpenQuestionRecord {
  chatId: string
  // The message that asked — the reminder quote-replies to it, so the owner
  // sees the original question rather than a paraphrase.
  messageId: number
  threadId?: number
  askedAtMs: number
  // Detector code that fired (ASK_* / OQ_*). Logged, and useful for telling
  // "waiting on a go" from "waiting on an answer" when tuning the patterns.
  code: string
  // Clipped fragment of the question, never the whole body.
  snippet: string
  remindersSent: number
  // Set by the sweep after each delivered reminder; absent until the first one.
  // `exactOptionalPropertyTypes` is on, so this is built conditionally — never
  // assigned `undefined`.
  lastRemindedAtMs?: number
}

// Persisted shape on disk: { "<chatId>": <record>, … }. Plain object, keyed by
// chat id, so the file is trivially inspectable.
type OpenQuestionFile = Record<string, OpenQuestionRecord>

export class OpenQuestionStore {
  private readonly filePath: string
  private readonly log: Logger
  private readonly questions = new Map<string, OpenQuestionRecord>()

  constructor(filePath: string, log: Logger) {
    this.filePath = filePath
    this.log = log
    for (const [chatId, rec] of Object.entries(readQuestionFile(filePath, log))) {
      this.questions.set(chatId, rec)
    }
  }

  get(chatId: string): OpenQuestionRecord | undefined {
    return this.questions.get(chatId)
  }

  // Replaces whatever that chat had open — see "one record per chat" above.
  set(rec: OpenQuestionRecord): void {
    this.questions.set(rec.chatId, rec)
    this.persist()
  }

  clear(chatId: string): void {
    if (this.questions.delete(chatId)) this.persist()
  }

  all(): OpenQuestionRecord[] {
    return [...this.questions.values()]
  }

  private persist(): void {
    const payload: OpenQuestionFile = Object.fromEntries(this.questions)
    const tmp = `${this.filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      // Best-effort, same as thread-store: worst case is a reminder lost across
      // a restart, not a crash.
      this.log.debug('open-question-store persist failed (ignored)', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

// Validates one on-disk entry field by field. A record written by a newer
// version with a missing/renamed field is DROPPED rather than half-trusted — a
// malformed record would otherwise reach the sweep and send a reminder quoting
// nothing.
function parseRecord(chatId: string, raw: unknown): OpenQuestionRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!isPositiveInt(r.messageId)) return undefined
  if (typeof r.askedAtMs !== 'number' || !Number.isFinite(r.askedAtMs)) return undefined
  if (typeof r.code !== 'string' || typeof r.snippet !== 'string') return undefined
  const remindersSent =
    typeof r.remindersSent === 'number' && Number.isInteger(r.remindersSent) && r.remindersSent >= 0
      ? r.remindersSent
      : 0
  const out: OpenQuestionRecord = {
    chatId,
    messageId: r.messageId,
    askedAtMs: r.askedAtMs,
    code: r.code,
    snippet: r.snippet,
    remindersSent,
  }
  if (isPositiveInt(r.threadId)) out.threadId = r.threadId
  if (typeof r.lastRemindedAtMs === 'number' && Number.isFinite(r.lastRemindedAtMs)) {
    out.lastRemindedAtMs = r.lastRemindedAtMs
  }
  return out
}

function readQuestionFile(filePath: string, log: Logger): OpenQuestionFile {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: OpenQuestionFile = {}
    for (const [chatId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = parseRecord(chatId, raw)
      if (rec !== undefined) out[chatId] = rec
    }
    return out
  } catch (err) {
    log.debug('open-question-store read failed, ignoring file', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    // Drop a corrupt file so the next write starts from a clean one.
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      /* ignore — purely opportunistic cleanup */
    }
    return {}
  }
}
