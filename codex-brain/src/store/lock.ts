// Single-writer lock for one Brain scope, shared by every process that writes it (bridge, CLI,
// hooks). It is the file `<lockDir>/held`, created with O_EXCL and removed on release.
//
// Every caller, in this process or another, polls the same file, so `timeoutMs` bounds the whole
// wait and a nested `withLock` on the same scope fails with LockTimeoutError instead of
// deadlocking. Keep critical sections short: file work only, never a model call or network I/O.
//
// Abandoned locks are broken:
// - holder pid is dead (same pid namespace) → at once;
// - holder pid is alive → only after LOCK_MAX_HOLD_MS (guards against pid reuse);
// - holder from another pid namespace (e.g. a container sharing the directory) → only after
//   LOCK_MAX_HOLD_MS, since its pid means nothing here; every holder records its namespace,
//   the `/proc/self/ns/pid` link (`pid:[<inode>]`);
// - file is empty or unreadable (crash between create and write) → after LOCK_UNREADABLE_MS.
// Breakers serialise on `<lockDir>/held.break` and re-check the bytes before removing the lock,
// so two breakers cannot remove a lock that a third process just took.

import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { FILE_MODE } from './atomic.js'

export const LOCK_FILE = 'held'
const BREAK_FILE = 'held.break'
/**
 * Default wait for the lock. Hook steps have a 2-second budget (slice plan K5,
 * `HOOK_STEP_BUDGET_MS`), so the wait leaves room for the work done under the lock.
 */
export const LOCK_TIMEOUT_MS = 1000
/** A live holder older than this is treated as a reused pid and broken. */
export const LOCK_MAX_HOLD_MS = 10 * 60 * 1000
/** An empty or unreadable lock (or break marker) older than this is a crash leftover. */
export const LOCK_UNREADABLE_MS = 5000

export interface LockOptions {
  timeoutMs?: number
  pollMs?: number
}

export class LockTimeoutError extends Error {
  constructor(readonly lockDir: string, readonly waitedMs: number) {
    super(`brain store is locked: gave up after ${waitedMs} ms on ${lockDir}`)
    this.name = 'LockTimeoutError'
  }
}

interface Holder {
  pid: number
  /** Pid namespace of the holder; null when it recorded none (no /proc, or foreign content). */
  pidns: string | null
  acquired: string
}

function readPidNamespace(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    return null
  }
}

const OWN_PID_NAMESPACE = readPidNamespace()

interface LockState {
  raw: string
  mtimeMs: number
  holder: Holder | null
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

function readLock(path: string): LockState | null {
  let raw: string
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && 'pid' in value && 'acquired' in value
      && typeof value.pid === 'number' && typeof value.acquired === 'string') {
      const pidns = 'pidns' in value && typeof value.pidns === 'string' ? value.pidns : null
      return { raw, mtimeMs, holder: { pid: value.pid, pidns, acquired: value.acquired } }
    }
  } catch { /* Empty, half-written or foreign content: judged by age below. */ }
  return { raw, mtimeMs, holder: null }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStale(state: LockState, now: number): boolean {
  if (state.holder === null) return now - state.mtimeMs > LOCK_UNREADABLE_MS
  const age = now - Date.parse(state.holder.acquired)
  if (!Number.isFinite(age) || age > LOCK_MAX_HOLD_MS) return true
  // A pid from another namespace cannot be checked from here: judged by age only.
  if (state.holder.pidns !== OWN_PID_NAMESPACE) return false
  return !pidAlive(state.holder.pid)
}

// Creates `path` exclusively with `raw` as content; false when it exists already.
function createExclusive(path: string, raw: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, raw)
  } finally {
    closeSync(fd)
  }
  return true
}

// The nonce makes every acquisition's bytes unique, so release can tell its own lock apart.
function holderBytes(): string {
  return JSON.stringify({ pid: process.pid, pidns: OWN_PID_NAMESPACE, acquired: new Date().toISOString(), nonce: randomBytes(8).toString('hex') })
}

// Removes the lock judged stale, unless it changed meanwhile.
function breakStale(lockDir: string, judged: LockState): void {
  const marker = join(lockDir, BREAK_FILE)
  if (!createExclusive(marker, holderBytes())) {
    const other = readLock(marker)
    // A breaker that died mid-break leaves its marker; clear it and retry on the next poll.
    if (other !== null && Date.now() - other.mtimeMs > LOCK_UNREADABLE_MS) rmSync(marker, { force: true })
    return
  }
  try {
    const now = readLock(join(lockDir, LOCK_FILE))
    if (now !== null && now.raw === judged.raw && now.mtimeMs === judged.mtimeMs) rmSync(join(lockDir, LOCK_FILE), { force: true })
  } finally {
    rmSync(marker, { force: true })
  }
}

async function acquire(lockDir: string, options: LockOptions): Promise<string> {
  const path = join(lockDir, LOCK_FILE)
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const pollMs = options.pollMs ?? 5
  const started = Date.now()
  for (;;) {
    const mine = holderBytes()
    if (createExclusive(path, mine)) return mine
    const current = readLock(path)
    if (current !== null && isStale(current, Date.now())) {
      breakStale(lockDir, current)
      continue
    }
    const waited = Date.now() - started
    if (waited >= timeoutMs) throw new LockTimeoutError(lockDir, waited)
    await Bun.sleep(Math.min(pollMs, timeoutMs - waited))
  }
}

/** Runs `fn` while holding the scope lock in `lockDir` (which must exist). */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const mine = await acquire(lockDir, options)
  try {
    return await fn()
  } finally {
    // Remove only our own lock: after an overlong hold another process may have broken it.
    const path = join(lockDir, LOCK_FILE)
    if (readLock(path)?.raw === mine) rmSync(path, { force: true })
  }
}
