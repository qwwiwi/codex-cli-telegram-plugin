import type { AppConfig } from '../config.js'
import { redactSecrets } from '../safety/redact.js'
import { buildActivityDetail, buildHumanizedActivityLine, type ActivityCall } from '../status/activity-renderer.js'
import type { StatusHandle, StatusManager, StatusState } from '../status/status-manager.js'
import { object, type CodexEvent } from './rpc.js'

type Settings = AppConfig['status']
const REPOST_DELAY_MS = 120
// Codex app-server v2 streams a reasoning item's summary as parts (summaryIndex) of text deltas.
const REASONING_PART = 'item/reasoning/summaryPartAdded'
const REASONING_DELTA = 'item/reasoning/summaryTextDelta'

function activityCall(item: ReturnType<typeof object>, clean: (text: string) => string): ActivityCall | undefined {
  const tool = typeof item.tool === 'string' ? clean(item.tool) : ''
  switch (item.type) {
    case 'commandExecution': {
      const command = typeof item.command === 'string' ? clean(item.command) : ''
      const display = command.replace(/^\S*(?:bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/, '$2')
      return {
        toolName: 'Bash',
        detail: buildActivityDetail('Bash', { command: display }),
        humanized: buildHumanizedActivityLine('Bash', { command: display }),
      }
    }
    case 'fileChange': {
      const path = Array.isArray(item.changes) ? object(item.changes[0]).path : undefined
      const file_path = typeof path === 'string' ? clean(path) : ''
      return { toolName: 'Edit', detail: 'editing files', humanized: buildHumanizedActivityLine('Edit', { file_path }) }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { toolName: 'Tool', detail: tool ? 'tool: ' + tool : 'calling a tool' }
    case 'collabAgentToolCall':
      return { toolName: 'Agent', detail: tool ? 'background agent: ' + tool : 'background agent' }
    case 'webSearch':
      return { toolName: 'WebSearch', detail: 'searching the web' }
    case 'contextCompaction':
      return { toolName: 'Compact', detail: 'compacting context' }
    case 'sleep':
      return { toolName: 'Sleep', detail: 'waiting' }
    default:
      return undefined
  }
}

export class CodexWorkStatus {
  private latestChatMessage = 0
  private repostTimer: ReturnType<typeof setTimeout> | undefined
  private foreground = false
  private closed = false
  private native = new Set<string>()
  private children = new Map<string, number>()
  private childRevision = 0
  private checkingChildren = false
  private commands = new Map<string, string>()
  private backgroundCommands = new Set<string>()
  private calls = new Map<string, ActivityCall>()
  private thought = ''
  // The summary part being streamed now; a new item or part starts it over.
  private reasoning = { item: '', index: -1, text: '' }
  private thoughtTimer: ReturnType<typeof setTimeout> | undefined
  private lastThoughtAt = Number.NEGATIVE_INFINITY
  private replyTo: number | undefined
  private startedAt = 0
  private lastActivityAt = 0
  private generation = 0
  private renderedGeneration = 0
  private handle: StatusHandle | undefined
  private dirty = false
  private pending: Promise<void> | undefined

  constructor(
    private manager: Pick<StatusManager, 'start' | 'update' | 'complete' | 'isActive' | 'activeMessageId'>,
    private chatId: string,
    private config: Settings,
    private secrets: readonly string[],
    private now: () => number = Date.now,
  ) {}

  get busy(): boolean {
    return !this.closed && (this.foreground || this.native.size > 0 || this.children.size > 0 || this.commands.size > 0)
  }

  recentlyBusy(thresholdMs: number): boolean {
    return this.busy && this.now() - this.lastActivityAt < thresholdMs
  }

  get hasWorker(): boolean {
    return this.children.size > 0 || this.commands.size > 0
  }

  get hasBackground(): boolean {
    return this.children.size > 0 || this.backgroundCommands.size > 0
  }

  begin(messageId?: number): void {
    if (!this.busy) this.newActivity(messageId)
    else this.lastActivityAt = this.now()
    this.foreground = true
    this.render()
  }

  finish(): void {
    this.foreground = false
    this.render()
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.repostTimer)
    clearTimeout(this.thoughtTimer)
    this.render()
    await this.pending
  }

  repost(messageId: number): void {
    if (!this.busy || !Number.isSafeInteger(messageId) ||
        messageId <= Math.max(this.latestChatMessage, this.manager.activeMessageId(this.chatId))) return
    this.latestChatMessage = messageId
    if (this.repostTimer !== undefined) return
    this.repostTimer = setTimeout(() => {
      this.repostTimer = undefined
      if (this.busy) this.render()
    }, REPOST_DELAY_MS)
    this.repostTimer.unref()
  }

  async reconcileChildren(isIdle: (threadId: string) => Promise<boolean>): Promise<void> {
    if (this.closed || this.foreground || this.checkingChildren || !this.children.size) return
    this.checkingChildren = true
    try {
      await Promise.all([...this.children].map(async ([id, revision]) => {
        let idle: boolean
        try {
          idle = await isIdle(id)
        } catch {
          return
        }
        // A child can start new work while its thread/read is in flight.
        if (idle && !this.closed && !this.foreground && this.children.get(id) === revision) {
          this.children.delete(id)
          this.native.delete(id)
          this.render()
        }
      }))
    } finally {
      this.checkingChildren = false
    }
  }

  receive({ method, params }: CodexEvent, currentThread: string | null): void {
    if (this.closed || typeof params.threadId !== 'string') return
    // Aggregate thread status may arrive after the turn that produced it.
    if (!['turn/started', 'turn/completed', 'thread/closed', 'item/started', 'item/completed',
      REASONING_PART, REASONING_DELTA].includes(method)) return
    const thread = params.threadId
    if (thread !== currentThread && !this.children.has(thread) && !this.native.has(thread) &&
        ![...this.commands.values()].includes(thread)) return
    const wasBusy = this.busy
    if (wasBusy) this.lastActivityAt = this.now()
    let update = false
    const item = object(params.item)
    if (method === REASONING_PART || method === REASONING_DELTA) {
      // Only the owner turn's own reasoning; a subagent's would interleave with it.
      if (!this.busy || thread !== currentThread || !this.config.thoughts?.enabled || typeof params.itemId !== 'string') return
      const index = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0
      if (params.itemId !== this.reasoning.item || index !== this.reasoning.index) {
        this.reasoning = { item: params.itemId, index, text: '' }
      }
      if (method === REASONING_DELTA && typeof params.delta === 'string') {
        this.reasoning.text += params.delta
        // Hold back the word still arriving: half of a secret does not match the redactor yet.
        this.showThought(this.reasoning.text.replace(/\S+$/, ''), true)
      }
      return
    }
    if (method === 'turn/started') {
      this.native.add(thread)
      if (this.children.has(thread)) this.children.set(thread, ++this.childRevision)
      update = wasBusy !== this.busy
    } else if (method === 'turn/completed' || method === 'thread/closed') {
      this.native.delete(thread)
      if (method === 'thread/closed' || thread !== currentThread) this.children.delete(thread)
      if (method === 'thread/closed' || object(params.turn).status === 'interrupted') {
        for (const [id, owner] of this.commands) if (owner === thread) {
          this.commands.delete(id)
          this.backgroundCommands.delete(id)
        }
      } else {
        for (const [id, owner] of this.commands) if (owner === thread) this.backgroundCommands.add(id)
      }
      update = wasBusy !== this.busy
      // The turn's thoughts end with it, even while a background command keeps the bubble.
      if (thread === currentThread && (this.thought || this.reasoning.item)) {
        this.thought = ''
        this.reasoning = { item: '', index: -1, text: '' }
        update = true
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
        if (item.kind === 'started' || item.kind === 'interacted') {
          this.children.set(item.agentThreadId, ++this.childRevision)
        }
        if (item.kind === 'completed' || item.kind === 'interrupted') {
          this.children.delete(item.agentThreadId)
          this.native.delete(item.agentThreadId)
        }
        update = wasBusy !== this.busy
      }
      if (item.type === 'collabAgentToolCall') {
        for (const [id, raw] of Object.entries(object(item.agentsStates))) {
          const status = object(raw).status
          if (status === 'running' || status === 'pendingInit') this.children.set(id, ++this.childRevision)
          else if (typeof status === 'string') {
            this.children.delete(id)
            this.native.delete(id)
          }
        }
        update = wasBusy !== this.busy
      }
      if (item.type === 'commandExecution' && typeof item.id === 'string') {
        if (typeof item.processId === 'string' && item.status === 'inProgress') this.commands.set(item.id, thread)
        else if (method === 'item/completed') {
          this.commands.delete(item.id)
          this.backgroundCommands.delete(item.id)
        }
        update = wasBusy !== this.busy
      }
      if (this.busy && !wasBusy) this.newActivity()
      if (this.busy && typeof item.id === 'string' && method === 'item/started') {
        const call = activityCall(item, text => this.clean(text))
        if (call) {
          this.calls.set(item.id, call)
          if (this.calls.size > 10) this.calls.delete(this.calls.keys().next().value!)
          update = true
        }
      }
      if (this.busy && method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'commentary'
          && this.config.thoughts?.enabled && typeof item.text === 'string') {
        this.thought = this.shapeThought(item.text)
        update = true
      }
      if (this.busy && method === 'item/completed' && item.type === 'reasoning' && thread === currentThread
          && this.config.thoughts?.enabled && Array.isArray(item.summary)) {
        const last: unknown = item.summary.at(-1)
        this.reasoning = { item: '', index: -1, text: '' }
        if (typeof last === 'string' && last.trim()) this.showThought(last, true)
      }
      if (update) this.render()
      return
    }
    if (this.busy && !wasBusy) this.newActivity()
    if (update) this.render()
  }

  // Code-stripped, redacted tail of a narration or reasoning summary, bounded by max_lines / max_chars.
  private shapeThought(text: string, plain = false): string {
    const { max_lines, max_chars } = this.config.thoughts ?? { max_lines: 3, max_chars: 280 }
    // Redact the whole text before splitting: a credential folded onto the line after its
    // header (`Bearer\n  <token>`) only matches while the header is still attached.
    const stripped = redactSecrets(text, this.secrets).replace(/```[\s\S]*?```/g, ' ')
    // Reasoning summaries head each part with a **bold** title; the bubble is plain text.
    return (plain ? stripped.replace(/\*\*/g, '') : stripped).split(/\r?\n/)
      .map(line => this.clean(line)).filter(Boolean)
      .slice(-max_lines).join('\n').slice(-max_chars)
  }

  // Streamed reasoning changes many times a second: edit at most once per read_throttle_ms and
  // always end on the latest text. Each edit still goes through the shared Telegram rate limiter.
  private showThought(text: string, plain: boolean): void {
    const thought = this.shapeThought(text, plain)
    if (!thought || thought === this.thought) return
    this.thought = thought
    const wait = this.lastThoughtAt + (this.config.thoughts?.read_throttle_ms ?? 0) - this.now()
    if (wait > 0) {
      this.thoughtTimer ??= setTimeout(() => {
        this.thoughtTimer = undefined
        this.lastThoughtAt = this.now()
        if (this.busy) this.render()
      }, wait)
      this.thoughtTimer.unref()
      return
    }
    clearTimeout(this.thoughtTimer)
    this.thoughtTimer = undefined
    this.lastThoughtAt = this.now()
    this.render()
  }

  private clean(text: string): string {
    return redactSecrets(text, this.secrets).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim()
  }

  private newActivity(replyTo?: number): void {
    this.generation++
    this.replyTo = replyTo
    this.startedAt = this.now()
    this.lastActivityAt = this.startedAt
    this.thought = ''
    this.reasoning = { item: '', index: -1, text: '' }
    this.calls.clear()
  }

  private render(): void {
    if (!this.config.enabled) return
    this.dirty = true
    if (!this.pending) {
      this.pending = this.flush().finally(() => {
        this.pending = undefined
        if (this.dirty) this.render()
      })
    }
  }

  private async flush(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      try {
        const bubbleId = this.manager.activeMessageId(this.chatId)
        const shouldMove = this.busy && this.repostTimer === undefined && bubbleId > 0 && bubbleId < this.latestChatMessage
        if (this.handle && (!this.busy || this.renderedGeneration !== this.generation || shouldMove)) {
          this.handle = undefined
          await this.manager.complete(this.chatId, shouldMove)
        }
        if (!this.busy) continue
        const state: StatusState = { kind: 'activity', snapshot: {
          startedAtMs: this.startedAt,
          phase: this.calls.size ? 'tool' : 'reasoning',
          calls: [...this.calls.values()],
          ...(this.thought ? { thought: this.thought } : {}),
        } }
        if (!this.handle || !this.manager.isActive(this.chatId)) {
          this.renderedGeneration = this.generation
          this.handle = await this.manager.start(this.chatId, this.replyTo,
            this.config.suppress_typing_bubble ? { kind: 'typing' } : state)
          if (this.config.suppress_typing_bubble && this.busy) await this.manager.update(this.handle, state)
        } else {
          await this.manager.update(this.handle, state)
        }
      } catch {
        // The Telegram status is best effort, independent of command and reply delivery.
      }
    }
  }
}
