// File-only Brain steps for the full-scope hook dispatcher.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readBrainConfig } from '../../codex-brain/src/config.js'
import {
  CompactTriggerSchema, estimateTokens, HANDOFF_MAX_TOKENS, HOOK_STEP_BUDGET_MS, HOT_MAX_TOKENS, OpenBoundarySchema,
  PERSONAL_MEMORY_ROLES, PromptCaptureSchema, SessionSourceSchema, Sha256Schema, type SessionSource,
} from '../../codex-brain/src/contract.js'
import { FactStore } from '../../codex-brain/src/facts/store.js'
import { createHandoffBuilder } from '../../codex-brain/src/handoff/index.js'
import { openJournal } from '../../codex-brain/src/journal/index.js'
import { FilePermitStore } from '../../codex-brain/src/permit/permits.js'
import { FileReceiptStore } from '../../codex-brain/src/permit/receipts.js'
import { FileSessionRegistry } from '../../codex-brain/src/permit/sessions.js'
import { createSnapshotBuilder, FileSummaryReader, readJson, readStoredSnapshot } from '../../codex-brain/src/snapshot/index.js'
import { writeFileAtomic } from '../../codex-brain/src/store/atomic.js'
import { withLock } from '../../codex-brain/src/store/lock.js'
import { ensureScope, LOCAL_SCOPE, resolveBrainHome, safeSegment } from '../../codex-brain/src/store/paths.js'
import { scrub } from './secrets.js'
import { readTurn, updateTurn } from './state.js'
import { text, type HookContext, type HookResult } from './types.js'

const BoundaryContextSchema = OpenBoundarySchema.pick({ boundary: true }).extend({
  clearTurn: Sha256Schema.optional(),
  tail: PromptCaptureSchema.shape.prompt,
}).strict()
// Written by the bridge when it put first-turn HOT into the turn itself (plugin/src/codex/brain-bridge.ts).
const BridgeSentSchema = OpenBoundarySchema.pick({ boundary: true })

export interface BrainHookResult extends HookResult { brainCorrection?: boolean }

function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value) + '\n')
}

