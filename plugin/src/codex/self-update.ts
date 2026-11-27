// Self-update from Telegram (docs/design/self-update-spec.md, S9): /update, /update check, /update rollback.
//
// The bridge updates its own checkout in-process: fetch, fast-forward only, `bun install
// --frozen-lockfile --ignore-scripts`, a type check, then exit 75 so systemd starts the new version.
// Every step before the exit runs as a child of the bridge and finishes before the bridge exits, and
// the bridge never calls `systemctl restart` on its own unit, so nothing has to survive the unit's
// cgroup being stopped. That is why there is no `systemd-run --scope` escape here (Hermes needs
// one because its updater outlives the gateway it restarts).
//
// The trial boot of the new commit must reach the health mark. The record of the trial lives in
// the git directory (<git-dir>/krotov-update-pending, key=value lines) so the bash boot guard can
// read it without running any of the new TypeScript: a version that crashes at import time is still
// rolled back. The unit runs a copy of the guard kept outside the checkout (<state>/boot-guard.sh),
// refreshed only when an update reached its health mark, so the new commit cannot delete or break it.
// Each trial boot writes how it ended (outcome=…) into the record; the guard decides from that (S9.5).
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { updateEnvironment } from './environment.js'

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions {
  cwd: string
  timeoutMs?: number
  /** Set on top of updateChildEnv() (the staged check points TMPDIR and the caches into its copy). */
  env?: Readonly<Record<string, string>>
}
export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

/** The environment of every child /update runs: no bot token, no GBRAIN_BEARER, no other credential. */
export function updateChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] =>
    pair[1] !== undefined && updateEnvironment.test(pair[0])))
}

/**
 * Runs a command without a shell; a missing binary or a timeout is a non-zero code, never a throw.
 * The child gets only updateChildEnv(). bun still reads plugin/.env by itself, which is why every
 * install runs with --ignore-scripts (INSTALL_ARGS): no dependency script runs to see that file's token.
 */
export const runCommand: Runner = (command, args, { cwd, timeoutMs = 300_000, env }) => new Promise(resolve => {
  execFile(command, [...args], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...updateChildEnv(), ...env } },
    (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code !== 0 ? error.message : '') })
    })
})

