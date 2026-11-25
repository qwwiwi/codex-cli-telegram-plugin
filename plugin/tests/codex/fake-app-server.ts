import { createInterface } from 'node:readline'

const emit = (message: object) => process.stdout.write(JSON.stringify(message) + '\n')
let threadId = ''
let turnNumber = 0
let activeTurn = ''
let pendingApproval = ''
let childTurn = ''
const goalState: { current: { objective: string; status: string; origin: string } | null } = { current: null }

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (!method && id === pendingApproval) {
    const response = JSON.parse(line)
    emit({ method: 'item/completed', params: {
      threadId, turnId: activeTurn,
      item: { type: 'agentMessage', phase: 'final_answer', text: response.result?.decision ?? 'unsupported' },
    } })
    emit({ method: 'turn/completed', params: {
      threadId, turn: { id: activeTurn, status: 'completed' },
    } })
    continue
  }
  const respond = (result: object) => emit({ id, result })
  switch (method) {
    case 'initialize':
      respond({})
      break
    case 'account/read':
      respond({ account: { type: process.argv[2] ?? 'chatgpt' } })
      break
    case 'account/rateLimits/read':
      respond({ rateLimits: { primary: { usedPercent: 16.8, windowDurationMins: 300 } } })
      break
    case 'model/list':
      respond({ data: [{ model: 'gpt-test', isDefault: true }, { model: 'hidden-test', hidden: true }] })
      break
    case 'config/read':
      respond({ config: { mcp_servers: { external: { enabled: true } } } })
      break
    case 'thread/start':
    case 'thread/resume':
      if (params.ephemeral) {
        if (params.sandbox !== 'read-only' || params.approvalPolicy !== 'never' ||
            params.environments?.length !== 0 || params.dynamicTools?.length !== 0 ||
            params.config?.mcp_servers?.external?.enabled !== false ||
            params.config?.['features.shell_tool'] !== false) {
          emit({ id, error: { code: -32602, message: 'Unsafe review settings' } })
          break
        }
        threadId = crypto.randomUUID()
        respond({ thread: { id: threadId, ephemeral: true }, approvalPolicy: 'never', sandbox: {
          type: process.argv[3] === 'wrong-sandbox' ? 'workspaceWrite' : 'readOnly',
        } })
        break
      }
      if (!['never', 'on-request'].includes(params.approvalPolicy) || params.sandbox !== 'workspace-write') {
        emit({ id, error: { code: -32602, message: 'Unexpected sandbox policy' } })
        break
      }
      threadId = params.threadId ?? crypto.randomUUID()
      respond({ thread: { id: threadId }, model: 'gpt-test' })
      break
    case 'thread/turns/list':
      if (params.threadId !== threadId) break
      respond({ data: [{ items: [{ type: 'agentMessage', text: 'Example' }] }], nextCursor: null })
      break
    case 'thread/read':
      respond({ thread: {
        id: params.threadId, cwd: process.cwd(), sessionId: threadId, parentThreadId: threadId,
        source: { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } } },
      } })
      break
    case 'thread/goal/get':
      respond({ goal: goalState.current })
      break
    case 'thread/goal/set': {
      const goal = {
        objective: params.objective ?? goalState.current?.objective ?? '',
        status: params.status, origin: params.origin,
      }
      goalState.current = goal
      respond({ goal })
      if (params.status !== 'active') break
      const turnId = 'goal-turn'
      emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
      emit({ method: 'item/completed', params: {
        threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'Goal achieved' },
      } })
      goal.status = 'complete'
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
      break
    }
    case 'thread/compact/start':
      if (params.threadId !== threadId) break
      activeTurn = 'turn-' + ++turnNumber
      respond({})
      emit({ method: 'turn/started', params: { threadId, turn: { id: activeTurn } } })
      emit({ method: 'thread/tokenUsage/updated', params: {
        threadId, turnId: activeTurn, tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
      } })
      emit({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'completed' } } })
      break
    case 'turn/start': {
      activeTurn = 'turn-' + ++turnNumber
      if (params.outputSchema) {
        emit({ method: 'item/completed', params: {
          threadId, turnId: activeTurn, item: { type: 'agentMessage', text: '{"entries":[]}' },
        } })
        emit({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'completed' } } })
        respond({ turn: { id: activeTurn } })
        break
      }
      if (params.input[0].text.startsWith('approval:')) {
        const scenario = params.input[0].text
        respond({ turn: { id: activeTurn } })
        emit({ method: 'turn/started', params: { threadId, turn: { id: activeTurn } } })
        childTurn = activeTurn + '-child'
        if (scenario.startsWith('approval:child')) {
          emit({ method: 'turn/started', params: { threadId: 'child', turn: { id: childTurn } } })
        }
        if (scenario.startsWith('approval:policy')) {
          const policy = { threadId, turnId: activeTurn, itemId: 'item' }
          const reply = await fetch(process.env.KROT_TEST_POLICY_URL!, {
            method: 'POST', headers: { authorization: 'Bearer test-policy', 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'command', target: 'printf test', cwd: '/workspace', operation: policy }),
          })
          if (!reply.ok) throw new Error('Policy fixture failed')
        }
        pendingApproval = 'approval-' + turnNumber
        emit({ id: pendingApproval, method: 'item/commandExecution/requestApproval', params: {
          threadId: scenario === 'approval:foreign' ? 'foreign' : scenario.startsWith('approval:child') ? 'child' : threadId,
          turnId: scenario === 'approval:child' ? childTurn : activeTurn,
          itemId: 'item',
          command: scenario === 'approval:policy' ? "/usr/bin/bash -lc 'printf test'"
            : scenario === 'approval:policy-mismatch' ? "/usr/bin/bash -lc 'printf other'" : 'printf test',
          cwd: '/workspace',
          ...(scenario === 'approval:incomplete' ? { command: undefined } : {}),
        } })
        break
      } else if (params.input[0].text !== 'wait') {
        // Exercise the race where notifications arrive before the RPC reply.
        emit({ method: 'item/completed', params: {
          threadId: 'other-thread', turnId: activeTurn,
          item: { type: 'agentMessage', phase: 'final_answer', text: 'wrong thread' },
        } })
        emit({ method: 'item/completed', params: {
          threadId, turnId: activeTurn,
          item: { type: 'agentMessage', phase: 'final_answer', text: params.input[0].text
            + params.input.slice(1).map((part: { type: string; path: string }) => '|' + part.type + ':' + part.path).join('') },
        } })
        emit({ method: 'item/completed', params: {
          threadId, turnId: activeTurn,
          item: { type: 'agentMessage', phase: 'commentary', text: 'status' },
        } })
        emit({ method: 'turn/completed', params: {
          threadId, turn: { id: activeTurn, status: 'completed' },
        } })
      }
      respond({ turn: { id: activeTurn } })
      break
    }
    case 'turn/steer':
      if (params.expectedTurnId !== activeTurn || params.threadId !== threadId) break
      respond({ turnId: activeTurn })
      emit({ method: 'item/completed', params: {
        threadId, turnId: activeTurn,
        item: { type: 'agentMessage', phase: 'commentary', text: 'Follow-up: ' + params.input[0].text },
      } })
      break
    case 'turn/interrupt':
      if (params.turnId !== activeTurn || params.threadId !== threadId) break
      respond({})
      emit({ method: 'turn/completed', params: {
        threadId, turn: { id: activeTurn, status: 'interrupted' },
      } })
      break
  }
}
