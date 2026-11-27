// The Codex thread profile of every non-owner (member or guest) thread.
//
// S0 (live codex 0.172): a read-only thread with these feature keys off and
// asked to run `id` answered NO_SHELL with no command execution item. The
// keys go into the thread/start `config` map, the same names as config.toml.
//
// MCP servers are NOT kept out here: live 0.172 deep-merges this `config` map
// into config.toml, so an empty `mcp_servers` table removes nothing. Public
// threads run on their own app-server whose CODEX_HOME holds only the
// allowlisted servers and skills (public-home.ts); the startup probe checks
// what such a thread can reach. This profile stays on top as defense in depth.

import type { CodexSandboxPolicy } from './session.js'

// Subagents (multi_agent, multi_agent_v2, enable_fanout), local image reads (view_image) and permission
// requests are off too; every name here is one the live 0.172 learning review already sends (learning-review.ts).
export const PUBLIC_FEATURES_OFF = [
  'shell_tool', 'unified_exec', 'apply_patch_freeform', 'browser_use', 'computer_use', 'apps', 'plugins', 'image_generation',
  'multi_agent', 'multi_agent_v2', 'enable_fanout', 'view_image', 'request_permissions_tool', 'code_mode', 'code_mode_only',
] as const

export const PUBLIC_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(PUBLIC_FEATURES_OFF.map(name => ['features.' + name, false])),
)

/** Web search of a public thread (Codex 0.172 `web_search`): guests always disabled, members live only when allowed. */
export type PublicWebSearch = 'disabled' | 'live'

/** thread/start and thread/resume parameters of a public thread. */
export function publicThreadParams(cwd: string, instructions: string, webSearch: PublicWebSearch = 'disabled'): Record<string, unknown> {
  return {
    cwd,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    // developer_instructions replaces the owner's config-level instructions in this thread.
    config: { ...PUBLIC_THREAD_CONFIG, web_search: webSearch, developer_instructions: instructions },
  }
}

/** turn/start overrides of a public turn: sent every turn, so nothing earlier can widen them. */
export function publicTurnParams(cwd: string): { cwd: string; approvalPolicy: 'never'; sandboxPolicy: CodexSandboxPolicy } {
  return { cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}

/** The reply text every public turn must give when it has no shell (the /doctor canary checks it). */
export const NO_SHELL = 'NO_SHELL'
