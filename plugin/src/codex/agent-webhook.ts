// Inbound inter-agent webhook: other agents of the fleet (for example a
// swarm worker) POST a task here and it becomes a Codex input in the owner's chat.
//
// Off unless KROT_AGENT_WEBHOOK_LISTEN is set. Never runs open: a bearer
// token (KROT_AGENT_WEBHOOK_TOKEN), a source IP allowlist
// (KROT_AGENT_WEBHOOK_ALLOW_IPS) or both are required, and both must pass
// when both are configured. The sender treats 2xx as delivered, 4xx (except
// 429) as a permanent failure and 5xx as retryable.
//
// The message is framed as untrusted data from another agent, never as an
// owner instruction. Logs carry neither the token nor the body.

import { z } from 'zod'

import type { Logger } from '../log.js'
import { bearerEquals } from '../webhook/http.js'
import { routeWhileBusy, type ParallelSettings, type SideRegistry } from './parallel.js'
import { agentFramePrefix, unverifiedSenderMark } from './provenance.js'

export const AGENT_WEBHOOK_BODY_LIMIT = 64 * 1024
const rememberedDeliveries = 500
const noticeChars = 200

export interface AgentWebhookSettings {
  hostname: string
  port: number
  token?: string | undefined
  allowIps?: string[]
}

export type AgentWebhookConfig =
  | { kind: 'off' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'on'; settings: AgentWebhookSettings }

export interface AgentDelivery {
  /** Codex input: the untrusted-data prefix followed by the agent's message. */
  input: string
  /** Short owner-facing Telegram notice. */
  notice: string
  /** Display-safe name of the sender (see agentSender), not the body agentId. */
  agentId: string
  /** The sender came from fromAgent or X-From-Agent, not only from the message text. */
  senderVerified: boolean
  deliveryId?: string
}

export type DeliverOutcome = 'accepted' | 'duplicate' | 'full' | 'stopping'

export type AgentRoute = { route: 'start' } | { route: 'queue' } | { route: 'side'; thread?: string }

const payloadSchema = z.object({
  message: z.string().refine(text => text.trim().length > 0, 'empty message'),
  // Routing always goes to the owner's chat; chatId is accepted and ignored.
  chatId: z.union([z.number(), z.string()]).optional(),
  // The gbrain worker sends the RECIPIENT here (or nothing); never the sender.
  agentId: z.string().max(256).optional(),
  fromAgent: z.string().max(256).optional(),
})

const deliveryIdPattern = /^[\w.:@/+=-]{1,200}$/u

/** Reads the KROT_AGENT_WEBHOOK_* variables. */
export function agentWebhookSettings(env: Record<string, string | undefined>): AgentWebhookConfig {
  const listen = env.KROT_AGENT_WEBHOOK_LISTEN?.trim()
  if (!listen) return { kind: 'off' }
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/u.exec(listen)
  const hostname = match?.[1] ?? match?.[2]
  const port = Number(match?.[3])
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: 'invalid', reason: 'KROT_AGENT_WEBHOOK_LISTEN must be host:port' }
  }
  const token = env.KROT_AGENT_WEBHOOK_TOKEN?.trim() || undefined
  const allowIps = (env.KROT_AGENT_WEBHOOK_ALLOW_IPS ?? '').split(',').map(normalizeIp).filter(Boolean)
  if (!token && allowIps.length === 0) {
    return { kind: 'invalid', reason: 'Set KROT_AGENT_WEBHOOK_TOKEN or KROT_AGENT_WEBHOOK_ALLOW_IPS; the listener never runs open' }
  }
  return { kind: 'on', settings: { hostname, port, ...(token ? { token } : {}), ...(allowIps.length ? { allowIps } : {}) } }
}

function normalizeIp(address: string): string {
  const trimmed = address.trim().toLowerCase()
  return trimmed.startsWith('::ffff:') && trimmed.includes('.') ? trimmed.slice(7) : trimmed
}

function safeAgentName(name: string | null | undefined): string {
  return (name ?? '').replace(/[^\p{L}\p{N}_.@-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64)
}

/** A display-safe agent name: one line, no brackets, bounded length. */
export function agentName(name: string | null | undefined): string {
  return safeAgentName(name) || 'unknown'
}

// The gbrain worker's header line; trusted only at the very start of the message.
const workerHeaderPattern = /^\[Inter-agent от ([^\s\]]+) → [^\s\]]+\]/u

