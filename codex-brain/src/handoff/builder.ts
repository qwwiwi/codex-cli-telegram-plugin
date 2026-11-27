// Handoff builder of one scope (spec §8.2-§8.3, A1; slice plan S3).
//
// `write` is deterministic file work with no model call (it runs in PreCompact): it reads facts
// and the journal through the contract interfaces and the bridge-exported state files (plan,
// open questions, note), applies the trust rule, fits the result into HANDOFF_MAX_TOKENS and
// stores `handoff/current.{json,md}` plus a history copy. `take` hands a stored handoff to its
// own session once.

import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { readBrainConfig } from '../config.js'
import {
  type BrainConfig, type Clock, compareIndexLines, type Exchange, type FactReader, type Handoff, type HandoffBuilder,
  HANDOFF_HISTORY_KEEP, HANDOFF_TAIL_ENTRIES, type HandoffRequest, HandoffSchema, type IndexLine, type JournalReader,
  isTrustedNote, NOTE_MAX, NoteSchema, OpenQuestionsSchema, PlanStateSchema, type PlanStep, PromptCaptureSchema, type Scope, type SessionRegistry,
  PROVENANCE_VERSION, TRUSTED_ORIGINS,
} from '../contract.js'
import { isPublicExchange } from '../journal/recent.js'
import { readJson, readStoredSnapshot } from '../snapshot/index.js'
import { isPersonalSession } from '../snapshot/builder.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, withLock } from '../store/lock.js'
import { ensureScope, scopePaths } from '../store/paths.js'
import { fitHandoff, oneLine, renderHandoff, truncate } from './render.js'

/** Owner-side journal exchanges (public-lane ones left out first) searched for the in-flight one, newest last. */
export const IN_FLIGHT_SCAN = 50
/** Max code points of the quoted in-flight owner message. */
export const IN_FLIGHT_QUOTE_MAX = 600
/** Max code points of one journal-tail line. */
export const TAIL_LINE_MAX = 160

export interface HandoffBuilderOptions {
  brainHome: string
  scope: Scope
  facts: FactReader
  journal: JournalReader
  sessions: SessionRegistry
  clock: Clock
  /** Effective Brain config, read on every call; defaults to `<brain_home>/config.json`. */
  config?: () => BrainConfig
  lock?: LockOptions
}

const trusted = (exchange: Exchange): boolean => TRUSTED_ORIGINS.includes(exchange.origin)
const inFlight = (exchange: Exchange): boolean => exchange.status === 'bound' || exchange.status === 'answered'

// Older handoffs can contain a next-step note whose origin was never checked.
const StoredHandoffSchema = HandoffSchema.extend({ provenance: z.literal(PROVENANCE_VERSION) })
  .transform(({ provenance: _, ...handoff }) => handoff)

