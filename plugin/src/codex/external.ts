import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { z } from 'zod'
import { WebhookMessagePayloadSchema } from '../schemas.js'
import { bearerEquals, readBody, reply } from '../webhook/http.js'
import { object } from './rpc.js'
import type { ApprovalDecision, PolicyApprovalRequest } from './session.js'

type Queue = (request: string, id: number) => 'accepted' | 'duplicate' | 'full' | 'stopping'
type PolicyApproval = { token: string; request: (approval: PolicyApprovalRequest) => Promise<ApprovalDecision> }

const taskId = z.union([z.string(), z.number().int().safe().positive()])
const metadata = z.string().max(512)
const taskText = z.string().max(64 * 1024)
const legacyTask = z.object({
  task_id: taskId.optional(),
  _task_id: taskId.optional(),
  from_agent: metadata.optional(),
  from: metadata.optional(),
  title: metadata.optional(),
  body: taskText.optional(),
  context: taskText.optional(),
  _delivery_id: taskId.optional(),
}).strict()

function readLegacyTask(value: unknown): { taskId: string; message: string } | undefined {
  const parsed = legacyTask.safeParse(value)
  if (!parsed.success) return
  const data = parsed.data
  const id = String(data.task_id || data._task_id || '')
  if (id === 'no-id' || !/^[a-z0-9._:-]{1,64}$/i.test(id)) return
  if (![data.title, data.body, data.context].some(part => part?.trim())) return
  const message = 'Задача из локального webhook. Метаданные отправителя приведены для справки.\n\n' +
    JSON.stringify({ task_id: id, from_agent: data.from_agent || data.from || 'unknown',
      title: data.title, body: data.body, context: data.context }, null, 2)
  if (message.length > 64 * 1024) return
  return { taskId: id, message }
}

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
      const key = req.headers['idempotency-key'] ?? randomUUID()
      if (typeof key !== 'string' || !/^[\w.:-]{1,128}$/u.test(key)) {
        return reply(res, 400, { error: 'invalid idempotency key' })
      }
      const legacy = payload.success ? undefined : readLegacyTask(raw)
      let message: string
      if (payload.success) {
        if (!payload.data.message.trim()) return reply(res, 400, { error: 'invalid payload' })
        if (payload.data.chatId !== chatId) return reply(res, 403, { error: 'chatId not in allowlist' })
        if (payload.data.agentId !== undefined && !['dashi-channel', 'example-agent'].includes(payload.data.agentId)) {
          return reply(res, 404, { error: 'agent not found' })
        }
        message = payload.data.message
      } else {
        if (!legacy) return reply(res, 400, { error: 'invalid payload' })
        message = legacy.message
      }
      const id = -1 - createHash('sha256')
        .update(legacy ? 'krot-legacy-task:' + legacy.taskId : 'krot-external:' + key).digest().readUIntBE(0, 6)
      const result = enqueue(message, id)
      if (result === 'full' || result === 'stopping') return reply(res, 503, { error: 'queue unavailable' })
      reply(res, 200, { status: 'accepted', ...(legacy ? { task_id: legacy.taskId } : {}) })
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
