import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readBrainConfig, writeBrainConfig } from '../../../codex-brain/src/config.js'
import {
  DaySchema, HandoffSchema, OpenQuestionsSchema, PERMIT_TTL_MS, PlanStateSchema, PlanStepSchema, PRIORITY_MAX_TOKENS,
  SummarizerStateSchema, estimateTokens, formatIndexLine, type BrainPort, type BrainStatus,
  type Clock, type CompactionEvent, type MemoryRequest, type SessionIntent, type SessionRole, type Summarizer,
  type TurnNotice, type TurnStartInput, type TurnTicket,
} from '../../../codex-brain/src/contract.js'
import { FactStore } from '../../../codex-brain/src/facts/store.js'
import { createHandoffBuilder } from '../../../codex-brain/src/handoff/index.js'
import { openJournal } from '../../../codex-brain/src/journal/index.js'
import { permitKeyHash } from '../../../codex-brain/src/permit/gate.js'
import { FilePermitStore } from '../../../codex-brain/src/permit/permits.js'
import { FileProposalStore } from '../../../codex-brain/src/permit/proposals.js'
import { FileReceiptStore } from '../../../codex-brain/src/permit/receipts.js'
import { FileSessionRegistry } from '../../../codex-brain/src/permit/sessions.js'
import { createSnapshotBuilder, readJson, readStoredSnapshot } from '../../../codex-brain/src/snapshot/index.js'
import { writeFileAtomic } from '../../../codex-brain/src/store/atomic.js'
import { ensureScope, homePaths, safeSegment, writeDefaultScope } from '../../../codex-brain/src/store/paths.js'
import { createBrainJobs } from '../../../codex-brain/src/summary/jobs.js'
import { FileSummaryReader } from '../../../codex-brain/src/summary/reader.js'
import { lockFor } from '../memory/_mutex.js'
import { redactSecrets } from '../safety/redact.js'
import { BRAIN_UNAVAILABLE, createBrainCommands } from './brain-commands.js'
import { migrateLearning } from './brain-migrate.js'
import { CodexRpc, object, type CodexEvent, type Json } from './rpc.js'

export interface BrainOptions {
  brainHome: string
  scope: string
  legacyRoot?: string
  clock?: Clock
  secrets?: readonly string[]
  /**
   * The bridge appends every turn permit key it mints here and drops old ones. Pass the array the
   * caller redacts outgoing text with, so a key the model repeats never reaches a chat or a log.
   */
  issuedKeys?: string[]
  summarizer?: Summarizer
  warn?: (message: string) => void
}

interface BridgeInput extends TurnStartInput {
  tsIn?: string
}

type RpcRequest = (method: string, params: Json, timeout?: number) => Promise<Json>
type BridgeRole = SessionIntent['role']
interface ExecutionState {
  role: BridgeRole
  input?: BridgeInput
  ticket?: TurnTicket
  unavailable: boolean
  turnId?: string
  permit?: string
  /** The key put into this turn's text; only its sha256 is stored in the permit. */
  permitKey?: string
}

const ContextSent = z.object({ boundary: z.string() })
/** First-turn context prepared for a boundary; `handoff` is the `written` stamp of the handoff it includes. */
const PreparedContext = z.object({ boundary: z.string(), text: z.string(), handoff: z.string().optional() })
type PreparedPayload = z.infer<typeof PreparedContext>
const PendingDelta = z.object({ text: z.string(), through: z.number().int().positive().optional() })
interface PreparedFirstTurn extends PreparedPayload { sessionId: string }
/** Minted keys kept for redaction; a key is useful only while its turn permit lives. */
const KEPT_PERMIT_KEYS = 32

function permitInstruction(key: string): string {
  return `Brain turn key: ${key}. Add \`--permit ${key}\` to every \`brain remember\`, \`brain pin\`, \`brain task\`, ` +
    '`brain done`, `brain forget` and `brain note` call in this turn. Never repeat the key in a reply.'
}

