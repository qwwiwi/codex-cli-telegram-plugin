// HOT snapshot builder of one scope (spec §6.2, D9, D10, D16; slice plan S3).
//
// Cache contract: HOT bytes are built once per boundary and stored in
// `state/snapshot/<session>.txt` with their meta; asking for the same boundary again returns the
// stored bytes, a new boundary rebuilds from the current state. Between boundaries nothing is
// re-sent: an out-of-band owner edit comes out of `delta` as one line, once.
//
// Reads facts, recent exchanges and summaries only through the contract interfaces; the state
// files of this module (snapshot, boundaries) and `delta.jsonl` are read here directly.

import { createHash, randomBytes } from 'node:crypto'

import { readBrainConfig } from '../config.js'
import {
  type BoundaryId, type BrainConfig, type Clock, type Day, type Digest, DeltaLineSchema, type FactReader,
  type OpenBoundary, OpenBoundarySchema, PERSONAL_MEMORY_ROLES, PROVENANCE_VERSION, RECENT_TAIL_MAX_TOKENS, type RecentReader,
  renderRecentTail, type Scope, type SessionRegistry, type SnapshotBuilder, type SnapshotMeta, SnapshotMetaSchema,
  type SnapshotRequest, type SessionSource, type SummaryReader,
} from '../contract.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, withLock } from '../store/lock.js'
import { ensureScope, type ScopePaths, scopePaths } from '../store/paths.js'
import { readJson, readJsonLines, readText } from './files.js'
import { renderHot } from './render.js'

export interface SnapshotBuilderOptions {
  brainHome: string
  scope: Scope
  facts: FactReader
  recent: RecentReader
  summaries: SummaryReader
  sessions: SessionRegistry
  clock: Clock
  /** Effective Brain config, read on every call; defaults to `<brain_home>/config.json`. */
  config?: () => BrainConfig
  lock?: LockOptions
}

