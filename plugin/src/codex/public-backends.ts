// KROT_MULTIUSER=1: starting and checking the public (member and guest) app-servers.
//
// Each role gets its own app-server on its own CODEX_HOME (public-home.ts). Startup probes
// every role and refuses to start on any problem. A role takes messages only once its permission
// hook is proven (provePublicHooks: one fixture tool call the hook must deny, cached per home hash);
// a failed proof quarantines it, a proof that passed but could not be cached only shows in /doctor. /doctor probes again and runs the NO_SHELL
// canary, and a role that fails either is quarantined: its messages get «временно недоступно»
// until a restart, never the owner's app-server.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkPublicProfile, proveHookDenial, runPublicCanary, type HookDenials, type HookProofRunner,
} from './multiuser-readiness.js'
import { PublicRouter, type PublicRunner } from './public-lane.js'
import { publishExclusive, type PublishFault } from './public-publish.js'
import { HOOK_PROOF_VERSION, hookProofName, readHookProof, type PreparedHome, type PublicRole } from './public-home.js'
import type { PublicProbe } from './session.js'

export interface PublicSessionLike extends PublicRunner, HookProofRunner {
  initialize(): Promise<void>
  probePublicProfile(cwd: string): Promise<PublicProbe>
}

export interface StartedPublicRole<S extends PublicSessionLike = PublicSessionLike> {
  role: PublicRole
  prepared: PreparedHome
  session: S
  /** False until the hook proof passed, and once the app-server exited, the bridge is stopping, or the role was quarantined. */
  alive(): boolean
  /** True once the permission hook of this home was proven (now or by the cached proof of the same home hash). */
  hookProven(): boolean
  /** Marks the hook proven and lets the role take messages (after a live pass). */
  enable(): void
  /** Stores the proof for this home hash; throws when it could not be saved. Never disables the role. */
  cacheProof(): void
  /** Where the proof of this home hash is stored. */
  proofFile: string
  quarantine(): void
}

// One proof entry per role and home hash (hookProofName): published once (public-publish.ts), never
// renamed over or rewritten. An entry for another hash, or an invalid one under the current name,
// is collected by public-gc.ts before the proving of the same start.
export { hookProofName }

// The cached hook proof of a public home: a valid proof file whose content names this exact hash.
function cachedProof(file: string, hash: string): boolean {
  return readHookProof(file) === hash
}

function saveProof(directory: string, name: string, hash: string, fault?: PublishFault): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const proof = JSON.stringify({ version: HOOK_PROOF_VERSION, configHash: hash, provenAt: new Date().toISOString() }) + '\n'
  try {
    publishExclusive(directory, name, proof, () => {}, fault)
  } catch (error) {
    // Never replaced: an existing entry counts only when it already is a valid proof for this hash.
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST' && cachedProof(join(directory, name), hash)) return
    throw error
  }
}

/** Starts and probes one app-server per role; throws (multi-user mode does not start) on the first problem. */
export async function startPublicBackends<S extends PublicSessionLike>(input: {
  roles: readonly PublicRole[]
  /** Builds this role in the generation opened by the caller before starting either backend. */
  prepare: (role: PublicRole) => PreparedHome
  /** `onExit` is called when this role's app-server stops. */
  createSession: (role: PublicRole, prepared: PreparedHome, onExit: () => void) => S
  probeCwd: string
  stopping: () => boolean
  /** Where the hook proofs are cached (outside the generations), one entry per role and home hash. */
  proofDirectory: string
  /** Test seam for the proof publish (public-publish.ts). */
  proofFault?: PublishFault
}): Promise<{ roles: StartedPublicRole<S>[]; router: PublicRouter }> {
  const roles: StartedPublicRole<S>[] = []
  for (const role of input.roles) {
    const prepared = input.prepare(role)
    let exited = false
    let quarantined = false
    const session = input.createSession(role, prepared, () => { exited = true })
    await session.initialize()
    const problem = await checkPublicProfile(session, input.probeCwd, prepared)
    if (problem) throw new Error('Multi-user mode cannot start (' + role + '): ' + problem)
    const proofName = hookProofName(role, prepared.configHash)
    const proofFile = join(input.proofDirectory, proofName)
    let proven = cachedProof(proofFile, prepared.configHash)
    roles.push({
      role, prepared, session,
      alive: () => proven && !exited && !quarantined && !input.stopping(),
      hookProven: () => proven,
      enable: () => { proven = true },
      cacheProof: () => saveProof(input.proofDirectory, proofName, prepared.configHash, input.proofFault),
      proofFile,
      quarantine: () => { quarantined = true },
    })
  }
  // Each role only ever reaches its own session; there is no fallback to another role or the owner.
  const router = new PublicRouter(Object.fromEntries(roles.map(started => [started.role,
    { runner: started.session, alive: started.alive }])))
  return { roles, router }
}

