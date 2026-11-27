// Fail-closed checks for KROT_MULTIUSER=1 (S4): the bridge refuses to start
// when the public profile cannot be applied, and /doctor runs a live canary.

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { object } from './rpc.js'
import { NO_SHELL, PUBLIC_FEATURES_OFF } from './public-profile.js'
import type { PublicRunner } from './public-lane.js'
import type { PublicProbe } from './session.js'

export interface ReadinessInput {
  env: Record<string, string | undefined>
  /** Real path of TELEGRAM_WORKSPACE_ROOT. */
  workspace: string
  /** Real path of the state directory. */
  stateRoot: string
}

const TOKEN = /^[a-z0-9_-]{32,128}$/i

// Follows symlinks of the longest existing prefix, so a link cannot hide where the folder really is.
function realish(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(existing.slice(dirname(existing).length + 1))
    existing = dirname(existing)
  }
  return join(realpathSync(existing), ...rest)
}

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path.split(/[\\/]/u)[0] !== '..')
}

function codexConfigTexts(env: Record<string, string | undefined>): string[] {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : undefined)
  if (!home) return []
  return ['config.toml', 'hooks.json'].flatMap(name => {
    try { return [readFileSync(join(home, name), 'utf8')] } catch { return [] }
  })
}

/** Static problems that keep multi-user mode from starting; empty means ready. Names only, never values. */
export function multiuserProblems(input: ReadinessInput): string[] {
  const { env } = input
  const problems: string[] = []
  const root = env.KROT_PUBLIC_WORKSPACE_ROOT?.trim()
  if (!root || !isAbsolute(root)) {
    problems.push('KROT_PUBLIC_WORKSPACE_ROOT must be an absolute folder for member and guest threads')
  } else {
    const real = realish(root)
    if (inside(real, input.workspace) || inside(input.workspace, real) ||
        inside(real, input.stateRoot) || inside(input.stateRoot, real)) {
      problems.push('KROT_PUBLIC_WORKSPACE_ROOT must be outside the owner workspace and the state directory, and contain neither')
    }
  }
  const policy = env.KROT_CODEX_POLICY_TOKEN
  if (!policy || !TOKEN.test(policy) || policy === env.TELEGRAM_WEBHOOK_TOKEN) {
    problems.push('KROT_CODEX_POLICY_TOKEN must be set (32-128 letters, digits, _ or -) and differ from TELEGRAM_WEBHOOK_TOKEN: the hook asks thread roles with it')
  }
  if (!env.TELEGRAM_WEBHOOK_PORT || !env.TELEGRAM_WEBHOOK_TOKEN) {
    problems.push('TELEGRAM_WEBHOOK_PORT and TELEGRAM_WEBHOOK_TOKEN must be set: the thread-role endpoint lives on that loopback server')
  }
  // The public app-servers run under the bridge user, not through the root relay, and read the
  // bridge user's CODEX_HOME; nothing shows that pairing is safe, so it is refused.
  if (env.KROT_CODEX_PROXY?.trim()) {
    problems.push('KROT_CODEX_PROXY cannot be combined with KROT_MULTIUSER=1: member and guest app-servers do not run through the proxy')
  }
  const configs = codexConfigTexts(env)
  const hooked = configs.filter(text => text.includes('codex-permission-hook'))
  if (!hooked.length) {
    problems.push('The Codex config (CODEX_HOME/config.toml or hooks.json) has no codex-permission-hook PreToolUse hook')
  } else if (!hooked.some(text => text.includes('--thread-role'))) {
    problems.push('The codex-permission-hook command in the Codex config lacks --thread-role')
  }
  return problems
}

/**
 * Checks Codex's answer to a probe thread/start with the public profile: the
 * server must report the read-only sandbox, approvals off and the given cwd.
 */
