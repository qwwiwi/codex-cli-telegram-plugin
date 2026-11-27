// Fact store of one scope (spec §5.2, §7.2, A1): one file per fact under `facts/`, the derived
// `INDEX.md`, and `state/manifest.json` with the hash of every file written through Brain.
//
// Only files that match the manifest count as facts: a file written around this store (the agent
// has shell access) is excluded from list, priority, get and INDEX.md, and reported by
// `integrity()` until the owner deals with it.
//
// Writes go through `writer(turn)`, bound to the turn that makes them: every write also appends
// to that turn's receipt under the same lock, so no fact revision is written without a receipt
// (see `auditFactWrites`). A write is a roll-forward intent (`state/fact-commit.json`, see
// `commit`): a crash leaves the intent, and the next read or write finishes it, so neither the
// old nor the new revision is ever hidden and no receipt names an uncommitted revision.
// Revisions never repeat: a removed fact leaves its last revision in `manifest.removed`.
// No write touches a stored snapshot (cache rule 1): HOT picks facts up at the next boundary.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import {
  type Clock, compareIndexLines, type Fact, type FactId, FactIdSchema, type FactInput, FactInputSchema, type FactKind,
  type FactReader, type FactRemoveResult, type FactWriter, type FactWriteResult, formatIndexLine, type IndexLine,
  type IntegrityIssue, type JournalRef, JournalRefSchema, type Manifest, ManifestSchema, type ReceiptWrite, ReceiptWriteSchema, type Scope,
  type TaskStatus,
} from '../contract.js'
import { appendReceiptLocked, readReceipt } from '../permit/receipts.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, LockTimeoutError, withLock } from '../store/lock.js'
import { ensureScope, type ScopePaths, scopePaths } from '../store/paths.js'
import { findSecretText } from './secrets.js'
import { parseFact, serializeFact } from './format.js'

export interface FactStoreOptions {
  clock?: Clock
  lock?: LockOptions
  /** Test seam: runs after the fact file is replaced and before INDEX.md is written (a "kill"). */
  faults?: { afterManifest?: () => void; afterFactFile?: () => void }
}

/** The turn a write belongs to; its id must be one the bridge issued (or a live permit's). */
export interface TurnBinding {
  turnId: string
  journalRef?: JournalRef
}

interface Loaded {
  facts: Map<FactId, Fact>
  manifest: Manifest
  manifestOk: boolean
  issues: IntegrityIssue[]
}

/** The pending commit of `FactStore.commit`, under `state/`. */
const COMMIT_INTENT_FILE = 'fact-commit.json'

const CommitIntentSchema = z.object({
  turn_id: z.string().min(1),
  journal_ref: JournalRefSchema.optional(),
  write: ReceiptWriteSchema,
  /** The new fact file; null removes it. */
  text: z.string().nullable(),
  manifest: ManifestSchema,
}).strict()
type CommitIntent = z.infer<typeof CommitIntentSchema>

const systemClock: Clock = { now: () => new Date() }

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const byId = (a: Fact, b: Fact): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Closed tasks are not active: they leave the index and HOT but stay readable through `get`. */
const isActive = (fact: Fact): boolean => fact.kind !== 'task' || fact.status === 'open'

const indexLine = (fact: Fact): IndexLine => ({ id: fact.id, kind: fact.kind, description: fact.description })

function renderIndex(facts: Iterable<Fact>): string {
  return [...facts].filter(isActive).map(indexLine).sort(compareIndexLines).map(line => `${formatIndexLine(line)}\n`).join('')
}

const failure = (error: 'conflict' | 'not-found' | 'secret' | 'invalid', message: string, current?: number) =>
  current === undefined ? { ok: false as const, error, message } : { ok: false as const, error, current, message }

export class FactStore implements FactReader {
  readonly paths: ScopePaths
  private readonly clock: Clock

  constructor(private readonly brainHome: string, readonly scope: Scope, private readonly options: FactStoreOptions = {}) {
    this.paths = scopePaths(brainHome, scope)
    this.clock = options.clock ?? systemClock
  }

  // ---------------------------------------------------------------- reading

