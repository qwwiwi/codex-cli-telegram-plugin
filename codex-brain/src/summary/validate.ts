// Checks on model output before anything is published (spec §9: "output is validated and redacted
// before publish"). A line that fails a check is dropped whole; no text is ever cut to fit.

import { redactSecrets } from '../../../plugin/src/safety/redact.js'
import { type JournalRef, parseJournalRef } from '../contract.js'
import { LINE_TEXT_MAX } from './prompt.js'

/** A line with at least this many words that appears verbatim in a message is a copied fragment. */
export const VERBATIM_MIN_WORDS = 8

/** Parses the model's JSON answer; null when it is not JSON. */
export function parseModelJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Redacted single-line text, or null: not a string, blank, more than one line, or longer than
 * `LINE_TEXT_MAX` (dropped rather than cut, A2 "never shortens mid-text").
 */
export function cleanLineText(raw: unknown): string | null {
  if (typeof raw !== 'string' || /[\r\n]/.test(raw)) return null
  const text = redactSecrets(raw).replace(/\s+/g, ' ').trim()
  if (text.length === 0 || text.length > LINE_TEXT_MAX) return null
  return text
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * True when `text` contains a run of at least `VERBATIM_MIN_WORDS` consecutive words copied from
 * one of `sources`, also inside a longer line: a cut fragment of a message (A2) or a repeated
 * instruction from the journal (spec §9).
 */
export function isVerbatimFragment(text: string, sources: readonly string[]): boolean {
  const words = normalize(text).split(' ')
  if (words.length < VERBATIM_MIN_WORDS) return false
  const haystacks = sources.map(source => ` ${normalize(source)} `)
  for (let i = 0; i + VERBATIM_MIN_WORDS <= words.length; i++) {
    const run = ` ${words.slice(i, i + VERBATIM_MIN_WORDS).join(' ')} `
    if (haystacks.some(haystack => haystack.includes(run))) return true
  }
  return false
}

/**
 * The ref when it is well-formed and one of `allowed` (the refs of the pass the line came from);
 * else null. The ref only locates a line: its provenance is the pass's, never the citation's.
 */
export function allowedRef(raw: unknown, allowed: ReadonlySet<JournalRef>): JournalRef | null {
  if (typeof raw !== 'string' || parseJournalRef(raw) === null || !allowed.has(raw)) return null
  return raw
}