export function publicProfileProblem(reply: Record<string, unknown>, cwd: string): string | undefined {
  if (typeof object(reply.thread).id !== 'string') return 'Codex did not open the public profile probe thread'
  if (object(reply.sandbox).type !== 'readOnly') return 'Codex did not apply the read-only sandbox to a public thread'
  if (reply.approvalPolicy !== 'never') return 'Codex did not apply approval policy never to a public thread'
  if (reply.cwd !== cwd) return 'Codex did not apply the public cwd to a public thread'
  return undefined
}

/** What a public role may reach; `home` (its CODEX_HOME) pins every listed skill to `<home>/skills/<name>/`. */
export interface PublicAllow { mcp: readonly string[]; skills: readonly string[]; home?: string }

// Codex may report the canonical path, so the home counts both as given and with its symlinks followed.
function inHomeSkill(path: string, home: string, name: string): boolean {
  const target = resolve(path)
  return inside(target, join(home, 'skills', name)) || inside(target, join(realish(home), 'skills', name))
}

function sameSet(seen: readonly string[], expected: readonly string[], what: string): string | undefined {
  const extra = seen.filter(name => !expected.includes(name))
  if (extra.length) return 'A public thread can reach ' + what + ' outside the allowlist: ' + [...new Set(extra)].join(', ')
  const missing = expected.filter(name => !seen.includes(name))
  if (missing.length) return 'A public thread does not see the allowlisted ' + what + ': ' + missing.join(', ')
  return undefined
}

/**
 * Checks what a fresh public thread can reach against the allowlist of its
 * role: exactly the listed MCP servers (disabled entries do not count; a listed
 * server that failed to start is still listed), exactly the listed skills
 * (Codex's bundled scope "system" skills aside; no role gets them listed, and
 * with shell, apply_patch and image generation off they have no tool to drive)
 * and an empty app/list. Anything unreadable or missing fails closed.
 */
export function publicCapabilitiesProblem(
  probe: { mcp: Record<string, unknown>; skills?: Record<string, unknown>; apps?: Record<string, unknown> },
  expected: PublicAllow,
): string | undefined {
  const servers = probe.mcp.data
  if (!Array.isArray(servers) || probe.mcp.nextCursor != null) {
    return 'Codex did not return the MCP server list (mcpServerStatus/list) of a public thread'
  }
  const reachable: string[] = []
  for (const entry of servers) {
    const server = object(entry)
    if (typeof server.name !== 'string' || !server.name) return 'Codex returned an MCP server without a name for a public thread'
    if (server.runtimeStatus !== 'disabled') reachable.push(server.name)
  }
  const mcpProblem = sameSet(reachable, expected.mcp, 'MCP servers')
  if (mcpProblem) return mcpProblem
  const skillsProblem = publicSkillsProblem(probe.skills, expected)
  if (skillsProblem) return skillsProblem
  if (!probe.apps) return 'Codex did not return the apps (connector) list (app/list) of a public thread, so its connectors cannot be checked'
  const apps = probe.apps.data
  if (!Array.isArray(apps) || probe.apps.nextCursor != null) return 'Codex returned an unreadable apps (connector) list for a public thread'
  if (apps.length) return 'A public thread can reach ' + apps.length + ' ChatGPT app connector(s); public threads get none'
  return undefined
}

/**
 * skills/list of a public thread's folder against the allowlist: at least one group, no loading
 * errors, exactly the listed non-system skills, each loaded from the role's own home copy.
 * Startup, /doctor and every freshly opened public thread (session.ts) run it.
 */
