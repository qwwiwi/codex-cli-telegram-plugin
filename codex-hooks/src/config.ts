// The pack's switchboard: one JSON file (default ~/.config/krotov-plugin/codex-hooks.json, override
// with CODEX_HOOKS_CONFIG) turns each hook on or off, names the agent, the remote MCP tools and the MCP
// server each one lives on, and may map those servers to URLs. A missing or broken file means the
// defaults: every hook on and no remote MCP (the pack ships no endpoint and no agent id).
import { readFileSync } from 'node:fs'
import { record, type Json } from './types.js'

export const HOOK_IDS = [
  'gbrain-inbox', // 1  SessionStart: inbox + own tasks + heartbeat online
  'recall', // 2  UserPromptSubmit: remote recall on the owner message
  'correction', // 3  UserPromptSubmit: correction phrase -> Brain or the legacy learning/ lesson
  'safety', // 4  PreToolUse: destructive commands and secret files (fails closed)
  'git-gate', // 5  PreToolUse: canonical push form only, never main (fails closed)
  'secret-warning', // 6  PostToolUse: token-shaped secret in tool output
  'activity-log', // 7  PostToolUse: one JSON line per tool call, rotated
  'hanging-prs', // 8  Stop: own open PRs older than prAgeHours
  'done-evidence', // 9  Stop: "готово" without a test or check this turn
  'turn-summary', // 10 Stop: turn summary + heartbeat to a task server
  'active-briefs', // 11 SessionStart + first prompt: brief/CHECKLIST.md progress
  'subagent-nudge', // 12 UserPromptSubmit: multi-part ask -> subagents
  'session-sanity', // 13 SessionStart: model, approval, multi_agent, MCP, AGENTS.md
  'main-branch-edit', // 14a PreToolUse: editing while on main
  'dirty-repo', // 14b Stop: uncommitted or unpushed work in a touched repo
] as const

export type HookId = typeof HOOK_IDS[number]

// Guards the switchboard cannot turn off: the file is writable by the agent the guards protect.
export const SAFETY_HOOKS: readonly HookId[] = ['safety', 'git-gate']

// Remote MCP hooks skip when endpoints are not configured (no agent id or no URL).
export const GBRAIN_HOOKS: readonly HookId[] = ['gbrain-inbox', 'recall', 'turn-summary']

// Env names that may stand in for the switchboard; env wins over the file.
export const AGENT_ENV = 'CODEX_HOOKS_AGENT_ID'
export const URL_ENV_PREFIX ='CODEX_HOOKS_GBRAIN_URL_'

// CODEX_HOOKS_GBRAIN_URL_<SERVER>: the server name upper-cased, any character other than A-Z0-9 as _.
export function urlEnvName(server: string): string {
  return URL_ENV_PREFIX + server.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

// One remote MCP tool call: the MCP server it lives on (a key of gbrain.urls, or an [mcp_servers.<server>]
// entry of $CODEX_HOME/config.toml), the tool name and its fixed arguments.
export interface ToolSpec { server: string; name: string; arguments: Json }

export interface HooksConfig {
  enabled: Record<HookId, boolean>
  // The MCP agent id (task assignee, heartbeat sender). Optional.
  agent: string | undefined
  gbrain: {
    // Explicit MCP endpoint. A server missing here is looked up in config.toml.
    urls: Record<string, string>
    // KEY=value file with GBRAIN_BEARER (or GBRAIN_API_KEY / GBRAIN_TOKEN); a leading ~ is the home dir.
    envFile: string
    timeoutMs: number
    tools: { inbox: ToolSpec; tasks: ToolSpec; heartbeat: ToolSpec; recall: ToolSpec; turnSummary: ToolSpec }
  }
  briefRoots: string[]
  prAgeHours: number
  activityMaxBytes: number
}

// Default MCP servers, tool names and arguments. agent_heartbeat takes
// status "online" or "busy" and an optional note; the turn-summary hook puts the summary into the
// note. The configured agent id goes into the task assignee and the heartbeat agent.
function defaultTools(agent: string | undefined): HooksConfig['gbrain']['tools'] {
  const heartbeat = () => ({ ...(agent ? { agent } : {}), status: 'online' })
  return {
    inbox: { server: 'swarm', name: 'list_my_pending', arguments: {} },
    tasks: { server: 'tasks', name: 'task_list', arguments: agent ? { assignee: agent } : {} },
    heartbeat: { server: 'tasks', name: 'agent_heartbeat', arguments: heartbeat() },
    recall: { server: 'recall', name: 'recall', arguments: { limit: 5 } },
    turnSummary: { server: 'tasks', name: 'agent_heartbeat', arguments: heartbeat() },
  }
}

export const DEFAULT_CONFIG: HooksConfig = {
  enabled: Object.fromEntries(HOOK_IDS.map(id => [id, true])) as Record<HookId, boolean>,
  agent: undefined,
  gbrain: {
    urls: {},
    envFile: '~/.secrets/gbrain.env',
    timeoutMs: 3000,
    tools: defaultTools(undefined),
  },
  briefRoots: ['~/workspace', '~/projects'],
  prAgeHours: 2,
  activityMaxBytes: 5_000_000,
}

function toolSpec(value: unknown, fallback: ToolSpec): ToolSpec {
  const spec = record(value)
  return {
    server: typeof spec.server === 'string' && spec.server ? spec.server : fallback.server,
    name: typeof spec.name === 'string' && spec.name ? spec.name : fallback.name,
    arguments: spec.arguments === undefined ? fallback.arguments : record(spec.arguments),
  }
}

const isUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value)
const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

