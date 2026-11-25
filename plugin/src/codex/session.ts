import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CodexRpc, object, type CodexEvent, type CodexServerRequest } from './rpc.js'
import { sameFilePatch, type NativeFileChange } from './file-approval.js'
import { agentChatTool, type AgentChatActions } from './chat-actions.js'
import { isRoutineServerCommand } from './server-approval-policy.js'
import { parseMcpApproval } from './mcp-approval.js'

export type ApprovalDecision = 'accept' | 'decline' | 'cancel'

export type ApprovalRequest = {
  kind: 'command' | 'file' | 'network' | 'stdin' | 'mcp'
  target: string
  cwd?: string
  reason?: string
  notice?: string
  dedupeKey?: string
}
export type PolicyApprovalRequest = ApprovalRequest & {
  kind: 'command' | 'file'
  operation?: { threadId: string; turnId: string; itemId: string }
}

type Settings = {
  cwd: string
  stateFile: string
  env: NodeJS.ProcessEnv
  command?: readonly [string, ...string[]]
  model?: string
  selectedModel?: () => string | undefined
  onThread?: (threadId: string) => void
  onProgress?: (kind: string) => void
  onActivity?: (event: CodexEvent, currentThread: string | null) => void
  mayRunGoal?: (threadId: string) => boolean
  onGoalResult?: (threadId: string, result: Result) => void
  approve?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>
  riskyApprovals?: boolean
  ask?: (questions: unknown, signal?: AbortSignal) => Promise<Record<string, { answers: string[] }>>
  chatAction?: (key: string, args: unknown, current: () => boolean) => ReturnType<AgentChatActions['call']>
}

type Result = { status: 'completed' | 'interrupted' | 'failed'; text: string }
type SessionStatus = {
  hasThread: boolean
  model: string | undefined
  usage: { usedTokens: number; windowTokens: number } | undefined
}

type Execution = {
  id?: string
  threadId: string
  fileChanges: Map<string, NativeFileChange[]>
}

type Turn = Execution & {
  stop: boolean
  lastText: string
  finalText?: string
  children: Map<string, Execution>
  approvedPolicy: Map<string, { kind: PolicyApprovalRequest['kind']; target: string; cwd: string; until: number }>
  finish: (result: Result) => void
}

function recordFileChange(execution: Execution, item: Record<string, unknown>): void {
  if (item.type !== 'fileChange' || typeof item.id !== 'string' || !Array.isArray(item.changes)) return
  const changes = item.changes.flatMap(entry => {
    const change = object(entry)
    return typeof change.path === 'string' && typeof change.diff === 'string'
      ? [{ path: change.path, diff: change.diff, kind: object(change.kind) }] : []
  })
  if (changes.length === item.changes.length) execution.fileChanges.set(item.id, changes)
}

function sameShellCommand(native: string, hook: string): boolean {
  // Match Codex's observed Bash argv presentation without evaluating shell syntax.
  const quoted = "'" + hook.replaceAll("'", "'\\''") + "'"
  const shellPrefix = /^(?:\/usr)?\/bin\/bash -(?:l)?c /u.exec(native)?.[0]
  return native === hook || (shellPrefix !== undefined && native.slice(shellPrefix.length) === quoted)
}

function networkDestination(context: unknown): string | undefined {
  const { host, protocol } = object(context)
  if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.:[\]_-]+$/u.test(host) ||
      typeof protocol !== 'string' || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(protocol)) return
  return protocol + '://' + host
}

export class CodexSession {
  private readonly pendingServerRequests = new Map<number | string, {
    threadId: string
    turnId: string | undefined
    abort: AbortController
  }>()
  private readonly turnApprovals = new WeakMap<Execution, { pending: Set<string>; declined: Set<string> }>()
  private readonly rpc: CodexRpc
  private threadId: string | null = null
  private needsResume = false
  private busy = false
  private stopRequested = false
  private model: string | undefined
  private usage: SessionStatus['usage']
  private lastActivity = Date.now()
  private active: Turn | undefined
  private goalTurn: Turn | undefined

