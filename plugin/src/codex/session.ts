import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CodexRpc, object, type CodexEvent, type CodexServerRequest } from './rpc.js'

export type ApprovalDecision = 'accept' | 'decline' | 'cancel'
export type ApprovalRequest = {
  kind: 'command' | 'file'
  target: string
  cwd?: string
  reason?: string
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
  approve?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  ask?: (questions: unknown) => Promise<Record<string, { answers: string[] }>>
}

type Result = { status: 'completed' | 'interrupted' | 'failed'; text: string }
type SessionStatus = {
  hasThread: boolean
  model: string | undefined
  usage: { usedTokens: number; windowTokens: number } | undefined
}

type Turn = {
  threadId: string
  id?: string
  stop: boolean
  lastText: string
  finalText?: string
  fileChanges: Map<string, string[]>
  finish: (result: Result) => void
}

export class CodexSession {
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
    const result = await this.rpc.request('thread/read', { threadId: id, includeTurns: false })
    const thread = object(result.thread)
    if (thread.id !== id) return false
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
    const threadId = await this.attachGoalThread()
    const response = await this.rpc.request('thread/goal/get', { threadId })
    return response.goal ? object(response.goal) : null
  }

  async setGoal(threadId: string, status: 'active' | 'paused', objective?: string,
    origin: 'user' | 'automatic' = 'user'): Promise<void> {
    if (threadId !== this.threadId) throw new Error('Wrong goal thread')
    await this.rpc.request('thread/goal/set', {
      threadId, status, origin,
      ...(objective ? { objective, tokenBudget: 60000 } : {}),
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
      const turn: Turn = { threadId, stop: false, lastText: '', fileChanges: new Map(), finish }
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
      : await this.rpc.request('thread/start', options)
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
          threadId, id: observedId, lastText: '', stop: false, fileChanges: new Map(),
          finish: result => {
            if (this.goalTurn?.id === observedId) this.goalTurn = undefined
            this.settings.onGoalResult?.(threadId, result)
          },
        }
      }
    }
    const active = this.goalTurn?.id === observedId ? this.goalTurn : this.active
    if (!active || params.threadId !== active.threadId) return
    if (method === 'turn/started') {
      const id = object(params.turn).id
      if (!active.id && typeof id === 'string') this.setTurnId(active, id)
      this.settings.onProgress?.('turn')
    } else if (method === 'item/started') {
      if (active.id && params.turnId !== active.id) return
      const item = object(params.item)
      if (typeof item.type === 'string') this.settings.onProgress?.(item.type)
      if (item.type === 'fileChange' && typeof item.id === 'string' && Array.isArray(item.changes)) {
        const changes = item.changes.flatMap(entry => {
          const change = object(entry)
          return typeof change.path === 'string' && typeof change.diff === 'string'
            ? [change.path + '\n' + change.diff] : []
        })
        if (changes.length === item.changes.length) active.fileChanges.set(item.id, changes)
      }
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

  private async requestApproval({ method, params }: CodexServerRequest) {
    if (method === 'item/tool/requestUserInput') {
      const current = this.goalTurn?.id === params.turnId ? this.goalTurn : this.active
      if (!current || current.stop || current.threadId !== params.threadId || current.id !== params.turnId) return { answers: {} }
      return { answers: await this.settings.ask?.(params.questions) ?? {} }
    }
    const commandRequest = method === 'item/commandExecution/requestApproval'
    if (!commandRequest && method !== 'item/fileChange/requestApproval') return undefined

    const current = this.goalTurn?.id === params.turnId ? this.goalTurn : this.active
    const approve = this.settings.approve
    if (!approve || !current || current.stop || typeof params.turnId !== 'string'
        || params.threadId !== current.threadId || (current.id && params.turnId !== current.id)) {
      return { decision: 'decline' }
    }

    if (commandRequest && (params.networkApprovalContext || (params.kind && params.kind !== 'command'))) {
      return { decision: 'decline' }
    }
    if (!commandRequest && params.grantRoot) return { decision: 'decline' }
    const target = commandRequest ? params.command
      : typeof params.itemId === 'string' ? current.fileChanges.get(params.itemId)?.join('\n') : undefined
    if (typeof target !== 'string' || !target.trim()) return { decision: 'decline' }
    const decision = await approve({
      kind: commandRequest ? 'command' : 'file',
      target,
      ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
      ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    }).catch(() => 'decline' as const)
    return { decision: (this.active === current || this.goalTurn === current) && !current.stop ? decision : 'cancel' }
  }
}
