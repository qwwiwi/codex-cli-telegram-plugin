import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebhookMessagePayloadSchema } from '../schemas.js'
import { bearerEquals, readBody, reply } from '../webhook/http.js'
import { object } from './rpc.js'
import type { ApprovalDecision, PolicyApprovalRequest } from './session.js'

type Queue = (request: string, id: number) => 'accepted' | 'duplicate' | 'full' | 'stopping'
type PolicyApproval = { token: string; request: (approval: PolicyApprovalRequest) => Promise<ApprovalDecision> }

export async function startExternalTasks(port: number, token: string, chatId: string, enqueue: Queue, policy?: PolicyApproval) {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        return reply(res, 200, { status: 'ok' })
      }
      const approvalRoute = req.url === '/hooks/permission/request' && policy
      if (req.method !== 'POST' || (req.url !== '/hooks/agent' && !approvalRoute)) return reply(res, 404, { error: 'not found' })
      if (!bearerEquals(req.headers.authorization ?? '', 'Bearer ' + (approvalRoute ? approvalRoute.token : token))) {
        return reply(res, 401, { error: 'unauthorized' })
      }
      const body = await readBody(req)
      if (body.tooLarge) return reply(res, 413, { error: 'payload too large' })
      let raw: unknown
      try { raw = JSON.parse(body.buf.toString('utf8')) } catch { return reply(res, 400, { error: 'invalid json' }) }
      if (approvalRoute) {
        const { kind, target, cwd, reason, operation } = object(raw)
        if ((kind !== 'command' && kind !== 'file') || typeof target !== 'string' || !target.trim() ||
            target.length > 3000 || (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 1000))) {
          return reply(res, 400, { decision: 'decline' })
        }
        const { threadId, turnId, itemId } = object(operation)
        const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w:-]{1,128}$/u.test(id)
        if (operation !== undefined && (!validId(threadId) || !validId(turnId) || !validId(itemId))) {
          return reply(res, 400, { decision: 'decline' })
        }
        const decision = await approvalRoute.request({ kind, target, ...(typeof cwd === 'string' ? { cwd } : {}),
          ...(typeof reason === 'string' ? { reason: reason.slice(0, 400) } : {}),
          ...(validId(threadId) && validId(turnId) && validId(itemId) ? { operation: { threadId, turnId, itemId } } : {}) })
        return reply(res, 200, { decision })
      }
      const payload = WebhookMessagePayloadSchema.safeParse(raw)
      if (!payload.success || !payload.data.message.trim()) return reply(res, 400, { error: 'invalid payload' })
      if (payload.data.chatId !== chatId) return reply(res, 403, { error: 'chatId not in allowlist' })
      if (payload.data.agentId !== undefined && !['dashi-channel', 'example-agent'].includes(payload.data.agentId)) {
        return reply(res, 404, { error: 'agent not found' })
      }
      const key = req.headers['idempotency-key'] ?? randomUUID()
      if (typeof key !== 'string' || !/^[\w.:-]{1,128}$/u.test(key)) {
        return reply(res, 400, { error: 'invalid idempotency key' })
      }
      const id = -1 - createHash('sha256').update('krot-external:' + key).digest().readUIntBE(0, 6)
      const result = enqueue(payload.data.message, id)
      if (result === 'full' || result === 'stopping') return reply(res, 503, { error: 'queue unavailable' })
      reply(res, 200, { status: 'accepted' })
    })().catch(() => { if (!res.headersSent) reply(res, 503, { error: 'queue unavailable' }) })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return server
}