export function loadConfig(path: string, log: (message: string) => void = () => undefined,
  env: Record<string, string | undefined> = {}): HooksConfig {
  let file: Json = {}
  try {
    file = record(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`config ${path} unreadable, using defaults`)
  }
  const enabled = { ...DEFAULT_CONFIG.enabled }
  for (const [id, on] of Object.entries(record(file.enabled))) {
    if ((HOOK_IDS as readonly string[]).includes(id) && typeof on === 'boolean') enabled[id as HookId] = on
  }
  for (const id of SAFETY_HOOKS) {
    if (!enabled[id]) log(`config ${path} tries to switch ${id} off: ignored, safety guards always run`)
    enabled[id] = true
  }
  const agent = nonEmpty(env[AGENT_ENV]) ?? nonEmpty(file.agent)
  const gbrain = record(file.gbrain)
  const tools = record(gbrain.tools)
  const base = defaultTools(agent)
  const number = (value: unknown, fallback: number) => typeof value === 'number' && value > 0 ? value : fallback
  const specs = {
    inbox: toolSpec(tools.inbox, base.inbox),
    tasks: toolSpec(tools.tasks, base.tasks),
    heartbeat: toolSpec(tools.heartbeat, base.heartbeat),
    recall: toolSpec(tools.recall, base.recall),
    turnSummary: toolSpec(tools.turnSummary, base.turnSummary),
  }
  const urls: Record<string, string> = {}
  for (const [server, url] of Object.entries(record(gbrain.urls))) {
    if (isUrl(url)) urls[server] = url
  }
  // An env URL can only be found for a server the tools use: the env name does not map back to a name.
  for (const server of new Set(Object.values(specs).map(spec => spec.server))) {
    const url = env[urlEnvName(server)]
    if (isUrl(url)) urls[server] = url
  }
  return {
    enabled,
    agent,
    gbrain: {
      urls,
      envFile: nonEmpty(gbrain.envFile) ?? DEFAULT_CONFIG.gbrain.envFile,
      timeoutMs: number(gbrain.timeoutMs, DEFAULT_CONFIG.gbrain.timeoutMs),
      tools: specs,
    },
    briefRoots: Array.isArray(file.briefRoots) && file.briefRoots.every(root => typeof root === 'string')
      ? file.briefRoots as string[] : DEFAULT_CONFIG.briefRoots,
    prAgeHours: number(file.prAgeHours, DEFAULT_CONFIG.prAgeHours),
    activityMaxBytes: number(file.activityMaxBytes, DEFAULT_CONFIG.activityMaxBytes),
  }
}
