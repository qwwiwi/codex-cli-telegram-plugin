// Everything main.ts does except owning the process runner: resolve paths and config, build the
// MCP client, parse stdin, dispatch, render. Separate so tests can drive it with a fake runner.
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_ENV, DEFAULT_CONFIG, loadConfig, URL_ENV_PREFIX, type HooksConfig } from './config.js'
import { dispatch } from './dispatch.js'
import { invokingHome } from './home.js'
import { createGbrain, mcpUrlFromToml, tokenFromEnvFile } from './mcp.js'
import { patchText } from './pre.js'
import { ALLOW_TOKEN, CONTEXT_PREFIX, CONTEXT_SUFFIX, DENY_EXIT, hookScope, type Scope } from './scope.js'
import { knownSecrets, scrub } from './secrets.js'
import { commandOf, SHELL_TOOLS } from './shell.js'
import { record, type Gbrain, type HookContext, type HookEvent, type McpClient, type Runner } from './types.js'

export const EVENTS: readonly HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact']

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return }
}

const expandHome = (path: string, home: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path

// One MCP client per configured server, made on first use. The URL comes from the switchboard or env
// (gbrain.urls), else from the [mcp_servers.<server>] entry of config.toml; every server gets the
// same key. Remote MCP is off (with the reason) without an agent id or without any server URL.
function gbrainFrom(env: Record<string, string | undefined>, home: string, codexHome: string,
  config: HooksConfig, configFile: string): { gbrain: Gbrain } | { off: string } {
  const gbrain = config.gbrain
  if (!config.agent) return { off: `no agent id (set "agent" in ${configFile} or ${AGENT_ENV})` }
  const toml = readText(join(codexHome, 'config.toml')) ?? ''
  const urlOf = (server: string) => Object.hasOwn(gbrain.urls, server) ? gbrain.urls[server] : mcpUrlFromToml(toml, server)
  const servers = [...new Set(Object.values(gbrain.tools).map(spec => spec.server))]
  if (!servers.some(urlOf)) {
    return { off: `no MCP server URL for ${servers.join(', ')} (set gbrain.urls in ${configFile}, ${URL_ENV_PREFIX}<SERVER> or [mcp_servers.<server>] url in ${join(codexHome, 'config.toml')})` }
  }
  const token = env.GBRAIN_BEARER ?? env.GBRAIN_API_KEY ?? tokenFromEnvFile(readText(expandHome(gbrain.envFile, home)) ?? '')
  const clients = new Map<string, McpClient>()
  const client = (server: string): McpClient => {
    const known = clients.get(server)
    if (known) return known
    const url = urlOf(server)
    if (!url) throw new Error(`MCP server ${server} has no URL`)
    const made = createGbrain(url, token, gbrain.timeoutMs)
    clients.set(server, made)
    return made
  }
  return {
    gbrain: {
      call: async (server, tool, args) => client(server).call(tool, args),
      ping: async server => client(server).ping(),
    },
  }
}

// A PreToolUse the guard can judge: an object naming its tool (nonblank tool_name) with a
// tool_input object (a string only for apply_patch's freeform patch); a shell tool must carry a
// readable command and apply_patch a nonblank patch text. Anything else is denied, never `{}`.
function readableToolCall(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const { tool_name: tool, tool_input: toolInput } = parsed as Record<string, unknown>
  if (typeof tool !== 'string' || !tool.trim()) return false
  const isObject = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
  if (tool === 'apply_patch') {
    const patch = patchText(toolInput)
    return (isObject || typeof toolInput === 'string') && patch !== undefined && patch.trim() !== ''
  }
  if (!isObject) return false
  return !SHELL_TOOLS.has(tool) || commandOf(tool, toolInput) !== undefined
}

// scope 'other' (a user that is provably not the bridge): nothing at all.
// scope 'safety' (bridge-uid missing or untrusted): only the PreToolUse safety guard, with
// the default switchboard, no MCP and no workspace; every other event answers nothing.
export async function runHook(eventName: string | undefined, stdin: string,
  env: Record<string, string | undefined>, home: string, run: Runner, scope: Scope = 'full'): Promise<string> {
  if (silentFor(eventName, scope)) return ''
  const stateDir = env.CODEX_HOOKS_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'krotov-plugin', 'codex-hooks')
  const logFile = join(stateDir, 'hooks.log')
  const log = (message: string) => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      try { if (statSync(logFile).size > 1_000_000) truncateSync(logFile, 0) } catch { /* new log */ }
      appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
    } catch { /* logging must never break a hook */ }
  }
  const event = EVENTS.find(name => name === eventName)
  if (!event) {
    log(`unknown event ${eventName ?? '(none)'}`)
    return '{}'
  }
  const unreadable = () => {
    log(`${event}: unreadable hook input`)
    return event === 'PreToolUse'
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Заблокировано: хук не смог прочитать вызов инструмента.' } })
      : '{}'
  }
  let parsed: unknown
  try { parsed = JSON.parse(stdin) } catch { return unreadable() }
  const input = record(parsed)
  if (event === 'PreToolUse' && !readableToolCall(parsed)) return unreadable()
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  if (scope === 'safety') {
    const ctx: HookContext = {
      event, input, config: DEFAULT_CONFIG, home, codexHome, stateDir, run, log, now: () => Date.now(),
      secrets: knownSecrets(env, []), tmpDirs: [tmpdir(), ...(env.TMPDIR ? [env.TMPDIR] : [])],
      gbrain: undefined, gbrainOff: 'safety scope', safetyOnly: true,
    }
    return JSON.stringify(await dispatch(ctx))
  }
  const configFile = env.CODEX_HOOKS_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'krotov-plugin', 'codex-hooks.json')
  const config = loadConfig(configFile, log, env)
  const brain = gbrainFrom(env, home, codexHome, config, configFile)
  const gbrainKey = env.GBRAIN_BEARER ?? env.GBRAIN_API_KEY ?? tokenFromEnvFile(readText(expandHome(config.gbrain.envFile, home)) ?? '')
  const ctx: HookContext = {
    event, input, config, home, codexHome, stateDir, run, log,
    now: () => Date.now(),
    secrets: knownSecrets(env, [gbrainKey]),
    tmpDirs: [tmpdir(), ...(env.TMPDIR ? [env.TMPDIR] : [])],
    ...(env.TELEGRAM_WORKSPACE_ROOT ? { workspace: env.TELEGRAM_WORKSPACE_ROOT } : {}),
    ...('gbrain' in brain ? { gbrain: brain.gbrain } : { gbrain: undefined, gbrainOff: brain.off }),
  }
  return JSON.stringify(await dispatch(ctx))
}