/** bun install as /update, the boot guard, install.sh and update.sh run it: locked versions, no dependency scripts. */
export const INSTALL_ARGS: readonly string[] = ['install', '--frozen-lockfile', '--ignore-scripts']
/** The type check; --no-env-file keeps plugin/.env out of the tsc process. */
export const TSC_ARGS: readonly string[] = ['--no-env-file', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', '.']

export const PENDING_FILE = 'krotov-update-pending'
export const LAST_FILE = 'krotov-update-last'
/** R29: after the health mark the new commit is on probation; the guard rolls it back on its third crash. */
export const PROBATION_FILE = 'krotov-update-probation'
/** R29: commits the guard rolled back because their own boots failed, one per line; never installed automatically. */
export const BAD_FILE = 'krotov-update-bad'
/** How long after the health mark crashes of the new commit still count (crashes N=3 in 10 min). */
export const PROBATION_MS = 600_000
/** The copy of plugin/scripts/boot-guard.sh in the state directory that the unit's ExecStartPre runs. */
export const GUARD_FILE = 'boot-guard.sh'
/**
 * The boot-guard.sh behaviour this bridge relies on, the `# krotov-boot-guard-version:` line of
 * plugin/scripts/boot-guard.sh. 2 = R29: a rolled-back commit is recorded in krotov-update-bad, and probation.
 * An older copy would roll a broken commit back without marking it bad, so the next automatic run retries it.
 */
export const GUARD_VERSION = 2
const guardMarker = /^# krotov-boot-guard-version: (\d+)$/m

/** The version a boot-guard.sh text declares; 0 for a guard from before the marker. */
export function guardVersion(text: string): number {
  const match = guardMarker.exec(text)
  return match ? Number(match[1]) : 0
}

/** The version of a guard file; undefined when it cannot be read. */
function guardFileVersion(path: string): number | undefined {
  try {
    return guardVersion(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * For /doctor: why an installed guard copy older than GUARD_VERSION keeps updates out; undefined when it is
 * current or absent (a missing copy is the `no-guard` refusal of check(), shown as the last attempt). Read-only.
 */
export function guardCopyProblem(stateDir: string): string | undefined {
  const installed = guardFileVersion(join(stateDir, GUARD_FILE))
  if (installed === undefined || installed >= GUARD_VERSION) return undefined
  return `Проверка запуска boot-guard.sh в каталоге состояния устарела (версия ${installed}, нужна ${GUARD_VERSION}): ` +
    'перед установкой мост заменит её сам, а если не сможет, не поставит новую версию.'
}

/**
 * Before an update: <state>/boot-guard.sh must speak GUARD_VERSION. An older copy (an install or update.sh
 * of an earlier release left it) is replaced by the running checkout's guard first. Undefined when the
 * copy is current, otherwise the owner-facing reason the update is refused.
 */
export function ensureGuardCopy(repo: string, stateDir: string): string | undefined {
  const target = join(stateDir, GUARD_FILE)
  const installed = guardFileVersion(target) ?? 0
  if (installed >= GUARD_VERSION) return undefined
  const refused = (why: string) => `Не обновляюсь: проверка запуска (boot-guard.sh) в каталоге состояния устарела ` +
    `(версия ${installed}, нужна ${GUARD_VERSION}), а заменить её не удалось: ${why}. Со старой проверкой неудачная версия ` +
    'откатилась бы, но не была бы помечена плохой, и автообновление ставило бы её снова. ' +
    'На сервере выполни ./install.sh --start: он поставит новую проверку.'
  const available = guardFileVersion(join(repo, 'plugin', 'scripts', 'boot-guard.sh')) ?? 0
  if (available < GUARD_VERSION) return refused('в копии моста нет её новой версии')
  try {
    refreshGuardCopy(repo, stateDir)
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  const now = guardFileVersion(target) ?? 0
  return now >= GUARD_VERSION ? undefined : refused('после замены версия всё ещё старая')
}

/**
 * The update lock in the state directory (the git directory without one): check, apply and rollback hold
 * it, so an automatic preflight and an /update never interleave, also across processes. It holds one JSON
 * line {pid, startedAt, token}, written in full to a temporary file before it is linked into place, so no
 * contender ever sees a lock without its holder.
 */
export const LOCK_FILE = 'self-update.lock'
/** A lock older than this is stale whatever its pid says (a reused pid): an apply takes minutes, not hours. */
const lockStaleMs = 3 * 3_600_000
/** A lock younger than this is held whatever it says (empty, unreadable, dead pid): it is never taken over. */
const lockGraceMs = 60_000
const sha = /^[0-9a-f]{40}$/
const maxCommits = 20

export type UpdatePhase = 'applying' | 'trial' | 'rolled_back' | 'rollback_failed'
/** How a trial boot ended: stop = exit 0, crash = exit 1 (and 78 during a trial), watchdog = startup limit, planned = other exit 75. */
export type TrialOutcome = 'stop' | 'crash' | 'watchdog' | 'planned'
export interface PendingUpdate {
  phase: UpdatePhase; from: string; to: string; boots: number; at: number
  /** Trial boots that failed without a verdict (killed, exit 75); the second one rolls back. */
  fails?: number
  outcome?: TrialOutcome
  /** The apply that wrote this record; only that apply may delete it. The boot guard ignores the key. */
  token?: string
}

export type UpdateCheck =
  | { kind: 'plan'; from: string; to: string; commits: string[]; total: number }
  | { kind: 'current'; head: string }
  | { kind: 'refused'; reason: 'dirty' | 'branch' | 'fetch' | 'diverged' | 'no-guard' | 'old-guard' | 'pending' | 'busy'; text: string }

export type ApplyResult =
  | { ok: true; from: string; to: string }
  | { ok: false; stage: 'state' | 'guard' | 'merge' | 'install' | 'tsc'; detail: string; restored: boolean }

export type RollbackResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: 'nothing' | 'dirty' | 'moved' | 'failed'; text: string }

export interface SelfUpdateOptions {
  /** The bridge checkout (the repository root). */
  repo: string
  run: Runner
  /** The bun binary that runs install and tsc (process.execPath in the bridge). */
  bun: string
  /** KROT_UPDATE_BRANCH: fetch this branch of the upstream remote instead of the upstream branch. */
  branch?: string
  /** True when the service unit runs the guard copy <state>/boot-guard.sh before each start. */
  guardInstalled: () => Promise<boolean>
  /** The bridge state directory: <state>/boot-guard.sh is refreshed there after a healthy trial. */
  stateDir?: string
  now?: () => number
}

function tail(text: string, chars = 600): string {
  const clean = text.trim()
  return clean.length > chars ? '…' + clean.slice(-chars) : clean
}

export function parsePending(text: string): PendingUpdate | undefined {
  const fields = new Map(text.split('\n').map(line => line.split('=', 2) as [string, string]).filter(pair => pair.length === 2))
  const phase = fields.get('phase')
  const from = fields.get('from') ?? ''
  const to = fields.get('to') ?? ''
  const boots = Number(fields.get('boots'))
  const at = Number(fields.get('at'))
  const fails = Number(fields.get('fails') ?? 0)
  const outcome = fields.get('outcome')
  const token = fields.get('token')
  if (fields.get('v') !== '1' || !sha.test(from) || !sha.test(to) || !Number.isInteger(boots) || !Number.isFinite(at)) return
  if (!Number.isInteger(fails)) return
  if (phase !== 'applying' && phase !== 'trial' && phase !== 'rolled_back' && phase !== 'rollback_failed') return
  const record: PendingUpdate = { phase, from, to, boots, at }
  if (fails > 0) record.fails = fails
  if (outcome === 'stop' || outcome === 'crash' || outcome === 'watchdog' || outcome === 'planned') record.outcome = outcome
  if (token) record.token = token
  return record
}

/** The same key=value lines plugin/scripts/boot-guard.sh reads and writes. */
export function formatPending(pending: PendingUpdate): string {
  return `v=1\nphase=${pending.phase}\nfrom=${pending.from}\nto=${pending.to}\nboots=${pending.boots}\nat=${pending.at}\n` +
    `fails=${pending.fails ?? 0}\n` + (pending.outcome ? `outcome=${pending.outcome}\n` : '') +
    (pending.token ? `token=${pending.token}\n` : '')
}

function writeFileAtomic(path: string, text: string): void {
  writeFileSync(path + '.tmp', text, { mode: 0o600 })
  renameSync(path + '.tmp', path)
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

interface LockHolder { pid: number; startedAt: number; token: string }

/** The tokens of the update locks this process holds now. */
const heldLockTokens = new Set<string>()

function parseLockHolder(text: string): LockHolder | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const pid = 'pid' in value ? value.pid : undefined
  const startedAt = 'startedAt' in value ? value.startedAt : undefined
  const token = 'token' in value ? value.token : undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || typeof token !== 'string' || !token) return undefined
  return { pid, startedAt, token }
}

/**
 * The text of the lock when it is stale, undefined while it is held. A lock younger than lockGraceMs is
 * always held. After that it is stale when it has no readable holder, is older than lockStaleMs, or its
 * process is gone (a lock of this pid counts as gone unless this process holds its token).
 */
function staleLockText(path: string): string | undefined {
  try {
    const age = Date.now() - statSync(path).mtimeMs
    const text = readFileSync(path, 'utf8')
    if (age < lockGraceMs) return undefined
    const holder = parseLockHolder(text)
    if (!holder || age > lockStaleMs) return text
    if (holder.pid === process.pid) return heldLockTokens.has(holder.token) ? undefined : text
    try {
      process.kill(holder.pid, 0)
      return undefined
    } catch (error) {
      // EPERM: the process exists but belongs to another user.
      return errorCode(error) === 'EPERM' ? undefined : text
    }
  } catch {
    // Gone or unreadable right now: treated as held this round.
    return undefined
  }
}

/**
 * Moves a stale lock out of the way: renamed aside first, so of two contenders taking over the same stale
 * lock only the one that moved exactly that lock goes on. A lock that changed in between is put back.
 */
function removeStaleLock(path: string, stale: string, token: string): boolean {
  const aside = `${path}.${token}.stale`
  try {
    renameSync(path, aside)
  } catch {
    return false
  }
  try {
    if (readFileSync(aside, 'utf8') === stale) return true
    try {
      linkSync(aside, path)
    } catch { /* another contender took the path meanwhile */ }
    return false
  } finally {
    rmSync(aside, { force: true })
  }
}

/**
 * Takes the lock file atomically: the full holder line goes into a private temporary file that is then
 * hard-linked to the lock path (EEXIST = held). False when the lock is held. A stale lock is replaced once.
 */
function takeLockFile(path: string, token: string): boolean {
  const temp = `${path}.${token}.tmp`
  const holder: LockHolder = { pid: process.pid, startedAt: Date.now(), token }
  writeFileSync(temp, JSON.stringify(holder) + '\n', { flag: 'wx', mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temp, path)
        return true
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      const stale = staleLockText(path)
      if (stale === undefined || !removeStaleLock(path, stale, token)) return false
    }
    return false
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Removes the lock file only while it is still the one this token took. */
function releaseLockFile(path: string, token: string): void {
  try {
    if (parseLockHolder(readFileSync(path, 'utf8'))?.token === token) rmSync(path, { force: true })
  } catch { /* already gone */ }
}

function gitSync(repo: string, ...args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000, env: updateChildEnv() })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/**
 * At the end of the process: when this boot is the trial of an /update (phase=trial for HEAD), writes
 * how it ended into the record for the boot guard and returns that record. Synchronous and never throws,
 * so it also runs on a startup error before anything else was set up. A missing outcome (killed, power
 * loss) is counted by the guard as one failed trial boot. R29: a commit on probation after its health
 * mark gets the outcome in its probation record the same way.
 */
export function recordTrialOutcome(repo: string, outcome: TrialOutcome): PendingUpdate | undefined {
  try {
    const gitDir = gitSync(repo, 'rev-parse', '--path-format=absolute', '--git-dir')
    const head = gitSync(repo, 'rev-parse', 'HEAD')
    if (!gitDir || !head) return undefined
    recordProbationOutcome(join(gitDir, PROBATION_FILE), head, outcome)
    const path = join(gitDir, PENDING_FILE)
    const pending = parsePending(readFileSync(path, 'utf8'))
    if (pending?.phase !== 'trial' || pending.to !== head) return undefined
    writeFileAtomic(path, formatPending({ ...pending, outcome }))
    return pending
  } catch {
    return undefined
  }
}

/** The probation record (boot-guard.sh reads it): from, to, until in epoch seconds, crashes so far. */
export interface Probation { from: string; to: string; until: number; crashes: number }

export function formatProbation(probation: Probation): string {
  return `v=1\nfrom=${probation.from}\nto=${probation.to}\nuntil=${probation.until}\ncrashes=${probation.crashes}\n`
}

function parseProbation(text: string): Probation | undefined {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1))
  }
  const from = fields.get('from') ?? ''
  const to = fields.get('to') ?? ''
  const until = Number(fields.get('until'))
  const crashes = Number(fields.get('crashes'))
  if (fields.get('v') !== '1' || !sha.test(from) || !sha.test(to) || !Number.isInteger(until) || !Number.isInteger(crashes)) return
  return { from, to, until, crashes }
}

