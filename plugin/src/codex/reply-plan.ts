// The delivery plan of a pending reply (v3): the whole masked shown text once, its entities, and where each
// message ends. `text:N` receipts count the pieces; a piece with any receipt is never sent again.
//
// Resume, every time delivery starts or continues (resumePlan):
//   1. `done` = leading pieces with a receipt, B = the end of the last of them (0 if none).
//   2. Mask the saved text again with the current secrets, keeping the edits.
//   3. Map the sent cuts through the edits; a cut inside an edit maps to the start of the marker, so the whole
//      marker lands in the pending part (sent `…MA`, pending `SKME`, `MASKME` registered meanwhile → the next
//      piece starts with `[REDACTED]`; `SKME` is never sent).
//   4. Drop the cuts after `done` and cut the masked text again from the mapped B.

import { render, cutPoints, mapPosition, maskWithEdits, MESSAGE_PREFERRED_LIMIT, slice, type Entity,
  type VisibleText } from '../format/visible.js'
import { PreformattedDocumentError } from '../format/chunk.js'
import type { PartStatus } from './reply-delivery.js'

export interface PlanV3 {
  v: 3
  text: string
  entities: Entity[]
  /** cuts[i] is the end of piece i in `text`. */
  cuts: number[]
}

const ENTITY_TYPES: ReadonlySet<string> = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code',
  'blockquote', 'expandable_blockquote', 'pre', 'text_link'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntity(value: unknown, length: number): value is Entity {
  if (!isRecord(value) || typeof value.type !== 'string' || !ENTITY_TYPES.has(value.type)) return false
  const { offset, length: size } = value
  if (typeof offset !== 'number' || typeof size !== 'number' || !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) || offset < 0 || size <= 0 || offset + size > length) return false
  if (value.type === 'text_link') return typeof value.url === 'string'
  if (value.type === 'pre') return value.language === undefined || typeof value.language === 'string'
  return true
}

/**
 * A well-formed saved plan: entities in bounds, cuts non-decreasing inside the text. A cut may repeat the one before
 * it (or be 0): a sent piece that a later redaction swallowed maps to an empty piece whose receipt still counts. A
 * pending piece is never empty, because every resume cuts the pending text again.
 */
export function isPlanV3(value: unknown): value is PlanV3 {
  if (!isRecord(value) || value.v !== 3 || typeof value.text !== 'string' || !Array.isArray(value.entities) ||
      !Array.isArray(value.cuts)) return false
  const { text, entities, cuts } = value
  let previous = 0
  for (const cut of cuts) {
    if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < previous || cut > text.length) return false
    previous = cut
  }
  return entities.every(entity => isEntity(entity, text.length))
}

/** A fresh plan of masked shown text. Throws PreformattedDocumentError when it cannot be cut into messages. */
export function newPlan(visible: VisibleText, limit: number = MESSAGE_PREFERRED_LIMIT): PlanV3 {
  return { v: 3, text: visible.text, entities: visible.entities, cuts: cutPoints(visible.text, limit) }
}

/** Resume steps 2-4 for a plan whose first `done` pieces have a receipt. */
export function resumePlan(plan: PlanV3, done: number, secrets: ReadonlyArray<string> | undefined,
  limit: number = MESSAGE_PREFERRED_LIMIT): PlanV3 {
  const { visible, passes } = maskWithEdits({ text: plan.text, entities: plan.entities }, secrets)
  const sent = plan.cuts.slice(0, done).map(cut => mapPosition(cut, passes))
  const from = sent.at(-1) ?? 0
  // A pending tail with nothing to show is no message: the reply is complete.
  const pending = /\S/.test(visible.text.slice(from)) ? cutPoints(visible.text, limit, from) : []
  return { v: 3, text: visible.text, entities: visible.entities, cuts: [...sent, ...pending] }
}

/** Where a pending reply's plan and receipts live (the inbox). */
export interface PlanStore {
  replyPart(id: number, key: string): PartStatus | undefined
  hasTextReceipt(id: number): boolean
  replyPlan(id: number): PlanV3 | undefined
  setReplyPlan(id: number, plan: PlanV3): void
}

/**
 * The pieces of reply `id` as delivery should walk them, its plan saved first: a saved plan resumes (steps 1-4),
 * a reply without one is planned from `shown` (its masked shown text). Receipts without a plan come from an
 * upgrade that marked the pending parts: nothing is sent again. Throws PreformattedDocumentError when the text
 * cannot be cut into messages.
 */
export function replyPieces(store: PlanStore, id: number, shown: () => VisibleText,
  secrets: ReadonlyArray<string> | undefined): VisibleText[] {
  const saved = store.replyPlan(id)
  if (!saved && store.hasTextReceipt(id)) return []
  let done = 0
  while (saved && done < saved.cuts.length && store.replyPart(id, 'text:' + done)) done += 1
  const plan = saved ? resumePlan(saved, done, secrets) : newPlan(shown())
  store.setReplyPlan(id, plan)
  return planPieces(plan)
}

/** The shown text of `plan` ahead of piece `index`: what was sent before it, for the seam check at every attempt. */
export function textBefore(plan: PlanV3, index: number): string {
  return index === 0 ? '' : plan.text.slice(0, plan.cuts[index - 1] ?? plan.text.length)
}

/** The next piece of a plan held in memory, re-planned first (resume steps 2-4) with its first `done` pieces sent. */
export interface NextPiece {
  plan: PlanV3
  piece: VisibleText
  /** The plan's shown text before the piece (textBefore). */
  before: string
}

/**
 * Resume `plan` with the current secrets and return piece `done` with the text before it; undefined when nothing is
 * pending. Throws PreformattedDocumentError when the pending text can no longer be cut into messages.
 */
export function nextPiece(plan: PlanV3, done: number, secrets: ReadonlyArray<string> | undefined,
  limit: number = MESSAGE_PREFERRED_LIMIT): NextPiece | undefined {
  let resumed: PlanV3
  try {
    resumed = resumePlan(plan, done, secrets, limit)
  } catch (error) {
    // Pieces already went, so the reply cannot become a document now: the pending pieces keep their cuts, and the
    // seam check at every attempt (sentBefore) still masks a value across them.
    if (!(error instanceof PreformattedDocumentError) || done === 0) throw error
    resumed = plan
  }
  const end = resumed.cuts[done]
  if (end === undefined) return undefined
  const start = done === 0 ? 0 : resumed.cuts[done - 1] ?? 0
  return { plan: resumed, piece: slice(resumed, start, end), before: textBefore(resumed, done) }
}

/** The pieces of a plan, one per cut. */
export function planPieces(plan: PlanV3): VisibleText[] {
  let start = 0
  return plan.cuts.map(end => {
    const piece = slice(plan, start, end)
    start = end
    return piece
  })
}

/**
 * The legacy plan (self-balanced Telegram HTML parts) as one v3 plan: each part rendered on its own, texts and
 * shifted entities concatenated, cuts at the running lengths, so `text:N` receipts keep their pieces.
 * Undefined when a part shows nothing (a blanked slot) and the receipts could no longer be matched.
 */
export function planFromLegacyParts(parts: readonly string[]): PlanV3 | undefined {
  let text = ''
  const entities: Entity[] = []
  const cuts: number[] = []
  for (const part of parts) {
    const shown = render(part, 'HTML')
    if (shown.text.length === 0) return undefined
    for (const entity of shown.entities) entities.push({ ...entity, offset: entity.offset + text.length })
    text += shown.text
    cuts.push(text.length)
  }
  return cuts.length === 0 ? undefined : { v: 3, text, entities, cuts }
}
