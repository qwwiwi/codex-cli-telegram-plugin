// Owner effects: the only module that calls the raw writers of owner memory and owner work.
//
// Every writer takes an OwnerTurnOrigin first, which only turn-origin.ts can make, so a caller holding
// a TurnOrigin must narrow it with ownerOrigin() and a foreign turn cannot reach them. The
// origin-taking helpers below (questionSeen, replyAttachments, exportOpenQuestions) narrow inside and
// keep the non-owner behaviour next to the owner one. tests/codex/owner-sinks.test.ts fails when a
// raw writer is called anywhere else.

import type { OpenQuestionDetection } from '../safety/open-question.js'
import type { OpenQuestionStore } from '../state/open-question-store.js'
import { extractAttachments } from './attachments.js'
import { ownerExecutionTask, ownerTaskBlocked } from './continuation.js'
import type { UnansweredQuestion } from './questions.js'
import { ownerOrigin, parseTurnOrigin, storedOrigin, type OwnerTurnOrigin, type TurnOrigin } from './turn-origin.js'

export interface OwnerEffectsDeps {
  chatId: string
  leases: { recordQuestion(messageId: number, summary: string): Promise<void> }
  brain: { openQuestions(sessionId: string, questions: string[]): Promise<void> }
  controls: { setPendingOwnerTask(thread: string | null, objective?: string): void }
  questionStore: Pick<OpenQuestionStore, 'get' | 'set' | 'clear'>
  /** The owner's main thread now. */
  currentThread: () => string | null
  /** Called after the reminder record changed, so the owner's open questions are exported again. */
  onQuestionsChanged?: () => void
  warn: (error: unknown, message: string) => void
}

export type OwnerEffects = ReturnType<typeof createOwnerEffects>

export function createUnansweredQuestionHandler(deps: {
  chatId: string
  questionStore: Pick<OpenQuestionStore, 'get' | 'set'>
  effects: () => Pick<OwnerEffects, 'recordQuestion'> | undefined
  syncBrainQuestions: () => void
}) {
  const { chatId, questionStore } = deps
  return async ({ messageId, askedAtMs, snippet, origin }: UnansweredQuestion): Promise<void> => {
    const previous = questionStore.get(chatId)
    if (previous?.messageId !== messageId && (previous?.askedAtMs ?? 0) <= askedAtMs) {
      questionStore.set({ chatId, messageId, askedAtMs, code: 'AQ_CARD', snippet, remindersSent: 0, ...(origin ? { origin } : {}) })
    }
    const by = ownerOrigin(parseTurnOrigin(origin, messageId))
    if (by) {
      const effects = deps.effects()
      if (!effects) throw new Error('An unanswered owner question arrived before the bridge was ready')
      await effects.recordQuestion(by, messageId, snippet)
    }
    deps.syncBrainQuestions()
  }
}

export function createOwnerEffects(deps: OwnerEffectsDeps) {
  const { chatId, leases, brain, controls, questionStore } = deps

  async function recordQuestion(_by: OwnerTurnOrigin, messageId: number, snippet: string): Promise<void> {
    await leases.recordQuestion(messageId, snippet).catch((error: unknown) => deps.warn(error, 'Could not save an open question'))
  }

  /** The owner's open questions go to his Brain export of his main thread. */
  function exportQuestions(by: OwnerTurnOrigin, questions: readonly string[]): Promise<void> {
    const thread = by.thread ?? deps.currentThread()
    return thread ? brain.openQuestions(thread, [...questions]) : Promise.resolve()
  }

  /** An owner execution task the report says is blocked becomes the pending owner task of the main thread. */
  function rememberBlocker(by: OwnerTurnOrigin, objective: string | undefined, report: string, current: boolean): void {
    if (by.messageId > 0 && objective && ownerExecutionTask(objective) && objective.length <= 4000 &&
        ownerTaskBlocked(report) && current) {
      controls.setPendingOwnerTask(deps.currentThread(), objective)
    }
  }

  /** Workspace files named by an owner turn's reply. */
  function attachments(_by: OwnerTurnOrigin, text: string): { text: string; files: string[] } {
    return extractAttachments(text)
  }

  /** Clears the owner's pending task of a thread once his turn finished, replaced or continued it. */
  function settlePendingTask(_by: OwnerTurnOrigin, thread: string | null): void {
    controls.setPendingOwnerTask(thread)
  }

  return {
    recordQuestion, exportQuestions, rememberBlocker, attachments, settlePendingTask,

    /**
     * An owner command (/stop, /goal pause) withdraws the pending owner task. It only removes owner
     * state, so it needs no turn; nothing foreign can add a task through it.
     */
    withdrawPendingTask(thread: string | null): void {
      controls.setPendingOwnerTask(thread)
    },

    /**
     * A sent reply that asks (or stopped asking). The reminder record always keeps the origin: the
     * reminder is a chat feature for every turn. Only an owner turn's question is the owner's.
     */
    async questionSeen(origin: TurnOrigin, messageId: number, question: OpenQuestionDetection | undefined): Promise<void> {
      if (question) {
        questionStore.set({ chatId, messageId, askedAtMs: Date.now(), code: question.code, snippet: question.snippet,
          remindersSent: 0, origin: storedOrigin(origin) })
        const by = ownerOrigin(origin)
        if (by) await recordQuestion(by, messageId, question.snippet)
      } else if (questionStore.get(chatId)?.code !== 'AQ_CARD') questionStore.clear(chatId)
      deps.onQuestionsChanged?.()
    },

    /** Files only for an owner turn; any other reply keeps its text as written and sends nothing. */
    replyAttachments(origin: TurnOrigin, text: string): { text: string; files: string[] } {
      const by = ownerOrigin(origin)
      return by ? attachments(by, text) : { text, files: [] }
    },

    /** Exports the owner's open questions: the reminder snippet only when its turn was the owner's. */
    exportOpenQuestions(main: OwnerTurnOrigin, open: readonly string[]): void {
      const record = questionStore.get(chatId)
      const snippet = record && ownerOrigin(parseTurnOrigin(record.origin, record.messageId)) ? record.snippet : undefined
      void exportQuestions(main, [...new Set([...(snippet ? [snippet] : []), ...open])])
        .catch((error: unknown) => deps.warn(error, 'Could not export open questions'))
    },
  }
}