// Never throws: a missing or foreign probation record is left alone.
function recordProbationOutcome(path: string, head: string, outcome: TrialOutcome): void {
  try {
    const probation = parseProbation(readFileSync(path, 'utf8'))
    if (probation?.to !== head) return
    writeFileAtomic(path, formatProbation(probation) + `outcome=${outcome}\n`)
  } catch { /* no probation */ }
}

/** The trial outcome for an exit code; `watchdog` when the startup watchdog asked for the exit. */
export function trialOutcomeFor(code: number, watchdog: boolean): TrialOutcome {
  if (watchdog) return 'watchdog'
  if (code === 0) return 'stop'
  if (code === 75) return 'planned'
  return 'crash'
}

/**
 * Copies plugin/scripts/boot-guard.sh of the running (healthy) checkout to <state>/boot-guard.sh, the
 * file the unit runs. Called only once an update reached its health mark, and by install.sh.
 */
export function refreshGuardCopy(repo: string, stateDir: string): void {
  const target = join(stateDir, GUARD_FILE)
  copyFileSync(join(repo, 'plugin', 'scripts', 'boot-guard.sh'), target + '.tmp')
  renameSync(target + '.tmp', target)
}

export class SelfUpdate {
  private readonly plugin: string
  private readonly now: () => number
  private locked = false
  private gitDir: string | undefined

