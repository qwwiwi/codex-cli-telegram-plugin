import { load } from 'js-yaml'
import { classifyToolCall, PermissionPolicySchema, type PermissionPolicy, type PermissionVerdict } from '../security/permission-policy.js'
import { object } from './rpc.js'
import { needsServerRiskCard } from './server-approval-policy.js'

export function assessPolicy(yaml: string, value: unknown, scope = 'main', riskyApprovals = false): PermissionVerdict {
  const { tool_name: tool, tool_input: input, hook_event_name: event } = object(value)
  const deny = { tier: 'deny', reason: 'Не удалось проверить действие по правилам YAML.', matchedRule: 'hook:invalid' } as const
  let document: unknown
  try { document = load(yaml) } catch { return deny }
  const parsed = PermissionPolicySchema.safeParse(document)
  if (!parsed.success || event !== 'PreToolUse' || typeof tool !== 'string') return deny
  if (scope !== 'main' && !Object.hasOwn(parsed.data.scopes ?? {}, scope)) return deny
  const classify = (toolName: string, toolInput: unknown) =>
    classifyToolCall({ toolName, toolInput, policy: parsed.data as PermissionPolicy, scope })
  const base = classify(tool, input)
  if (riskyApprovals && base.tier === 'allow' && ['Bash', 'exec_command', 'shell_command'].includes(tool)) {
    const { command } = object(input)
    if (typeof command === 'string' && needsServerRiskCard(command)) {
      return { tier: 'confirm', reason: 'Команда может удалить данные или изменить критичные настройки.', matchedRule: 'server:risk' }
    }
  }
  if (tool !== 'apply_patch' || base.tier === 'deny') return base
  const { command } = object(input)
  if (typeof command !== 'string') return deny
  const paths = [...command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
  if (!paths.length) return deny
  let required = base
  for (const [, path] of paths) {
    const verdict = classify('Edit', { file_path: path })
    if (verdict.tier === 'deny') return verdict
    if (verdict.tier === 'confirm') required = verdict
  }
  return required
}

export function policyHookOutput(allowed: boolean, reason = 'Действие остановлено профилем разрешений Telegram.') {
  return allowed ? {} : {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }
}
