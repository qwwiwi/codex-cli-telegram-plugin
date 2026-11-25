// Open-question detector — the pure check over an OUTGOING `reply` body that
// decides whether the agent left a question open for the owner, so the reminder
// sweep can nudge him if he never answers.
//
// Two pattern sources, deliberately:
//   * `scanSelfGatingAsk` (ask-guard) — the tier-1 wordings the codebase
//     already recognises («жду го», «дай добро», «могу продолжать?», …). Reused
//     through its exported raw scan, NEVER re-typed here: one list, two
//     readers. Note we want that scan WITHOUT the guard's two policy layers —
//     no lease precondition (a reminder is not about mandates) and no hard-gate
//     exemption (a pending deploy or payment decision is the ask the owner
//     forgets most).
//   * OQ_* below — wordings the guard has no reason to carry, because they are
//     not self-gating under a mandate, yet still leave the owner on the
//     critical path («скажешь go — отправлю», «жду твоего ответа»).
//
// Narrow by design. The expensive failure is a FALSE POSITIVE: a wrong
// detection pings the owner at 3am about nothing. So a bare trailing «?» is NOT
// a trigger, and a status-wait («жду завершения тестов», «жду ответа от
// провайдера») must not fire — only an OWNER-directed wait does, which the
// possessive «тво…» enforces.
//
// Pure + stateless, and never throws by contract: callers treat a throw as "no
// question" and fail open.

import { fenceProtectedLines } from '../format/rich.js'
import { scanSelfGatingAsk } from './ask-guard.js'

export interface OpenQuestionDetection {
  // Machine code of the pattern that fired — either an ask-guard tier-1 code
  // (ASK_*) or one of this module's own (OQ_*). Stable; surfaces in logs and in
  // the persisted record.
  code: string
  // The matched fragment, clipped. NEVER the whole message body: the reminder
  // quotes the original message instead of re-sending its text.
  snippet: string
}

// Cyrillic-aware letter class and boundaries — same approach as ask-guard.ts
// (JS `\b` and `\w` are ASCII-only, so «Скажительно» would otherwise match
// «скажи»).
const LETTER = '[а-яёa-z]'
const B = `(?<!${LETTER})`
const A = `(?!${LETTER})`
// Optional quote wrapper around the go-token («go» / "да" / го).
const Q = '["«»“”]?'

const BLOCKQUOTE_RE = /^\s*>/
const SNIPPET_MAX_CHARS = 60

interface OpenQuestionPattern {
  code: string
  re: RegExp
}

const OQ_PATTERNS: ReadonlyArray<OpenQuestionPattern> = [
  // «скажи/скажешь «го»|«go»|«да»», «напиши «да»» — the call-to-action shape
  // this agent's own reply style ends on. The boundary right after the verb
  // keeps «Скажительно» out, and requiring the go-token keeps «Напиши коллеге»
  // out.
  {
    code: 'OQ_SAY_GO',
    re: new RegExp(
      `${B}(?:скаж(?:и|ешь)|напиш(?:и|ешь))${A}\\s+${Q}(?:го|go|да)${Q}${A}`,
      'i',
    ),
  },
  // «жду тво(его|ё) (ответа|решения|слова)» — owner-directed by the possessive.
  // Without «тво…» this would swallow status-waits («жду ответа от
  // провайдера», «жду решения вендора»), which are NOT open questions.
  //
  // The noun list is CLOSED, not a stem plus an open suffix: a bare «ответ»
  // followed by «any letters» also matched «ответственного подхода»,
  // «словаря терминов», «словоохотливого рассказа» — reminders for messages
  // that asked nothing. There are only a handful of real word forms here, so
  // enumerate them.
  {
    code: 'OQ_WAIT_ANSWER',
    re: new RegExp(`${B}жду\\s+тво(?:его|[её])\\s+(?:ответа?|решени[яе]|слов[оа])${A}`, 'i'),
  },
]

// Truncate on code points (not UTF-16 units) so a surrogate pair is never
// sliced — mirrors ask-guard.ts / store.ts.
function clip(s: string, maxChars: number): string {
  const cps = Array.from(s)
  if (cps.length <= maxChars) return s
  return `${cps.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

const FENCE_MARKER_RE = /^\s*(?:```|~~~)/
const INLINE_CODE_RE = /`[^`\n]*`/g

// Blank out `inline code` spans, keeping length so the snippet still clips the
// same way. The shared fence mask only covers ``` / ~~~ BLOCKS, which is right
// for the guard (it sees few replies), but this detector sees EVERY reply — and
// a reply that merely quotes the wording («раньше я писал `жду го`») asks
// nothing. Only paired backticks on one line mask; a lone one is just a
// character.
//
// Line by line, skipping fence-protected lines AND the ``` markers themselves:
// a marker is three adjacent backticks, which the inline rule would otherwise
// eat as an empty span — destroying the fence and exposing the block it
// protects.
function maskInlineCode(lines: readonly string[], fenceMask: readonly boolean[]): string[] {
  return lines.map((line, i) => {
    if (fenceMask[i] === true || FENCE_MARKER_RE.test(line)) return line
    return line.replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length))
  })
}

/**
 * The first open-question signal in `text`, or undefined when the reply leaves
 * nothing pending on the owner.
 *
 * Ask-guard codes win over OQ codes when both kinds are present, so the finding
 * taxonomy stays stable (the tier-1 list is the older, better-calibrated one).
 */
export function detectOpenQuestion(rawText: string): OpenQuestionDetection | undefined {
  if (rawText.length === 0) return undefined

  const rawLines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const fenceMask = fenceProtectedLines(rawLines)
  const lines = maskInlineCode(rawLines, fenceMask)

  const guardHit = scanSelfGatingAsk(lines.join('\n'))[0]
  if (guardHit !== undefined) return { code: guardHit.code, snippet: guardHit.snippet }

  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue
    const line = lines[i] as string
    if (BLOCKQUOTE_RE.test(line)) continue
    for (const p of OQ_PATTERNS) {
      const m = line.match(p.re)
      if (m !== null) return { code: p.code, snippet: clip(m[0], SNIPPET_MAX_CHARS) }
    }
  }
  return undefined
}