  constructor(private readonly options: SelfUpdateOptions) {
    this.plugin = join(options.repo, 'plugin')
    this.now = options.now ?? Date.now
  }

  private git(...args: string[]): Promise<RunResult> {
    return this.options.run('git', args, { cwd: this.options.repo, timeoutMs: 120_000 })
  }

  private async gitText(...args: string[]): Promise<string | undefined> {
    const result = await this.git(...args)
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  private async statePath(name: string): Promise<string> {
    if (!this.gitDir) {
      const dir = await this.gitText('rev-parse', '--path-format=absolute', '--git-dir')
      if (!dir) throw new Error('The bridge checkout is not a git repository')
      this.gitDir = dir
    }
    return join(this.gitDir, name)
  }

  /**
   * Takes the update lock: in this process first (synchronously, before any await), then the lock file.
   * Returns its release, or undefined while another check, apply or rollback holds it.
   */
  private async lock(): Promise<(() => void) | undefined> {
    if (this.locked) return undefined
    this.locked = true
    try {
      const path = this.options.stateDir ? join(this.options.stateDir, LOCK_FILE) : await this.statePath(LOCK_FILE)
      const token = randomUUID()
      heldLockTokens.add(token)
      if (!takeLockFile(path, token)) {
        heldLockTokens.delete(token)
        this.locked = false
        return undefined
      }
      return () => {
        releaseLockFile(path, token)
        heldLockTokens.delete(token)
        this.locked = false
      }
    } catch (error) {
      this.locked = false
      throw error
    }
  }

  private async readRecord(name: string): Promise<PendingUpdate | undefined> {
    try {
      return parsePending(readFileSync(await this.statePath(name), 'utf8'))
    } catch {
      return undefined
    }
  }

  private async writeRecord(name: string, record: PendingUpdate): Promise<void> {
    writeFileAtomic(await this.statePath(name), formatPending(record))
  }

  private async removeRecord(name: string): Promise<void> {
    rmSync(await this.statePath(name), { force: true })
  }

  /** Deletes the pending record only while it is still the one the apply with this token wrote. */
  private async removeOwnPending(token: string): Promise<void> {
    if ((await this.readRecord(PENDING_FILE))?.token === token) await this.removeRecord(PENDING_FILE)
  }

  /** The current pending record (for /doctor and /status). */
  pending(): Promise<PendingUpdate | undefined> {
    return this.readRecord(PENDING_FILE)
  }

  /** R29: commits boot-guard.sh rolled back after failed boots (for automatic update and /doctor). */
  async badCommits(): Promise<string[]> {
    try {
      return readFileSync(await this.statePath(BAD_FILE), 'utf8').split('\n').map(line => line.trim()).filter(line => sha.test(line))
    } catch {
      return []
    }
  }

  private async dirtyFiles(): Promise<string[] | undefined> {
    const status = await this.git('status', '--porcelain', '--untracked-files=all')
    if (status.code !== 0) return undefined
    return status.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
  }

  private dirtyText(files: readonly string[]): string {
    return 'Не обновляюсь: в копии моста есть несохранённые изменения, обновление их бы затронуло. ' +
      'Сохрани или убери их на сервере (git status), потом повтори /update.\n\nФайлы:\n' +
      files.slice(0, 10).map(file => '• ' + file).join('\n') + (files.length > 10 ? `\n… и ещё ${files.length - 10}` : '')
  }

  /** Fetches the configured branch and lists what /update would apply. Changes nothing in the tree. */
  async check(): Promise<UpdateCheck> {
    const release = await this.lock()
    if (!release) return { kind: 'refused', reason: 'busy', text: 'Обновление уже идёт.' }
    try {
      return await this.checkLocked()
    } finally {
      release()
    }
  }

  private async checkLocked(): Promise<UpdateCheck> {
    const files = await this.dirtyFiles()
    if (!files) return { kind: 'refused', reason: 'branch', text: 'Не удалось прочитать git status копии моста.' }
    if (files.length > 0) return { kind: 'refused', reason: 'dirty', text: this.dirtyText(files) }
    const pending = await this.readRecord(PENDING_FILE)
    if (pending?.phase === 'trial' || pending?.phase === 'applying') {
      // Only a live trial of HEAD blocks a new update. Anything else is left over: HEAD moved by hand,
      // a rollback the guard could not finish (HEAD back on `from`), or an apply that died. The check
      // never deletes it: it did not write it, and the boot guard may still need it to recover. The
      // next apply writes its own record over it.
      const head = await this.gitText('rev-parse', 'HEAD')
      if (pending.phase === 'trial' && head === pending.to) {
        return { kind: 'refused', reason: 'pending', text: 'Предыдущее обновление ещё проверяется. Подожди пару минут ' +
          'или верни прежнюю версию командой /update rollback.' }
      }
    }
    const branch = await this.gitText('symbolic-ref', '--quiet', '--short', 'HEAD')
    if (!branch) return { kind: 'refused', reason: 'branch', text: 'Копия моста не на ветке (detached HEAD). Переключи её на ветку на сервере.' }
    const remote = await this.gitText('config', '--get', `branch.${branch}.remote`) ?? (this.options.branch ? 'origin' : undefined)
    const merge = this.options.branch ? 'refs/heads/' + this.options.branch : await this.gitText('config', '--get', `branch.${branch}.merge`)
    if (!remote || remote === '.' || remote.startsWith('-') || !merge) {
      return { kind: 'refused', reason: 'branch', text: 'У ветки ' + branch + ' не настроен upstream, неоткуда брать обновления. Можно задать ветку в KROT_UPDATE_BRANCH.' }
    }
    const fetched = await this.git('fetch', '--quiet', '--', remote, merge)
    if (fetched.code !== 0) {
      return { kind: 'refused', reason: 'fetch', text: 'Не удалось получить обновления с ' + remote + ': ' + tail(fetched.stderr, 300) }
    }
    const from = await this.gitText('rev-parse', '--verify', 'HEAD^{commit}')
    const to = await this.gitText('rev-parse', '--verify', 'FETCH_HEAD^{commit}')
    if (!from || !to) return { kind: 'refused', reason: 'fetch', text: 'Не удалось определить версии до и после обновления.' }
    if (from === to) return { kind: 'current', head: from }
    if ((await this.git('merge-base', '--is-ancestor', from, to)).code !== 0) {
      return { kind: 'refused', reason: 'diverged', text: 'Копия моста разошлась с веткой обновлений (есть свои коммиты). Обновление только fast-forward, разреши расхождение вручную на сервере.' }
    }
    if (!await this.options.guardInstalled()) {
      return { kind: 'refused', reason: 'no-guard', text: 'Не обновляюсь: служба не запускает проверку запуска (boot-guard.sh) из каталога состояния, без неё неудачную версию нельзя откатить автоматически. ' +
        'На сервере выполни ./update.sh, затем ./install.sh --start (он обновит файл службы), и /update заработает из чата.' }
    }
    // R29: the installed copy must be the guard that marks a rolled-back commit bad; an older one is replaced first.
    const guard = this.options.stateDir ? ensureGuardCopy(this.options.repo, this.options.stateDir) : undefined
    if (guard) return { kind: 'refused', reason: 'old-guard', text: guard }
    const total = Number(await this.gitText('rev-list', '--count', `${from}..${to}`) ?? 0)
    const log = await this.gitText('log', '--no-decorate', '--format=%h %s', '-n', String(maxCommits), `${from}..${to}`) ?? ''
    return { kind: 'plan', from, to, total, commits: log.split('\n').filter(Boolean) }
  }

  private async restore(from: string): Promise<boolean> {
    const reset = await this.git('reset', '--keep', from)
    const install = reset.code === 0 ? await this.install() : reset
    return reset.code === 0 && install.code === 0
  }

  private install(): Promise<RunResult> {
    return this.options.run(this.options.bun, INSTALL_ARGS, { cwd: this.plugin, timeoutMs: 600_000 })
  }

  /**
   * Applies a plan from check(). On success the caller records the restart intent and exits 75;
   * the trial record makes the next boot prove the new version. On failure the copy is back on `from`.
   */
  async apply(plan: Extract<UpdateCheck, { kind: 'plan' }>): Promise<ApplyResult> {
    const release = await this.lock()
    if (!release) return { ok: false, stage: 'state', detail: 'Обновление уже идёт.', restored: true }
    try {
      const files = await this.dirtyFiles()
      if (!files || files.length > 0 || await this.gitText('rev-parse', 'HEAD') !== plan.from) {
        return { ok: false, stage: 'state', detail: 'Копия моста изменилась после проверки. Повтори /update.', restored: true }
      }
      // Checked again right before the apply: the staged check of an automatic update takes minutes.
      const guard = this.options.stateDir ? ensureGuardCopy(this.options.repo, this.options.stateDir) : undefined
      if (guard) return { ok: false, stage: 'guard', detail: guard, restored: true }
      const record: PendingUpdate = { phase: 'applying', from: plan.from, to: plan.to, boots: 0, at: this.now() }
      // The token marks the applying record as this apply's: a failure below deletes only its own record.
      const token = randomUUID()
      await this.writeRecord(PENDING_FILE, { ...record, token })
      // --no-overwrite-ignore: an ignored local file (plugin/.env) that the target starts tracking stops the merge.
      const merge = await this.git('merge', '--ff-only', '--no-overwrite-ignore', plan.to)
      if (merge.code !== 0) {
        await this.removeOwnPending(token)
        return { ok: false, stage: 'merge', detail: tail(merge.stderr), restored: await this.gitText('rev-parse', 'HEAD') === plan.from }
      }
      const install = await this.install()
      const tsc = install.code === 0
        ? await this.options.run(this.options.bun, TSC_ARGS, { cwd: this.plugin, timeoutMs: 600_000 })
        : undefined
      if (install.code !== 0 || (tsc && tsc.code !== 0)) {
        const restored = await this.restore(plan.from)
        if (restored) await this.removeOwnPending(token)
        else await this.writeRecord(PENDING_FILE, { ...record, phase: 'rollback_failed' })
        const failed = tsc ?? install
        return { ok: false, stage: tsc ? 'tsc' : 'install', detail: tail(failed.stdout + '\n' + failed.stderr), restored }
      }
      await this.writeRecord(PENDING_FILE, { ...record, phase: 'trial' })
      return { ok: true, from: plan.from, to: plan.to }
    } finally {
      release()
    }
  }

  /** What the previous update left for this boot to report; a finished rollback is reported once. */
  async bootReport(commit: string): Promise<{ kind: 'trial' | 'rolled_back' | 'rollback_failed'; from: string; to: string } | undefined> {
    const pending = await this.readRecord(PENDING_FILE)
    if (!pending) return
    if (pending.phase === 'trial') return pending.to === commit ? { kind: 'trial', from: pending.from, to: pending.to } : undefined
    if (pending.phase === 'rolled_back' || pending.phase === 'rollback_failed') {
      await this.removeRecord(PENDING_FILE)
      return { kind: pending.phase, from: pending.from, to: pending.to }
    }
    return undefined
  }

  /** Called at the health mark: a trial of this commit becomes the last good update. */
  async markHealthy(commit: string): Promise<{ from: string; to: string; guardError?: string } | undefined> {
    const pending = await this.readRecord(PENDING_FILE)
    if (pending?.phase !== 'trial' || pending.to !== commit) return
    const { fails: _fails, outcome: _outcome, ...last } = pending
    await this.writeRecord(LAST_FILE, { ...last, at: this.now() })
    // R29: three crashes of this commit within PROBATION_MS still roll it back (boot-guard.sh).
    writeFileAtomic(await this.statePath(PROBATION_FILE), formatProbation({
      from: pending.from, to: pending.to, until: Math.floor((this.now() + PROBATION_MS) / 1000), crashes: 0,
    }))
    await this.removeRecord(PENDING_FILE)
    // The new version proved itself: its guard becomes the one the unit runs.
    if (this.options.stateDir) {
      try {
        refreshGuardCopy(this.options.repo, this.options.stateDir)
      } catch (error) {
        return { from: pending.from, to: pending.to, guardError: error instanceof Error ? error.message : String(error) }
      }
    }
    return { from: pending.from, to: pending.to }
  }

  /** /update rollback: returns the copy to the commit before the last update. The caller exits 75. */
  async rollback(): Promise<RollbackResult> {
    const release = await this.lock()
    if (!release) return { ok: false, reason: 'failed', text: 'Обновление уже идёт.' }
    try {
      const head = await this.gitText('rev-parse', 'HEAD')
      // A live trial of HEAD (the boot after /update, before its health mark) is rolled back from its own record.
      const pending = await this.readRecord(PENDING_FILE)
      const trial = pending?.phase === 'trial' && pending.to === head ? pending : undefined
      const last = trial ?? await this.readRecord(LAST_FILE)
      if (!last) return { ok: false, reason: 'nothing', text: 'Нечего откатывать: после последнего /update не сохранилось записи о предыдущей версии.' }
      const files = await this.dirtyFiles()
      if (!files || files.length > 0) return { ok: false, reason: 'dirty', text: this.dirtyText(files ?? []) }
      if (trial) {
        if (!await this.restore(trial.from)) {
          await this.writeRecord(PENDING_FILE, { ...trial, phase: 'rollback_failed' })
          return { ok: false, reason: 'failed', text: 'Откат не завершился. Проверь на сервере git status и зависимости (bun install).' }
        }
        await this.removeRecord(PENDING_FILE)
        return { ok: true, from: trial.to, to: trial.from }
      }
      if (head !== last.to) {
        return { ok: false, reason: 'moved', text: 'Не откатываю: текущая версия ' + (head ?? '?').slice(0, 12) +
          ' не та, что поставил последний /update (' + last.to.slice(0, 12) + '). Откати вручную на сервере.' }
      }
      if (!await this.restore(last.from)) {
        return { ok: false, reason: 'failed', text: 'Откат не завершился. Проверь на сервере git status и зависимости (bun install).' }
      }
      await this.removeRecord(LAST_FILE)
      return { ok: true, from: last.to, to: last.from }
    } finally {
      release()
    }
  }
}