export interface SenderSource {
  /** Body field fromAgent, set by the worker from the authenticated outbox row. */
  fromAgent?: string | undefined
  /** X-From-Agent request header. */
  fromHeader?: string | null | undefined
  message: string
}

export interface AgentSender {
  /** Display-safe name, 'unknown' when nothing names the sender. */
  name: string
  /** True only for a name from fromAgent or X-From-Agent, which the authenticated worker sets. */
  verified: boolean
}

/**
 * The display-safe sender of a delivery: fromAgent, else X-From-Agent (both
 * verified), else the worker header line at position 0 (a claim in the text
 * any authenticated caller can write: unverified), else 'unknown'. The body
 * agentId names the recipient and is never used.
 */
export function agentSender(source: SenderSource): AgentSender {
  for (const candidate of [source.fromAgent, source.fromHeader]) {
    const name = safeAgentName(candidate)
    if (name) return { name, verified: true }
  }
  const claimed = safeAgentName(workerHeaderPattern.exec(source.message)?.[1])
  return { name: claimed || 'unknown', verified: false }
}

// How the sender is shown to the owner and to Codex: a name only the message text claims carries a mark.
function senderLabel(name: string | undefined, verified: boolean): string {
  const safe = agentName(name)
  return verified || safe === 'unknown' ? safe : safe + unverifiedSenderMark
}

// The worker appends its delivery steps after a --- separator; the last such
// block is the worker's, earlier look-alikes stay the sender's words. The
// header may carry a variant note, e.g. "ПОРЯДОК ДЕЙСТВИЙ (ack-only fast path, …):".
const protocolStartPattern = /^---[ \t]*\r?\n(?:[ \t]*\r?\n)*(?=ПОРЯДОК ДЕЙСТВИЙ(?: \([^)\n]*\))?:[ \t]*\r?$)/gmu
const protocolLabel = '[протокол доставки gbrain (служебный, не просьба отправителя)]\n'

/** Labels the worker's delivery protocol block so Codex does not read it as the sender's request. */
function labelDeliveryProtocol(message: string): string {
  let start: number | undefined
  for (const match of message.matchAll(protocolStartPattern)) start = match.index + match[0].length
  return start === undefined ? message : message.slice(0, start) + protocolLabel + message.slice(start)
}

export interface FrameOptions {
  /** The sender name came from fromAgent or X-From-Agent; otherwise it is shown as unverified. Default true. */
  verified?: boolean
  /** The body carries fromAgent, so the trailing protocol block is the worker's. Default false. */
  workerProtocol?: boolean
}

/**
 * Frames an agent message as untrusted data for Codex; sender is the resolved sender name. The gbrain protocol
 * label is applied only for a delivery of the authenticated worker: any other caller can write that block itself.
 */
export function frameAgentMessage(message: string, sender?: string, options: FrameOptions = {}): string {
  return agentFramePrefix + senderLabel(sender, options.verified ?? true) +
    '; the owner did not write this]\n\n' + (options.workerProtocol === true ? labelDeliveryProtocol(message) : message)
}

function ownerNotice(message: string, sender: AgentSender): string {
  return 'Сообщение от агента ' + senderLabel(sender.name, sender.verified) + ': ' +
    Array.from(message.trim()).slice(0, noticeChars).join('')
}

/**
 * Where an agent message goes. Idle Codex starts a turn; a busy one queues it,
 * or opens a side thread when the parallel mode allows. Never the main turn:
 * an agent message must not steer the owner's running task.
 */
export function routeAgentMessage(text: string,
  state: { busy: boolean; parallel: ParallelSettings; sides: SideRegistry }): AgentRoute {
  if (!state.busy) return { route: 'start' }
  if (!state.parallel.enabled) return { route: 'queue' }
  const decision = routeWhileBusy({ text },
    { keywords: state.parallel.keywords, maxParallel: state.parallel.maxParallel, sides: state.sides })
  return decision.route === 'side' ? decision : { route: 'queue' }
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status })
}

