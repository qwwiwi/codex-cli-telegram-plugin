import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync,
  type BigIntStats,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  isPublicOwner, ownedPublicDirectory, preparePublicHome, PublicHomeError, PUBLIC_ROLES, samePublicObject, type PublicRole,
} from './public-home.js'
import { publishExclusive, PUBLISH_TEMP, syncDirectory, type PublishFault } from './public-publish.js'

export const GENERATION_ID = /^\d{12}-[a-f0-9]{16}$/u
// The legacy <codex-public>/<role> source in a retry list.
const LEGACY = 'legacy'

/** Where history is imported from: a published generation, or the legacy role folders (no id). */
export interface ImportSource {
  id: string | undefined
  path: string
  identity: BigIntStats
}

function entryAt(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false })
}

function isPrivateFile(stat: BigIntStats | undefined): stat is BigIntStats {
  return stat !== undefined && stat.isFile() && isPublicOwner(stat) && stat.nlink === 1n
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

function ensureDirectory(path: string): BigIntStats {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  return ownedPublicDirectory(path)
}

const MARKER = 'complete.json'
const MARKER_VERSION = 1

interface Unpublished { state: 'unpublished' }
interface Published { state: 'published'; retry: string[] }
interface Damaged { state: 'damaged' }
/** What complete.json says about a generation; only `published` is ever trusted as complete. */
type MarkerState = Unpublished | Published | Damaged

const UNPUBLISHED: Unpublished = { state: 'unpublished' }
const DAMAGED: Damaged = { state: 'damaged' }

// A crash between link and unlink (public-publish.ts) leaves the marker with its temporary twin.
function hasPublishTwin(generation: string, marker: BigIntStats): boolean {
  return readdirSync(generation).some(name => {
    if (!PUBLISH_TEMP.test(name)) return false
    const twin = entryAt(join(generation, name))
    return twin !== undefined && twin.isFile() && twin.dev === marker.dev && twin.ino === marker.ino
  })
}

function isRetryToken(value: unknown, id: string): value is string {
  return typeof value === 'string' && (value === LEGACY || GENERATION_ID.test(value) && value !== id)
}

/**
 * Reads complete.json of a generation directory strictly. Missing: unpublished (the final name
 * never appears half-written). A regular own file with one link, version 1, its own id and a valid
 * retry list: published. Everything else (read error, link, foreign owner, extra links, bad JSON or
 * fields) is damaged and stops the collection.
 */
function readMarker(generation: string, id: string): MarkerState {
  const path = join(generation, MARKER)
  let value: unknown
  try {
    const stat = entryAt(path)
    if (!stat) return UNPUBLISHED
    if (stat.isFile() && isPublicOwner(stat) && stat.nlink === 2n && hasPublishTwin(generation, stat)) return UNPUBLISHED
    if (!isPrivateFile(stat)) return DAMAGED
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const open = fstatSync(fd, { bigint: true })
      if (!isPrivateFile(open) || !samePublicObject(open, stat)) return DAMAGED
      value = JSON.parse(readFileSync(fd, 'utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return DAMAGED
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DAMAGED
  if (!('version' in value) || value.version !== MARKER_VERSION || !('id' in value) || value.id !== id) return DAMAGED
  if (!('retry' in value) || !Array.isArray(value.retry)) return DAMAGED
  const retry: string[] = []
  for (const token of value.retry) {
    if (!isRetryToken(token, id)) return DAMAGED
    retry.push(token)
  }
  return { state: 'published', retry }
}

interface Classified { id: string; path: string; stat: BigIntStats | undefined; marker: MarkerState }

/** Open the store under the token lock. The state directory already exists. */
export function openPublicGenerations(homesRoot: string, before: BeforeStep = () => {}) {
  const root = resolve(homesRoot)
  before(root)
  const rootIdentity = ensureDirectory(root)
  const directory = join(root, 'generations')
  before(directory)
  ownedPublicDirectory(root, rootIdentity)
  const generationsIdentity = ensureDirectory(directory)
  const check = () => {
    ownedPublicDirectory(root, rootIdentity)
    ownedPublicDirectory(directory, generationsIdentity)
  }
  const ids = readdirSync(directory).filter(id => GENERATION_ID.test(id)).sort().reverse()
  const classified: Classified[] = ids.map(id => {
    check()
    const path = join(directory, id)
    const stat = entryAt(path)
    const own = stat?.isDirectory() && stat.dev === generationsIdentity.dev && isPublicOwner(stat)
    return { id, path, stat: own ? stat : undefined, marker: own ? readMarker(path, id) : DAMAGED }
  })
  const byId = new Map(classified.map(generation => [generation.id, generation]))
  const source = (generation: Classified): ImportSource[] =>
    generation.stat ? [{ id: generation.id, path: generation.path, identity: generation.stat }] : []
  const legacy: ImportSource = { id: undefined, path: root, identity: rootIdentity }
  const sources: ImportSource[] = []
  // Paths that stop every collection of this start: a damaged marker anywhere, or a retry id of the
  // newest published generation that is missing.
  const stopped = new Set<string>()
  // Retry ids of the newest published marker that still exist on disk. Each one stays referenced
  // (kept, and named in the next marker) until a published generation imported it without a failure.
  const referenced: string[] = []
  const damaged = classified.filter(generation => generation.marker.state === 'damaged')
  for (const generation of damaged) stopped.add(generation.path)
  const newest = classified.find(generation => generation.marker.state === 'published')
  if (newest && newest.marker.state === 'published') {
    sources.push(...source(newest))
    for (const retry of newest.marker.retry) {
      if (retry === LEGACY) {
        sources.push(legacy)
        continue
      }
      const retried = byId.get(retry)
      if (!retried) {
        // Nothing left on disk to lose: this start stops, the next marker no longer names it.
        stopped.add(join(directory, retry))
        continue
      }
      referenced.push(retry)
      // A referenced generation is history that failed to import, whatever its own marker says
      // now (lost, unpublished): copy from it while it is an own directory, never collect it.
      if (retried.marker.state !== 'damaged') sources.push(...source(retried))
    }
  }
  // A damaged generation may still hold chats: copy from it, never trust it as complete.
  for (const generation of damaged) sources.push(...source(generation))
  if (!newest) sources.push(legacy)
  const importId = sources[0]?.id
  // Generation ids the collection before the build keeps: every import source and every reference.
  const keep = [...new Set([...sources.flatMap(entry => entry.id === undefined ? [] : [entry.id]), ...referenced])]
  const identities = [rootIdentity, generationsIdentity].map(stat => ({ dev: String(stat.dev), ino: String(stat.ino) }))
  return { root, directory, identities, importId, ids, check, sources, keep, referenced, stopped: [...stopped] }
}

type GenerationStore = ReturnType<typeof openPublicGenerations>
type PrepareInput = Omit<Parameters<typeof preparePublicHome>[0], 'home' | 'beforeCreate' | 'checkParents'>
type BeforeStep = (path: string) => void

// A read error of eligible history (EACCES, EIO, EMFILE, ...) fails the import so its source is
// kept; a substituted link (ELOOP) or a changed object is unsafe and skipped.
function readFailed(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && code !== 'ELOOP'
}

// Copies sessions/** and bridge-thread.json into the new role home. Entries already present
// (imported from a newer source) are kept: a retried older source only fills what is missing.
function importHistory(input: {
  source: string; target: string; checkSourceParent: () => BigIntStats; checkTarget: () => void
  before: BeforeStep; warn: () => void; fail: () => void
  /** A directory that gained an entry; it is fsynced before the marker is published. */
  touched: (directory: string) => void
}): void {
  const { source, target, checkSourceParent, checkTarget, before, warn, fail, touched } = input
  const skip = (error: unknown) => {
    if (readFailed(error)) fail()
    else warn()
  }
  let role: BigIntStats
  try {
    const parent = checkSourceParent()
    if (!entryAt(source)) return
    role = ownedPublicDirectory(source)
    if (role.dev !== parent.dev) throw new Error('Source directory device changed')
  } catch (error) {
    skip(error)
    return
  }
  const checkSource = () => {
    checkSourceParent()
    ownedPublicDirectory(source, role)
  }

  function copy(path: string, dest: string, kind: 'any' | 'directory' | 'file',
    checkParent: () => void, checkDest: () => void): void {
    let stat: BigIntStats | undefined
    try {
      checkParent()
      stat = entryAt(path)
      if (!stat) {
        if (kind === 'any') warn()
        return
      }
    } catch (error) {
      skip(error)
      return
    }
    if (stat.isDirectory() && kind !== 'file' && isPublicOwner(stat) && stat.dev === role.dev) {
      const identity = stat
      const checkDir = () => {
        checkParent()
        ownedPublicDirectory(path, identity)
      }
      let names: string[]
      before(path)
      try {
        checkDir()
        names = readdirSync(path)
        checkDir()
      } catch (error) {
        skip(error)
        return
      }
      before(dest)
      checkDest()
      try {
        checkDir()
      } catch (error) {
        skip(error)
        return
      }
      const existing = entryAt(dest)
      let destIdentity: BigIntStats
      if (existing) {
        if (!existing.isDirectory() || !isPublicOwner(existing)) {
          warn()
          return
        }
        destIdentity = existing
      } else {
        mkdirSync(dest, { mode: 0o700 })
        destIdentity = ownedPublicDirectory(dest)
        touched(dirname(dest))
        touched(dest)
      }
      const checkNewDir = () => {
        checkDest()
        ownedPublicDirectory(dest, destIdentity)
      }
      for (const name of names) copy(join(path, name), join(dest, name), 'any', checkDir, checkNewDir)
    } else if (kind !== 'directory' && isPrivateFile(stat) && stat.dev === role.dev) {
      before(path)
      before(dest)
      let content: Buffer
      try {
        checkParent()
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const open = fstatSync(fd, { bigint: true })
          if (!isPrivateFile(open) || !samePublicObject(stat, open)) throw new Error('Source file changed')
          content = readFileSync(fd)
          checkParent()
          if (!isPrivateFile(fstatSync(fd, { bigint: true }))) throw new Error('Source file changed')
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        skip(error)
        return
      }
      checkDest()
      // A newer source already provided this file.
      if (entryAt(dest)) return
      writeDurable(dest, content)
      touched(dirname(dest))
    } else {
      warn()
    }
  }
  copy(join(source, 'sessions'), join(target, 'sessions'), 'directory', checkSource, checkTarget)
  copy(join(source, 'bridge-thread.json'), join(target, 'bridge-thread.json'), 'file', checkSource, checkTarget)
}

// Exclusive create (never through a link), full write and fsync of one imported history file.
function writeDurable(path: string, content: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let written = 0
    while (written < content.length) written += writeSync(fd, content, written, content.length - written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function oneLine(path: string): string {
  return path.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
}

export function createPublicGeneration(store: GenerationStore, warn: (message: string) => void, before: BeforeStep = () => {}) {
  let seq = Number(store.ids[0]?.slice(0, 12) ?? 0)
  let id: string
  let path: string
  for (;;) {
    if (++seq > 999_999_999_999) throw new PublicHomeError('Public home generation sequence exhausted')
    id = String(seq).padStart(12, '0') + '-' + randomBytes(8).toString('hex')
    path = join(store.directory, id)
    before(path)
    store.check()
    try {
      mkdirSync(path, { mode: 0o700 })
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  const generation = ownedPublicDirectory(path)
  const checkGeneration = () => {
    store.check()
    ownedPublicDirectory(path, generation)
  }
  const prepared = new Map<PublicRole, () => void>()
  // Directories whose new entries must be durable before complete.json appears.
  const dirty = new Set<string>([store.directory, path])
  const touched = (directory: string) => { dirty.add(directory) }
  const warned = new Set<ImportSource>()
  const failed = new Set<ImportSource>()
  // Ids this generation's marker must name: every failed source, and every reference of the store
  // that was not imported here without a failure (not an own directory now, for example).
  const pending = (): string[] => {
    const imported = new Set(store.sources.flatMap(source => source.id !== undefined && !failed.has(source) ? [source.id] : []))
    const ids = [...failed].map(source => source.id ?? LEGACY)
    return [...new Set([...ids, ...store.referenced.filter(ref => !imported.has(ref))])]
  }

  return {
    id,
    path,
    prepare(input: PrepareInput) {
      const home = join(path, input.role)
      before(home)
      checkGeneration()
      mkdirSync(home, { mode: 0o700 })
      const role = ownedPublicDirectory(home)
      touched(home)
      const checkRole = () => {
        checkGeneration()
        ownedPublicDirectory(home, role)
      }
      for (const source of store.sources) {
        const checkSource = () => {
          store.check()
          return ownedPublicDirectory(source.path, source.identity)
        }
        importHistory({
          source: join(source.path, input.role), target: home, checkSourceParent: checkSource, checkTarget: checkRole, before, touched,
          warn: () => {
            if (warned.has(source)) return
            warned.add(source)
            warn('Skipped unsafe or unreadable public Codex history while importing from ' + oneLine(source.path))
          },
          fail: () => {
            if (failed.has(source)) return
            failed.add(source)
            warn('Could not read public Codex history in ' + oneLine(source.path) +
              '; the folder is kept and the import is retried at the next start')
          },
        })
      }
      const result = preparePublicHome({ ...input, home, beforeCreate: before, checkParents: checkRole })
      prepared.set(input.role, checkRole)
      return result
    },
    /** Paths of the import sources whose history could not be read; each is kept and retried. */
    importFailures(): string[] {
      return [...failed].map(source => source.path)
    },
    /** Generation ids the collection after the start keeps: this one and every id its marker names. */
    keep(): string[] {
      return [id, ...pending().filter(ref => ref !== LEGACY)]
    },
    publish(fault?: PublishFault) {
      const marker = join(path, MARKER)
      before(marker)
      checkGeneration()
      for (const role of PUBLIC_ROLES) {
        const check = prepared.get(role)
        if (!check) throw new PublicHomeError('Cannot publish the public generation before both roles are built')
        check()
      }
      // Every imported file was fsynced when written; now the directories, deepest first, so the
      // marker never survives a power loss that its history did not.
      for (const directory of [...dirty].sort((a, b) => b.length - a.length)) {
        checkGeneration()
        syncDirectory(directory)
      }
      publishExclusive(path, MARKER, JSON.stringify({ version: MARKER_VERSION, id, retry: pending() }) + '\n', checkGeneration, fault)
    },
  }
}