async function withBudget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Brain step exceeded ${HOOK_STEP_BUDGET_MS} ms`)
      controller.abort(error)
      reject(error)
    }, HOOK_STEP_BUDGET_MS)
  })
  try {
    return await Promise.race([work(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

function appendHandoff(hot: string, handoff: string): string {
  if (!handoff) return hot
  const prefix = hot && !hot.endsWith('\n') ? hot + '\n' : hot
  const lines = handoff.split('\n')
  while (lines.length && estimateTokens(prefix + lines.join('\n')) > HOT_MAX_TOKENS + HANDOFF_MAX_TOKENS) lines.pop()
  return prefix + lines.join('\n')
}

export function runBrainStep(ctx: HookContext, phase: 'before' | 'final' = 'before'): Promise<BrainHookResult> {
  return withBudget(async signal => {
    const sessionId = text(ctx.input.session_id)
    if (!sessionId.trim()) return {}
    const source = SessionSourceSchema.safeParse(ctx.input.source)
    if (ctx.event === 'SessionStart' && (!source.success || source.data === 'fork')) return {}
    const brainHome = resolveBrainHome({ CODEX_HOME: ctx.codexHome })
    const home = statSync(brainHome, { throwIfNoEntry: false })
    if (home && !home.isDirectory()) throw new Error('Brain home is not a directory')
    const config = readBrainConfig(brainHome)
    if (!config.enabled) return {}
    if (ctx.event === 'SessionStart' && source.data === 'resume' && !config.resume_reemit) return {}

    const clock = { now: () => new Date(ctx.now()) }
    const sessions = new FileSessionRegistry(brainHome)
    // Only a registered session gets memory. A live bridge intent is not proof that this session is the
    // bridge thread (any session starting in the window could claim it); the bridge registers its own
    // threads and injects first-turn HOT itself when the hook gave nothing.
    const entry = await sessions.resolve(sessionId)
    if (!entry || !PERSONAL_MEMORY_ROLES.includes(entry.role) || (entry.role === 'terminal') !== (entry.scope === LOCAL_SCOPE)) return {}

    const { scope, role } = entry
    const journal = openJournal(brainHome, scope, clock)
    const { paths } = journal
    const facts = new FactStore(brainHome, scope, { clock })
    const options = { brainHome, scope, facts, sessions, clock }
    const snapshot = createSnapshotBuilder({ ...options, recent: journal.recent, summaries: new FileSummaryReader(paths) })
    const handoff = createHandoffBuilder({ ...options, journal: journal.reader })
    const permits = new FilePermitStore(brainHome, scope)
    const turnId = text(ctx.input.turn_id)
    const terminal = role === 'terminal'
    const boundaryContextFile = paths.boundary(sessionId) + '.context'
    const lockDir = paths.boundary(sessionId) + '.lock'
    const bridgeSentFile = join(paths.snapshotDir, safeSegment(sessionId) + '.bridge.json')

    // The builders take the scope lock internally. This separate session lock serializes full
    // steps across processes, including the boundary decision and terminal read/append/remove.
    const inSession = async (work: () => Promise<HookResult>): Promise<HookResult> => {
      signal.throwIfAborted()
      mkdirSync(lockDir, { recursive: true, mode: 0o700 })
      return withLock(lockDir, async () => {
        signal.throwIfAborted()
        const latest = await sessions.resolve(sessionId)
        if (latest?.role !== role || latest.scope !== scope || !readBrainConfig(brainHome).enabled) return {}
        return work()
      })
    }

    const sessionStart = async (source: SessionSource): Promise<HookResult> => {
      if (source === 'resume') return { context: scrub(ctx, readStoredSnapshot(paths, sessionId)?.text ?? '') }
      return inSession(async () => {
        const open = await snapshot.openBoundary(sessionId)
        const cached = readJson(boundaryContextFile, BoundaryContextSchema)
        // Startup identifies the session itself. Clear can carry the turn that requested it.
        const clearTurn = source === 'clear' && turnId ? createHash('sha256').update(turnId).digest('hex') : undefined
        const reuse = open?.source === source && (source !== 'clear' || cached?.boundary !== open.boundary || cached.clearTurn === clearTurn)
        // The bridge already put this boundary's HOT into the first turn: emitting it again would duplicate it.
        if (reuse && readJson(bridgeSentFile, BridgeSentSchema)?.boundary === open.boundary) return {}
        const boundary = reuse ? open.boundary : await snapshot.beginBoundary(sessionId, source)
        signal.throwIfAborted()
        const hot = await snapshot.build({ sessionId, source, boundary })
        signal.throwIfAborted()
        if (!hot) return {}
        if (source === 'compact') return { context: scrub(ctx, appendHandoff(hot, await handoff.take(sessionId))) }
        const tail = cached?.boundary === boundary ? cached.tail : scrub(ctx, await snapshot.recentTail())
        signal.throwIfAborted()
        if (cached?.boundary !== boundary) writeJson(boundaryContextFile, { boundary, clearTurn, tail })
        return { context: scrub(ctx, tail ? [hot, tail].join(hot.endsWith('\n') ? '\n' : '\n\n') : hot) }
      })
    }

    switch (ctx.event) {
      case 'SessionStart':
        return source.success ? sessionStart(source.data) : {}
      case 'PreCompact': {
        const trigger = CompactTriggerSchema.safeParse(ctx.input.trigger)
        if (!trigger.success) return {}
        return inSession(async () => {
          const open = await snapshot.openBoundary(sessionId)
          const stored = readStoredSnapshot(paths, sessionId)
          if (open?.source === 'compact' && stored?.meta.boundary !== open.boundary) {
            const current = await handoff.current()
            if (current?.session_id === sessionId && !current.delivered) return {}
          }
          await journal.writer.flush()
          signal.throwIfAborted()
          await handoff.write({ sessionId, ...(turnId ? { turnId } : {}), trigger: trigger.data })
          signal.throwIfAborted()
          await snapshot.beginBoundary(sessionId, 'compact')
          return {}
        })
      }
      case 'UserPromptSubmit': {
        const prompt = text(ctx.input.prompt)
        if (terminal && turnId && prompt.trim()) await inSession(async () => {
          if (existsSync(paths.permit(turnId)) || existsSync(paths.prompt(turnId))) return {}
          ensureScope(brainHome, scope)
          writeJson(paths.prompt(turnId), PromptCaptureSchema.parse({
            session_id: sessionId, turn_id: turnId, prompt: scrub(ctx, prompt), at: clock.now().toISOString(),
          }))
          return {}
        })
        signal.throwIfAborted()
        const delta = await snapshot.delta(sessionId)
        return { context: scrub(ctx, delta), brainCorrection: true }
      }
      case 'Stop':
        if (!turnId) return {}
        if (phase === 'before' && !terminal) {
          const permit = await permits.get(turnId)
          if (permit?.session_id !== sessionId || permit.origin !== 'owner-direct' || !permit.cue
            || Date.parse(permit.expires) <= ctx.now()) return {}
          return inSession(async () => {
            const receipt = await new FileReceiptStore(brainHome, scope).get(turnId)
            signal.throwIfAborted()
            if (receipt || ctx.input.stop_hook_active === true || readTurn(ctx).stopReturned) return {}
            updateTurn(ctx, current => { current.stopReturned = true })
            return { block: 'Was there an owner correction or decision in this turn, and is it saved? Save it with `brain remember` or say why not.' }
          })
        }
        if (phase !== 'final' || !terminal) return {}
        const file = paths.prompt(turnId)
        if (!existsSync(file)) return {}
        return inSession(async () => {
          const capture = readJson(file, PromptCaptureSchema)
          if (capture?.session_id !== sessionId || capture.turn_id !== turnId) return {}
          if (existsSync(paths.permit(turnId)) || (ctx.input.stop_hook_active === true && !readTurn(ctx).stopReturned)) {
            rmSync(file, { force: true })
            return {}
          }
          const reply = text(ctx.input.last_assistant_message)
          if (!reply.trim()) return {}
          const key = 'terminal:' + createHash('sha256').update(JSON.stringify([sessionId, turnId])).digest('hex')
          const ref = await journal.writer.bind({
            key, origin: 'terminal', input_kind: 'text', input: capture.prompt, thread: sessionId, turn: turnId, ts_in: capture.at,
          })
          signal.throwIfAborted()
          const exchange = await journal.reader.get(ref)
          if (!exchange) throw new Error('Terminal journal exchange is missing after bind')
          if (exchange.status === 'bound') await journal.writer.answered(ref, scrub(ctx, reply))
          signal.throwIfAborted()
          if (exchange.status !== 'delivered') await journal.writer.delivered(ref)
          rmSync(file, { force: true })
          return {}
        })
      default:
        return {}
    }
  })
}
