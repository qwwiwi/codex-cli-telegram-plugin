// KROT_MULTIUSER=1: starting and checking the public (member and guest) app-servers.
//
// Each role gets its own app-server on its own CODEX_HOME (public-home.ts). Startup probes
// every role and refuses to start on any problem. A role takes messages only once its permission
// hook is proven (provePublicHooks: one fixture tool call the hook must deny, cached per home hash);
// a failed proof quarantines it. /doctor probes again and runs the NO_SHELL
// canary, and a role that fails either is quarantined: its messages get «временно недоступно»
// until a restart, never the owner's app-server.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  checkPublicProfile, proveHookDenial, runPublicCanary, type HookDenials, type HookProofRunner,
} from './multiuser-readiness.js'
import { PublicRouter, type PublicRunner } from './public-lane.js'
import type { PreparedHome, PublicRole } from './public-home.js'
import { object } from './rpc.js'
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
  /** Marks the hook proven, stores the proof for this home hash and lets the role take messages. */
  proveHook(): void
  quarantine(): void
}

// The cached hook proof of a public home: valid only for the exact home hash it was made for.
function cachedProof(file: string, hash: string): boolean {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return object(saved).configHash === hash
  } catch {
    return false
  }
}

function saveProof(file: string, hash: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify({ configHash: hash, provenAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}

/** Starts and probes one app-server per role; throws (multi-user mode does not start) on the first problem. */
export async function startPublicBackends<S extends PublicSessionLike>(input: {
  roles: readonly PublicRole[]
  prepare: (role: PublicRole) => PreparedHome
  /** `onExit` is called when this role's app-server stops. */
  createSession: (role: PublicRole, prepared: PreparedHome, onExit: () => void) => S
  probeCwd: string
  stopping: () => boolean
  /** Where the hook proof of a role's home is cached (outside the home: a rebuild clears the home). */
  proofFile: (role: PublicRole) => string
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
    const proofFile = input.proofFile(role)
    let proven = cachedProof(proofFile, prepared.configHash)
    roles.push({
      role, prepared, session,
      alive: () => proven && !exited && !quarantined && !input.stopping(),
      hookProven: () => proven,
      proveHook: () => {
        saveProof(proofFile, prepared.configHash)
        proven = true
      },
      quarantine: () => { quarantined = true },
    })
  }
  // Each role only ever reaches its own session; there is no fallback to another role or the owner.
  const router = new PublicRouter(Object.fromEntries(roles.map(started => [started.role,
    { runner: started.session, alive: started.alive }])))
  return { roles, router }
}

/**
 * Startup, once the thread-role endpoint listens: every role without a proof for its home hash runs
 * the hook proof; a pass enables it, a failure quarantines it until a restart. Returns the problems.
 */
export async function provePublicHooks(roles: readonly StartedPublicRole[], input: {
  denials: HookDenials; probeCwd: string; timeoutMs: number
}): Promise<string[]> {
  const problems: string[] = []
  for (const started of roles) {
    if (started.hookProven()) continue
    const problem = await proveHookDenial(started.session, input.denials, input.probeCwd, input.timeoutMs)
    if (problem) {
      started.quarantine()
      problems.push(started.role + ': ' + problem)
      continue
    }
    try {
      started.proveHook()
    } catch {
      started.quarantine()
      problems.push(started.role + ': the hook proof passed but could not be saved')
    }
  }
  return problems
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
