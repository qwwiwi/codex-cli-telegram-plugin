// HTTP primitives shared by every webhook route: body draining with a cap,
// JSON+schema parsing, the auth/origin gate, and the JSON reply writer.
//
// Moved out of server.ts unchanged (2026-11-14). These were module-private
// there; they are exported here because the route modules import them. They are
// NOT re-exported from server.ts — the public surface stays what it was.

import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'

export const BODY_LIMIT_BYTES = 256 * 1024
// Per-route cap for AskUserQuestion bodies. Cheap pre-check: drains
// fewer bytes than the generic limit before paying Zod's parse cost.
// 64 KB is the upper bound the PRX-1 plan reserved for AskUserQuestion;
// 4 questions × 4 options × ~1 KB preview ≈ 16 KB worst case, leaving
// headroom for header/description text + question prose.
export const ASK_BODY_LIMIT_BYTES = 64 * 1024
// Read-receipt bodies are tiny ({chat_id, message_id, emoji}); 4 KB is
// generous and keeps the route cheap to abuse-proof.
export const REACT_BODY_LIMIT_BYTES = 4 * 1024
// Fallback-reply bodies carry one text up to Telegram's 4096-char cap plus a
// short chat_id. FIX 5 (2026-06-03): 4096 chars × up to 4 UTF-8 bytes + JSON
// overhead can exceed 16 KB, which would 413 BEFORE the schema validates the
// 4096-char text. 32 KB covers the worst-case multibyte body with headroom
// while still cheap to abuse-proof.
export const FALLBACK_REPLY_BODY_LIMIT_BYTES = 32 * 1024
// Permission-gate request bodies carry a bounded preview (≤4096) + reason
// (≤1024) + small ids; 32 KB covers the worst-case multibyte body with
// headroom while staying cheap to abuse-proof.
export const PERMISSION_REQUEST_BODY_LIMIT_BYTES = 32 * 1024

// Loopback hosts that count as «caller is on this machine». Mirrors the
// L5 guard in startWebhookServer — `localhost` is intentionally NOT in
// this list because /etc/hosts can redirect it elsewhere.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  // Node's req.socket.remoteAddress reports IPv6-mapped v4 as `::ffff:127.0.0.1`.
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true
  if (addr.startsWith('127.')) return true
  return false
}

export function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    try { res.end() } catch { /* ignore */ }
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function bearerEquals(received: string, expected: string): boolean {
  // Pad both sides to a single fixed length BEFORE the comparison so we run
  // the exact same timingSafeEqual call regardless of input lengths — no
  // length-conditional code path that could leak a length bit (review M4).
  // Final result combines the constant-time byte-compare with an explicit
  // length-equality bit, so mismatched lengths still return false.
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  const max = Math.max(a.length, b.length, 32)
  const padA = Buffer.alloc(max)
  const padB = Buffer.alloc(max)
  a.copy(padA)
  b.copy(padB)
  const bytesEqual = timingSafeEqual(padA, padB)
  return bytesEqual && a.length === b.length
}

// Drain request body up to BODY_LIMIT_BYTES + 1. We return early as soon
// as the cap is exceeded so a hostile sender can't burn memory on us.
export function readBody(req: IncomingMessage): Promise<{ tooLarge: boolean; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      length += chunk.length
      if (length > BODY_LIMIT_BYTES) {
        tooLarge = true
        // Stop accumulating; destroy the stream to free socket buffers.
        try { req.destroy() } catch { /* ignore */ }
        resolve({ tooLarge: true, buf: Buffer.alloc(0) })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolve({ tooLarge: false, buf: Buffer.concat(chunks) })
    })
    req.on('error', (err) => {
      if (tooLarge) return
      reject(err)
    })
  })
}

// Drain helper used by AskUserQuestion routes — parameterised on cap so
// the same primitive serves both the 64 KB AskUserQuestion budget and
// any future route that needs a tighter limit. The legacy /hooks/agent
// path keeps using `readBody` above (hardcoded 256 KB) to minimise
// churn in already-shipped behaviour.
export function readBodyWithCap(
  req: IncomingMessage,
  cap: number,
): Promise<{ tooLarge: boolean; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      length += chunk.length
      if (length > cap) {
        tooLarge = true
        try { req.destroy() } catch { /* ignore */ }
        resolve({ tooLarge: true, buf: Buffer.alloc(0) })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolve({ tooLarge: false, buf: Buffer.concat(chunks) })
    })
    req.on('error', (err) => {
      if (tooLarge) return
      reject(err)
    })
  })
}

export async function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
  cap: number,
  schema: z.ZodType<T>,
  routeLabel: string,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lenHeader = req.headers['content-length']
  if (lenHeader !== undefined) {
    const declared = Number.parseInt(Array.isArray(lenHeader) ? (lenHeader[0] ?? '0') : lenHeader, 10)
    if (Number.isFinite(declared) && declared > cap) {
      reply(res, 413, { error: 'payload too large' })
      return { ok: false }
    }
  }
  let buf: Buffer
  try {
    const drained = await readBodyWithCap(req, cap)
    if (drained.tooLarge) {
      reply(res, 413, { error: 'payload too large' })
      return { ok: false }
    }
    buf = drained.buf
  } catch (err) {
    reply(res, 400, { error: 'invalid body' })
    log.warn(`${routeLabel} body read failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
  let parsed: unknown
  try {
    parsed = buf.length > 0 ? JSON.parse(buf.toString('utf8')) : {}
  } catch (err) {
    reply(res, 400, { error: 'invalid json' })
    log.warn(`${routeLabel} json parse failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
      .slice(0, 512)
    reply(res, 400, { error: `invalid payload: ${summary}` })
    log.warn(`${routeLabel} schema validation failed`, { summary })
    return { ok: false }
  }
  return { ok: true, value: result.data }
}

// Shared auth/origin gate. Returns `false` when the response has
// already been written (route handler short-circuits on false return).
export function authGate(
  req: IncomingMessage,
  res: ServerResponse,
  webhookToken: string | undefined,
): boolean {
  // Loopback origin check — even on a 127.0.0.1 bind we re-verify the
  // socket peer so a future change to host config (or a port-forward
  // through an SSH tunnel) doesn't silently expose these routes.
  const remote = req.socket.remoteAddress
  if (!isLoopbackAddress(remote)) {
    reply(res, 403, { error: 'loopback only' })
    return false
  }
  if (!webhookToken) {
    reply(res, 503, { error: 'webhook auth not configured' })
    return false
  }
  const authHeader = (req.headers['authorization'] ?? '').toString()
  const expected = `Bearer ${webhookToken}`
  if (!bearerEquals(authHeader, expected)) {
    reply(res, 401, { error: 'unauthorized' })
    return false
  }
  return true
}

export function chatIdAllowed(config: AppConfig, chatId: string): boolean {
  for (const entry of config.allowed_chat_ids) {
    if (String(entry) === chatId) return true
  }
  return false
}

// Build a "safe" public view of config for /health. No tokens, no env.
export function healthBody(config: AppConfig): Record<string, unknown> {
  return {
    status: 'ok',
    bot_id: config.bot_id,
    allowed_chat_ids: config.allowed_chat_ids.map((v) => String(v)),
  }
}
