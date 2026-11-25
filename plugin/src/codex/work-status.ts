import type { AppConfig } from '../config.js'
import { redactSecrets } from '../safety/redact.js'
import { buildActivityDetail, buildHumanizedActivityLine, type ActivityCall } from '../status/activity-renderer.js'
import type { StatusHandle, StatusManager, StatusState } from '../status/status-manager.js'
import { object, type CodexEvent } from './rpc.js'

type Settings = AppConfig['status']

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
  private foreground = false
  private closed = false
  private native = new Set<string>()
  private children = new Set<string>()
  private commands = new Map<string, string>()
  private backgroundCommands = new Set<string>()
  private calls = new Map<string, ActivityCall>()
  private thought = ''
  private replyTo: number | undefined
  private startedAt = 0
  private lastActivityAt = 0
  private generation = 0
  private renderedGeneration = 0
  private handle: StatusHandle | undefined
  private dirty = false
  private pending: Promise<void> | undefined

  constructor(
    private manager: Pick<StatusManager, 'start' | 'update' | 'complete' | 'isActive'>,
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
    this.render()
    await this.pending
  }

  receive({ method, params }: CodexEvent, currentThread: string | null): void {
    if (this.closed || typeof params.threadId !== 'string') return
    if (!['turn/started', 'turn/completed', 'thread/status/changed', 'thread/closed',
      'item/started', 'item/completed'].includes(method)) return
    const thread = params.threadId
    if (thread !== currentThread && !this.children.has(thread) && !this.native.has(thread) &&
        ![...this.commands.values()].includes(thread)) return
    const wasBusy = this.busy
    if (wasBusy) this.lastActivityAt = this.now()
    let update = false
    const item = object(params.item)
    if (method === 'turn/started' || method === 'thread/status/changed') {
      const active = method === 'turn/started' || object(params.status).type === 'active'
      if (active) this.native.add(thread)
      else this.native.delete(thread)
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
    } else if (method === 'item/started' || method === 'item/completed') {
      if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
        if (item.kind === 'started' || item.kind === 'interacted') this.children.add(item.agentThreadId)
        if (item.kind === 'completed' || item.kind === 'interrupted') {
          this.children.delete(item.agentThreadId)
          this.native.delete(item.agentThreadId)
        }
        update = wasBusy !== this.busy
      }
      if (item.type === 'collabAgentToolCall') {
        for (const [id, raw] of Object.entries(object(item.agentsStates))) {
          const status = object(raw).status
          if (status === 'running' || status === 'pendingInit') this.children.add(id)
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
        this.thought = item.text.replace(/```[\s\S]*?```/g, ' ').split(/\r?\n/)
          .map(line => this.clean(line)).filter(Boolean)
          .slice(-this.config.thoughts.max_lines).join('\n').slice(-this.config.thoughts.max_chars)
        update = true
      }
      if (update) this.render()
      return
    }
    if (this.busy && !wasBusy) this.newActivity()
    if (update) this.render()
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
        if (this.handle && (!this.busy || this.renderedGeneration !== this.generation)) {
          this.handle = undefined
          await this.manager.complete(this.chatId)
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