  private readManifest(): { manifest: Manifest; ok: boolean } {
    if (!existsSync(this.paths.manifest)) return { manifest: { version: 1, facts: {} }, ok: true }
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(this.paths.manifest, 'utf8')))
      if (parsed.success) return { manifest: parsed.data, ok: true }
    } catch {
      // Reported below as an invalid manifest.
    }
    return { manifest: { version: 1, facts: {} }, ok: false }
  }

  private load(): Loaded {
    const { manifest, ok } = this.readManifest()
    const facts = new Map<FactId, Fact>()
    const issues: IntegrityIssue[] = []
    if (!ok) issues.push({ file: 'state/manifest.json', problem: 'invalid' })
    const names = existsSync(this.paths.factsDir) ? readdirSync(this.paths.factsDir).filter(n => n.endsWith('.md') && !n.startsWith('.')) : []
    const seen = new Set<string>()
    for (const name of names) {
      const file = `facts/${name}`
      const id = name.slice(0, -3)
      seen.add(id)
      let text: string
      try {
        text = readFileSync(join(this.paths.factsDir, name), 'utf8')
      } catch {
        issues.push({ file, problem: 'invalid' })
        continue
      }
      const fact = FactIdSchema.safeParse(id).success ? parseFact(text) : null
      const entry = manifest.facts[id]
      if (fact === null || fact.id !== id) issues.push({ file, problem: 'invalid' })
      else if (entry === undefined) issues.push({ file, problem: 'not-in-manifest' })
      else if (entry.sha256 !== sha256(text) || entry.revision !== fact.revision) issues.push({ file, problem: 'hash-mismatch' })
      else facts.set(id, fact)
    }
    for (const id of Object.keys(manifest.facts)) {
      if (!seen.has(id)) issues.push({ file: `facts/${id}.md`, problem: 'missing-file' })
    }
    issues.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.problem < b.problem ? -1 : 1))
    return { facts, manifest, manifestOk: ok, issues }
  }

  /**
   * `load()` for readers. A writer replaces the manifest before the fact file, so a reader that
   * lands in between sees a hash mismatch and would drop the fact (from HOT, for a whole session).
   * On a mismatch or a missing file the reader waits once for the scope lock and reads again; if
   * the lock cannot be had in time, the first view stands and `integrity()` reports it.
   */
  private async loadSettled(): Promise<Loaded> {
    await this.settle()
    const first = this.load()
    if (!first.issues.some(issue => issue.problem === 'hash-mismatch' || issue.problem === 'missing-file')) return first
    if (!existsSync(this.paths.lockDir)) return first
    try {
      return await withLock(this.paths.lockDir, async () => this.load(), this.options.lock ?? {})
    } catch (error) {
      if (error instanceof LockTimeoutError) return first
      throw error
    }
  }

  async get(id: FactId): Promise<Fact | null> {
    return (await this.loadSettled()).facts.get(id) ?? null
  }

  async list(kind?: FactKind): Promise<IndexLine[]> {
    return [...(await this.loadSettled()).facts.values()]
      .filter(fact => isActive(fact) && (kind === undefined || fact.kind === kind))
      .map(indexLine)
      .sort(compareIndexLines)
  }

  /** Active facts whose description or body contains `query`, case-insensitive, in index order. */
  async search(query: string): Promise<IndexLine[]> {
    const needle = query.toLocaleLowerCase()
    return [...(await this.loadSettled()).facts.values()]
      .filter(fact => isActive(fact) && `${fact.description}\n${fact.body}`.toLocaleLowerCase().includes(needle))
      .map(indexLine)
      .sort(compareIndexLines)
  }

  async priority(): Promise<Fact[]> {
    const facts = [...(await this.loadSettled()).facts.values()]
    return [
      ...facts.filter(fact => fact.kind === 'pinned').sort(byId),
      ...facts.filter(fact => fact.kind === 'task' && fact.status === 'open').sort(byId),
    ]
  }

  async indexText(): Promise<string> {
    return renderIndex((await this.loadSettled()).facts.values())
  }

  async manifest(): Promise<Manifest> {
    await this.settle()
    return this.readManifest().manifest
  }

  async integrity(): Promise<IntegrityIssue[]> {
    return (await this.loadSettled()).issues
  }

  /** Rebuilds INDEX.md from the facts that match the manifest. */
  async reindex(): Promise<{ lines: number }> {
    return this.locked(paths => {
      const text = renderIndex(this.load().facts.values())
      writeFileAtomic(paths.index, text)
      return { lines: text === '' ? 0 : text.split('\n').length - 1 }
    })
  }

  // ---------------------------------------------------------------- writing

  /** A writer whose every write is recorded in the receipt of `turn`. */
  writer(turn: TurnBinding): FactWriter {
    if (turn.turnId.length === 0) throw new Error('a fact writer needs a turn id')
    return {
      put: (input, expectedRevision) => this.write(turn, input, expectedRevision, 'put'),
      remove: (id, expectedRevision) => this.remove(turn, id, expectedRevision),
      done: (id, status, expectedRevision) => this.close(turn, id, status ?? 'done', expectedRevision),
    }
  }

  private async locked<T>(fn: (paths: ScopePaths) => T): Promise<T> {
    const paths = ensureScope(this.brainHome, this.scope)
    return withLock(paths.lockDir, async () => {
      this.recoverLocked(paths)
      return fn(paths)
    }, this.options.lock ?? {})
  }

  private receiptWrite(fact: Pick<Fact, 'id' | 'kind' | 'description'>, revision: number, action: ReceiptWrite['action']): ReceiptWrite {
    return { id: fact.id, kind: fact.kind, description: fact.description, revision, action, at: this.clock.now().toISOString() }
  }

  private async write(turn: TurnBinding, input: FactInput, expectedRevision: number | undefined, action: 'put' | 'done'): Promise<FactWriteResult> {
    const parsed = FactInputSchema.safeParse(input)
    if (!parsed.success) return failure('invalid', parsed.error.issues.map(issue => `${issue.path.join('.') || 'fact'}: ${issue.message}`).join('; '))
    const data = parsed.data
    if (data.owner_message_id !== undefined && /[\r\n]/.test(data.owner_message_id)) return failure('invalid', 'owner_message_id must be one line')
    // The id is a file name, an index line and a manifest key: a token-shaped id is a secret too.
    const secret = findSecretText([data.id, data.description, data.body, data.owner_message_id ?? ''])
    if (secret !== null) return failure('secret', `the fact contains a secret (${secret}); facts never store secrets`)

    return this.locked(paths => {
      const loaded = this.load()
      if (!loaded.manifestOk) throw new Error('state/manifest.json is unreadable; run `brain doctor` before writing')
      const current = loaded.manifest.facts[data.id]?.revision
      if (expectedRevision === undefined && current !== undefined) {
        return failure('conflict', `fact ${data.id} exists at revision ${current}; pass it as the expected revision to update`, current)
      }
      if (expectedRevision !== undefined && current === undefined) return failure('not-found', `fact ${data.id} does not exist`)
      if (expectedRevision !== undefined && current !== expectedRevision) {
        return failure('conflict', `fact ${data.id} is at revision ${current}, not ${expectedRevision}`, current)
      }
      const today = this.clock.now().toISOString().slice(0, 10)
      // Above the removed high-water mark too: a recreated id never reuses an old revision.
      const revision = (current ?? loaded.manifest.removed?.[data.id] ?? 0) + 1
      const fact: Fact = { ...data, revision, created: loaded.facts.get(data.id)?.created ?? today, updated: today }
      const text = serializeFact(fact)
      const hash = sha256(text)
      const removed = { ...loaded.manifest.removed }
      delete removed[fact.id]
      const manifest: Manifest = { version: 1, facts: { ...loaded.manifest.facts, [fact.id]: { revision, sha256: hash } } }
      if (Object.keys(removed).length > 0) manifest.removed = removed
      this.commit(paths, {
        turn_id: turn.turnId,
        ...(turn.journalRef === undefined ? {} : { journal_ref: turn.journalRef }),
        write: { ...this.receiptWrite(fact, revision, action), sha256: hash },
        text,
        manifest,
      })
      return { ok: true as const, fact }
    })
  }

  // ---------------------------------------------------------------- commit (write-ahead intent)

  /**
   * One fact write as a roll-forward intent: the intent file (`state/fact-commit.json`) is the
   * commit point. Then fact file → manifest → receipt → INDEX.md, and the intent is removed. A
   * crash anywhere after the intent is finished by `recoverLocked` on the next read or write, so
   * a revision is never half-visible and a receipt is only ever written for a committed write.
   */
  private commit(paths: ScopePaths, intent: CommitIntent): void {
    // Everything that can refuse the write is checked before the commit point: an unreadable
    // receipt would otherwise stop `apply` after the fact and the manifest were already written.
    const receipt = paths.receipt(intent.turn_id)
    if (existsSync(receipt) && readReceipt(receipt) === null) {
      throw new Error(`receipt of turn ${intent.turn_id} is unreadable; nothing was written (run \`brain doctor\`)`)
    }
    writeFileAtomic(this.intentPath(paths), `${JSON.stringify(CommitIntentSchema.parse(intent))}\n`)
    this.apply(paths, intent)
  }

  private apply(paths: ScopePaths, intent: CommitIntent): void {
    const file = paths.fact(intent.write.id)
    if (intent.text === null) rmSync(file, { force: true })
    else writeFileAtomic(file, intent.text)
    this.options.faults?.afterFactFile?.()
    writeFileAtomic(paths.manifest, `${JSON.stringify(ManifestSchema.parse(intent.manifest))}\n`)
    this.options.faults?.afterManifest?.()
    const receipt = readReceipt(paths.receipt(intent.turn_id))
    const recorded = receipt?.writes.some(w => w.id === intent.write.id && w.revision === intent.write.revision && w.action === intent.write.action && w.at === intent.write.at) ?? false
    if (!recorded) appendReceiptLocked(paths, intent.turn_id, intent.journal_ref, intent.write)
    writeFileAtomic(paths.index, renderIndex(this.load().facts.values()))
    rmSync(this.intentPath(paths), { force: true })
  }

  private intentPath(paths: ScopePaths): string {
    return join(paths.stateDir, COMMIT_INTENT_FILE)
  }

  private readIntent(paths: ScopePaths): CommitIntent | null {
    const path = this.intentPath(paths)
    if (!existsSync(path)) return null
    try {
      const parsed = CommitIntentSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (parsed.success) return parsed.data
    } catch {
      // Falls through: the file is not an intent this code can apply.
    }
    // Kept for repair, never deleted: it may describe a write that was only partly applied (the
    // manifest hash check then flags that fact file). Moved aside so later writes are not blocked.
    const stamp = this.clock.now().toISOString().replace(/[^0-9TZ]/g, '')
    renameSync(path, join(paths.stateDir, `fact-commit.unreadable-${stamp}-${randomBytes(3).toString('hex')}.json`))
    return null
  }

  /** Finishes an interrupted commit; the caller holds the scope lock. */
  private recoverLocked(paths: ScopePaths): void {
    const intent = this.readIntent(paths)
    if (intent !== null) this.apply(paths, intent)
  }

  /** Takes the lock and finishes an interrupted commit, if there is one; false if the lock was busy. */
  private async settle(): Promise<boolean> {
    if (!existsSync(this.intentPath(this.paths))) return true
    try {
      await withLock(this.paths.lockDir, async () => this.recoverLocked(this.paths), this.options.lock ?? {})
      return true
    } catch (error) {
      if (error instanceof LockTimeoutError) return false
      throw error
    }
  }

  private async remove(turn: TurnBinding, id: FactId, expectedRevision: number): Promise<FactRemoveResult> {
    if (!FactIdSchema.safeParse(id).success) return failure('invalid', `invalid fact id ${id}`)
    return this.locked(paths => {
      const loaded = this.load()
      if (!loaded.manifestOk) throw new Error('state/manifest.json is unreadable; run `brain doctor` before writing')
      const current = loaded.manifest.facts[id]?.revision
      if (current === undefined) return failure('not-found', `fact ${id} does not exist`)
      if (current !== expectedRevision) return failure('conflict', `fact ${id} is at revision ${current}, not ${expectedRevision}`, current)
      const path = paths.fact(id)
      const known = loaded.facts.get(id) ?? (existsSync(path) ? parseFact(readFileSync(path, 'utf8')) : null)
      const subject = known ?? { id, kind: 'user' as const, description: '(unreadable fact file)' }

      const facts = { ...loaded.manifest.facts }
      delete facts[id]
      const manifest: Manifest = { version: 1, facts, removed: { ...loaded.manifest.removed, [id]: current } }
      this.commit(paths, {
        turn_id: turn.turnId,
        ...(turn.journalRef === undefined ? {} : { journal_ref: turn.journalRef }),
        write: this.receiptWrite(subject, current, 'remove'),
        text: null,
        manifest,
      })
      return { ok: true as const, id, revision: current }
    })
  }

  private async close(turn: TurnBinding, id: FactId, status: Exclude<TaskStatus, 'open'>, expectedRevision: number | undefined): Promise<FactWriteResult> {
    const existing = await this.get(id)
    if (existing === null) return failure('not-found', `fact ${id} does not exist`)
    if (existing.kind !== 'task') return failure('invalid', `fact ${id} is a ${existing.kind}, not a task`)
    const { revision: _revision, created: _created, updated: _updated, ...input } = existing
    return this.write(turn, { ...input, status }, expectedRevision ?? existing.revision, 'done')
  }
}