  constructor(private readonly settings: Settings, onClose: () => void) {
    try {
      const saved: unknown = JSON.parse(readFileSync(settings.stateFile, 'utf8'))
      if (saved !== null && (typeof saved !== 'string' || saved.length === 0)) {
        throw new Error('Invalid Codex thread state')
      }
      this.threadId = saved
      this.needsResume = saved !== null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    this.rpc = new CodexRpc(settings.cwd, settings.env, event => this.receive(event), () => {
      this.active?.finish({ status: 'failed', text: '' })
      onClose()
    }, settings.command, request => this.requestApproval(request))
  }

  async initialize(): Promise<void> {
    await this.rpc.initialize()
    const account = await this.rpc.request('account/read', { refreshToken: false })
    if (object(account.account).type !== 'chatgpt') {
      throw new Error('This private pilot requires a managed ChatGPT login in Codex CLI')
    }
  }

  get isRunning(): boolean {
    return this.busy || this.goalTurn !== undefined
  }

  get quietForMs(): number {
    return Date.now() - this.lastActivity
  }

  async stopBackground(): Promise<boolean> {
    return (await this.rpc.request('krot/background/stop', {})).scheduled === true
  }

  async previousTurnIdle(): Promise<boolean> {
    const id = this.threadId
    if (!id) return true
    if (this.needsResume) await this.resume(id)
    return this.threadIsIdle(id)
  }

  async threadIsIdle(threadId: string): Promise<boolean> {
    const result = await this.rpc.request('thread/read', { threadId, includeTurns: false }, 5000)
    const thread = object(result.thread)
    if (thread.id !== threadId) return false
    const status = object(thread.status).type
    return status === 'idle' || status === 'notLoaded'
  }

  async attachGoalThread(): Promise<string> {
    if (this.busy) throw new Error('Current turn is busy')
    return this.getThread()
  }

  async fork(): Promise<string> {
    const source = await this.attachGoalThread()
    const response = await this.rpc.request('thread/fork', {
      threadId: source, cwd: this.settings.cwd, excludeTurns: true,
      approvalPolicy: this.settings.approve ? 'on-request' : 'never', sandbox: 'workspace-write',
    })
    const id = object(response.thread).id
    if (typeof id !== 'string' || !id || id === source) throw new Error('Codex did not return a forked thread')
    this.saveThread(id)
    return id
  }

  async openArchive(context: string): Promise<void> {
    if (this.isRunning) throw new Error('A Codex turn is running')
    this.busy = true
    const previous = this.threadId
    try {
      const threadId = await this.openThread(null)
      await this.injectContext(threadId, context)
    } catch (error) {
      this.saveThread(previous)
      this.needsResume = previous !== null
      throw error
    } finally {
      this.busy = false
    }
  }

  async injectContext(threadId: string, context: string): Promise<void> {
    if (threadId !== this.threadId) throw new Error('Wrong context thread')
    await this.rpc.request('thread/inject_items', {
      threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: context }] }],
    })
  }

  async goal(): Promise<Record<string, unknown> | null> {
    if (!this.threadId) return null
    const threadId = this.needsResume ? await this.attachGoalThread() : this.threadId
    const response = await this.rpc.request('thread/goal/get', { threadId })
    return response.goal ? object(response.goal) : null
  }

  async setGoal(threadId: string, status: 'active' | 'paused', objective?: string,
    origin: 'user' | 'automatic' = 'user'): Promise<void> {
    if (threadId !== this.threadId) throw new Error('Wrong goal thread')
    await this.rpc.request('thread/goal/set', {
      threadId, status, origin,
      ...(objective ? { objective, tokenBudget: null } : {}),
    })
  }

  async clearGoal(): Promise<void> {
    if (!this.threadId) return
    const threadId = await this.attachGoalThread()
    await this.rpc.request('thread/goal/clear', { threadId })
  }

  recoverConnection(): void {
    this.rpc.close()
  }

  get status(): SessionStatus {
    return { hasThread: this.threadId !== null, model: this.model ?? this.settings.model, usage: this.usage }
  }

  get currentThread(): string | null {
    return this.threadId
  }

  async resume(id: string): Promise<void> {
    if (this.busy) throw new Error('A Codex turn is running')
    this.busy = true
    try {
      if (id !== this.threadId || this.needsResume) await this.openThread(id)
    } finally {
      this.busy = false
    }
  }

  async models(): Promise<Array<{ name: string; default: boolean }>> {
    const reply = await this.rpc.request('model/list', { limit: 100, includeHidden: false })
    return Array.isArray(reply.data) ? reply.data.map(object)
      .filter(x => typeof x.model === 'string' && x.hidden !== true)
      .map(x => ({ name: x.model as string, default: x.isDefault === true })) : []
  }

  async usageLimits(): Promise<Array<{ used: number; minutes?: number }>> {
    const reply = await this.rpc.request('account/rateLimits/read', {})
    const rate = object(object(reply.rateLimitsByLimitId).codex ?? reply.rateLimits)
    return [rate.primary, rate.secondary].map(object).flatMap(window =>
      typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
        ? [{ used: Math.round(window.usedPercent),
          ...(typeof window.windowDurationMins === 'number' ? { minutes: window.windowDurationMins } : {}) }]
        : [])
  }

  async recentTurns(): Promise<{ turns: unknown[]; partial: boolean }> {
    const threadId = this.threadId
    if (!threadId || this.busy) throw new Error('A conversation must be available and idle')
    this.busy = true
    try {
      if (this.needsResume) await this.openThread(threadId)
      const turns: unknown[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const result = await this.rpc.request('thread/turns/list', {
          threadId, limit: 10, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}),
        })
        if (!Array.isArray(result.data)) throw new Error('Codex did not return conversation history')
        turns.push(...result.data)
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
        if (!cursor) break
      }
      return { turns: turns.reverse(), partial: !!cursor }
    } finally {
      this.busy = false
    }
  }

  reset(): void {
    if (this.busy) throw new Error('A Codex turn is running')
    this.saveThread(null)
    this.usage = undefined
    this.model = undefined
  }

  async run(text: string, imagePaths: readonly string[] = [], onStarted?: (turnId: string) => void): Promise<Result> {
    return this.withTurn(async (threadId, turn) => {
      const model = this.settings.selectedModel?.() ?? this.settings.model
      const response = await this.rpc.request('turn/start', {
        threadId,
        ...(model ? { model } : {}),
        input: [
          { type: 'text', text, text_elements: [] },
          ...imagePaths.map(path => ({ type: 'localImage', path })),
        ],
      })
      const id = object(response.turn).id
      if (typeof id !== 'string') throw new Error('Codex did not return a turn ID')
      onStarted?.(id)
      if (model) this.model = model
      if (!turn.id) this.setTurnId(turn, id)
    })
  }

  async compact(): Promise<Result['status']> {
    if (this.threadId === null) throw new Error('There is no Codex conversation to compact')
    return (await this.withTurn(async threadId => {
      await this.rpc.request('thread/compact/start', { threadId })
    })).status
  }

  get steerableTurn(): string | undefined {
    const turn = this.active ?? this.goalTurn
    return turn?.stop ? undefined : turn?.id
  }

  async steer(text: string, messageId: number, imagePaths: readonly string[] = [], expected = this.steerableTurn): Promise<boolean> {
    const turn = this.active ?? this.goalTurn
    if (!turn?.id || turn.id !== expected || turn.stop) return false
    await this.rpc.request('turn/steer', {
      threadId: turn.threadId,
      expectedTurnId: turn.id,
      clientUserMessageId: String(messageId),
      input: [{ type: 'text', text, text_elements: [] }, ...imagePaths.map(path => ({ type: 'localImage', path }))],
    })
    return true
  }

  private async withTurn(start: (threadId: string, turn: Turn) => Promise<void>): Promise<Result> {
    if (this.busy) throw new Error('A Codex turn is running')
    this.busy = true
    this.stopRequested = false
    this.lastActivity = Date.now()
    try {
      const threadId = await this.getThread()
      if (this.stopRequested) return { status: 'interrupted', text: '' }
      let finish!: Turn['finish']
      const completed = new Promise<Result>(resolve => { finish = resolve })
      const turn: Turn = {
        threadId, stop: false, lastText: '', fileChanges: new Map(), children: new Map(), approvedPolicy: new Map(), finish,
      }
      this.active = turn
      await start(threadId, turn)
      return await completed
    } finally {
      this.active = undefined
      this.busy = false
    }
  }

  async stop(): Promise<boolean> {
    if (!this.isRunning) return false
    const turn = this.active ?? this.goalTurn
    if (!turn) {
      this.stopRequested = true
      return true
    }
    turn.stop = true
    if (turn.id) {
      await this.rpc.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id })
    }
    return true
  }

  close(): void {
    this.rpc.close()
  }

  private async getThread(): Promise<string> {
    if (this.threadId && !this.needsResume) return this.threadId
    return this.openThread(this.threadId)
  }

  private async openThread(expected: string | null): Promise<string> {
    const model = this.settings.selectedModel?.() ?? this.settings.model
    const options = {
      cwd: this.settings.cwd,
      approvalPolicy: this.settings.approve ? 'on-request' : 'never',
      sandbox: 'workspace-write',
      ...(model ? { model } : {}),
    }
    const reply = expected
      ? await this.rpc.request('thread/resume', { ...options, threadId: expected, excludeTurns: true })
      : await this.rpc.request('thread/start', {
        ...options,
        ...(this.settings.chatAction ? { dynamicTools: [agentChatTool] } : {}),
      })
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id || (expected && id !== expected)) {
      throw new Error('Codex did not return the expected thread ID')
    }
    this.model = typeof reply.model === 'string' ? reply.model : undefined
    if (id !== this.threadId) this.usage = undefined
    this.saveThread(id)
    return id
  }

  private saveThread(id: string | null): void {
    const path = this.settings.stateFile
    const tempPath = path + '.' + randomUUID() + '.tmp'
    writeFileSync(tempPath, JSON.stringify(id) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(tempPath, path)
    this.threadId = id
    this.needsResume = false
    if (id) this.settings.onThread?.(id)
  }

  private receive(event: CodexEvent): void {
    if (event.method === 'serverRequest/resolved') {
      const { requestId, threadId, turnId } = event.params
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        const request = this.pendingServerRequests.get(requestId)
        if (request && (request.turnId === undefined ? request.threadId === threadId :
          (threadId == null || request.threadId === threadId) && (turnId == null || request.turnId === turnId))) {
          request.abort.abort()
        }
      }
    }
    this.settings.onActivity?.(event, this.threadId)
    const { method, params } = event
    if (typeof params.threadId === 'string' && method !== 'thread/status/changed' &&
        (params.threadId === this.active?.threadId || params.threadId === this.goalTurn?.threadId ||
         method === 'turn/started' && params.threadId === this.threadId && this.settings.mayRunGoal?.(params.threadId))) {
      this.lastActivity = Date.now()
    }
    if (method === 'thread/tokenUsage/updated' && params.threadId === this.threadId) {
      const usage = object(params.tokenUsage)
      const usedTokens = object(usage.last).totalTokens
      const windowTokens = usage.modelContextWindow
      if (typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens >= 0
          && typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0) {
        this.usage = { usedTokens, windowTokens }
      }
    }
    const observedId = typeof params.turnId === 'string' ? params.turnId : object(params.turn).id
    if (method === 'turn/started' && typeof observedId === 'string' && typeof params.threadId === 'string' &&
        params.threadId === this.threadId && this.settings.mayRunGoal?.(params.threadId) &&
        (!this.active || !!this.active.id && this.active.id !== observedId)) {
      const threadId = params.threadId
      if (this.goalTurn?.id !== observedId) {
        this.goalTurn = {
          threadId, id: observedId, lastText: '', stop: false,
          fileChanges: new Map(), children: new Map(), approvedPolicy: new Map(),
          finish: result => {
            if (this.goalTurn?.id === observedId) this.goalTurn = undefined
            this.settings.onGoalResult?.(threadId, result)
          },
        }
      }
    }
    const active = this.goalTurn?.id === observedId ? this.goalTurn : this.active
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId && typeof observedId === 'string') {
      for (const owner of this.runningTurns()) {
        const child = owner.children.get(params.threadId)
        if (method === 'turn/started' && !child && owner.children.size < 128) {
          owner.children.set(params.threadId, { id: observedId, threadId: params.threadId, fileChanges: new Map() })
        } else if (child?.id === observedId) {
          if (method === 'item/started') recordFileChange(child, object(params.item))
          if (method === 'turn/completed') owner.children.delete(params.threadId)
        }
      }
    }
    if (!active || params.threadId !== active.threadId) return
    if (method === 'turn/started') {
      const id = object(params.turn).id
      if (!active.id && typeof id === 'string') this.setTurnId(active, id)
      this.settings.onProgress?.('turn')
    } else if (method === 'item/started') {
      if (active.id && params.turnId !== active.id) return
      const item = object(params.item)
      if (typeof item.type === 'string') this.settings.onProgress?.(item.type)
      recordFileChange(active, item)
    } else if (method === 'item/completed') {
      if (active.id && params.turnId !== active.id) return
      const item = object(params.item)
      if (item.type !== 'agentMessage' || item.delivery === 'async' || typeof item.text !== 'string') return
      if (item.phase === 'final_answer') active.finalText = item.text
      else if (item.phase !== 'commentary') active.lastText = item.text
    } else if (method === 'turn/completed') {
      const turn = object(params.turn)
      if (active.id && turn.id !== active.id) return
      const status = turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed'
      active.finish({ status, text: active.finalText ?? active.lastText })
    }
  }

  private setTurnId(turn: Turn, id: string): void {
    turn.id = id
    if (turn.stop) {
      void this.rpc.request('turn/interrupt', { threadId: turn.threadId, turnId: id }).catch(() => undefined)
    }
  }

  private runningTurns(): Turn[] {
    return [this.active, this.goalTurn].filter((turn): turn is Turn => !!turn?.id && !turn.stop)
  }

  private async approveInTurn(
    execution: Execution, request: ApprovalRequest, approve: NonNullable<Settings['approve']>, signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal?.aborted) return 'cancel'
    if (request.target.length > 3000) return approve(request, signal)
    let state = this.turnApprovals.get(execution)
    if (!state) {
      state = { pending: new Set(), declined: new Set() }
      this.turnApprovals.set(execution, state)
    }

    const key = JSON.stringify([request.kind, request.cwd, request.dedupeKey ?? request.target])
    if (state.pending.has(key) || state.declined.has(key)) return 'decline'
    state.pending.add(key)
    try {
      const decision = await approve(request, signal)
      if (decision === 'decline' && !signal?.aborted) {
        if (state.declined.size >= 128) state.declined.delete(state.declined.values().next().value!)
        state.declined.add(key)
      }
      return decision
    } finally {
      state.pending.delete(key)
    }
  }

  async requestPolicyApproval({ operation, ...request }: PolicyApprovalRequest): Promise<ApprovalDecision> {
    const approve = this.settings.approve
    if (!approve) return 'decline'
    if (!operation || !request.cwd) return approve(request)
    const matches = this.runningTurns().filter(turn => turn.threadId === operation.threadId)
      .flatMap(owner => [owner, ...owner.children.values()].filter(execution => execution.id === operation.turnId)
        .map(execution => ({ owner, execution })))
    const scope = matches.length === 1 ? matches[0] : await this.approvalExecution(operation.threadId, operation.turnId)
    if (!scope) return approve(request)
    const { owner, execution } = scope
    const canRecordReceipt = owner.threadId === operation.threadId
    const decision = await this.approveInTurn(execution, canRecordReceipt ? {
      ...request,
      notice: request.kind === 'command'
        ? 'Если эта же команда потребует нативное разрешение, её можно один раз выполнить вне песочницы.'
        : 'Если этот же набор изменений потребует нативное разрешение, его можно один раз применить вне песочницы.',
    } : request, approve)
    if (!this.runningTurns().includes(owner) ||
        (owner !== execution && owner.children.get(execution.threadId) !== execution)) return 'cancel'
    if (decision === 'accept' && canRecordReceipt && owner.approvedPolicy.size < 128) {
      owner.approvedPolicy.set(JSON.stringify([execution.threadId, operation.turnId, operation.itemId]), {
        kind: request.kind, target: request.target, cwd: request.cwd, until: Date.now() + 30_000,
      })
    }
    return decision
  }

  private async approvalExecution(threadId: string, turnId: string): Promise<{ owner: Turn; execution: Execution } | undefined> {
    const candidates = this.runningTurns()
    const own = candidates.find(turn => turn.threadId === threadId && turn.id === turnId)
    if (own) return { owner: own, execution: own }
    const observing = candidates.filter(turn => turn.children.get(threadId)?.id === turnId)
    if (!observing.length) return
    const read = await this.rpc.request('thread/read', { threadId, includeTurns: false }).catch(() => undefined)
    const thread = object(read?.thread)
    const spawn = object(object(object(thread.source).subAgent).thread_spawn)
    const parents = observing.filter(turn => thread.sessionId === turn.threadId &&
      this.runningTurns().includes(turn) && turn.children.get(threadId)?.id === turnId)
    if (parents.length !== 1 || thread.id !== threadId || thread.cwd !== this.settings.cwd ||
        typeof thread.parentThreadId !== 'string' || spawn.parent_thread_id !== thread.parentThreadId ||
        typeof spawn.depth !== 'number' || !Number.isSafeInteger(spawn.depth) || spawn.depth < 1 ||
        (spawn.depth === 1 && thread.parentThreadId !== parents[0]!.threadId)) return
    const owner = parents[0]!
    return { owner, execution: owner.children.get(threadId)! }
  }

  private async requestApproval({ id, method, params }: CodexServerRequest) {
    if (method === 'item/tool/call') {
      const { threadId, turnId, callId, namespace, tool, arguments: args } = params
      const run = this.settings.chatAction
      const turn = this.runningTurns().find(turn => turn.threadId === threadId && turn.id === turnId)
      if (!run || !turn || namespace !== null || tool !== agentChatTool.name ||
          typeof callId !== 'string' || !/^[\w.:-]{1,128}$/u.test(callId)) return
      return this.withServerRequest(id, turn.threadId, signal =>
        run(JSON.stringify([threadId, turnId, callId]), args, () => !signal.aborted && this.runningTurns().includes(turn)))
    }
    if (method === 'item/tool/requestUserInput') {
      const current = this.goalTurn?.id === params.turnId ? this.goalTurn : this.active
      if (!current || current.stop || current.threadId !== params.threadId || current.id !== params.turnId) return { answers: {} }
      const ask = this.settings.ask
      return { answers: ask
        ? await this.withServerRequest(id, current.threadId, signal => ask(params.questions, signal))
        : {} }
    }
    if (method === 'mcpServer/elicitation/request') {
      const request = parseMcpApproval(params)
      const approve = this.settings.approve
      if (!request || !approve) return { action: 'cancel' }
      const decision = await this.withServerRequest(id, request.threadId, async signal => {
        const scope = await this.approvalExecution(request.threadId, request.turnId)
        if (signal.aborted || !scope) return 'cancel'
        const { owner, execution } = scope
        const decision = await this.approveInTurn(execution, request.operation, approve, signal)
        if (signal.aborted || !this.runningTurns().includes(owner) ||
            (owner !== execution && owner.children.get(execution.threadId) !== execution)) return 'cancel'
        return decision
      }, request.turnId).catch(() => 'cancel')
      return decision === 'accept' ? { action: 'accept', content: {} } : { action: decision }
    }
    const commandRequest = method === 'item/commandExecution/requestApproval'
    if (!commandRequest && method !== 'item/fileChange/requestApproval') return undefined

    const approve = this.settings.approve
    if (!approve || typeof params.turnId !== 'string' || typeof params.threadId !== 'string' || typeof params.itemId !== 'string') {
      return { decision: 'decline' }
    }

    const stdin = commandRequest && params.kind === 'writeStdin'
    const network = commandRequest && params.networkApprovalContext != null
    const destination = network ? networkDestination(params.networkApprovalContext) : undefined
    if (commandRequest && (params.additionalPermissions != null ||
        (params.kind && params.kind !== 'command' && !stdin))) return { decision: 'decline' }
    if ((network || stdin) && ((params.environmentId != null && params.environmentId !== 'local') ||
        (params.availableDecisions !== undefined &&
          (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept'))))) {
      return { decision: 'decline' }
    }
    if (network && (!destination || stdin)) return { decision: 'decline' }
    if (stdin) {
      // App Server 0.171 serializes these exact arguments with shlex_join.
      if (typeof params.approvalId !== 'string' || !/^[\w.:-]{1,128}$/u.test(params.approvalId) ||
          typeof params.command !== 'string' || !/^write_stdin --session-id \d{1,10} [\s\S]+$/u.test(params.command)) {
        return { decision: 'decline' }
      }
    } else if (commandRequest && !network && params.approvalId != null) return { decision: 'decline' }
    if (!commandRequest && params.grantRoot) return { decision: 'decline' }
    const scope = await this.approvalExecution(params.threadId, params.turnId)
    if (!scope) return { decision: 'decline' }
    const { owner, execution } = scope
    const changes = commandRequest ? undefined : execution.fileChanges.get(params.itemId)
    const target = destination
      ? destination + (typeof params.command === 'string' && params.command.trim() ? '\n\n' + params.command : '')
      : commandRequest ? params.command
      : changes?.map(change => change.path + '\n' + change.diff).join('\n')
    if (typeof target !== 'string' || !target.trim()) return { decision: 'decline' }
    if (!network && !stdin && (params.environmentId == null || params.environmentId === 'local')) {
      const key = JSON.stringify([params.threadId, params.turnId, params.itemId])
      const receipt = owner.approvedPolicy.get(key)
      owner.approvedPolicy.delete(key)
      if (receipt && receipt.until >= Date.now()) {
        const matches = commandRequest
          ? receipt.kind === 'command' && receipt.cwd === params.cwd && sameShellCommand(target, receipt.target)
          : receipt.kind === 'file' && changes !== undefined && sameFilePatch(receipt.target, receipt.cwd, changes)
        if (matches) return { decision: 'accept' }
      }
    }
    if (this.settings.riskyApprovals && commandRequest && !network && !stdin &&
        (params.environmentId == null || params.environmentId === 'local') &&
        (params.availableDecisions == null || Array.isArray(params.availableDecisions) && params.availableDecisions.includes('accept')) &&
        isRoutineServerCommand(target, params.cwd)) {
      return { decision: 'accept' }
    }
    const decision = await this.withServerRequest(id, execution.threadId, signal => this.approveInTurn(execution, {
      kind: network ? 'network' : stdin ? 'stdin' : commandRequest ? 'command' : 'file',
      target,
      ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
      ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    }, approve, signal)).catch(() => 'decline' as const)
    return { decision: this.runningTurns().includes(owner) &&
      (owner === execution || owner.children.get(execution.threadId) === execution)
      ? stdin && decision === 'decline' ? 'cancel' : decision : 'cancel' }
  }

  private async withServerRequest<T>(
    id: number | string, threadId: string, run: (signal: AbortSignal) => Promise<T>, turnId?: string,
  ): Promise<T> {
    const abort = new AbortController()
    const request = { threadId, turnId, abort }
    this.pendingServerRequests.set(id, request)
    try { return await run(abort.signal) } finally {
      if (this.pendingServerRequests.get(id) === request) this.pendingServerRequests.delete(id)
    }
  }
}