async function readCapped(request: Request, cap: number): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > cap) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Starts the listener. Throws when neither a token nor an IP allowlist is set. */
export function startAgentWebhook(settings: AgentWebhookSettings,
  deliver: (delivery: AgentDelivery) => DeliverOutcome | Promise<DeliverOutcome>, log: Logger) {
  const token = settings.token || undefined
  const allowIps = new Set((settings.allowIps ?? []).map(normalizeIp).filter(Boolean))
  if (!token && allowIps.size === 0) throw new Error('The agent webhook needs a token or an IP allowlist')
  const delivered = new Set<string>()
  const pending = new Set<string>()

  const server = Bun.serve({
    hostname: settings.hostname,
    port: settings.port,
    // Bun refuses larger bodies itself; readCapped also covers chunked bodies.
    maxRequestBodySize: AGENT_WEBHOOK_BODY_LIMIT + 1024,
    async fetch(request, current) {
      const path = new URL(request.url).pathname
      if (request.method !== 'POST' || (path !== '/webhook' && path !== '/')) {
        return json(404, { ok: false, error: 'not found' })
      }
      if (allowIps.size) {
        // The socket peer only; X-Forwarded-For is caller-controlled.
        const peer = current.requestIP(request)?.address
        if (!peer || !allowIps.has(normalizeIp(peer))) {
          log.warn('Agent webhook refused a source outside the allowlist')
          return json(403, { ok: false, error: 'forbidden' })
        }
      }
      if (token && !bearerEquals(request.headers.get('authorization') ?? '', 'Bearer ' + token)) {
        log.warn('Agent webhook refused a request with a wrong bearer')
        return json(401, { ok: false, error: 'unauthorized' })
      }
      const type = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
      if (type !== 'application/json') return json(415, { ok: false, error: 'json only' })
      if (Number(request.headers.get('content-length')) > AGENT_WEBHOOK_BODY_LIMIT) {
        return json(413, { ok: false, error: 'payload too large' })
      }
      const deliveryId = request.headers.get('x-delivery-id')?.trim() || undefined
      if (deliveryId !== undefined && !deliveryIdPattern.test(deliveryId)) {
        return json(400, { ok: false, error: 'invalid delivery id' })
      }
      let body: string | undefined
      try { body = await readCapped(request, AGENT_WEBHOOK_BODY_LIMIT) } catch {
        return json(400, { ok: false, error: 'invalid body' })
      }
      if (body === undefined) return json(413, { ok: false, error: 'payload too large' })
      let raw: unknown
      try { raw = JSON.parse(body) } catch { return json(400, { ok: false, error: 'invalid json' }) }
      const parsed = payloadSchema.safeParse(raw)
      if (!parsed.success) return json(400, { ok: false, error: 'invalid payload' })
      if (deliveryId !== undefined) {
        if (delivered.has(deliveryId)) {
          log.info('Agent webhook skipped a repeated delivery')
          return json(200, { ok: true })
        }
        // A concurrent retry of a delivery still in flight is retried later.
        if (pending.has(deliveryId)) return json(503, { ok: false, error: 'delivery in progress' })
        pending.add(deliveryId)
      }
      const { message, fromAgent } = parsed.data
      const sender = agentSender({ fromAgent, fromHeader: request.headers.get('x-from-agent'), message })
      const name = sender.name
      // fromAgent is set by the worker from the authenticated outbox row: only then is the protocol block its own.
      const workerProtocol = safeAgentName(fromAgent) !== ''
      try {
        const outcome = await deliver({
          input: frameAgentMessage(message, name, { verified: sender.verified, workerProtocol }),
          notice: ownerNotice(message, sender), agentId: name, senderVerified: sender.verified,
          ...(deliveryId !== undefined ? { deliveryId } : {}),
        })
        if (outcome === 'full' || outcome === 'stopping') {
          log.warn('Agent webhook could not queue a message', { agent: name, outcome })
          return json(503, { ok: false, error: 'queue unavailable' })
        }
        if (deliveryId !== undefined) {
          delivered.add(deliveryId)
          if (delivered.size > rememberedDeliveries) delivered.delete(delivered.values().next().value!)
        }
        log.info('Agent webhook accepted a message', { agent: name, chars: message.length, outcome })
        return json(200, { ok: true })
      } catch {
        log.warn('Agent webhook could not deliver a message', { agent: name })
        return json(503, { ok: false, error: 'queue unavailable' })
      } finally {
        if (deliveryId !== undefined) pending.delete(deliveryId)
      }
    },
    error() {
      return json(500, { ok: false, error: 'internal error' })
    },
  })
  return server
}
