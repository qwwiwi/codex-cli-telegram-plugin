// Brain summarizer adapter (slice S4, A3, K11): turns the contract's `Summarizer` into a
// structured call over `requestStructured` (ephemeral read-only thread, no tools), with the model
// and effort from `<brain_home>/config.json` (default gpt-6.1-terra at high).
//
// Before the first call, and again after `recheckMs`, it reads `model/list`. The configured model
// is used only when the list has it and names the configured effort among its supported efforts;
// otherwise the job falls back to the main (default) model at low effort and records a warning in
// `<brain_home>/summarizer.json` for `/memory` and `BrainStatus.summarizer` - never a silent skip.
// Only background jobs call this; no hook imports it (slice plan K5).

import { readBrainConfig } from '../../../codex-brain/src/config.js'
import {
  type Clock, type JsonSchemaObject, type Summarizer, type SummarizerState, SummarizerStateSchema,
} from '../../../codex-brain/src/contract.js'
import { writeFileAtomic } from '../../../codex-brain/src/store/atomic.js'
import { ensureHome } from '../../../codex-brain/src/store/paths.js'
import { requestStructured } from './learning-review.js'
import { CodexRpc, object } from './rpc.js'
import type { CodexModel } from './session.js'

/** Effort of the documented fallback (A3). */
export const FALLBACK_EFFORT = 'low'
/** How long one `model/list` check is reused by a summarizer instance. */
export const MODEL_CHECK_TTL_MS = 60 * 60 * 1000

type ModelChoice = { model: string; effort: string }

function fallbackChoice(models: readonly CodexModel[]): ModelChoice {
  const main = models.find(m => m.default) ?? models[0]
  if (main === undefined) throw new Error('model/list returned no model for the Brain summarizer')
  const effort = main.efforts.includes(FALLBACK_EFFORT) ? FALLBACK_EFFORT : main.defaultEffort ?? main.efforts[0] ?? FALLBACK_EFFORT
  return { model: main.name, effort }
}

/** Decides which model and effort the summarizer uses, given the configured pair and `model/list`. */
export function resolveSummarizerModel(configured: ModelChoice, models: readonly CodexModel[], now: Date): SummarizerState {
  const checked = now.toISOString()
  const listed = models.find(m => m.name === configured.model)
  if (listed?.efforts.includes(configured.effort)) {
    return SummarizerStateSchema.parse({ configured: { ...configured }, used: { ...configured }, fallback: false, checked })
  }
  const used = fallbackChoice(models)
  const reason = listed === undefined
    ? `Модель сводок ${configured.model} не найдена в списке моделей Codex`
    : `Модель сводок ${configured.model} не поддерживает усилие ${configured.effort}`
  return SummarizerStateSchema.parse({
    configured: { ...configured }, used, fallback: true, checked,
    warning: `${reason}: сводки и дайджест идут на ${used.model} с усилием ${used.effort}.`,
  })
}

/** One structured model call with an explicit model and effort. */
export type StructuredRequest = (prompt: string, schema: JsonSchemaObject, signal: AbortSignal, model: string, effort: string) => Promise<string>

export interface BrainSummarizerOptions {
  brainHome: string
  clock: Clock
  listModels: () => Promise<CodexModel[]>
  request: StructuredRequest
  recheckMs?: number
}

function writeState(brainHome: string, state: SummarizerState): void {
  const home = ensureHome(brainHome)
  writeFileAtomic(home.summarizerState, `${JSON.stringify(state, null, 2)}\n`)
}

export function createBrainSummarizer(options: BrainSummarizerOptions): Summarizer {
  const recheckMs = options.recheckMs ?? MODEL_CHECK_TTL_MS
  let cached: { state: SummarizerState; at: number } | null = null
  return async (prompt, schema, signal) => {
    const configured = readBrainConfig(options.brainHome).summarizer
    const now = options.clock.now()
    let current = cached
    if (current === null || now.getTime() - current.at >= recheckMs
      || current.state.configured.model !== configured.model || current.state.configured.effort !== configured.effort) {
      // A failed list fails the call: the job keeps its batch and retries later.
      const state = resolveSummarizerModel(configured, await options.listModels(), now)
      writeState(options.brainHome, state)
      current = { state, at: now.getTime() }
      cached = current
    }
    return options.request(prompt, schema, signal, current.state.used.model, current.state.used.effort)
  }
}

const EFFORT_NAME = /^[a-z]{1,16}$/

/** `model/list` of a short-lived App Server, parsed as the bridge's session does. */
export async function listCodexModels(cwd: string, env: NodeJS.ProcessEnv, command?: readonly [string, ...string[]]): Promise<CodexModel[]> {
  const rpc = new CodexRpc(cwd, env, () => undefined, () => undefined, command)
  try {
    await rpc.initialize()
    const reply = await rpc.request('model/list', { limit: 100, includeHidden: false })
    if (!Array.isArray(reply.data)) return []
    return reply.data.map(object)
      .filter(item => typeof item.model === 'string' && item.hidden !== true)
      .map(item => {
        const efforts = Array.isArray(item.supportedReasoningEfforts) ? [...new Set(item.supportedReasoningEfforts
          .map(option => object(option).reasoningEffort)
          .filter((effort): effort is string => typeof effort === 'string' && EFFORT_NAME.test(effort)))] : []
        const fallback = item.defaultReasoningEffort
        return {
          name: item.model as string, default: item.isDefault === true, efforts,
          ...(typeof fallback === 'string' && efforts.includes(fallback) ? { defaultEffort: fallback } : {}),
        }
      })
  } finally {
    rpc.close()
  }
}

/** `requestStructured` bound to one working directory, environment and App Server command. */
export function structuredRequest(cwd: string, env: NodeJS.ProcessEnv, command?: readonly [string, ...string[]]): StructuredRequest {
  return (prompt, schema, signal, model, effort) => requestStructured(cwd, env, prompt, schema, signal, model, command, effort)
}
