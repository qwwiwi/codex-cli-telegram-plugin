import type { HooksConfig } from './config.js'
import type { Limits } from './snapshot.js'

export type Json = Record<string, unknown>

// The Codex hook events this pack handles (names as in the hook input `hook_event_name`).
export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'PreCompact'

export interface RunResult { code: number | null; stdout: string }

// Runs a program without a shell. Never throws for a non-zero exit; may throw when it cannot start.
export type Runner = (argv: readonly string[], options: { cwd?: string; timeoutMs: number }) => RunResult

// One MCP server: a tool call resolves to the text content of the result.
export interface McpClient {
  call: (tool: string, args: Json) => Promise<string>
  // Resolves when the server answers the MCP handshake.
  ping: () => Promise<void>
}

// Each MCP tool call names its server.
// A server without a URL rejects, like an unreachable one.
export interface Gbrain {
  call: (server: string, tool: string, args: Json) => Promise<string>
  ping: (server: string) => Promise<void>
}

export interface HookContext {
  event: HookEvent
  input: Json
  config: HooksConfig
  home: string
  codexHome: string
  stateDir: string
  now: () => number
  run: Runner
  // undefined when remote MCP is not configured; gbrainOff then says what is missing.
  gbrain: Gbrain | undefined
  gbrainOff?: string
  log: (message: string) => void
  // Exact values of configured secrets (MCP key, tokens from the environment): masked before
  // anything is stored or sent.
  secrets?: string[]
  // The agent's own workspace root (learning/ lives there), when known.
  workspace?: string
  // System temp directories that count as scratch for the deletion rule (default os.tmpdir()).
  tmpDirs?: string[]
  // Another user of the host-wide managed pack: only the PreToolUse safety guard runs.
  safetyOnly?: boolean
  // Snapshot caps (file count, bytes copied); default snapshot.ts DEFAULT_LIMITS.
  snapshotLimits?: Limits
  // The lstat behind the guard's "does this path exist" (default node:fs lstatSync; tests inject errors).
  lstat?: (path: string) => unknown
}

// What one hook asks for. dispatch.ts merges the results of all hooks of an event into the
// Codex output JSON: `deny` only for PreToolUse, `block` only for Stop.
export interface HookResult { context?: string; deny?: string; block?: string }

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
