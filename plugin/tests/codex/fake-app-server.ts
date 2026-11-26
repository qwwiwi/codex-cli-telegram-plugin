import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const emit = (message: object) => process.stdout.write(JSON.stringify(message) + '\n')
let threadId = ''
let turnNumber = 0
let activeTurn = ''
let pendingApproval = ''
let childTurn = ''
let resolveMcpDuringLookup: { requestId: string; threadId: string; turnId: string } | undefined
let repeatedApproval: { prefix: string; results: Map<string, string> } | undefined
// Threads started while the main turn waits are side threads; they keep the main thread intact.
const sideThreads = new Set<string>()
let mainWaiting = false
let sideTurnNumber = 0
let pendingSideApproval: { id: string; threadId: string; turnId: string } | undefined
const goalState: { current: { objective: string; status: string; origin: string } | null } = { current: null }

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line)
  // KROT_FAKE_LOG: tests read back every client request (one JSON line each).
  if (method && process.env.KROT_FAKE_LOG) appendFileSync(process.env.KROT_FAKE_LOG, JSON.stringify({ method, params }) + '\n')
  if (!method && repeatedApproval && typeof id === 'string' && id.startsWith(repeatedApproval.prefix)) {
    const { prefix, results } = repeatedApproval
    results.set(id, result?.decision ?? 'unsupported')
    if (results.size === 2) {
      emit({ id: prefix + '3', method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId: activeTurn, itemId: 'item-3', command: 'printf test', cwd: '/workspace',
      } })
    } else if (results.size === 3) {
      emit({ method: 'item/completed', params: {
        threadId, turnId: activeTurn,
        item: { type: 'agentMessage', phase: 'final_answer',
          text: [1, 2, 3].map(index => results.get(prefix + index)).join(',') },
      } })
      emit({ method: 'turn/completed', params: {
        threadId, turn: { id: activeTurn, status: 'completed' },
      } })
      repeatedApproval = undefined
    }
    continue
  }
  if (!method && pendingSideApproval && id === pendingSideApproval.id) {
    const { threadId: side, turnId } = pendingSideApproval
    pendingSideApproval = undefined
    emit({ method: 'item/completed', params: {
      threadId: side, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'side ' + JSON.parse(line).result?.decision },
    } })
    emit({ method: 'turn/completed', params: { threadId: side, turn: { id: turnId, status: 'completed' } } })
    continue
  }
  if (!method && id === pendingApproval) {
    const response = JSON.parse(line)
    emit({ method: 'item/completed', params: {
      threadId, turnId: activeTurn,
      item: { type: 'agentMessage', phase: 'final_answer', text: response.result?.decision ??
        (response.result?.action ? JSON.stringify(response.result) : 'unsupported') },
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
      // argv[4] pins the exact "approvalPolicy/sandbox" pair a test expects.
      if (process.argv[4] ? params.approvalPolicy + '/' + params.sandbox !== process.argv[4]
        : !['never', 'on-request'].includes(params.approvalPolicy) || params.sandbox !== 'workspace-write') {
        emit({ id, error: { code: -32602, message: 'Unexpected sandbox policy' } })
        break
      }
      if (mainWaiting && !params.threadId) {
        const side = crypto.randomUUID()
        sideThreads.add(side)
        respond({ thread: { id: side }, model: 'side-model' })
        break
      }
      threadId = params.threadId ?? crypto.randomUUID()
      respond({ thread: { id: threadId }, model: 'gpt-test' })
      break
    case 'thread/fork': {
      // KROT_FAKE_NO_FORK: an App Server (or relay) that refuses forks.
      if (process.env.KROT_FAKE_NO_FORK === '1' || params.threadId !== threadId || params.excludeTurns !== true) {
        emit({ id, error: { code: -32601, message: 'Fork refused' } })
        break
      }
      // While the main turn runs, a fork must stop at a finished turn (lastTurnId).
      if (mainWaiting && (typeof params.lastTurnId !== 'string' || !params.lastTurnId.startsWith('turn-') ||
          params.lastTurnId === activeTurn)) {
        emit({ id, error: { code: -32602, message: 'Fork would copy the running turn' } })
        break
      }
      const side = crypto.randomUUID()
      if (mainWaiting) sideThreads.add(side)
      else threadId = side
      respond({ thread: { id: side, ephemeral: params.ephemeral === true, forkedFromId: params.threadId }, model: 'gpt-test' })
      break
    }
    case 'thread/turns/list':
      if (params.threadId !== threadId) break
      respond({ data: [{ items: [{ type: 'agentMessage', text: 'Example' }] }], nextCursor: null })
      break
    case 'thread/read':
      if (resolveMcpDuringLookup?.threadId === params.threadId) {
        emit({ method: 'serverRequest/resolved', params: resolveMcpDuringLookup })
        resolveMcpDuringLookup = undefined
      }
      respond({ thread: {
        id: params.threadId === 'wrong-thread' ? 'other-thread' : params.threadId,
        status: { type: ({ 'idle-child': 'idle', 'unloaded-child': 'notLoaded', 'wrong-thread': 'idle' } as Record<string, string>)[params.threadId] ?? 'active' },
        cwd: process.cwd(), sessionId: threadId, parentThreadId: threadId,
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
      if (sideThreads.has(params.threadId)) {
        const side = params.threadId
        const turnId = 'side-turn-' + ++sideTurnNumber
        const text = params.input[0].text
        // A side turn reports as a fresh thread would: started, usage, then its answer.
        emit({ method: 'turn/started', params: { threadId: side, turn: { id: turnId } } })
        emit({ method: 'thread/tokenUsage/updated', params: {
          threadId: side, turnId, tokenUsage: { last: { totalTokens: 99 }, modelContextWindow: 100 },
        } })
        emit({ method: 'item/started', params: { threadId: side, turnId, item: { id: 'side-cmd', type: 'commandExecution', command: 'ls' } } })
        respond({ turn: { id: turnId } })
        if (text.endsWith('side-approval')) {
          pendingSideApproval = { id: 'side-approval-' + sideTurnNumber, threadId: side, turnId }
          emit({ id: pendingSideApproval.id, method: 'item/commandExecution/requestApproval', params: {
            threadId: side, turnId, itemId: 'side-item', command: 'printf side', cwd: '/workspace',
          } })
        } else if (!text.endsWith('side-wait')) {
          emit({ method: 'item/completed', params: {
            threadId: side, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'side: ' + text },
          } })
          emit({ method: 'turn/completed', params: { threadId: side, turn: { id: turnId, status: 'completed' } } })
        }
        break
      }
      activeTurn = 'turn-' + ++turnNumber
      mainWaiting = params.input[0].text === 'wait'
      if (params.outputSchema) {
        emit({ method: 'item/completed', params: {
          threadId, turnId: activeTurn, item: { type: 'agentMessage', text: '{"entries":[]}' },
        } })
        emit({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'completed' } } })
        respond({ turn: { id: activeTurn } })
        break
      }
      if (params.input[0].text.startsWith('mcp-approval:')) {
        const scenario = params.input[0].text
        const github = scenario.includes(':github')
        respond({ turn: { id: activeTurn } })
        emit({ method: 'turn/started', params: { threadId, turn: { id: activeTurn } } })
        pendingApproval = 'mcp-approval-' + turnNumber
        const worker = scenario.endsWith('resolved')
        if (worker) {
          resolveMcpDuringLookup = { requestId: pendingApproval, threadId: 'mcp-worker', turnId: activeTurn + '-worker' }
          emit({ method: 'turn/started', params: {
            threadId: resolveMcpDuringLookup.threadId, turn: { id: resolveMcpDuringLookup.turnId },
          } })
        }
        emit({ id: pendingApproval, method: 'mcpServer/elicitation/request', params: {
          threadId: resolveMcpDuringLookup?.threadId ?? threadId,
          turnId: resolveMcpDuringLookup?.turnId ?? (scenario.endsWith('stale') ? 'wrong-turn' : activeTurn),
          serverName: github ? 'codex_apps' : 'example-tasks', mode: scenario.endsWith('url') ? 'url' : 'form',
          message: 'Allow opening this test task?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: github ? 'github.create_tree' : 'task_read',
            tool_params: github ? { repository_full_name: 'example/private', tree: [{ content: 'internal fixture' }] }
              : { id: 42 }, persist: 'always' },
        } })
        break
      }
      if (params.input[0].text.startsWith('approval:')) {
        const scenario = params.input[0].text
        const fileApproval = scenario.startsWith('approval:policy-file')
        const patch = [
          '*** Begin Patch', '*** Add File: nested/new.txt', '+created',
          '*** Update File: nested/change.txt', '@@', '-before', '+after',
          '*** Delete File: nested/remove.txt', '*** End Patch',
        ].join('\n')
        respond({ turn: { id: activeTurn } })
        emit({ method: 'turn/started', params: { threadId, turn: { id: activeTurn } } })
        if (scenario === 'approval:repeated') {
          const prefix = 'repeated-approval-' + turnNumber + '-'
          repeatedApproval = { prefix, results: new Map() }
          for (const index of [1, 2]) {
            emit({ id: prefix + index, method: 'item/commandExecution/requestApproval', params: {
              threadId, turnId: activeTurn, itemId: 'item-' + index, command: 'printf test', cwd: '/workspace',
            } })
          }
          break
        }
        childTurn = activeTurn + '-child'
        if (scenario.startsWith('approval:child')) {
          emit({ method: 'turn/started', params: { threadId: 'child', turn: { id: childTurn } } })
        }
        if (scenario.startsWith('approval:policy')) {
          const policy = { threadId, turnId: activeTurn, itemId: 'item' }
          const reply = await fetch(process.env.KROT_TEST_POLICY_URL!, {
            method: 'POST', headers: { authorization: 'Bearer test-policy', 'content-type': 'application/json' },
            body: JSON.stringify(fileApproval
              ? { kind: 'file', target: patch, cwd: '/workspace', operation: policy }
              : { kind: 'command', target: 'printf test', cwd: '/workspace', operation: policy }),
          })
          if (!reply.ok) throw new Error('Policy fixture failed')
        }
        pendingApproval = 'approval-' + turnNumber
        if (fileApproval) {
          emit({ method: 'item/started', params: { threadId, turnId: activeTurn, item: { id: 'item',
            type: 'fileChange', changes: [
              { path: '/workspace/nested/new.txt', kind: { type: 'add' }, diff: 'created\n' },
              { path: '/workspace/nested/change.txt', kind: { type: 'update', move_path: null },
                diff: '@@ -1,2 +1,2 @@\n context\n-before\n+' + (scenario.endsWith('mismatch') ? 'different' : 'after') + '\n' },
              { path: '/workspace/nested/remove.txt', kind: { type: 'delete' }, diff: 'removed file contents\n' },
            ] } } })
          emit({ id: pendingApproval, method: 'item/fileChange/requestApproval',
            params: { threadId, turnId: activeTurn, itemId: 'item' } })
          break
        }
        emit({ id: pendingApproval, method: 'item/commandExecution/requestApproval', params: {
          threadId: scenario === 'approval:foreign' ? 'foreign' : scenario.startsWith('approval:child') ? 'child' : threadId,
          turnId: scenario === 'approval:child' ? childTurn : activeTurn,
          itemId: 'item',
          command: scenario === 'approval:routine' || scenario === 'approval:routine-remote' ? "/bin/bash -lc 'df -h && free -m'"
            : scenario === 'approval:risky' ? "/bin/bash -lc 'df -h && rm -r -- ./temporary'"
            : scenario === 'approval:policy' ? "/usr/bin/bash -lc 'printf test'"
            : scenario === 'approval:policy-production-shell' ? "/bin/bash -c 'printf test'"
            : scenario === 'approval:policy-mismatch' ? "/usr/bin/bash -lc 'printf other'" : 'printf test',
          cwd: '/workspace',
          ...(scenario.startsWith('approval:network') ? {
            availableDecisions: scenario === 'approval:network-persistent-only' ? ['acceptForSession', 'cancel'] : ['accept', 'cancel'],
            networkApprovalContext: { protocol: 'https', host: scenario === 'approval:network-invalid' ? 'example.test/path' : 'example.test:443' },
            environmentId: scenario === 'approval:network-remote' ? 'remote' : 'local',
          } : {}),
          ...(scenario.startsWith('approval:stdin') ? {
            kind: 'writeStdin', approvalId: 'stdin-approval', availableDecisions: ['accept', 'cancel'],
            ...(scenario === 'approval:stdin-visible' ? { command: "write_stdin --session-id 123 'test input'" } : {}),
          } : {}),
          ...(scenario === 'approval:incomplete' ? { command: undefined } : {}),
          ...(scenario === 'approval:routine-remote' ? { environmentId: 'remote' } : {}),
        } })
        break
      } else if (params.input[0].text !== 'wait') {
        if (params.input[0].text.startsWith('usage:')) {
          // 'usage:cached' reports cache counters, 'usage:plain' omits them.
          const cached = params.input[0].text === 'usage:cached'
          emit({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: activeTurn, tokenUsage: {
            last: { totalTokens: 5000, ...(cached ? { inputTokens: 4000, cachedInputTokens: 3280 } : {}) },
            modelContextWindow: 100000,
          } } })
        }
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
      if (sideThreads.has(params.threadId)) {
        respond({})
        emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } })
        break
      }
      if (params.turnId !== activeTurn || params.threadId !== threadId) break
      mainWaiting = false
      respond({})
      emit({ method: 'turn/completed', params: {
        threadId, turn: { id: activeTurn, status: 'interrupted' },
      } })
      break
  }
}
