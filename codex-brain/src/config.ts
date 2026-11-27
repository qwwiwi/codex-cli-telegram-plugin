// Brain settings in `<brain_home>/config.json` (slice plan K10). Hooks, CLI and bridge all read
// this one file; the bridge's own config (legacy `memory.enabled`) is never consulted, so its
// off-by-default value cannot be mistaken for the owner switching Brain off.
//
// Tri-state `enabled` (spec §11): missing file or missing key → on; `true` → on; `false` → off.
// A present but unreadable file, or an `enabled` that is not a boolean, reads as off and is
// reported in `problems`: the file shows the owner meant to configure something, and writing
// memory against a possible refusal is worse than pausing it until `/memory` shows why.

import { existsSync, readFileSync } from 'node:fs'

import { type BrainConfig, BrainConfigFileSchema, DEFAULT_SUMMARIZER } from './contract.js'
import { writeFileAtomic } from './store/atomic.js'
import { type LockOptions, withLock } from './store/lock.js'
import { brainConfigPath, ensureHome } from './store/paths.js'

function defaults(): BrainConfig {
  return { enabled: true, summarizer: { ...DEFAULT_SUMMARIZER }, resume_reemit: false, problems: [] }
}

function readRaw(path: string): { value: Record<string, unknown> } | { error: string } | null {
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { error: `config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'config.json must hold a JSON object' }
  return { value: parsed as Record<string, unknown> }
}

export function readBrainConfig(brainHome: string): BrainConfig {
  const config = defaults()
  const raw = readRaw(brainConfigPath(brainHome))
  if (raw === null) return config
  if ('error' in raw) return { ...config, enabled: false, problems: [raw.error] }

  // Validate field by field so one bad key does not discard the others.
  const shape = BrainConfigFileSchema.shape
  if ('enabled' in raw.value) {
    const enabled = shape.enabled.safeParse(raw.value.enabled)
    if (enabled.success && enabled.data !== undefined) config.enabled = enabled.data
    else {
      config.enabled = false
      config.problems.push('config.json: "enabled" must be true or false; Brain stays off until it is fixed')
    }
  }
  if ('summarizer' in raw.value) {
    const summarizer = shape.summarizer.safeParse(raw.value.summarizer)
    if (summarizer.success) {
      if (summarizer.data?.model !== undefined) config.summarizer.model = summarizer.data.model
      if (summarizer.data?.effort !== undefined) config.summarizer.effort = summarizer.data.effort
    } else config.problems.push('config.json: "summarizer" must be {"model": string, "effort": lowercase word}; defaults used')
  }
  if ('resume_reemit' in raw.value) {
    const reemit = shape.resume_reemit.safeParse(raw.value.resume_reemit)
    if (reemit.success && reemit.data !== undefined) config.resume_reemit = reemit.data
    else config.problems.push('config.json: "resume_reemit" must be true or false; false used')
  }
  return config
}

export interface BrainConfigPatch {
  enabled?: boolean
  summarizer?: { model: string; effort: string }
  resume_reemit?: boolean
}

/**
 * Merges `patch` into config.json (unknown keys kept) and writes it atomically with mode 0600.
 * The read-modify-write runs under the brain_home lock, so two writers (the bridge's `/memory`
 * and the CLI) cannot lose each other's keys; a held lock rejects with `LockTimeoutError`.
 * `/memory off` uses `{ enabled: false }`; that value survives updates because nothing else writes it.
 * An unreadable existing file is replaced, since the owner asked for an explicit state.
 */
export async function writeBrainConfig(brainHome: string, patch: BrainConfigPatch, options: LockOptions = {}): Promise<void> {
  const home = ensureHome(brainHome)
  await withLock(home.lockDir, async () => {
    const raw = readRaw(home.config)
    const current = raw !== null && 'value' in raw ? raw.value : {}
    const next: Record<string, unknown> = { ...current }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.summarizer !== undefined) next.summarizer = { ...patch.summarizer }
    if (patch.resume_reemit !== undefined) next.resume_reemit = patch.resume_reemit
    writeFileAtomic(home.config, `${JSON.stringify(next, null, 2)}\n`)
  }, options)
}
