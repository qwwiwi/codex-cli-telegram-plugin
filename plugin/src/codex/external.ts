import { createHash, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  AskUserQuestionRequestSchema, PermissionRequestRouteSchema, ReactRouteRequestSchema,
  WebhookMessagePayloadSchema, type AskUserQuestionRequest,
} from '../schemas.js'
import {
  ASK_BODY_LIMIT_BYTES, BODY_LIMIT_BYTES, PERMISSION_REQUEST_BODY_LIMIT_BYTES, REACT_BODY_LIMIT_BYTES,
  authGate, readBodyWithCap, reply,
} from '../webhook/http.js'
import { object } from './rpc.js'
import type { ApprovalDecision, ApprovalRequest, PolicyApprovalRequest } from './session.js'

type Queue = (request: string, id: number) => 'accepted' | 'duplicate' | 'full' | 'stopping'
type PolicyApproval = {
  token: string
  request: (approval: PolicyApprovalRequest) => Promise<ApprovalDecision>
  legacy?: { timeoutMs: number; request: (approval: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision> }
}
type QuestionInput = {
  id: string; question: string; isOther: true; multiSelect: boolean
  options: { label: string; description: string }[]
}
type ExternalTaskOptions = {
  agentId?: string
  ask?: { timeoutMs: number; request: (questions: QuestionInput[], signal: AbortSignal) =>
    Promise<Record<string, { answers: string[] }> | undefined> }
  react?: (messageId: number) => Promise<boolean>
}

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
const receipt = ReactRouteRequestSchema.extend({
  message_id: z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().safe().positive()),
  emoji: z.literal('👀').default('👀'),
}).strict()
const legacyPermission = PermissionRequestRouteSchema.extend({
  session_id: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(256),
}).strict()

const questionPath = '/hooks/ask-user-question/request'
const answerPath = '/hooks/ask-user-question/answer'
const approvalPath = '/hooks/permission/request'
const receiptPath = '/hooks/react'
const fallbackPath = '/hooks/fallback-reply'

async function waitForOwner<T>(res: ServerResponse, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const disconnected = new AbortController()
  const cancel = () => disconnected.abort()
  const socket = res.socket
  res.once('close', cancel)
  socket?.once('close', cancel)
  if (res.destroyed || socket?.destroyed) cancel()
  const signal = AbortSignal.any([deadline, disconnected.signal])
  try {
    const result = await run(signal)
    return { result, timedOut: deadline.aborted, disconnected: disconnected.signal.aborted }
  } finally {
    res.off('close', cancel)
    socket?.off('close', cancel)
  }
}

function questionCards(questions: AskUserQuestionRequest['questions']): QuestionInput[] {
  return questions.map(({ header, question, multiSelect, options }, index) => ({
    id: String(index),
    // Keep an explicit source label ahead of the caller's text so this card
    // cannot be interpreted as a native Codex lease request.
    question: 'Вопрос от локальной службы. Она получит ответ.\n\n' + header + '\n' + question,
    isOther: true,
    multiSelect,
    options: options.map(({ label, description, preview }) => ({
      label, description: [description, preview].filter(Boolean).join('\n'),
    })),
  }))
}

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