interface MainResult { stdout: string; code: number; stderr?: string }

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// JSON string text with every `"`, backslash and control character as \uXXXX (see scope.ts).
function contextText(context: string): string {
  let text = ''
  for (const char of context) {
    const code = char.codePointAt(0) ?? 0
    text += code < 0x20 || code === 0x22 || code === 0x5c || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }
  return text
}

// A PreToolUse result of runMain as the managed launcher takes it (the contract in scope.ts).
// Only what is known to be an allow leaves with exit 0, and always behind the ALLOW_TOKEN line:
// nothing (another user's no-op), `{}`, or context alone. A deny, a failed run and every answer
// of another shape leave with DENY_EXIT and a reason.
export function launcherVerdict(result: MainResult): MainResult {
  const deny = (reason: string): MainResult => ({ stdout: reason, code: DENY_EXIT })
  const allow = (line: string): MainResult => ({ stdout: line ? `${ALLOW_TOKEN}\n${line}` : ALLOW_TOKEN, code: 0 })
  if (result.code === 0 && (result.stdout === '' || result.stdout === '{}')) return allow(result.stdout)
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch { return deny('Заблокировано: ответ хука не разобран.') }
  const output = plainObject(parsed) && Object.keys(parsed).length === 1 ? parsed.hookSpecificOutput : undefined
  if (plainObject(output) && output.permissionDecision === 'deny') {
    return deny(typeof output.permissionDecisionReason === 'string' ? output.permissionDecisionReason : '')
  }
  if (result.code !== 0) return deny(`Заблокировано: хук завершился с кодом ${result.code}.`)
  if (plainObject(output) && Object.keys(output).length === 2 && output.hookEventName === 'PreToolUse'
    && typeof output.additionalContext === 'string') {
    return allow(`${CONTEXT_PREFIX}${contextText(output.additionalContext)}${CONTEXT_SUFFIX}`)
  }
  return deny('Заблокировано: ответ хука не в известной форме.')
}

