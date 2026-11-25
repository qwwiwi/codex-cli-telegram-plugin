// Per-chat forum-topic memory.
//
// THE BUG: a reply to a message that arrived inside a forum topic landed in
// the supergroup's General topic, because nothing carried the inbound
// `message_thread_id` through to the outbound `sendMessage`. The agent omits
// `reply_to` for the latest message (per the reply-tool contract), so Telegram
// had no thread to infer either.
//
// THE FIX (one half of it): remember the thread id of the LAST inbound message
// per chat. The reply / status surfaces consult it as the default thread when
// the caller did not pass one explicitly. In single-session deployments the
// inbound handler and the reply tool share ONE process, so the in-memory map
// is authoritative and instant; the file backing only lets the default survive
// a `systemctl restart`.
//
// This is a SAFETY NET. The primary, cross-process mechanism is surfacing
// `message_thread_id` in the `<channel>` block so the agent passes `thread_id`
// back explicitly — that path works even in multichat where each chat runs in
// its own process and cannot see this in-memory store.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

import type { Logger } from '../log.js'

// Persisted shape on disk: { "<chatId>": <threadId>, … }. Plain object so the
// file is trivially inspectable and forward-compatible.
type ThreadFile = Record<string, number>

export interface ThreadStore {
  // Record the thread id of the latest inbound message for a chat. A falsy
  // threadId (General topic / private chat) CLEARS any stale thread so a later
  // reply does not get pinned to a topic the conversation has moved out of.
  record(chatId: string, threadId: number | undefined): void
  // The remembered thread for a chat, or undefined when none / General.
  get(chatId: string): number | undefined
}

// File-backed ThreadStore. Writes are tiny and infrequent (one per inbound
// turn), so synchronous atomic writes (temp + rename) are cheap and avoid a
// torn file if the process dies mid-write. Reads are served from the in-memory
// map — the file is only loaded once at construction.
export class FileThreadStore implements ThreadStore {
  private readonly filePath: string
  private readonly log: Logger
  private readonly threads = new Map<string, number>()

  constructor(filePath: string, log: Logger) {
    this.filePath = filePath
    this.log = log
    for (const [chatId, threadId] of Object.entries(readThreadFile(filePath, log))) {
      this.threads.set(chatId, threadId)
    }
  }

  record(chatId: string, threadId: number | undefined): void {
    if (threadId === undefined || threadId <= 0) {
      // Moved back to General (or a private chat) — forget the topic.
      if (this.threads.delete(chatId)) this.persist()
      return
    }
    if (this.threads.get(chatId) === threadId) return
    this.threads.set(chatId, threadId)
    this.persist()
  }

  get(chatId: string): number | undefined {
    return this.threads.get(chatId)
  }

  private persist(): void {
    const payload: ThreadFile = Object.fromEntries(this.threads)
    const tmp = `${this.filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      // Best-effort: a failed persist must never break a live turn. Worst case
      // is a missed default thread after a restart, not a crash.
      this.log.debug('thread-store persist failed (ignored)', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function readThreadFile(filePath: string, log: Logger): ThreadFile {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: ThreadFile = {}
    for (const [chatId, threadId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof threadId === 'number' && Number.isFinite(threadId) && threadId > 0) {
        out[chatId] = threadId
      }
    }
    return out
  } catch (err) {
    log.debug('thread-store read failed, ignoring file', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    // A corrupt file should not strand the chat — drop it so the next record
    // rewrites a clean one.
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      /* ignore — purely opportunistic cleanup */
    }
    return {}
  }
}
