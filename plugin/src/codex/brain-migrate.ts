import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DESCRIPTION_MAX, ProposalSchema, TimestampSchema, type Clock, type FactKind, type JournalWriter, type ProposalStore } from '../../../codex-brain/src/contract.js'
import type { FactStore } from '../../../codex-brain/src/facts/store.js'
import { writeFileAtomic } from '../../../codex-brain/src/store/atomic.js'
import { withLock } from '../../../codex-brain/src/store/lock.js'
import { ensureScope, type ScopePaths } from '../../../codex-brain/src/store/paths.js'
import { readJson } from '../../../codex-brain/src/snapshot/files.js'
import { redactSecrets } from '../safety/redact.js'

const EntrySchema = z.object({
  kind: z.enum(['user', 'memory', 'skill']),
  key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  text: z.string().min(1),
  triggers: z.array(z.string()),
})
const LegacySchema = z.object({
  pending: z.array(EntrySchema).default([]),
  approved: z.array(EntrySchema).default([]),
  exchanges: z.array(z.object({ user: z.string(), assistant: z.string() })).default([]),
})
const StateSchema = z.object({ started: TimestampSchema, done: z.boolean() })
const kinds: Record<z.infer<typeof EntrySchema>['kind'], FactKind> = {
  user: 'user', memory: 'correction', skill: 'reference',
}

export function legacyFactId(value: string): string {
  const match = /^(user|memory|skill)\/([a-z][a-z0-9-]{0,39})$/u.exec(value)
  return match ? `legacy-${match[1]}-${match[2]}` : value
}

export function factDescription(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, DESCRIPTION_MAX).replace(/[\uD800-\uDBFF]$/u, '')
}

interface MigrationOptions {
  root: string
  paths: ScopePaths
  facts: FactStore
  proposals: ProposalStore
  writer: JournalWriter
  clock: Clock
  secrets: readonly string[]
  warn?: (message: string) => void
}

export async function migrateLearning(options: MigrationOptions): Promise<{ facts: number; proposals: number; exchanges: number }> {
  const { root, paths, facts, proposals, writer, clock, secrets } = options
  const counts = { facts: 0, proposals: 0, exchanges: 0 }
  const marker = join(paths.stateDir, 'learning-migration.json')
  if (readJson(marker, StateSchema)?.done) return counts
  let raw: string
  try {
    raw = readFileSync(join(root, 'learning.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return counts
    throw error
  }
  const legacy = LegacySchema.safeParse(JSON.parse(raw))
  if (!legacy.success) throw new Error('Legacy learning state failed validation')
  ensureScope(paths.brainHome, paths.scope)
  const lock = join(paths.stateDir, 'learning-migration-lock')
  mkdirSync(lock, { recursive: true, mode: 0o700 })
  return withLock(lock, async () => {
    const state = readJson(marker, StateSchema) ?? { started: clock.now().toISOString(), done: false }
    if (state.done) return counts
    const save = (done: boolean) => writeFileAtomic(marker, JSON.stringify({ ...state, done }) + '\n')
    save(false)
    const clean = (text: string) => redactSecrets(text, secrets)
    const toFact = (entry: z.infer<typeof EntrySchema>) => ({
      id: legacyFactId(entry.kind + '/' + entry.key),
      kind: kinds[entry.kind],
      description: factDescription(clean(entry.text)) || entry.key,
      body: clean(entry.text + (entry.triggers.length ? '\n\nTriggers: ' + entry.triggers.join(', ') : '')),
    })
    const manifest = await facts.manifest()
    // A legacy "approved" entry carries no durable evidence that the owner approved it: with
    // auto-save on, the learning reviewer (model output) wrote it there itself. So every legacy
    // entry becomes a proposal the owner confirms in /memory, never a fact (`counts.facts` stays 0).
    // A fact imported by an earlier version, or removed since, is left as it is.
    for (const entry of [...legacy.data.approved, ...legacy.data.pending]) {
      const fact = toFact(entry)
      if (manifest.facts[fact.id] || manifest.removed?.[fact.id] || await proposals.get(fact.id)) continue
      const candidate = { id: fact.id, fact, from: 'migration' as const, reason: 'migration' as const, created: state.started }
      // An entry the store cannot hold is skipped with a warning: throwing here would fail every start.
      if (!ProposalSchema.safeParse(candidate).success) {
        options.warn?.(`Brain skipped the legacy learning entry ${entry.kind}/${entry.key}: it is not a valid proposal`)
        continue
      }
      await proposals.add(candidate)
      counts.proposals++
    }
    for (const [i, exchange] of legacy.data.exchanges.entries()) {
      // Legacy learning has no durable proof of a direct Telegram origin.
      const ref = await writer.bind({
        key: 'legacy-learning:' + i, origin: 'owner-forward', input_kind: 'text',
        input: clean(exchange.user), ts_in: state.started,
      })
      await writer.answered(ref, clean(exchange.assistant))
      await writer.delivered(ref)
      counts.exchanges++
    }
    save(true)
    return counts
  })
}
