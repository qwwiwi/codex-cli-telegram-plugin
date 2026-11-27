// Provenance of what the S4 model jobs read and write (docs/design/brain/provenance-consistency.md
// §1). Owner memory is produced only by a pass whose whole input is trusted owner text; everything
// else goes to a reference pass whose lines are reference-only. Which pass a text goes to, and the
// source of a reference line, come from journal metadata here, never from what the model cites.

import { redactSecrets } from '../../../plugin/src/safety/redact.js'
import { estimateTokens, type Exchange, type JournalRef, type ReferenceSource, TRUSTED_ORIGINS } from '../contract.js'

/** Tokens kept free in every prompt for its rules, so the whole prompt stays within the target. */
export const PROMPT_OVERHEAD_TOKENS = 1000
/** Tokens kept free in one item for its `ref`, `part` and `source` fields. */
const ITEM_OVERHEAD_TOKENS = 100

/**
 * True when the exchange's `input` is text the owner typed themselves: a trusted origin and not a
 * forwarded message. Replies, errors and every other input are never owner text.
 */
export function isOwnerText(exchange: Exchange): boolean {
  return TRUSTED_ORIGINS.includes(exchange.origin) && exchange.input_kind !== 'forward' && exchange.input !== undefined
}

/** Source of a reference line about this exchange, from its journal metadata. */
export function referenceSource(exchange: Exchange): ReferenceSource {
  return TRUSTED_ORIGINS.includes(exchange.origin) && exchange.input_kind !== 'forward' ? 'agent-reply' : 'not-owner'
}

/** One entry of a prompt's data block: one text of one exchange, or one part of it. */
export interface PassItem {
  ref: JournalRef
  /** `i/n` when the text was split because it does not fit one prompt. */
  part?: string
  /** Reference pass only. */
  source?: ReferenceSource
  input?: string
  reply?: string
  error?: string
}

/** One model call: `owner` holds trusted owner text only, `reference` holds everything else. */
export interface Pass {
  kind: 'owner' | 'reference'
  items: PassItem[]
}

const itemTokens = (item: PassItem): number => estimateTokens(JSON.stringify(item)) + 1
// Per-piece estimates add up to at least the estimate of the joined text, so the sum is a safe bound.
const pieceTokens = (piece: string): number => estimateTokens(JSON.stringify(piece).slice(1, -1))

/** `text` whole when it fits `maxTokens`, else consecutive parts that each fit; nothing is dropped. */
export function splitText(text: string, maxTokens: number): string[] {
  if (pieceTokens(text) <= maxTokens) return [text]
  const parts: string[] = []
  let current = ''
  let tokens = 0
  const flush = (): void => {
    if (current !== '') parts.push(current)
    current = ''
    tokens = 0
  }
  // Words keep their trailing whitespace, so joining the parts gives the text back.
  for (const word of text.split(/(?<=\s)/u)) {
    const size = pieceTokens(word)
    if (size > maxTokens) {
      flush()
      // One unbroken run longer than a prompt: cut by length (a UTF-16 unit is at most 2 tokens).
      const step = Math.max(1, Math.floor(maxTokens / 2))
      for (let i = 0; i < word.length; i += step) parts.push(word.slice(i, i + step))
      continue
    }
    if (tokens + size > maxTokens) flush()
    current += word
    tokens += size
  }
  flush()
  return parts
}

type TextField = 'input' | 'reply' | 'error'

function fieldItems(base: Pick<PassItem, 'ref' | 'source'>, field: TextField, raw: string, budget: number): PassItem[] {
  const parts = splitText(redactSecrets(raw), budget - ITEM_OVERHEAD_TOKENS)
  return parts.map((text, i) => ({
    ref: base.ref,
    ...(parts.length === 1 ? {} : { part: `${i + 1}/${parts.length}` }),
    ...(base.source === undefined ? {} : { source: base.source }),
    [field]: text,
  }))
}

function pack(kind: Pass['kind'], items: readonly PassItem[], budget: number): Pass[] {
  const passes: Pass[] = []
  let current: PassItem[] = []
  let tokens = 0
  for (const item of items) {
    const size = itemTokens(item)
    if (current.length > 0 && tokens + size > budget) {
      passes.push({ kind, items: current })
      current = []
      tokens = 0
    }
    current.push(item)
    tokens += size
  }
  if (current.length > 0) passes.push({ kind, items: current })
  return passes
}

/**
 * The model calls that cover `exchanges`: owner passes first, then reference passes, each within
 * `promptTokens` including the prompt rules. Every text is redacted on the way in; a text too large
 * for one prompt is split into parts with the same ref. A pass kind with no text gives no call.
 */
export function planPasses(exchanges: readonly Exchange[], promptTokens: number): Pass[] {
  const budget = promptTokens - PROMPT_OVERHEAD_TOKENS
  const owner: PassItem[] = []
  const reference: PassItem[] = []
  for (const exchange of exchanges) {
    const source = referenceSource(exchange)
    if (exchange.input !== undefined) {
      if (isOwnerText(exchange)) owner.push(...fieldItems({ ref: exchange.ref }, 'input', exchange.input, budget))
      else reference.push(...fieldItems({ ref: exchange.ref, source }, 'input', exchange.input, budget))
    }
    if (exchange.reply !== undefined) reference.push(...fieldItems({ ref: exchange.ref, source }, 'reply', exchange.reply, budget))
    if (exchange.error !== undefined) reference.push(...fieldItems({ ref: exchange.ref, source }, 'error', exchange.error, budget))
  }
  return [...pack('owner', owner, budget), ...pack('reference', reference, budget)]
}

/** Refs a line of this pass may cite. */
export const passRefs = (pass: Pass): Set<JournalRef> => new Set(pass.items.map(item => item.ref))

/** The texts this pass shows the model (for the verbatim-copy check). */
export const passTexts = (pass: Pass): string[] =>
  pass.items.flatMap(item => [item.input, item.reply, item.error].filter((text): text is string => text !== undefined))