export function createBrainBridge(options: BrainOptions) {
  const { brainHome, scope, secrets = [], clock = { now: () => new Date() } } = options
  const issuedKeys = options.issuedKeys ?? []
  const minted: string[] = []
  const clean = (text: string) => redactSecrets(text, issuedKeys === secrets ? secrets : [...secrets, ...issuedKeys])

  function mintPermitKey(): string {
    const key = randomBytes(18).toString('hex')
    issuedKeys.push(key)
    minted.push(key)
    while (minted.length > KEPT_PERMIT_KEYS) {
      const old = minted.shift()
      const index = old === undefined ? -1 : issuedKeys.indexOf(old)
      if (index >= 0) issuedKeys.splice(index, 1)
    }
    return key
  }
  const config = () => readBrainConfig(brainHome)
  const journal = openJournal(brainHome, scope, clock)
  const { paths } = journal
  const facts = new FactStore(brainHome, scope, { clock })
  const permits = new FilePermitStore(brainHome, scope)
  const proposals = new FileProposalStore(brainHome, scope)
  const receipts = new FileReceiptStore(brainHome, scope)
  const sessions = new FileSessionRegistry(brainHome)
  const summaries = new FileSummaryReader(paths)
  const snapshot = createSnapshotBuilder({ brainHome, scope, facts, recent: journal.recent, summaries, sessions, clock })
  const handoff = createHandoffBuilder({ brainHome, scope, facts, journal: journal.reader, sessions, clock })
  const jobs = options.summarizer && createBrainJobs({ brainHome, scope, journal: journal.reader, proposals, receipts, clock,
    summarizer: (prompt, schema, signal) => options.summarizer!(clean(prompt), schema, signal) })
  const executions = new AsyncLocalStorage<ExecutionState>()
  // Set only while the session opens its main conversation (thread/start, thread/fork, thread/resume).
  const mainOpens = new AsyncLocalStorage<true>()
  const startupLock = lockFor(paths.stateDir + ':thread-start')
  const permitLock = lockFor(paths.stateDir + ':turn-permits')
  const contextLock = lockFor(paths.stateDir + ':context')
  const deliveryLock = lockFor(paths.stateDir + ':delivery')
  const active = new Map<string, ExecutionState>()
  // `mayWrite`: the turn gets a write permit (an owner caption on media needs a memory cue).
  const ticketState = new WeakMap<TurnTicket, { cue: boolean; mayWrite: boolean; unavailable: boolean; turnId?: string }>()
  const compacting = new Map<string, 'started' | 'completed'>()
  const foreignTurns = new Set<ExecutionState>()
  const livePermits = new Set<string>()
  const lastDeliveryPath = join(paths.stateDir, 'handoff-delivered.json')
  let hookState: Pick<BrainStatus, 'hooks' | 'precompact'> = { hooks: 'none', precompact: 'not-installed' }
  let nativeMemories = false
  let migrationWarning = false
  let jobsAbort = new AbortController()
  let stopped = false
  let runningJob = false
  let queuedJob = false
  let forceNextJob = false

  function warn(message: string) {
    options.warn?.(message)
  }

  function reportFailure(message: string, ticket?: TurnTicket): void {
    warn(message)
    const execution = executions.getStore()
    if (execution) execution.unavailable = true
    const state = ticket && ticketState.get(ticket)
    if (state) state.unavailable = true
  }

  /**
   * The single writer of session roles. An absent entry is written; the same scope and role is kept;
   * another role or scope is refused and nothing is written, so a guest or side thread never becomes
   * the owner's (and the owner's never becomes a guest's).
   */
  async function registerThread(sessionId: string, role: SessionRole): Promise<'registered' | 'kept' | 'refused'> {
    const existing = await sessions.resolve(sessionId)
    if (existing) {
      if (existing.scope === scope && existing.role === role) return 'kept'
      warn('Brain refused to register thread ' + sessionId + ' as ' + role + ': it is already ' + existing.role)
      return 'refused'
    }
    await sessions.register({ scope, session_id: sessionId, thread_id: sessionId, role, registered: clock.now().toISOString() })
    return 'registered'
  }

  async function isOwner(sessionId: string): Promise<boolean> {
    const entry = await sessions.resolve(sessionId)
    return entry?.scope === scope && entry.role === 'owner'
  }

  async function migrate() {
    if (!config().enabled || !options.legacyRoot) return { facts: 0, proposals: 0, exchanges: 0 }
    return migrateLearning({ root: options.legacyRoot, paths, facts, proposals, writer: journal.writer, clock, secrets, warn })
  }

  async function migrateIfPossible(): Promise<void> {
    try {
      await migrate()
      migrationWarning = false
    } catch {
      if (!migrationWarning) warn('Brain could not finish the legacy learning migration')
      migrationWarning = true
    }
  }

  function scheduleJobs(force = false): void {
    if (!jobs || stopped || !config().enabled) return
    queuedJob = true
    forceNextJob ||= force
    if (runningJob) return
    runningJob = true
    const signal = jobsAbort.signal
    // Start after yielding so jobs cannot delay the reply or acquire the journal lock ahead of it.
    setTimeout(() => {
      void (async () => {
        while (queuedJob && !signal.aborted && config().enabled) {
          const batch = forceNextJob
          queuedJob = false
          forceNextJob = false
          try { await jobs.summarize(signal, batch) } catch { if (!signal.aborted) warn('Brain rolling summary failed') }
          if (signal.aborted || !config().enabled) break
          try {
            await jobs.sealDays(signal)
            if (jobs.lastSealErrors().length) warn('Brain day sealing reported errors')
          } catch { if (!signal.aborted) warn('Brain day sealing failed') }
        }
      })().finally(() => {
        runningJob = false
        if (queuedJob && !jobsAbort.signal.aborted) scheduleJobs()
      })
    }, 0).unref()
  }

  async function start(purgeStalePermits = true) {
    if (!config().enabled) return
    try {
      ensureScope(brainHome, scope)
      writeDefaultScope(brainHome, scope)
      if (purgeStalePermits) await permitLock.run(async () => {
        for (const permit of await permits.all()) await clearPermit(permit.turn_id)
      })
      await migrateIfPossible()
      scheduleJobs()
    } catch { reportFailure('Brain setup or migration failed') }
  }

  async function clearPermit(turnId: string) {
    await permits.remove(turnId)
    livePermits.delete(turnId)
  }

  async function setEnabled(enabled: boolean) {
    await permitLock.run(async () => {
      await writeBrainConfig(brainHome, { enabled })
      if (!enabled) {
        jobsAbort.abort()
        queuedJob = false
        forceNextJob = false
        for (const id of livePermits) await clearPermit(id).catch(() => warn('Brain permit cleanup failed'))
      }
    })
    if (enabled) {
      if (jobsAbort.signal.aborted) jobsAbort = new AbortController()
      await start(false)
    }
  }

  function degraded() {
    return hookState.precompact === 'not-installed' || hookState.hooks === 'none' || hookState.hooks === 'user-needs-review'
  }

  async function journalBytes(): Promise<number> {
    let bytes = 0
    for (const directory of [paths.journalDir, paths.archiveDir]) {
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names.filter(name => /\.(jsonl|tar\.gz)$/u.test(name))) {
        bytes += await stat(join(directory, name)).then(file => file.size, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0
          throw error
        })
      }
    }
    return bytes
  }

  const sentFile = (sessionId: string) => join(paths.snapshotDir, safeSegment(sessionId) + '.bridge.json')
  const preparedFile = (sessionId: string) => join(paths.snapshotDir, safeSegment(sessionId) + '.bridge.pending.json')
  // Memory changes for a turn Codex has not accepted yet.
  const deltaFile = (sessionId: string) => join(paths.snapshotDir, safeSegment(sessionId) + '.bridge.delta.json')

  /**
   * Builds (or reloads) the first-turn context of an open boundary without marking anything sent.
   * The payload is persisted, so a turn/start that Codex rejects is retried with the same bytes.
   */
  async function prepareFirstTurn(sessionId: string): Promise<PreparedFirstTurn | null> {
    if (!config().enabled) return null
    try {
      return await contextLock.run(async () => {
        if (!await isOwner(sessionId)) return null
        let open = await snapshot.openBoundary(sessionId)
        // Working hooks own an open boundary. No boundary means the SessionStart hook gave nothing
        // (the thread was not registered yet when it started), so the bridge injects first-turn HOT.
        if (open && !degraded()) return null
        if (!open) {
          await snapshot.beginBoundary(sessionId, 'startup')
          open = await snapshot.openBoundary(sessionId)
        }
        if (!open || readJson(sentFile(sessionId), ContextSent)?.boundary === open.boundary) return null
        const existing = readStoredSnapshot(paths, sessionId)
        if (existing?.meta.boundary === open.boundary &&
            (hookState.hooks === 'managed' || hookState.hooks === 'user-trusted') && !compacting.has(sessionId)) return null
        const saved = readJson(preparedFile(sessionId), PreparedContext)
        if (saved?.boundary === open.boundary) return { sessionId, ...saved }
        const hot = await snapshot.build({ sessionId, source: open.source, boundary: open.boundary })
        const current = await handoff.current()
        const fresh = current?.session_id === sessionId && current.delivered === undefined ? current : null
        const payload: PreparedPayload = {
          boundary: open.boundary, text: clean([hot, fresh ? handoff.render(fresh) : ''].filter(Boolean).join('\n\n')),
          ...(fresh ? { handoff: fresh.written } : {}),
        }
        ensureScope(brainHome, scope)
        writeFileAtomic(preparedFile(sessionId), JSON.stringify(payload) + '\n')
        return { sessionId, ...payload }
      })
    } catch {
      reportFailure('Brain could not load first-turn context')
      return null
    }
  }

  /** After Codex accepted the turn carrying it: the boundary counts as sent and its handoff as delivered. */
  async function commitFirstTurn(prepared: PreparedFirstTurn): Promise<boolean> {
    const { sessionId } = prepared
    try {
      await contextLock.run(async () => {
        const current = await handoff.current()
        if (prepared.handoff !== undefined && current?.session_id === sessionId && current.written === prepared.handoff &&
            current.delivered === undefined) {
          await handoff.take(sessionId)
          const delivered = await handoff.current()
          if (delivered?.session_id === sessionId && delivered.delivered) {
            writeFileAtomic(lastDeliveryPath, JSON.stringify(delivered) + '\n')
          }
        }
        writeFileAtomic(sentFile(sessionId), JSON.stringify({ boundary: prepared.boundary }) + '\n')
        rmSync(preparedFile(sessionId), { force: true })
        compacting.delete(sessionId)
      })
      scheduleJobs(true)
      return true
    } catch {
      reportFailure('Brain could not record the delivered first-turn context')
      return false
    }
  }

  const port: BrainPort = {
    async sessionStarting(role) {
      if (!config().enabled) return null
      try { return (await sessions.intend({ scope, role }, clock.now())).id } catch {
        reportFailure('Brain session intent could not be saved')
        return null
      }
    },

    async sessionStarted(sessionId, role, intent) {
      try {
        if (config().enabled) await registerThread(sessionId, role === 'terminal' ? 'guest' : role)
      } catch { reportFailure('Brain session could not be registered') }
      finally {
        if (intent) await sessions.withdraw(intent).catch(() => reportFailure('Brain session intent could not be cleared'))
      }
    },

    async turnStarting(input: BridgeInput) {
      if (!config().enabled || input.origin === 'terminal') return null
      try {
        // A caption on the owner's own photo or document is his text too (only the caption is journaled).
        const direct = (input.inputKind === 'text' || input.inputKind === 'voice' || input.inputKind === 'media')
          && Boolean(input.input?.trim())
          && !input.error && await isOwner(input.sessionId)
        const origin = input.origin === 'owner-direct' && !direct ? 'agent' : input.origin
        const ref = await journal.writer.bind({
          key: input.key, origin, input_kind: input.inputKind, thread: input.sessionId,
          ...(input.tsIn === undefined ? {} : { ts_in: input.tsIn }),
          ...(input.input === undefined ? {} : { input: clean(input.input) }),
          ...(input.error === undefined ? {} : { error: clean(input.error) }),
        })
        const saved = await journal.reader.get(ref)
        // Provenance comes from the original bind. Replayed data may only lower its trust.
        const storedOrigin = saved?.origin === 'owner-direct' ? origin : saved?.origin ?? 'agent'
        const sameThread = saved?.thread === input.sessionId
        const ticket: TurnTicket = { key: input.key, sessionId: input.sessionId, ref,
          origin: sameThread && storedOrigin !== 'terminal' ? storedOrigin : 'agent' }
        const cue = input.cue && ticket.origin === 'owner-direct'
        ticketState.set(ticket, { cue, unavailable: false,
          mayWrite: ticket.origin === 'owner-direct' && (input.inputKind !== 'media' || cue) })
        return ticket
      } catch {
        reportFailure('Brain could not bind the exchange')
        return null
      }
    },

    async turnStarted(ticket, turnId) {
      const state = ticketState.get(ticket)
      if (state) state.turnId = turnId
      const current = executions.getStore()
      // Only the key given to this ticket's turn text binds the permit; without one no caller can use it.
      const key = current?.ticket === ticket ? current.permitKey : undefined
      try {
        await journal.writer.started(ticket.ref, turnId)
        if (ticket.origin !== 'owner-direct' || !state?.mayWrite || !await isOwner(ticket.sessionId)) return
        await permitLock.run(async () => {
          if (!config().enabled || foreignTurns.size || executions.getStore()?.unavailable) return
          await permits.put({
            scope, session_id: ticket.sessionId, turn_id: turnId, origin: 'owner-direct',
            journal_ref: ticket.ref, cue: state?.cue ?? false,
            expires: new Date(clock.now().getTime() + PERMIT_TTL_MS).toISOString(),
            ...(key === undefined ? {} : { key_hash: permitKeyHash(key) }),
          })
          livePermits.add(turnId)
          const execution = executions.getStore()
          if (execution) execution.permit = turnId
        })
      } catch { reportFailure('Brain could not record the start of the turn', ticket) }
    },

    async turnAnswered(ticket, text) {
      if (!config().enabled) return
      try {
        await deliveryLock.run(async () => {
          const exchange = await journal.reader.get(ticket.ref)
          if (exchange?.status !== 'delivered') await journal.writer.answered(ticket.ref, clean(text))
        })
      } catch { reportFailure('Brain could not journal the answer', ticket) }
    },

    async turnDelivered(ticket, outcome) {
      const state = ticketState.get(ticket)
      const notice: TurnNotice = { saved: [], unavailable: state?.unavailable ?? false }
      if (!config().enabled) return notice
      try {
        await deliveryLock.run(async () => {
          const exchange = await journal.reader.get(ticket.ref)
          const turnId = state?.turnId ?? exchange?.turn
          if (turnId) await permitLock.run(() => clearPermit(turnId)).catch(() => {
            warn('Brain could not clear the completed turn permit')
            notice.unavailable = true
          })
          if (exchange?.status === 'delivered') return
          if (outcome.status === 'delivered') {
            await journal.writer.delivered(ticket.ref)
            const receipt = turnId && ticket.origin === 'owner-direct' ? await receipts.get(turnId) : null
            notice.saved = receipt?.writes ?? []
            scheduleJobs()
          } else if (outcome.status === 'cancelled') await journal.writer.cancelled(ticket.ref)
          else await journal.writer.failed(ticket.ref, clean(outcome.error))
        })
      } catch {
        reportFailure('Brain could not record the delivery outcome', ticket)
        notice.unavailable = true
      }
      return notice
    },

    async planUpdated(update) {
      if (!config().enabled) return
      try {
        if (!await isOwner(update.sessionId)) return
        const plan = PlanStateSchema.parse({
          session_id: update.sessionId, turn_id: update.turnId,
          ...(update.explanation === undefined ? {} : { explanation: clean(update.explanation).slice(0, 1000) }),
          steps: update.steps.map(step => ({ ...step, step: clean(step.step).slice(0, 500) })),
          updated: clock.now().toISOString(),
        })
        writeFileAtomic(ensureScope(brainHome, scope).plan, JSON.stringify(plan) + '\n')
      } catch { reportFailure('Brain could not export the turn plan') }
    },

    async openQuestions(sessionId, questions) {
      if (!config().enabled) return
      try {
        if (!await isOwner(sessionId)) return
        const data = OpenQuestionsSchema.parse({
          session_id: sessionId, updated: clock.now().toISOString(),
          questions: questions.map(q => clean(q).trim().slice(0, 500)).filter(Boolean),
        })
        writeFileAtomic(ensureScope(brainHome, scope).questions, JSON.stringify(data) + '\n')
      } catch { reportFailure('Brain could not export open questions') }
    },

    async compactionSeen(event: CompactionEvent) {
      if (!config().enabled) return
      try {
        await contextLock.run(async () => {
          const { sessionId, phase } = event
          if (!await isOwner(sessionId)) return
          if (phase === 'started' && compacting.get(sessionId) !== 'started') {
            const turnId = active.get(sessionId)?.turnId
            compacting.set(sessionId, 'started')
            if (degraded()) {
              await journal.writer.flush()
              await snapshot.beginBoundary(sessionId, 'compact')
              await handoff.write({ sessionId, trigger: 'bridge', ...(turnId === undefined ? {} : { turnId }) })
            }
            scheduleJobs(true)
          }
          if (phase === 'completed' && compacting.has(sessionId)) compacting.set(sessionId, 'completed')
          if (phase === 'context-delivered' && compacting.has(sessionId)) {
            const current = await handoff.current()
            if (current?.session_id === sessionId && current.delivered) {
              writeFileAtomic(lastDeliveryPath, JSON.stringify(current) + '\n')
              compacting.delete(sessionId)
            }
          }
        })
      } catch { reportFailure('Brain could not prepare or confirm the compaction handoff') }
    },

    async firstTurnContext(sessionId) {
      const prepared = await prepareFirstTurn(sessionId)
      if (!prepared) return ''
      return await commitFirstTurn(prepared) ? prepared.text : ''
    },

    async status() {
      const current = config()
      const summarizer = readJson(homePaths(brainHome).summarizerState, SummarizerStateSchema)
      const [entries, pending, days, integrity, priority, bytes, currentHandoff] = await Promise.all([
        facts.list(), proposals.list(), summaries.digestDays(), facts.integrity(), facts.priority(), journalBytes(), handoff.current(),
      ])
      const priorityTokens = estimateTokens(priority.map(formatIndexLine).join('\n'))
      const delivery = readJson(lastDeliveryPath, HandoffSchema)?.delivered
      const lastDelivery = [delivery, currentHandoff?.delivered].filter((at): at is string => !!at).sort().at(-1)
      return {
        enabled: current.enabled, scope, facts: entries.length, pending: pending.length,
        priority_tokens: priorityTokens, priority_over_budget: priorityTokens > PRIORITY_MAX_TOKENS,
        last_digest: days.at(-1) ?? null, journal_bytes: bytes, ...hookState, degraded: degraded(),
        last_handoff_delivery: lastDelivery ?? null, integrity,
        summarizer: { ...(summarizer?.used ?? current.summarizer), fallback: summarizer?.fallback ?? false },
        warnings: [...current.problems, ...(summarizer?.warning ? [summarizer.warning] : []),
          ...(migrationWarning ? ['Перенос старой памяти ещё не завершён.'] : []),
          ...(nativeMemories ? ['В Codex включена собственная память. Она может дублировать Brain.'] : [])].map(clean),
      }
    },

    async memoryCommand(request: MemoryRequest) {
      try {
        const result = await commands.handle(request)
        return { ...result, text: clean(result.text) }
      } catch {
        warn('Brain command could not access the store')
        return { text: BRAIN_UNAVAILABLE, buttons: [] }
      }
    },
  }

  const commands = createBrainCommands({
    facts, proposals, receipts, journal: journal.reader, summaries, handoff, paths, clock, clean,
    status: port.status, enabled: () => config().enabled, setEnabled,
    migrate: migrateIfPossible, lastHandoff: () => readJson(lastDeliveryPath, HandoffSchema),
  })

  async function request(send: RpcRequest, method: string, params: Json, timeout?: number): Promise<Json> {
    if (!['thread/start', 'thread/resume', 'thread/fork', 'thread/compact/start', 'turn/start'].includes(method)
      || !config().enabled) {
      return send(method, params, timeout)
    }
    const execution = executions.getStore()
    // The main thread is registered by the session (registerOwnerMain), never by a resume.
    if (method === 'thread/resume') return send(method, params, timeout)
    // Only the session's main-open path makes a new thread the owner's; any other new thread gets
    // the execution's role, an owner execution's side thread being a guest's.
    const role: BridgeRole = mainOpens.getStore() ? 'owner' : execution?.role === 'side' ? 'side' : 'guest'
    if (method === 'thread/start') {
      return startupLock.run(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const intent = await port.sessionStarting(role)
          try {
            const response = await send(method, params, timeout)
            const sessionId = object(response.thread).id
            if (typeof sessionId !== 'string') return response
            const claimed = await (intent ? sessions.claim(sessionId, clock.now()) : sessions.resolve(sessionId))
              .catch(() => {
                reportFailure('Brain could not verify the session claim')
                return null
              })
            // A concurrent or missing claim can attach terminal HOT to a new thread. Discard the
            // thread before giving it a bridge prompt if the hook used another memory scope.
            if (claimed && (claimed.scope !== scope || claimed.role === 'terminal' ||
                claimed.role === 'owner' && role !== 'owner')) {
              reportFailure('Brain discarded a thread claimed in the wrong scope')
              continue
            }
            await port.sessionStarted(sessionId, role)
            if (role !== 'owner' && hookState.hooks !== 'none' && hookState.hooks !== 'user-needs-review') {
              const registered = await sessions.resolve(sessionId).catch(() => null)
              if (registered?.scope !== scope || registered.role !== role) {
                throw new Error('Brain could not verify the isolated session')
              }
            }
            return response
          } finally {
            if (intent) await sessions.withdraw(intent).catch(() => reportFailure('Brain session intent could not be cleared'))
          }
        }
        throw new Error('Codex did not open a thread in the bridge memory scope')
      })
    }
    if (method === 'thread/fork') {
      const response = await send(method, params, timeout)
      const sessionId = object(response.thread).id
      if (typeof sessionId === 'string') await port.sessionStarted(sessionId, role)
      return response
    }
    const sessionId = params.threadId
    if (typeof sessionId !== 'string') return send(method, params, timeout)
    if (method === 'thread/compact/start') {
      await port.compactionSeen({ sessionId, phase: 'started' })
      try { return await send(method, params, timeout) } catch (error) {
        await port.compactionSeen({ sessionId, phase: 'completed' })
        throw error
      }
    }
    if (method !== 'turn/start' || !execution?.input) return send(method, params, timeout)
    if (execution.role !== 'owner' && execution.input.origin === 'owner-direct') {
      execution.input = { ...execution.input, origin: 'agent', cue: false }
    }
    const ticket = execution.ticket ?? await port.turnStarting({ ...execution.input, sessionId })
    if (ticket) execution.ticket = ticket
    active.set(sessionId, execution)
    try {
      let injected = params
      let prepared: PreparedFirstTurn | null = null
      let sentDelta = false
      if (execution.ticket?.origin === 'owner-direct') {
        prepared = await prepareFirstTurn(sessionId)
        const context = prepared?.text ?? ''
        let delta = ''
        if (degraded()) {
          try {
            const file = deltaFile(sessionId)
            const pending = readJson(file, PendingDelta)
            let text = pending?.text ?? ''
            await snapshot.delta(sessionId, {
              through: pending?.through ?? 0,
              save(fresh, through) {
                text = [text.trimEnd(), fresh.trimEnd()].filter(Boolean).join('\n\n')
                writeFileAtomic(file, JSON.stringify({ text, through }) + '\n')
              },
            })
            delta = text
          } catch { reportFailure('Brain could not load memory changes') }
        }
        const writes = execution.ticket !== undefined && ticketState.get(execution.ticket)?.mayWrite === true
        if (Array.isArray(params.input)) {
          const [first, ...rest] = params.input as unknown[]
          const original = object(first)
          if (original.type === 'text' && typeof original.text === 'string') {
            // A fresh key per sent turn: the permit stores only its hash, the journal never sees it.
            const key = writes ? mintPermitKey() : undefined
            if (key !== undefined) execution.permitKey = key
            const text = [context, original.text, delta, key === undefined ? '' : permitInstruction(key)]
              .filter(Boolean).join('\n\n')
            injected = { ...params, input: [{ ...original, text }, ...rest] }
            sentDelta = delta !== ''
          }
        }
      }
      const response = await send(method, injected, timeout)
      // Only an accepted turn delivered the context: a rejected one leaves it prepared for the retry.
      if (prepared) await commitFirstTurn(prepared)
      if (sentDelta) {
        try { rmSync(deltaFile(sessionId), { force: true }) } catch { reportFailure('Brain could not record the delivered memory changes') }
      }
      const turnId = object(response.turn).id
      if (typeof turnId === 'string' && execution.ticket && !execution.turnId) {
        execution.turnId = turnId
        await port.turnStarted(execution.ticket, turnId)
      }
      return response
    } catch (error) {
      if (execution.ticket) await port.turnDelivered(execution.ticket, { status: 'failed', error: 'Codex rejected the turn' })
      throw error
    }
  }

  return {
    ...port, clock, facts, permits, proposals, receipts, sessions, journal, migrate, start, request,
    get enabled() { return config().enabled },
    setHooks(state: typeof hookState) { hookState = state },
    setNativeMemories(enabled: boolean) { nativeMemories = enabled },
    /**
     * Registers the session's main conversation as the owner's. Resolves false while memory is off
     * (nothing written, the session retries); throws when the thread already has another role.
     */
    async registerOwnerMain(threadId: string): Promise<boolean> {
      if (!config().enabled) return false
      if (await registerThread(threadId, 'owner') === 'refused') {
        throw new Error('Brain refused to make thread ' + threadId + ' the owner thread')
      }
      return true
    },
    /** Runs the RPC that opens the main conversation; a thread it starts or forks is the owner's. */
    mainOpen<T>(open: () => Promise<T>): Promise<T> {
      return mainOpens.run(true, open)
    },
    stop() {
      stopped = true
      jobsAbort.abort()
      void permitLock.run(async () => {
        for (const turnId of livePermits) await clearPermit(turnId)
      }).catch(() => warn('Brain permits could not be cleared during shutdown'))
    },
    /** The session owns its RPC transport. Scope the adapter to this instance before initialization. */
    attach(session: object) {
      const rpc: unknown = Reflect.get(session, 'rpc')
      if (!(rpc instanceof CodexRpc)) throw new Error('Codex session RPC is unavailable')
      const send = rpc.request.bind(rpc)
      rpc.request = (method, params, timeout) => request(send, method, params, timeout)
      return send
    },
    execution(role: BridgeRole, input?: BridgeInput) {
      const state: ExecutionState = { role, unavailable: false, ...(input === undefined ? {} : { input }) }
      return {
        get ticket() { return state.ticket },
        get unavailable() { return state.unavailable },
        async run<T>(operation: () => Promise<T>): Promise<T> {
          if (!config().enabled) return operation()
          return executions.run(state, async () => {
            const foreign = role !== 'owner' || input?.origin !== 'owner-direct'
            try {
              if (foreign) await permitLock.run(async () => {
                foreignTurns.add(state)
                for (const turnId of livePermits) await clearPermit(turnId)
              })
              return await operation()
            } finally {
              await permitLock.run(async () => {
                foreignTurns.delete(state)
                if (state.permit) await clearPermit(state.permit)
              }).catch(() => reportFailure('Brain could not clear a turn permit'))
              if (state.ticket && active.get(state.ticket.sessionId) === state) active.delete(state.ticket.sessionId)
            }
          })
        },
      }
    },
    async recover(key: string, day?: string): Promise<TurnTicket | null> {
      if (!config().enabled) return null
      try {
        const date = DaySchema.safeParse(day)
        const pool = date.success ? await journal.reader.fold(date.data) : await journal.reader.tail(100)
        const exchange = pool.find(entry => entry.key === key)
        if (!exchange?.thread) return null
        return { sessionId: exchange.thread, key, ref: exchange.ref, origin: exchange.origin }
      } catch { reportFailure('Brain could not recover the exchange'); return null }
    },
    isSafeSide: async (sessionId: string) => {
      const entry = await sessions.resolve(sessionId).catch(() => null)
      return entry?.scope === scope && (entry.role === 'guest' || entry.role === 'side')
    },
    notice: commands.notice,
    observe(event: CodexEvent) {
      if (event.method !== 'turn/plan/updated' && event.method !== 'item/started' &&
          event.method !== 'item/completed' && event.method !== 'hook/completed') return
      if (!config().enabled) return
      const sessionId = event.params.threadId
      if (typeof sessionId !== 'string') return
      const item = object(event.params.item)
      if (item.type === 'contextCompaction') {
        if (event.method === 'item/started') void port.compactionSeen({ sessionId, phase: 'started' })
        if (event.method === 'item/completed') void port.compactionSeen({ sessionId, phase: 'completed' })
      }
      const hook = object(event.params.run)
      const name = typeof hook.eventName === 'string' ? hook.eventName.replace(/[^a-z]/gi, '').toLowerCase() : ''
      if (event.method === 'hook/completed' && name === 'sessionstart') {
        void port.compactionSeen({ sessionId, phase: 'context-delivered' })
      }
      if (event.method === 'turn/plan/updated' && typeof event.params.turnId === 'string' && Array.isArray(event.params.plan)) {
        const steps = event.params.plan.flatMap((step: unknown) => {
          const parsed = PlanStepSchema.safeParse(step)
          return parsed.success ? [parsed.data] : []
        })
        void port.planUpdated({ sessionId, turnId: event.params.turnId, steps,
          ...(typeof event.params.explanation === 'string' ? { explanation: event.params.explanation } : {}) })
      }
    },
  }
}
