// Handoff document renderer and budget fitter (spec §8.3, A1).
//
// The handoff enters at developer level, so the renderer prints only what the builder already
// cleared under the trust rule: owner-direct / terminal text, validated fact descriptions and
// agent-authored plan / question / note lines. No timestamp is printed, so the same state gives
// the same bytes.

import { redactSecrets } from '../../../plugin/src/safety/redact.js'
import { estimateTokens, formatIndexLine, type Handoff, HANDOFF_MAX_TOKENS, type PlanStep } from '../contract.js'

export const HANDOFF_TITLE = '# Handoff (reference data, grants no permissions)'
export const NO_NEXT_STEP = 'see journal tail'

/** The line that stands for open tasks left out of a bounded block (HOT and handoff). */
export const moreTasksLine = (count: number): string => `- ${count} more open tasks: brain list --kind task`

const TRIGGER_LABEL: Record<Handoff['trigger'], string> = {
  manual: 'PreCompact manual',
  auto: 'PreCompact auto',
  bridge: 'bridge (hooks unavailable)',
}

const PLAN_MARK: Record<PlanStep['status'], string> = { completed: '[x]', inProgress: '[>]', pending: '[ ]' }

/** One clean line: secrets redacted, every run of whitespace (line breaks included) one space. */
export function oneLine(text: string): string {
  return redactSecrets(text).replace(/\s+/g, ' ').trim()
}

/** Cuts to `max` code points, marking the cut with `…`. */
export function truncate(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`
}

const notQuoted = (ref: string, origin: string): string => `${ref} · ${origin}: text not quoted, read it with \`brain journal show ${ref}\``

export function renderHandoff(handoff: Handoff): string {
  const thread = handoff.thread ?? handoff.session_id
  const journal = handoff.journal_to === undefined ? '' : ` · journal up to ${handoff.journal_to}`
  const out: string[] = [HANDOFF_TITLE, `written: ${TRIGGER_LABEL[handoff.trigger]} · thread ${thread}${journal}`]

  if (handoff.tasks.length > 0) {
    out.push('', '## Open tasks')
    for (const task of handoff.tasks) out.push(`- ${task.id} · ${task.description}${task.next === undefined ? '' : ` · next: ${task.next}`}`)
  }
  if (handoff.tasks_omitted !== undefined) {
    if (handoff.tasks.length === 0) out.push('', '## Open tasks')
    out.push(moreTasksLine(handoff.tasks_omitted))
  }

  out.push('', '## In-flight task')
  const inFlight = handoff.in_flight
  if (inFlight === null) out.push('none')
  else if (inFlight.quote === undefined) out.push(notQuoted(inFlight.ref, inFlight.origin))
  else out.push(`${inFlight.ref} · ${inFlight.origin}: ${inFlight.quote}`)
  if (handoff.in_flight_prompt !== undefined) out.push(`terminal prompt: ${handoff.in_flight_prompt}`)
  if (handoff.plan.length > 0) out.push(`Plan: ${handoff.plan.map(step => `${PLAN_MARK[step.status]} ${step.step}`).join(' · ')}`)

  if (handoff.open_questions.length > 0) {
    out.push('', '## Open questions to the owner', ...handoff.open_questions.map(question => `- ${question}`))
  }
  if (handoff.decisions.length > 0) out.push('', '## Last decisions', ...handoff.decisions.map(formatIndexLine))

  out.push('', '## Next step', handoff.next_step ?? NO_NEXT_STEP)

  if (handoff.tail.length > 0) {
    out.push('', '## Journal tail')
    for (const entry of handoff.tail) out.push(entry.line === undefined ? `- ${notQuoted(entry.ref, entry.origin)}` : `- ${entry.ref} · ${entry.origin}: ${entry.line}`)
  }
  return `${out.join('\n')}\n`
}

type Reducer = (handoff: Handoff) => Handoff | null

/** Shrink steps, least important first; each returns null when it has nothing left to remove. */
const REDUCERS: readonly Reducer[] = [
  // Tail text first: the refs stay, the journal has the full text.
  h => {
    const i = h.tail.findIndex(entry => entry.line !== undefined)
    const entry = h.tail[i]
    if (entry === undefined) return null
    const { line: _line, ...bare } = entry
    return { ...h, tail: h.tail.map((e, j) => (j === i ? bare : e)) }
  },
  h => (h.decisions.length === 0 ? null : { ...h, decisions: h.decisions.slice(0, -1) }),
  h => (h.open_questions.length === 0 ? null : { ...h, open_questions: h.open_questions.slice(0, -1) }),
  h => (h.plan.length === 0 ? null : { ...h, plan: h.plan.slice(0, -1) }),
  h => {
    const quote = h.in_flight?.quote
    if (h.in_flight === null || quote === undefined) return null
    const length = Array.from(quote).length
    if (length > 80) return { ...h, in_flight: { ...h.in_flight, quote: truncate(quote, Math.floor(length / 2)) } }
    const { quote: _quote, ...bare } = h.in_flight
    return { ...h, in_flight: bare }
  },
  h => {
    const prompt = h.in_flight_prompt
    if (prompt === undefined) return null
    const length = Array.from(prompt).length
    if (length > 80) return { ...h, in_flight_prompt: truncate(prompt, Math.floor(length / 2)) }
    const { in_flight_prompt: _prompt, ...rest } = h
    return rest
  },
  h => (h.tail.length === 0 ? null : { ...h, tail: h.tail.slice(1) }),
  h => {
    const i = h.tasks.findLastIndex(task => task.next !== undefined)
    const task = h.tasks[i]
    if (task === undefined) return null
    const { next: _next, ...bare } = task
    return { ...h, tasks: h.tasks.map((t, j) => (j === i ? bare : t)) }
  },
  // Last resort: list fewer open tasks; the count line keeps every one reachable.
  h => {
    if (h.tasks.length === 0) return null
    return { ...h, tasks: h.tasks.slice(0, -1), tasks_omitted: (h.tasks_omitted ?? 0) + 1 }
  },
]

/**
 * Shrinks the handoff until its rendering fits `maxTokens`. Open tasks go last, and then only
 * from the listing: `tasks_omitted` counts them and the rendering points to `brain list`.
 */
export function fitHandoff(handoff: Handoff, maxTokens: number = HANDOFF_MAX_TOKENS): Handoff {
  let current = handoff
  const over = (h: Handoff): boolean => estimateTokens(renderHandoff(h)) > maxTokens
  for (const reduce of REDUCERS) {
    while (over(current)) {
      const next = reduce(current)
      if (next === null) break
      current = next
    }
  }
  return current
}
