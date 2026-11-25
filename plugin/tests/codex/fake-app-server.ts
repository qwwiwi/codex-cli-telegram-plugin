import { createInterface } from 'node:readline'

const emit = (message: object) => process.stdout.write(JSON.stringify(message) + '\n')
let threadId = ''
let turnNumber = 0
let activeTurn = ''
let pendingApproval = ''
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
    case 'thread/start':
    case 'thread/resume':
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
      if (params.input[0].text.startsWith('approval:')) {
        respond({ turn: { id: activeTurn } })
        pendingApproval = 'approval-' + turnNumber
        emit({ id: pendingApproval, method: 'item/commandExecution/requestApproval', params: {
          threadId: params.input[0].text === 'approval:foreign' ? 'foreign' : threadId,
          turnId: activeTurn, itemId: 'item', command: 'printf test', cwd: '/workspace',
          ...(params.input[0].text === 'approval:incomplete' ? { command: undefined } : {}),
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
