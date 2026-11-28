import { lstatSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { GENERATION_ID, type openPublicGenerations } from './public-generations.js'
import { HOOK_PROOF_NAME, isPublicOwner, PUBLIC_ROLES, samePublicObject, validHookProof } from './public-home.js'
import { PUBLISH_TEMP } from './public-publish.js'
import { object } from './rpc.js'

interface Identity { dev: string; ino: string }
/** An entry fixed by the parent under the token lock. The child never enumerates on its own. */
interface Candidate extends Identity { name: string }

export interface GcInput {
  root: string
  identities: Identity[]
  /** Retired generations (generations/<name>) to collect whole. */
  generations: Candidate[]
  /** Kept import sources whose unused login is removed. */
  retire: Candidate[]
  /** Stale or invalid hook proofs and interrupted publish temps (codex-public/<name>). */
  proofs: Candidate[]
  /** Paths that stopped this collection (damaged marker, missing retry id): no generation is removed. */
  stopped: string[]
  /** The bridge that planned this run; the child stops once it is gone or lost the token lock. */
  parentPid: number
  lockFile: string
}

export interface GcResult { problems: string[]; legacy: string[]; quarantined: string[]; stopped: string[] }

export interface GcOptions {
  /** Generation ids that are never collected (the running home, failed import sources). */
  keep: readonly string[]
  /** Kept generation ids whose login is removed (import sources before the build). */
  retire?: readonly string[]
  /** Current hook proof names; when given, regular own proofs for another hash are collected. */
  keepProofs?: readonly string[]
  /** The token lock file (bot.pid) that names this bridge. */
  lockFile: string
}

/** Test seams: `before` runs before a removal's checks, `afterCheck` between the last check and the syscall. */
export interface GcHooks { before?: (path: string) => void; afterCheck?: (path: string) => void }

interface Position { name: string; stat: BigIntStats; parent?: Position }
type Artifact = 'link' | 'socket'
interface Entry { name: string; stat: BigIntStats; children?: Entry[]; artifact?: Artifact }
interface Context { before: (path: string) => void; afterCheck: (path: string) => void; alive: () => void }

class LostPosition extends Error {}
class Aborted extends LostPosition {}

// Codex creates these in its home on every start. Exact paths relative to the generation; unlink
// removes the link or socket itself and never follows it. Anything else odd still quarantines.
const ARTIFACTS: ReadonlyArray<{ path: RegExp; kind: Artifact }> = [
  { path: /^(?:member|guest)\/tmp\/arg0-linux\/codex-arg0[A-Za-z0-9]{6}\/(?:codex-linux-sandbox|applypatch|apply_patch)$/u, kind: 'link' },
  { path: /^(?:member|guest)\/packages\/app-server-daemon\/current$/u, kind: 'link' },
  { path: /^(?:member|guest)\/app-server-daemon\/daemon-updater\.sock$/u, kind: 'socket' },
  { path: /^(?:member|guest)\/app-server-control\/app-server-control\.sock$/u, kind: 'socket' },
]

function at(name: string): BigIntStats | undefined {
  return lstatSync(name, { bigint: true, throwIfNoEntry: false })
}

function current(): BigIntStats {
  return statSync('.', { bigint: true })
}

// Links to this file in the current directory. A file whose links are all siblings here (the
// marker or proof next to its interrupted publish temp, public-publish.ts) has nothing outside.
function linksHere(stat: BigIntStats): bigint {
  let count = 0n
  for (const name of readdirSync('.')) {
    const sibling = at(name)
    if (sibling && samePublicObject(sibling, stat)) count++
  }
  return count
}

// Files: called with the containing directory as the current directory.
function safeEntry(stat: BigIntStats, device: bigint, artifact?: Artifact): boolean {
  if (!isPublicOwner(stat) || stat.dev !== device) return false
  if (artifact === 'link') return stat.isSymbolicLink() && stat.nlink === 1n
  if (artifact === 'socket') return stat.isSocket() && stat.nlink === 1n
  return stat.isDirectory() || stat.isFile() && (stat.nlink === 1n || stat.nlink <= linksHere(stat))
}

function artifactAt(relative: string): Artifact | undefined {
  return ARTIFACTS.find(artifact => artifact.path.test(relative))?.kind
}

function enter(parent: Position, name: string, expected: BigIntStats): Position {
  const found = at(name)
  if (!found?.isDirectory() || !samePublicObject(found, expected) || !safeEntry(found, expected.dev)) {
    throw new Error('Directory changed')
  }
  process.chdir(name)
  if (!samePublicObject(current(), expected)) throw new LostPosition('Directory changed during entry')
  return { name, stat: expected, parent }
}

function leave(position: Position): void {
  if (!position.parent || !samePublicObject(current(), position.stat)) throw new LostPosition('Lost directory position')
  process.chdir('..')
  if (!samePublicObject(current(), position.parent.stat)) throw new LostPosition('Parent directory changed')
}

function within<T>(parent: Position, name: string, stat: BigIntStats, visit: (position: Position) => T): T {
  const position = enter(parent, name, stat)
  try {
    return visit(position)
  } finally {
    leave(position)
  }
}

// Rewalk the saved names from the anchor at a mutation boundary. A moved directory
// can still be the current inode, so the current inode alone is insufficient.
function verifyPosition(position: Position): void {
  if (!position.parent) {
    if (!samePublicObject(current(), position.stat)) throw new LostPosition('Anchor directory changed')
    return
  }
  leave(position)
  verifyPosition(position.parent)
  try {
    enter(position.parent, position.name, position.stat)
  } catch {
    throw new LostPosition('Directory changed before removal')
  }
}

function requireEntry(name: string, device: bigint, expected?: BigIntStats, artifact?: Artifact): BigIntStats {
  const stat = at(name)
  if (!stat || !safeEntry(stat, device, artifact) || (expected && !samePublicObject(stat, expected))) {
    throw new Error('Unsafe or changed entry')
  }
  return stat
}

function inspect(position: Position, name: string, relative: string): Entry {
  const artifact = artifactAt(relative)
  const found = at(name)
  if (artifact && found && safeEntry(found, position.stat.dev, artifact)) return { name, stat: found, artifact }
  const stat = requireEntry(name, position.stat.dev)
  if (!stat.isDirectory()) return { name, stat }
  const children = within(position, name, stat, child =>
    readdirSync('.').map(entry => inspect(child, entry, relative === '' ? entry : relative + '/' + entry)))
  return { name, stat, children }
}

function removeEntry(parent: Position, path: string, entry: Entry, context: Context): void {
  const { name, stat, children, artifact } = entry
  if (children !== undefined) {
    within(parent, name, stat, position => {
      const names = readdirSync('.')
      if (names.length !== children.length) throw new Error('Directory contents changed')
      for (const child of children) requireEntry(child.name, position.stat.dev, child.stat, child.artifact)
      for (const child of children) removeEntry(position, join(path, child.name), child, context)
    })
  }
  context.before(path)
  context.alive()
  // The identity re-walk is the last step before the syscall. Residual (accepted, see
  // docs/design/v06/role-home-generations-final.md): a same-user swap after this check makes
  // unlink remove the swapped-in name itself (never a link target) and rmdir refuse a link
  // or a non-empty directory, so nothing outside the candidate is removed.
  verifyPosition(parent)
  requireEntry(name, parent.stat.dev, stat, artifact)
  context.afterCheck(path)
  if (children === undefined) unlinkSync(name)
  else rmdirSync(name)
}

function matchesIdentity(stat: BigIntStats, expected: Identity | undefined): boolean {
  return expected?.dev === String(stat.dev) && expected.ino === String(stat.ino)
}

function checkedDirectory(name: string, expected: Identity | undefined): BigIntStats {
  const stat = at(name)
  if (!stat?.isDirectory() || !safeEntry(stat, stat.dev) || !matchesIdentity(stat, expected)) {
    throw new Error('Directory changed')
  }
  return stat
}

// Removes only the regular own login of each role in a kept or quarantined generation.
function retireLogins(position: Position, candidate: Candidate, path: string, context: Context): void {
  const stat = at(candidate.name)
  if (!stat?.isDirectory() || !safeEntry(stat, position.stat.dev) || !matchesIdentity(stat, candidate)) {
    throw new Error('Generation changed')
  }
  within(position, candidate.name, stat, generation => {
    for (const role of PUBLIC_ROLES) {
      const home = at(role)
      if (!home?.isDirectory() || !safeEntry(home, generation.stat.dev)) continue
      within(generation, role, home, roleHome => {
        const auth = at('auth.json')
        if (!auth?.isFile() || !safeEntry(auth, roleHome.stat.dev)) return
        removeEntry(roleHome, join(path, role, 'auth.json'), { name: 'auth.json', stat: auth }, context)
      })
    }
  })
}

function displayPath(path: string): string {
  return path.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
}

function parentAlive(parentPid: number, lockFile: string): () => void {
  return () => {
    if (process.ppid !== parentPid) throw new Aborted('The bridge that planned this collection is gone')
    let owner: string
    try {
      owner = readFileSync(lockFile, 'utf8').trim()
    } catch {
      throw new Aborted('The token lock cannot be read')
    }
    if (owner !== String(parentPid)) throw new Aborted('The token lock changed owner')
  }
}

/** Runs in a dedicated Bun process anchored at the state directory. */
export function collectPublicHomes(input: GcInput, hooks: GcHooks = {}): GcResult {
  const { root, identities } = input
  const context: Context = {
    before: hooks.before ?? (() => {}), afterCheck: hooks.afterCheck ?? (() => {}),
    alive: parentAlive(input.parentPid, input.lockFile),
  }
  const result: GcResult = { problems: [], legacy: [], quarantined: [], stopped: input.stopped }
  const attempt = (path: string, visit: () => void): void => {
    try {
      visit()
    } catch (error) {
      result.problems.push(displayPath(path))
      if (error instanceof LostPosition) throw error
    }
  }
  try {
    context.alive()
    const state: Position = { name: '.', stat: current() }
    const rootStat = checkedDirectory('codex-public', identities[0])
    within(state, 'codex-public', rootStat, homes => {
      const generations = checkedDirectory('generations', identities[1])
      if (generations.dev !== rootStat.dev) throw new Error('Generations device changed')
      within(homes, 'generations', generations, position => {
        // Keep the importable history across interrupted builds; its old login is unused from now on.
        for (const candidate of input.retire) {
          const path = join(root, 'generations', candidate.name)
          attempt(path, () => retireLogins(position, candidate, path, context))
        }
        for (const candidate of input.generations) {
          const path = join(root, 'generations', candidate.name)
          attempt(path, () => {
            context.alive()
            const stat = at(candidate.name)
            if (!stat) return
            if (!matchesIdentity(stat, candidate)) throw new Error('Generation replaced since the plan')
            let plan: Entry
            try {
              plan = inspect(position, candidate.name, '')
              if (!plan.children || !samePublicObject(plan.stat, stat)) throw new Error('Expected the planned generation directory')
            } catch (error) {
              if (error instanceof LostPosition) throw error
              // Quarantine: the generation stays untouched except for its unused login.
              result.quarantined.push(displayPath(path))
              if (stat.isDirectory()) {
                try {
                  retireLogins(position, candidate, path, context)
                } catch (inner) {
                  if (inner instanceof LostPosition) throw inner
                }
              }
              throw error
            }
            removeEntry(position, path, plan, context)
          })
        }
      })
      for (const proof of input.proofs) {
        const path = join(root, proof.name)
        attempt(path, () => {
          context.alive()
          const stat = at(proof.name)
          if (!stat) return
          if (!stat.isFile() || !safeEntry(stat, rootStat.dev) || !matchesIdentity(stat, proof)) throw new Error('Proof changed')
          removeEntry(homes, path, { name: proof.name, stat }, context)
        })
      }
      for (const role of PUBLIC_ROLES) {
        const legacy = join(root, role)
        if (!at(role)) continue
        result.legacy.push(displayPath(legacy))
        attempt(legacy, () => {
          const stat = requireEntry(role, rootStat.dev)
          within(homes, role, stat, position => {
            if (!at('auth.json')) return
            const auth = requireEntry('auth.json', rootStat.dev)
            if (!auth.isFile()) throw new Error('Expected a regular login file')
            removeEntry(position, join(legacy, 'auth.json'), { name: 'auth.json', stat: auth }, context)
          })
        })
      }
    })
  } catch {
    result.problems.push(displayPath(root))
  }
  return result
}

function identityOf(stat: BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

const PROOF_ENTRY = new RegExp(HOOK_PROOF_NAME.source + '|' + PUBLISH_TEMP.source, 'u')

/** Under the token lock: the fixed list of what the child may remove, with each entry's identity. */
export function planPublicGc(store: ReturnType<typeof openPublicGenerations>, options: GcOptions): GcInput {
  store.check()
  const keep = new Set(options.keep)
  const retire = new Set(options.retire ?? [])
  const stopped = store.stopped.length > 0
  const generations: Candidate[] = []
  const retired: Candidate[] = []
  for (const name of readdirSync(store.directory)) {
    if (!GENERATION_ID.test(name) || keep.has(name)) continue
    const stat = lstatSync(join(store.directory, name), { bigint: true, throwIfNoEntry: false })
    if (!stat) continue
    // Stopped: every generation stays; only the login of each one except the running home goes.
    if (!stopped) generations.push({ name, ...identityOf(stat) })
    else if (stat.isDirectory()) retired.push({ name, ...identityOf(stat) })
  }
  for (const source of store.sources) {
    if (source.id !== undefined && keep.has(source.id) && retire.has(source.id)) {
      retired.push({ name: source.id, ...identityOf(source.identity) })
    }
  }
  const proofs: Candidate[] = []
  if (options.keepProofs) {
    const current = new Set(options.keepProofs)
    const temps: Candidate[] = []
    for (const name of readdirSync(store.root)) {
      const temp = PUBLISH_TEMP.test(name)
      if (!temp && !HOOK_PROOF_NAME.test(name)) continue
      // A current proof stays unless it is invalid (partial, corrupt, extra link): the proving after
      // this collection saves a good one under the same name.
      if (current.has(name) && validHookProof(store.root, name)) continue
      const stat = lstatSync(join(store.root, name), { bigint: true, throwIfNoEntry: false })
      // Only regular own files with at most the publish twin as a second link; the child re-checks
      // that every link is a sibling. Anything else is left alone.
      if (stat?.isFile() && isPublicOwner(stat) && stat.nlink <= 2n) (temp ? temps : proofs).push({ name, ...identityOf(stat) })
    }
    // Temps first: a proof left with nlink 2 by a crash is down to one link once its twin is gone.
    proofs.unshift(...temps)
  }
  store.check()
  return {
    root: store.root, identities: store.identities, generations, retire: retired, proofs, stopped: [...store.stopped],
    // Absolute: the child reads it after changing directories.
    parentPid: process.pid, lockFile: resolve(options.lockFile),
  }
}

export function runPublicGc(store: ReturnType<typeof openPublicGenerations>, options: GcOptions): GcResult {
  const fallback = { problems: [displayPath(store.root)], legacy: [], quarantined: [], stopped: [...store.stopped] }
  try {
    const request = planPublicGc(store, options)
    const run = Bun.spawnSync([process.execPath, '--no-env-file', import.meta.path, JSON.stringify(request)], {
      cwd: dirname(store.root), env: {}, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 15_000,
    })
    if (run.exitCode !== 0) return fallback
    const result = object(JSON.parse(run.stdout.toString()))
    const paths = (value: unknown): value is string[] => Array.isArray(value) && value.every(path => typeof path === 'string')
    if (!paths(result.problems) || !paths(result.legacy) || !paths(result.quarantined) || !paths(result.stopped)) return fallback
    return { problems: result.problems, legacy: result.legacy, quarantined: result.quarantined, stopped: result.stopped }
  } catch {
    return fallback
  }
}

function parseIdentity(value: unknown): Identity {
  const { dev, ino } = object(value)
  if (typeof dev !== 'string' || typeof ino !== 'string') throw new Error('Invalid directory identity')
  return { dev, ino }
}

function parseCandidates(value: unknown, name: RegExp): Candidate[] {
  if (!Array.isArray(value)) throw new Error('Invalid GC candidates')
  return value.map(entry => {
    const candidate = object(entry)
    if (typeof candidate.name !== 'string' || !name.test(candidate.name)) throw new Error('Invalid GC candidate')
    return { name: candidate.name, ...parseIdentity(candidate) }
  })
}

if (import.meta.main) {
  const input = object(JSON.parse(process.argv[2] ?? ''))
  const stopped = input.stopped
  if (typeof input.root !== 'string' || !Array.isArray(input.identities) || typeof input.parentPid !== 'number' ||
      typeof input.lockFile !== 'string' || !Array.isArray(stopped) || !stopped.every(path => typeof path === 'string')) {
    throw new Error('Invalid GC request')
  }
  const result = collectPublicHomes({
    root: input.root, identities: input.identities.map(parseIdentity),
    generations: parseCandidates(input.generations, GENERATION_ID),
    retire: parseCandidates(input.retire, GENERATION_ID),
    proofs: parseCandidates(input.proofs, PROOF_ENTRY),
    stopped: stopped.filter((path): path is string => typeof path === 'string'),
    parentPid: input.parentPid, lockFile: input.lockFile,
  })
  console.log(JSON.stringify(result))
}