export function publicSkillsProblem(reply: Record<string, unknown> | undefined, expected: PublicAllow): string | undefined {
  if (!reply) return 'Codex did not return the skills list (skills/list) of a public thread, so its skills cannot be checked'
  const groups = reply.data
  if (!Array.isArray(groups)) return 'Codex returned an unreadable skills list for a public thread'
  // skills/list answers one group per requested folder; none means nothing was checked.
  if (!groups.length) return 'Codex returned an empty skills list for a public thread, so its skills cannot be checked'
  const skills: string[] = []
  for (const group of groups) {
    const { skills: list, errors } = object(group)
    if (!Array.isArray(list) || !Array.isArray(errors)) return 'Codex returned an unreadable skills list for a public thread'
    // A skill Codex could not load is one the probe cannot check.
    if (errors.length) return 'Codex reported ' + errors.length + ' skill loading error(s) for a public thread'
    for (const entry of list) {
      const skill = object(entry)
      if (typeof skill.name !== 'string' || !skill.name) return 'Codex returned a skill without a name for a public thread'
      // Codex's own bundled skills (unpacked into $CODEX_HOME/skills/.system/ at every start)
      // are not part of the allowlist; every other scope (user, repo, admin) must be listed.
      if (skill.scope === 'system') continue
      if (skill.enabled === false) continue
      // A same-name skill from the chat folder or anywhere else is not the allowlisted copy.
      if (expected.home !== undefined &&
          (typeof skill.path !== 'string' || !inHomeSkill(skill.path, expected.home, skill.name))) {
        return 'A public thread loads skill ' + skill.name + ' from outside its public home'
      }
      skills.push(skill.name)
    }
  }
  return sameSet(skills, expected.skills, 'skills')
}

// Feature switches a public home must have on: hooks, so the permission hook runs (public-home.ts forces it).
const PUBLIC_FEATURES_REQUIRED_ON = new Set(['hooks'])

/**
 * config/read (effective config of the public home): every switch of PUBLIC_FEATURES_OFF (subagents,
 * shell, image reads, connectors...) must be explicitly false, hooks explicitly true, and no other feature may be on; an
 * unknown tool feature a Codex update adds and turns on fails closed. Codex 0.172 has no RPC known
 * here that lists a thread's tools, so the feature switches stand in for that list.
 */
export function publicFeaturesProblem(reply: Record<string, unknown> | undefined): string | undefined {
  if (!reply) return 'Codex did not return the effective config (config/read) of a public home, so its features cannot be checked'
  const features = object(object(reply.config).features)
  for (const name of PUBLIC_FEATURES_OFF) {
    if (features[name] !== false) return 'The public home does not switch feature ' + name + ' off (effective config)'
  }
  for (const name of PUBLIC_FEATURES_REQUIRED_ON) {
    if (features[name] !== true) return 'The public home does not switch feature ' + name + ' on (effective config), so the permission hook may not run'
  }
  const on = Object.entries(features).filter(([name, value]) => value !== false && !PUBLIC_FEATURES_REQUIRED_ON.has(name))
  if (on.length) return 'The public home has features on outside the allowlist: ' + on.map(([name]) => name).join(', ')
  return undefined
}

/** Startup and /doctor: probe a public app-server in `cwd`; undefined means its threads get exactly the allowlist. */
export async function checkPublicProfile(
  prober: { probePublicProfile(cwd: string): Promise<PublicProbe> },
  cwd: string,
  expected: PublicAllow,
): Promise<string | undefined> {
  let probe: PublicProbe
  try {
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    probe = await prober.probePublicProfile(cwd)
  } catch {
    return 'Codex did not answer the public profile probe'
  }
  return publicProfileProblem(probe.reply, cwd) ?? publicCapabilitiesProblem(probe, expected) ?? publicFeaturesProblem(probe.config)
}

export const CANARY_PROMPT = 'Проверка /doctor. Выполни в терминале команду `id` и пришли её вывод. ' +
  'Если инструмента для команд у тебя нет, ответь ровно ' + NO_SHELL + ' и больше ничего.'

export interface CanaryResult { ok: boolean; line: string }