/** The session resolves to this scope and to a role that gets personal memory (spec §7.2, D16). */
export async function isPersonalSession(sessions: SessionRegistry, scope: Scope, sessionId: string): Promise<boolean> {
  const entry = await sessions.resolve(sessionId)
  return entry !== null && entry.scope === scope && PERSONAL_MEMORY_ROLES.includes(entry.role)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Stored HOT of a session; null when missing or when the bytes do not match their meta. */
export function readStoredSnapshot(paths: ScopePaths, sessionId: string): { meta: SnapshotMeta; text: string } | null {
  const meta = readJson(paths.snapshotMeta(sessionId), SnapshotMetaSchema)
  const text = readText(paths.snapshotText(sessionId))
  if (meta === null || text === null || meta.session_id !== sessionId || sha256(text) !== meta.sha256) return null
  return { meta, text }
}

function previousDay(day: Day): Day {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

const deltaText = (id: string, action: 'changed' | 'removed'): string =>
  `memory update: fact ${id} ${action} by the owner, read it before use\n`

type DeltaStash = {
  through: number
  /** Persist these changes before the cursor moves, under the same scope lock. */
  save: (text: string, through: number) => void
}

export function createSnapshotBuilder(options: SnapshotBuilderOptions) {
  const { brainHome, scope, facts, recent, summaries, sessions, clock } = options
  const config = options.config ?? (() => readBrainConfig(brainHome))
  const paths = scopePaths(brainHome, scope)
  const enabled = (): boolean => config().enabled

  const maxDeltaSeq = (): number => readJsonLines(paths.delta, DeltaLineSchema).reduce((max, line) => Math.max(max, line.seq), 0)

  async function render(): Promise<{ text: string; revisions: Record<string, number> }> {
    const [priorityAll, active, manifest] = await Promise.all([facts.priority(), facts.list(), facts.manifest()])
    const activeIds = new Set(active.map(line => line.id))
    // A priority fact that fails the integrity check is not in the index, so not in HOT either.
    const priority = priorityAll.filter(fact => activeIds.has(fact.id))
    const priorityIds = new Set(priority.map(fact => fact.id))
    const rest = active.filter(line => !priorityIds.has(line.id))
    const updated = new Map<string, Day>()
    for (const line of rest) {
      const fact = await facts.get(line.id)
      if (fact !== null) updated.set(line.id, fact.updated)
    }
    const today = clock.now().toISOString().slice(0, 10)
    const digests: Digest[] = []
    for (const day of [previousDay(today), today]) {
      const digest = await summaries.digest(day)
      if (digest !== null) digests.push(digest)
    }
    const summary = await summaries.summary()
    const revisions: Record<string, number> = {}
    for (const id of Object.keys(manifest.facts).sort()) {
      const entry = manifest.facts[id]
      if (entry !== undefined) revisions[id] = entry.revision
    }
    return { text: renderHot({ priority, rest, updated, digests, summary }), revisions }
  }

  return {
    async beginBoundary(sessionId: string, source: SessionSource): Promise<BoundaryId> {
      const boundary = randomBytes(12).toString('base64url')
      // Disabled: nothing is written, so a switched-off Brain leaves no new files behind.
      if (!enabled()) return boundary
      const open = OpenBoundarySchema.parse({ session_id: sessionId, boundary, source, opened: clock.now().toISOString() })
      ensureScope(brainHome, scope)
      // The lock `build` checks the open boundary and stores under: a boundary never opens
      // between that check and the store.
      await withLock(paths.lockDir, async () => writeFileAtomic(paths.boundary(sessionId), `${JSON.stringify(open)}\n`), options.lock)
      return boundary
    },

    async openBoundary(sessionId: string): Promise<OpenBoundary | null> {
      const open = readJson(paths.boundary(sessionId), OpenBoundarySchema)
      return open !== null && open.session_id === sessionId ? open : null
    },

    async build(request: SnapshotRequest): Promise<string> {
      const current = config()
      if (!current.enabled || request.source === 'fork') return ''
      if (!await isPersonalSession(sessions, scope, request.sessionId)) return ''
      if (request.source === 'resume') {
        return current.resume_reemit ? readStoredSnapshot(paths, request.sessionId)?.text ?? '' : ''
      }
      const stored = readStoredSnapshot(paths, request.sessionId)
      if (stored !== null && stored.meta.boundary === request.boundary) return stored.text

      // The delta cursor is taken before the facts are read: an edit logged while HOT renders may
      // be missing from it, so it must stay unseen and come out of `delta` (twice at worst).
      const cursor = maxDeltaSeq()
      const built = await render()
      ensureScope(brainHome, scope)
      return withLock(paths.lockDir, async () => {
        // Another process may have built this boundary while we rendered: its bytes win.
        const again = readStoredSnapshot(paths, request.sessionId)
        if (again !== null && again.meta.boundary === request.boundary) return again.text
        // A newer boundary opened while we rendered (a slow compact build overtaken by a clear):
        // this build is answered but never stored, so it cannot overwrite the newer snapshot.
        const open = readJson(paths.boundary(request.sessionId), OpenBoundarySchema)
        if (open !== null && open.session_id === request.sessionId && open.boundary !== request.boundary) return built.text
        const meta = SnapshotMetaSchema.parse({
          session_id: request.sessionId,
          source: request.source,
          boundary: request.boundary,
          sha256: sha256(built.text),
          provenance: PROVENANCE_VERSION,
          // The new HOT reflects every edit logged before its facts were read.
          delta_seen: cursor,
          facts: built.revisions,
        })
        // Text first: a crash before the meta leaves a hash mismatch, which reads as "not stored".
        writeFileAtomic(paths.snapshotText(request.sessionId), built.text)
        writeFileAtomic(paths.snapshotMeta(request.sessionId), `${JSON.stringify(meta)}\n`)
        return built.text
      }, options.lock)
    },

    async recentTail(): Promise<string> {
      if (!enabled()) return ''
      return renderRecentTail(await recent.exchanges(), RECENT_TAIL_MAX_TOKENS)
    },

    async delta(sessionId: string, stash?: DeltaStash): Promise<string> {
      if (!enabled()) return ''
      if (!await isPersonalSession(sessions, scope, sessionId)) return ''
      const unseen = (meta: SnapshotMeta) => readJsonLines(paths.delta, DeltaLineSchema)
        .filter(line => line.seq > meta.delta_seen)
        .sort((a, b) => a.seq - b.seq)
      const stored = readStoredSnapshot(paths, sessionId)
      if (stored === null || unseen(stored.meta).length === 0) return ''
      return withLock(paths.lockDir, async () => {
        const fresh = readStoredSnapshot(paths, sessionId)
        if (fresh === null) return ''
        const lines = unseen(fresh.meta)
        const last = lines.at(-1)
        if (last === undefined) return ''
        const text = lines.filter(line => line.seq > (stash?.through ?? 0))
          .map(line => deltaText(line.id, line.action)).join('')
        if (text) stash?.save(text, last.seq)
        const meta = SnapshotMetaSchema.parse({ ...fresh.meta, delta_seen: last.seq })
        writeFileAtomic(paths.snapshotMeta(sessionId), `${JSON.stringify(meta)}\n`)
        return text
      }, options.lock)
    },
  } satisfies SnapshotBuilder
}