export async function startExternalTasks(port: number, token: string, chatId: string, enqueue: Queue,
  policy?: PolicyApproval, options: ExternalTaskOptions = {}) {
  const dedicatedPolicy = policy?.token !== token ? policy : undefined
  const agentId = options.agentId ?? 'krotov'
  const savedAnswers = new Map<string, { digest: string; answers: Record<string, string>; at: number }>()
  let asking = false

  const server = createServer((req, res) => {
    void (async () => {
      const path = req.url?.split('?', 1)[0]
      if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
        return reply(res, 200, { status: 'ok' })
      }
      const approvalRoute = path === approvalPath ? dedicatedPolicy : undefined
      if (req.method !== 'POST' || (path !== '/hooks/agent' && !approvalRoute &&
          path !== questionPath && path !== answerPath && path !== receiptPath && path !== fallbackPath)) {
        return reply(res, 404, { error: 'not found' })
      }
      if (!authGate(req, res, approvalRoute ? approvalRoute.token : token)) return
      // Only a verified Telegram event can answer a card. Legacy fallback
      // bodies have no turn binding, while the Codex inbox delivers final
      // replies using its persisted ready outcome.
      if (path === answerPath) return reply(res, 403, { status: 'unauthorized' })
      if (path === fallbackPath) return reply(res, 503, { status: 'fallback_reply_unavailable' })
      if (path === receiptPath && !options.react) return reply(res, 503, { status: 'reactions_unavailable' })
      const limit = path === questionPath ? ASK_BODY_LIMIT_BYTES : path === receiptPath ? REACT_BODY_LIMIT_BYTES
        : approvalRoute ? PERMISSION_REQUEST_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES
      if (Number(req.headers['content-length']) > limit) return reply(res, 413, { error: 'payload too large' })
      const body = await readBodyWithCap(req, limit)
      if (body.tooLarge) return reply(res, 413, { error: 'payload too large' })
      let raw: unknown
      try { raw = JSON.parse(body.buf.toString('utf8')) } catch { return reply(res, 400, { error: 'invalid json' }) }
      if (path === receiptPath && options.react) {
        const parsed = receipt.safeParse(raw)
        if (!parsed.success) return reply(res, 400, { error: 'invalid payload' })
        if (parsed.data.chat_id !== chatId) return reply(res, 403, { error: 'chatId not in allowlist' })
        try {
          if (!await options.react(parsed.data.message_id)) return reply(res, 403, { error: 'unknown inbound message' })
          return reply(res, 200, { status: 'reacted' })
        } catch { return reply(res, 200, { status: 'react_failed' }) }
      }
      if (path === questionPath) {
        const parsed = AskUserQuestionRequestSchema.strict().safeParse(raw)
        if (!parsed.success) return reply(res, 400, { error: 'invalid payload' })
        const ask = options.ask
        if (!ask) return reply(res, 200, { status: 'pass_through' })
        const { session_id, tool_use_id, questions, timeout_ms } = parsed.data
        const key = JSON.stringify([session_id, tool_use_id])
        const digest = createHash('sha256').update(JSON.stringify(questions)).digest('hex')
        const saved = savedAnswers.get(key)
        if (saved && Date.now() - saved.at < 60_000) {
          if (saved.digest !== digest) return reply(res, 409, { error: 'question request changed' })
          return reply(res, 200, { status: 'answered', updatedInput: { questions, answers: saved.answers } })
        }
        if (asking) return reply(res, 503, { error: 'question relay busy' })
        asking = true
        try {
          const timeout = Math.min(ask.timeoutMs, timeout_ms ?? 3_600_000)
          const outcome = await waitForOwner(res, timeout, signal => ask.request(questionCards(questions), signal))
          if (outcome.disconnected) return
          const result = outcome.result
          if (!outcome.timedOut && result === undefined) return reply(res, 200, { status: 'pass_through' })
          const answers = questions.flatMap(({ question }, index) => {
            const values = result?.[String(index)]?.answers
            return values?.length ? [[question, values.join(', ')] as const] : []
          })
          if (outcome.timedOut || answers.length !== questions.length) {
            return reply(res, 200, { status: 'timeout', reason: 'Question closed without a complete answer' })
          }
          const byQuestion = Object.fromEntries(answers)
          savedAnswers.delete(key)
          if (savedAnswers.size >= 16) savedAnswers.delete(savedAnswers.keys().next().value!)
          savedAnswers.set(key, { digest, answers: byQuestion, at: Date.now() })
          return reply(res, 200, { status: 'answered', updatedInput: { questions, answers: byQuestion } })
        } finally { asking = false }
      }
      if (approvalRoute) {
        if (Object.hasOwn(object(raw), 'tool_name')) {
          const parsed = legacyPermission.safeParse(raw)
          const legacy = approvalRoute.legacy
          // The old Bash hook clips its preview at 400 characters. Only a
          // shorter preview shows the entire command it asks to authorize.
          if (!parsed.success || !legacy || parsed.data.tool_name !== 'Bash' ||
              !parsed.data.preview.trim() || parsed.data.preview.length >= 400) {
            return reply(res, 200, { status: 'deny' })
          }
          const { timeout_ms, preview, reason } = parsed.data
          const timeout = Math.min(legacy.timeoutMs, timeout_ms ?? legacy.timeoutMs, 3_600_000)
          const outcome = await waitForOwner(res, timeout,
            signal => legacy.request({ kind: 'command', target: preview, reason: reason.slice(0, 400) }, signal))
          if (outcome.disconnected) return
          return reply(res, 200, { status: outcome.timedOut ? 'timeout' : outcome.result === 'accept' ? 'allow' : 'deny' })
        }
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
        if (payload.data.agentId !== undefined && payload.data.agentId !== agentId) {
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
