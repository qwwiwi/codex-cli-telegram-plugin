// Full access only behind live guards: the sandbox the bridge starts Codex with.
import type { CodexSandboxMode } from './session.js'

export interface SandboxDecision {
  sandbox: CodexSandboxMode | undefined
  // Why a requested danger-full-access was replaced by workspace-write (shown in the log and /doctor).
  fallback?: string
}

/**
 * Resolves the startup sandbox. A requested danger-full-access is kept only when `check` reports
 * the managed guards active (root-owned, self-tested and listed by Codex); a failed or throwing
 * check falls back to workspace-write. Other modes are passed through without a check.
 */
export async function startupSandbox(requested: CodexSandboxMode | undefined,
  check: () => Promise<{ active: boolean; why: string }>): Promise<SandboxDecision> {
  if (requested !== 'danger-full-access') return { sandbox: requested }
  let result: { active: boolean; why: string }
  try {
    result = await check()
  } catch {
    result = { active: false, why: 'проверка защиты не выполнилась' }
  }
  return result.active ? { sandbox: requested } : { sandbox: 'workspace-write', fallback: result.why }
}