/** A hook proof that passed live but could not be cached: the role works, the proof runs again next start. */
export interface ProofCacheProblem { role: PublicRole; path: string }

export interface HookProofResult {
  /** Roles whose live proof failed; each is quarantined until a restart. */
  problems: string[]
  cacheProblems: ProofCacheProblem[]
}

/**
 * Startup, once the thread-role endpoint listens: every role without a proof for its home hash runs
 * the hook proof; a pass enables it at once and then caches the proof, a failure quarantines it
 * until a restart. A cache failure never disables the role.
 */
export async function provePublicHooks(roles: readonly StartedPublicRole[], input: {
  denials: HookDenials; probeCwd: string; timeoutMs: number
}): Promise<HookProofResult> {
  const result: HookProofResult = { problems: [], cacheProblems: [] }
  for (const started of roles) {
    if (started.hookProven()) continue
    const problem = await proveHookDenial(started.session, input.denials, input.probeCwd, input.timeoutMs)
    if (problem) {
      started.quarantine()
      result.problems.push(started.role + ': ' + problem)
      continue
    }
    started.enable()
    try {
      started.cacheProof()
    } catch {
      result.cacheProblems.push({ role: started.role, path: started.proofFile })
    }
  }
  return result
}

/** The /doctor line of a proof that passed but was not saved. */
export function proofCacheLine(problem: ProofCacheProblem): string {
  const label = problem.role === 'member' ? 'участник' : 'гость'
  return '⚠️ Проверка хука (' + label + ') прошла, но не сохранена; повторится при следующем запуске: ' + problem.path
}

export interface PublicDoctorReport {
  passes: string[]
  problems: Array<{ text: string; fix: string }>
}

const FIX = 'Выключите KROT_MULTIUSER, пока причина не найдена: гостевые потоки должны быть без команд и без чужих инструментов.'

/** /doctor: per role, probe again and run the canary; a role that fails is quarantined and gets no canary after a failed probe. */
export async function doctorPublicRoles(roles: readonly StartedPublicRole[], input: {
  probeCwd: string; canaryDir: string; canaryTimeoutMs: number
}): Promise<PublicDoctorReport> {
  const report: PublicDoctorReport = { passes: [], problems: [] }
  for (const started of roles) {
    const label = started.role === 'member' ? 'участник' : 'гость'
    if (!started.alive()) {
      report.problems.push({ text: '❌ Гостевой Codex (' + label + ') не работает: такие сообщения получают «временно недоступно».',
        fix: 'Перезапустите мост; если не помогло, проверьте журнал.' })
      continue
    }
    const problem = await checkPublicProfile(started.session, input.probeCwd, started.prepared)
    if (problem) {
      started.quarantine()
      report.problems.push({ text: '❌ Доступ (' + label + '): ' + problem + '. Роль отключена до перезапуска моста.', fix: FIX })
      continue
    }
    report.passes.push('✅ Доступ (' + label + '): ровно по списку, без лишних MCP и навыков.')
    mkdirSync(input.canaryDir, { recursive: true, mode: 0o700 })
    const canary = await runPublicCanary(started.session, input.canaryDir, input.canaryTimeoutMs)
    const line = canary.line.replace('Канарейка гостевого профиля', 'Канарейка (' + label + ')')
    if (canary.ok) {
      report.passes.push(line)
    } else {
      started.quarantine()
      report.problems.push({ text: line + ' Роль отключена до перезапуска моста.', fix: FIX })
    }
  }
  return report
}
