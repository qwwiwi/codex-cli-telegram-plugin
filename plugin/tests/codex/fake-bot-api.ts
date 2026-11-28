// A fake Bot API server for tests that run the production Telegram stack (grammY → rate limiter → safe
// wrapper) and assert the exact payload each HTTP request carried.
import { Bot } from 'grammy'

export interface CapturedCall {
  method: string
  payload: Record<string, unknown>
  /** The file names of a multipart upload (sendDocument, sendPhoto), as the request carried them. */
  files?: string[]
}

/** A test answer: a Bot API result, or an error the server returns instead. */
export type FakeAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } }

export interface FakeBotApi {
  bot: Bot
  calls: CapturedCall[]
  /** Answer the next request of `method` with `answer` instead of a sent message. */
  answerNext(method: string, answer: FakeAnswer): void
  stop(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const FAKE_TOKEN = '123456:TEST-token'

export function fakeBotApi(): FakeBotApi {
  const calls: CapturedCall[] = []
  const queued = new Map<string, FakeAnswer[]>()
  let next = 1000
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split('/').pop() ?? ''
      if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
        // An upload: its text fields (JSON-decoded when they hold JSON) and its files by name.
        const form = await request.formData()
        const payload: Record<string, unknown> = {}
        const files: string[] = []
        for (const [key, entry] of form.entries()) {
          // Typed as a string here, a file part at run time.
          const value: unknown = entry
          if (typeof value !== 'string') {
            files.push(value instanceof Blob && 'name' in value && typeof value.name === 'string' ? value.name : '')
            continue
          }
          try { payload[key] = JSON.parse(value) } catch { payload[key] = value }
        }
        calls.push({ method, payload, files })
      } else {
        const body: unknown = await request.json().catch(() => ({}))
        calls.push({ method, payload: isRecord(body) ? body : {} })
      }
      const answer = queued.get(method)?.shift()
      if (answer !== undefined) return Response.json(answer, { status: answer.ok ? 200 : answer.error_code })
      next += 1
      return Response.json({ ok: true, result: method === 'editMessageText' ? true
        : { message_id: next, date: 0, chat: { id: 42, type: 'private' } } })
    },
  })
  const bot = new Bot(FAKE_TOKEN, {
    botInfo: {
      id: 100001, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: false,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
      can_manage_bots: false, supports_guest_queries: false, needs_inline_query_location: false,
      has_topic_sidebar: false, supports_join_request_queries: false,
    },
    client: { apiRoot: `http://127.0.0.1:${server.port}` },
  })
  return {
    bot,
    calls,
    answerNext(method, answer) { queued.set(method, [...queued.get(method) ?? [], answer]) },
    stop() { void server.stop(true) },
  }
}
