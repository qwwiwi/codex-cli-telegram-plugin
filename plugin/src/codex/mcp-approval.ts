import { object } from './rpc.js'

const name = /^[a-z0-9][a-z0-9_.:-]{0,100}$/i
const sensitiveKey = /"[^"]*(?:token|authorization|password|credential|secret|api[_-]?key)[^"]*"\s*:/iu

// Codex marks its own tool approval forms. Other MCP elicitation modes can
// request input, navigate to a URL, or require device verification.
export function parseMcpApproval(request: Record<string, unknown>) {
  const { threadId, turnId, serverName, mode, message, environmentId } = request
  const meta = object(request._meta)
  const schema = object(request.requestedSchema)
  const properties = schema.properties
  if (typeof serverName !== 'string' || !name.test(serverName) ||
      typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId ||
      mode !== 'form' || (environmentId != null && environmentId !== 'local') ||
      meta.codex_approval_kind !== 'mcp_tool_call' ||
      typeof meta.tool_name !== 'string' || !name.test(meta.tool_name) ||
      typeof message !== 'string' || !message.trim() || message.length > 400 ||
      schema.type !== 'object' || properties == null || typeof properties !== 'object' ||
      Array.isArray(properties) || Object.keys(properties).length !== 0 ||
      (schema.required != null && (!Array.isArray(schema.required) || schema.required.length !== 0))) return

  const args = JSON.stringify(meta.tool_params ?? {}, null, 2)
  const target = serverName + ' / ' + meta.tool_name + '\n' + args
  if (target.length > 2700 || sensitiveKey.test(args)) return
  return { threadId, turnId, operation: { kind: 'mcp' as const, target, reason: message } }
}