export function hookFailure(eventName: string | undefined, problem: string, error: unknown,
  env: Record<string, string | undefined>): MainResult {
  const detail = scrub({ secrets: knownSecrets(env, []) }, error instanceof Error ? error.message : String(error))
  const stderr = `${problem}: ${detail}`
  if (eventName !== 'PreToolUse') return { stdout: '{}', code: 0, stderr }
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Заблокировано: ${stderr}` } })
  return { stdout, code: 2, stderr }
}

// A user a trusted bridge-uid proves is not the bridge ('other'): every event answers nothing at
// all. When bridge-uid cannot tell ('safety'): every event except PreToolUse answers nothing.
export const silentFor = (eventName: string | undefined, scope: Scope) =>
  scope === 'other' || (scope === 'safety' && eventName !== 'PreToolUse')

// How long a PreToolUse run may work before it gives up: below the launcher deadline (20 s) and
// the Codex handler timeout (30 s), so an overrun ends as the hook's own deny, not as a Codex
// timeout (Codex 0.172 lets the tool run when a PreToolUse hook times out).
export const HOOK_DEADLINE_MS = 18_000

// Rejects when `work` has not settled within `ms`; the timer never keeps the process alive.
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`хук не ответил за ${ms} мс`)), ms)
    timer.unref?.()
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

// The whole hook process behind one try/catch: a crash denies a PreToolUse call (stdout deny
// JSON, reason on stderr, exit 2) and lets every other event through (empty object, exit 0). A
// PreToolUse run also has a deadline, started before stdin is read and the scope is resolved
// (synchronous work cannot be interrupted by it; the launcher's timeout covers that). Other
// events have none: Codex's 30 s handler timeout bounds them and they fail open. Outside the
// bridge user's scope the other events print nothing and touch nothing, before HOME is resolved.
export async function runMain(eventName: string | undefined, stdin: string | (() => Promise<string>),
  env: Record<string, string | undefined>, run: Runner, hook: typeof runHook = runHook,
  scopeOf: (env: Record<string, string | undefined>) => Scope = hookScope, deadlineMs = HOOK_DEADLINE_MS): Promise<MainResult> {
  let scope: Scope = 'safety'
  const work = async () => {
    scope = scopeOf(env)
    if (silentFor(eventName, scope)) return undefined
    const input = typeof stdin === 'string' ? stdin : await stdin()
    return hook(eventName, input, env, invokingHome(env), run, scope)
  }
  try {
    // Started now, before work() reads stdin or resolves the scope.
    const answer = await (eventName === 'PreToolUse' ? withDeadline(Promise.resolve().then(work), deadlineMs) : work())
    if (answer === undefined || silentFor(eventName, scope)) return { stdout: '', code: 0 }
    return { stdout: answer, code: 0 }
  } catch (error) {
    if (silentFor(eventName, scope)) return { stdout: '', code: 0 }
    return hookFailure(eventName, 'сбой хука Codex', error, env)
  }
}