export function createHandoffBuilder(options: HandoffBuilderOptions): HandoffBuilder {
  const { brainHome, scope, facts, journal, sessions, clock } = options
  const config = options.config ?? (() => readBrainConfig(brainHome))
  const paths = scopePaths(brainHome, scope)

  function empty(request: HandoffRequest): Handoff {
    return HandoffSchema.parse({
      session_id: request.sessionId, trigger: request.trigger, written: clock.now().toISOString(),
      in_flight: null, plan: [], open_questions: [], decisions: [], tasks: [], next_step: null, tail: [],
    })
  }

  // The last IN_FLIGHT_SCAN exchanges once public-lane ones are left out, oldest first: a burst of
  // member or guest turns never pushes a bound owner exchange out of the scan.
  async function ownerExchanges(): Promise<Exchange[]> {
    const out: Exchange[] = []
    const days = await journal.days()
    for (let i = days.length - 1; i >= 0 && out.length < IN_FLIGHT_SCAN; i--) {
      const day = days[i]
      if (day !== undefined) out.unshift(...(await journal.fold(day)).filter(exchange => !isPublicExchange(exchange)))
    }
    return out.slice(-IN_FLIGHT_SCAN)
  }

  async function draft(request: HandoffRequest): Promise<Handoff> {
    const { sessionId } = request
    const entry = await sessions.resolve(sessionId)
    const threadKey = entry?.thread_id ?? sessionId
    const exchanges = await ownerExchanges()

    // In-flight: the active turn's exchange; without a turn id, the newest of this thread. Never a guess
    // across turns: a turn id that matches nothing gives none.
    const active = [...exchanges].reverse().find(ex => inFlight(ex) && (request.turnId === undefined ? ex.thread === threadKey : ex.turn === request.turnId))
    const quote = active !== undefined && trusted(active) && active.input !== undefined ? truncate(oneLine(active.input), IN_FLIGHT_QUOTE_MAX) : ''
    const inFlightRef = active === undefined ? null : { ref: active.ref, origin: active.origin, ...(quote === '' ? {} : { quote }) }
    // A terminal session has no bridge journal entry for its turn: its prompt was captured by the hook.
    const capture = entry?.role === 'terminal' && request.turnId !== undefined ? readJson(paths.prompt(request.turnId), PromptCaptureSchema) : null
    const prompt = capture !== null && capture.session_id === sessionId && capture.turn_id === request.turnId ? truncate(oneLine(capture.prompt), IN_FLIGHT_QUOTE_MAX) : ''

    const planState = readJson(paths.plan, PlanStateSchema)
    const plan: PlanStep[] = planState?.session_id === sessionId
      ? planState.steps.map(step => ({ step: oneLine(step.step) || '(empty step)', status: step.status }))
      : []
    const questionState = readJson(paths.questions, OpenQuestionsSchema)
    const questions = questionState?.session_id === sessionId ? questionState.questions.map(oneLine).filter(q => q !== '') : []
    const noteState = readJson(paths.note, NoteSchema)
    // Only a note with explicit trusted provenance: written in a turn of this session whose origin
    // is recorded and trusted (a forwarded turn's note, one bound to no session, or one with no
    // origin never becomes the owner's next step).
    const note = noteState !== null && isTrustedNote(noteState) && noteState.session_id === sessionId ? noteState : null
    const noteText = note === null ? '' : oneLine(note.text)

    const [priority, activeLines, manifest] = await Promise.all([facts.priority(), facts.list(), facts.manifest()])
    const activeIds = new Set(activeLines.map(line => line.id))
    const tasks = priority
      .filter(fact => fact.kind === 'task' && fact.status === 'open' && activeIds.has(fact.id))
      .map(fact => ({ id: fact.id, description: fact.description, ...(note?.task === fact.id && noteText !== '' ? { next: noteText } : {}) }))
    const taskIds = new Set(tasks.map(task => task.id))

    // Facts written or changed since this session's snapshot boundary (manifest diff).
    const baseline = readStoredSnapshot(paths, sessionId)?.meta.facts
    const decisions: IndexLine[] = baseline === undefined ? [] : activeLines
      .filter(line => !taskIds.has(line.id) && manifest.facts[line.id] !== undefined && manifest.facts[line.id]?.revision !== baseline[line.id])
      .sort(compareIndexLines)

    const firstOpen = plan.find(step => step.status !== 'completed')
    const nextStep = noteText !== '' ? noteText : firstOpen === undefined ? null : truncate(firstOpen.step, NOTE_MAX)

    const tail = exchanges.slice(-HANDOFF_TAIL_ENTRIES).map(ex => {
      const line = trusted(ex) && ex.input !== undefined ? truncate(oneLine(ex.input), TAIL_LINE_MAX) : ''
      return { ref: ex.ref, origin: ex.origin, ...(line === '' ? {} : { line }) }
    })
    const last = exchanges.at(-1)

    return HandoffSchema.parse({
      session_id: sessionId,
      ...(entry?.thread_id === undefined ? {} : { thread: entry.thread_id }),
      trigger: request.trigger,
      written: clock.now().toISOString(),
      ...(last === undefined ? {} : { journal_to: last.ref }),
      in_flight: inFlightRef,
      ...(prompt === '' ? {} : { in_flight_prompt: prompt }),
      plan,
      open_questions: questions,
      decisions,
      tasks,
      next_step: nextStep,
      tail,
    })
  }

  function writeHandoffMeta(handoff: Handoff): void {
    writeFileAtomic(paths.handoffMeta, `${JSON.stringify({ ...handoff, provenance: PROVENANCE_VERSION })}\n`)
  }

  function store(handoff: Handoff): void {
    const text = renderHandoff(handoff)
    writeHandoffMeta(handoff)
    writeFileAtomic(paths.handoffCurrent, text)
    const stamp = handoff.written.replace(/[^0-9A-Za-z]/g, '')
    writeFileAtomic(join(paths.handoffHistoryDir, `${stamp}-${randomBytes(4).toString('hex')}.md`), text)
    const history = readdirSync(paths.handoffHistoryDir).filter(name => name.endsWith('.md')).sort()
    for (const name of history.slice(0, Math.max(0, history.length - HANDOFF_HISTORY_KEEP))) {
      rmSync(join(paths.handoffHistoryDir, name), { force: true })
    }
  }

  return {
    async write(request: HandoffRequest): Promise<Handoff> {
      // Disabled, or a session without personal memory in this scope: nothing personal is
      // collected and the stored handoff of the owner's session is left alone.
      if (!config().enabled || !await isPersonalSession(sessions, scope, request.sessionId)) return empty(request)
      const handoff = fitHandoff(await draft(request))
      ensureScope(brainHome, scope)
      await withLock(paths.lockDir, async () => store(handoff), options.lock)
      return handoff
    },

    render: renderHandoff,

    async take(sessionId: string): Promise<string> {
      if (!config().enabled || !await isPersonalSession(sessions, scope, sessionId)) return ''
      const fresh = (h: Handoff | null): h is Handoff => h !== null && h.session_id === sessionId && h.delivered === undefined
      if (!fresh(readJson(paths.handoffMeta, StoredHandoffSchema))) return ''
      return withLock(paths.lockDir, async () => {
        const handoff = readJson(paths.handoffMeta, StoredHandoffSchema)
        if (!fresh(handoff)) return ''
        const delivered = HandoffSchema.parse({ ...handoff, delivered: clock.now().toISOString() })
        writeHandoffMeta(delivered)
        return renderHandoff(handoff)
      }, options.lock)
    },

    async current(): Promise<Handoff | null> {
      return readJson(paths.handoffMeta, StoredHandoffSchema)
    },
  }
}