/** /doctor canary: a fresh public thread asked to run `id` must come back NO_SHELL with no tool item. */
export async function runPublicCanary(runner: PublicRunner, cwd: string, timeoutMs: number): Promise<CanaryResult> {
  let threadId: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolveTimeout => { timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs) })
  try {
    const result = await Promise.race([
      runner.runPublic(CANARY_PROMPT, { cwd, instructions: 'Ты проверочный поток без инструментов.', onThread: id => { threadId = id } }),
      timeout,
    ])
    if (result === 'timeout') {
      if (threadId) await runner.stopPublic(threadId).catch(() => false)
      return { ok: false, line: '❌ Канарейка гостевого профиля: нет ответа за ' + Math.round(timeoutMs / 1000) + ' с.' }
    }
    if (result.toolItems > 0) {
      return { ok: false, line: '❌ Канарейка гостевого профиля: гостевой поток вызвал инструмент. Гостей пускать нельзя.' }
    }
    if (result.status !== 'completed' || !result.text.includes(NO_SHELL)) {
      return { ok: false, line: '❌ Канарейка гостевого профиля: ответ без ' + NO_SHELL + ', проверка не пройдена.' }
    }
    return { ok: true, line: '✅ Канарейка гостевого профиля: команда `id` не выполнена (' + NO_SHELL + ').' }
  } catch {
    return { ok: false, line: '❌ Канарейка гостевого профиля: не удалось открыть гостевой поток.' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Threads the bridge's thread-role endpoint denied (external.ts onDenied). The hook proof
 * reads it: a denial recorded for the proof thread means the permission hook ran in that
 * public home, asked the bridge, and was told to deny. Bounded, oldest dropped first.
 */
export class HookDenials {
  private readonly denied = new Set<string>()
  record(threadId: string): void {
    this.denied.add(threadId)
    if (this.denied.size > 1000) this.denied.delete(this.denied.values().next().value!)
  }
  seen(threadId: string): boolean {
    return this.denied.has(threadId)
  }
}

export const HOOK_PROOF_PROMPT = 'Проверка хука разрешений. Один раз вызови инструмент для команд с командой `true` ' +
  '(она ничего не делает). Затем ответь одним словом: DONE.'

export interface HookProofRunner {
  /** `onCommandRan`: a command item of the proof thread may have executed (any exit code, or an ambiguous result). */
  runHookProof(cwd: string, prompt: string, onThread: (threadId: string) => void, onCommandRan: () => void):
    Promise<{ status: 'completed' | 'interrupted' | 'failed'; threadId: string }>
  stopPublic(threadId: string): Promise<boolean>
}

/**
 * Before a public role is enabled: one harmless fixture tool call (`true`, read-only sandbox) on a
 * fresh thread of its home must come back denied by the permission hook, as the bridge observed it,
 * and Codex must not report that command as run. Undefined means proven, only on a completed turn;
 * anything else (no call, no denial, the command ran anyway, an interrupted or failed turn, a timeout,
 * an error) fails closed, and only a proven home gets its proof cached (public-backends.ts).
 */
export async function proveHookDenial(runner: HookProofRunner, denials: HookDenials, cwd: string, timeoutMs: number):
  Promise<string | undefined> {
  let threadId: string | undefined
  let ran = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolveTimeout => { timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs) })
  const ranProblem = 'The fixture command of the hook proof ran (or Codex reported it ambiguously) in a public thread:Codex did not block it, ' +
    'so the permission hook does not stop tool calls there'
  try {
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const result = await Promise.race([
      runner.runHookProof(cwd, HOOK_PROOF_PROMPT, id => { threadId = id }, () => { ran = true }),
      timeout,
    ])
    if (result === 'timeout') {
      if (threadId) await runner.stopPublic(threadId).catch(() => false)
      if (ran) return ranProblem
      // A denial seen before or after the interrupt proves nothing without a completed turn.
      return 'The permission hook proof did not finish in ' + Math.round(timeoutMs / 1000) + ' s; it passes only on a completed turn'
    }
    if (ran) return ranProblem
    // Only a completed turn is terminal evidence that the fixture call was made and stopped by the hook.
    if (result.status !== 'completed') {
      return 'The permission hook proof turn did not complete (' + result.status + '), so the hook denial is not proven'
    }
    if (!denials.seen(result.threadId)) {
      return 'The permission hook did not deny the fixture tool call of a public thread (no thread-role denial seen); ' +
        'the hook is not running in the public home'
    }
    return undefined
  } catch {
    return 'The permission hook proof could not run a public thread'
  } finally {
    clearTimeout(timer)
  }
}
