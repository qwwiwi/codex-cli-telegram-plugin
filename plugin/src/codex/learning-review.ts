import { CodexRpc, object } from './rpc.js'

const outputSchema = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: { entries: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['kind', 'key', 'text', 'triggers', 'evidence'],
    properties: {
      kind: { type: 'string', enum: ['user', 'memory', 'skill'] },
      key: { type: 'string' }, text: { type: 'string' },
      triggers: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'integer' } },
    },
  } } },
}

// Keep this independent of the owner session and mirror the upstream Codex
// temporary structured thread: no environment, approvals, MCP, or tools.
export async function reviewLearning(
  cwd: string, env: NodeJS.ProcessEnv, prompt: string, signal: AbortSignal, model?: string,
  command?: readonly [string, ...string[]],
): Promise<string> {
  return requestStructured(cwd, env, prompt, outputSchema, signal, model, command)
}

export async function requestStructured(
  cwd: string, env: NodeJS.ProcessEnv, prompt: string, schema: Record<string, unknown>, signal: AbortSignal,
  model?: string, command?: readonly [string, ...string[]],
): Promise<string> {
  const completed = Promise.withResolvers<string | undefined>()
  let threadId: string | undefined
  let turnId: string | undefined
  let text: string | undefined
  const rpc = new CodexRpc(cwd, env, event => {
    if (!threadId || event.params.threadId !== threadId) return
    const item = object(event.params.item)
    if (event.method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
      text = item.text.length <= 8000 ? item.text : undefined
    }
    if (event.method === 'turn/completed') {
      const turn = object(event.params.turn)
      completed.resolve(turn.status === 'completed' ? text : undefined)
    }
  }, () => completed.resolve(undefined), command)
  const abort = () => rpc.close()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 90_000)
  try {
    if (signal.aborted) throw new Error('Review cancelled')
    await rpc.initialize()
    const account = await rpc.request('account/read', { refreshToken: false })
    if (object(account.account).type !== 'chatgpt') throw new Error('Learning requires a local ChatGPT login')
    const effective = await rpc.request('config/read', { cwd, includeLayers: false })
    if (!effective.config || typeof effective.config !== 'object' || Array.isArray(effective.config)) {
      throw new Error('Review needs readable effective Codex configuration')
    }
    const disabledMcp = Object.fromEntries(Object.keys(object(object(effective.config).mcp_servers))
      .map(name => [name, { enabled: false }]))
    const disabled = [
      'apps', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder',
      'deferred_executor', 'enable_fanout', 'goals', 'hooks', 'image_generation', 'memories',
      'multi_agent', 'multi_agent_v2', 'plugins', 'request_permissions_tool', 'shell_snapshot',
      'shell_tool', 'standalone_web_search', 'token_budget', 'tool_suggest', 'unified_exec', 'view_image',
    ]
    const start = await rpc.request('thread/start', {
      cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: [],
      ...(model ? { model } : {}),
      config: {
        ...Object.fromEntries(disabled.map(name => ['features.' + name, false])),
        'cloud.skills.enabled': false,
        'skills.include_instructions': false,
        'tools.experimental_request_user_input.enabled': false,
        'tools.update_plan.enabled': false,
        default_permissions: ':read-only',
        web_search: 'disabled',
        mcp_servers: disabledMcp,
      },
    })
    const thread = object(start.thread)
    if (typeof thread.id !== 'string' || thread.ephemeral !== true ||
        start.approvalPolicy !== 'never' || object(start.sandbox).type !== 'readOnly') {
      throw new Error('Review requires an ephemeral read-only thread')
    }
    threadId = thread.id
    const result = await rpc.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], outputSchema: schema,
    })
    const turn = object(result.turn)
    if (typeof turn.id !== 'string') throw new Error('Review turn was not started')
    turnId = turn.id
    const reply = await completed.promise
    if (!reply || signal.aborted) throw new Error('Review ended without a valid response')
    turnId = undefined
    return reply
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    if (turnId && threadId) {
      void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
    }
    // This connection owns only the temporary local App Server process.
    rpc.close()
  }
}
