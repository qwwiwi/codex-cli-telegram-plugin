import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { CodexRpc, object, type CodexEvent, type CodexServerRequest } from './rpc.js'
import { sameFilePatch, type NativeFileChange } from './file-approval.js'
import { agentTools, type AgentChatActions } from './chat-actions.js'
import type { PreviewToolResult } from './render-preview.js'
import { isRoutineServerCommand } from './server-approval-policy.js'
import { parseMcpApproval } from './mcp-approval.js'
import { parseRateLimits, type CodexLimitWindow } from '../status/codex-limits.js'
import { publicThreadParams, publicTurnParams, type PublicWebSearch } from './public-profile.js'
import { publicSkillsProblem, type PublicAllow } from './multiuser-readiness.js'

export type ApprovalDecision = 'accept' | 'decline' | 'cancel'

export type ApprovalRequest = {
  kind: 'command' | 'file' | 'network' | 'stdin' | 'mcp'
  target: string
  cwd?: string
  reason?: string
  notice?: string
  dedupeKey?: string
}
// Codex sandbox modes the bridge may request. 'danger-full-access' is meant only
// for a dedicated unprivileged OS user; with approvals off it means no cards.
export type CodexSandboxMode = 'workspace-write' | 'danger-full-access'

// Per-turn sandbox override of the Codex app-server (v2 TurnStartParams.sandboxPolicy,
// schema of `codex app-server generate-ts`). Every field is required: a partial
// object is rejected by the server, so it must also fail tsc here.
// The bridge never sends externalSandbox; its NetworkAccess enum values are not
// pinned here: <<PLACEHOLDER: NetworkAccess literal values from the generated schema>>.
export type CodexNetworkAccess = string
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: CodexNetworkAccess }
  | {
    type: 'workspaceWrite'
    writableRoots: string[]
    networkAccess: boolean
    excludeTmpdirEnvVar: boolean
    excludeSlashTmp: boolean
  }

// Per-turn options. An untrusted turn answers input the owner did not write
// (another agent): it runs in workspace-write without approvals and never
// reaches owner approval cards, owner questions or Telegram chat actions.
export interface TurnOptions {
  untrusted?: boolean
}

// A model from the App Server's model/list with the reasoning efforts it accepts.
export interface CodexModel {
  name: string
  default: boolean
  efforts: string[]
  defaultEffort?: string
}

const effortName = /^[a-z]{1,16}$/
// A member or guest thread: its own folder, the role instructions, and the
// thread ID saved for that chat key (undefined starts a fresh thread).
export interface PublicTurnProfile {
  cwd: string
  instructions: string
  threadId?: string
  // The role whose public app-server runs this turn (the router needs it; a session ignores it).
  role?: 'member' | 'guest'
  // Called once the thread is open, before the turn starts (a timeout can then interrupt it).
  onThread?: (threadId: string) => void
  // Asked right before turn/start: true (access revoked, lane stopped) ends it interrupted without a turn.
  cancelled?: () => boolean
}

/** What the startup probe read from a fresh public thread. */
export interface PublicProbe {
  reply: Record<string, unknown>
  /** mcpServerStatus/list, every nextCursor page joined; {} when Codex refused a page (fails the check). */
  mcp: Record<string, unknown>
  /** skills/list; absent when Codex refused it (fails the check). */
  skills?: Record<string, unknown>
  /** app/list; absent when Codex refused it (fails the check). */
  apps?: Record<string, unknown>
  /** config/read of the public home (effective features); absent when Codex refused it (fails the check). */
  config?: Record<string, unknown>
}

/** Who a Codex thread belongs to, as the permission hook asks it. */
export type ThreadRole = 'owner' | 'agent' | 'public' | 'unknown'

// Item types that are conversation, not a tool call.
const conversationItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'])

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
  // Owner-chosen reasoning effort (turn/start `effort`); undefined: the model default.
  selectedEffort?: () => string | undefined
  // Ask for reasoning summaries (turn/start `summary: "auto"`) so the working bubble can show them.
  reasoningSummary?: boolean
  onThread?: (threadId: string) => void
  onProgress?: (kind: string, item?: Record<string, unknown>) => void
  onTurnProgressEnd?: (status: Result['status']) => void
  onActivity?: (event: CodexEvent, currentThread: string | null) => void
  mayRunGoal?: (threadId: string) => boolean
  onGoalResult?: (threadId: string, result: Result) => void
  approve?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>
  riskyApprovals?: boolean
  sandbox?: CodexSandboxMode
  ask?: (questions: unknown, signal?: AbortSignal) => Promise<Record<string, { answers: string[] }>>
  // `tool` is one of agentTools: telegram_action, a component tool or render_preview (text and one PNG).
  chatAction?: (key: string, args: unknown, current: () => boolean, tool: string) =>
    Promise<Awaited<ReturnType<AgentChatActions['call']>> | PreviewToolResult>
  widgetsAvailable?: () => boolean
  // Operational notes without user content, e.g. a fallback the bridge took.
  onWarning?: (message: string) => void
  // Every thread/tokenUsage/updated of any thread (main, side, subagent): the prompt-cache counters.
  onTokenUsage?: (threadId: string, tokenUsage: unknown) => void
  /**
   * Called for the thread the session adopts as its main conversation; idempotent; may throw. Resolves
   * false when nothing could be registered yet (e.g. memory is off): the next turn tries again.
   */
  onMain?: (threadId: string) => Promise<boolean>
  /** Wraps the thread/start, thread/resume or thread/fork that opens the main conversation. */
  aroundMainOpen?: <T>(open: () => Promise<T>) => Promise<T>
  // Public app-server only: `web_search` of its threads (default disabled; live for members that have it).
  publicWebSearch?: PublicWebSearch
  // Public app-server only: the role's allowlist; every newly opened public thread must see exactly
  // these skills (from `home`) in its own folder before its first turn.
  publicAllow?: PublicAllow
}

/** A public thread whose folder or skills are outside its role's allowlist; it never gets a turn. */
class PublicThreadRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicThreadRefused'
  }
}

// Upper bound of mcpServerStatus/list pages the probe follows; more fails the check.
const MCP_STATUS_PAGES = 20

type Result = { status: 'completed' | 'interrupted' | 'failed'; text: string }
type SessionStatus = {
  hasThread: boolean
  model: string | undefined
  // cachePercent: share of the last main request's input read from the prompt cache.
  usage: { usedTokens: number; windowTokens: number; cachePercent?: number } | undefined
}

type Execution = {
  id?: string
  threadId: string
  fileChanges: Map<string, NativeFileChange[]>
}

type Turn = Execution & {
  stop: boolean
  untrusted?: true
  // Tool items (commands, patches, MCP calls...) a public turn started; it should have none.
  toolItems: number
  lastText: string
  finalText?: string
  children: Map<string, Execution>
  approvedPolicy: Map<string, { kind: PolicyApprovalRequest['kind']; target: string; cwd: string; until: number }>
  finish: (result: Result) => void
  // Hook proof turns: called for every command item Codex may have executed (not declined before it ran).
  onCommandRan?: () => void
}

// A command item that may have executed: any numeric exit code (0 or not, a process ran), and any
// result other than declined without an exit code is ambiguous, so it counts as executed (fail closed).
function commandRan(item: Record<string, unknown>): boolean {
  if (item.type !== 'commandExecution') return false
  if (typeof item.exitCode === 'number') return true
  return item.status !== 'declined'
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

// Cached input is part of input in Codex token usage; missing or odd numbers give no share.
function cacheShare(input: unknown, cached: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0 ||
      typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0) return
  return Math.min(100, Math.round(cached / input * 100))
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

export function readSavedMainThread(stateFile: string): string | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (saved !== null && (typeof saved !== 'string' || saved.length === 0)) {
      throw new Error('Invalid Codex thread state')
    }
    return saved
  } catch (error) {
    if (object(error).code !== 'ENOENT') throw error
    return null
  }
}

export class CodexSession {
  private readonly pendingServerRequests = new Map<number | string, {
    threadId: string
    turnId: string | undefined
    abort: AbortController
  }>()
  private readonly turnApprovals = new WeakMap<Execution, { pending: Set<string>; declined: Set<string> }>()
  private readonly rpc: CodexRpc
  private threadId: string | null
  private needsResume: boolean
  // The main thread onMain last accepted; a mismatch is retried by getThread.
  private mainRegistered: string | null = null
  private busy = false
  private stopRequested = false
  private model: string | undefined
  private usage: SessionStatus['usage']
  private lastActivity = Date.now()
  private active: Turn | undefined
  private goalTurn: Turn | undefined
  // Parallel side turns, keyed by their own thread. Side threads never become
  // the main conversation and are never treated as children of a main turn.
  private readonly sides = new Map<string, Turn>()
  // Known side threads and the model each one runs on (undefined: not known).
  private readonly sideThreads = new Map<string, string | undefined>()
  // Owner sides fork the main thread until the App Server refuses a fork once.
  private forkSides = true
  // Last main-thread turn that finished; a fork during a running turn stops there.
  private lastMainTurn: { threadId: string; id: string } | undefined
  // Side turns whose thread is still opening; stopSide() reaches them too.
  private readonly startingSides = new Set<{ stop: boolean }>()
  // Threads whose last turn ran restricted; Codex keeps turn overrides for later turns.
  private readonly restrictedThreads = new Set<string>()
  // Member and guest threads (public lane). They never fork, never become the
  // main thread, and every request from them is declined.
  private readonly publicThreads = new Set<string>()
  private readonly publicTurns = new Map<string, Turn>()
  // Hook proof threads (runHookProof): public too, but never resumed or reused for a chat.
  private readonly proofThreads = new Set<string>()

  constructor(private readonly settings: Settings, onClose: () => void) {
    this.threadId = readSavedMainThread(settings.stateFile)
    this.needsResume = this.threadId !== null

    this.rpc = new CodexRpc(settings.cwd, settings.env, event => this.receive(event), () => {
      this.active?.finish({ status: 'failed', text: '' })
      for (const side of this.sides.values()) side.finish({ status: 'failed', text: '' })
      for (const turn of this.publicTurns.values()) turn.finish({ status: 'failed', text: '' })
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
    const response = await this.mainOpen(() => this.rpc.request('thread/fork', {
      threadId: source, cwd: this.settings.cwd, excludeTurns: true, ...this.permissions(),
    }))
    const id = object(response.thread).id
    if (typeof id !== 'string' || !id || id === source) throw new Error('Codex did not return a forked thread')
    this.saveThread(id)
    await this.registerMain(id)
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

  async models(): Promise<CodexModel[]> {
    const reply = await this.rpc.request('model/list', { limit: 100, includeHidden: false })
    return Array.isArray(reply.data) ? reply.data.map(object)
      .filter(x => typeof x.model === 'string' && x.hidden !== true)
      .map(x => {
        // Only short lowercase names: they go into Telegram callback data and back to turn/start.
        const efforts = Array.isArray(x.supportedReasoningEfforts) ? [...new Set(x.supportedReasoningEfforts
          .map(option => object(option).reasoningEffort)
          .filter((effort): effort is string => typeof effort === 'string' && effortName.test(effort)))] : []
        const fallback = x.defaultReasoningEffort
        return {
          name: x.model as string, default: x.isDefault === true, efforts,
          ...(typeof fallback === 'string' && efforts.includes(fallback) ? { defaultEffort: fallback } : {}),
        }
      }) : []
  }

  async usageLimits(): Promise<CodexLimitWindow[]> {
    return parseRateLimits(await this.rpc.request('account/rateLimits/read', {}))
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

  /** The latest turns of a side thread, oldest first; the main thread and its busy state are untouched. */
  async sideTurns(threadId: string): Promise<unknown[]> {
    if (!threadId || threadId === this.threadId) throw new Error('Not a side thread')
    // The exact shape the root relay admits for thread/turns/list.
    const result = await this.rpc.request('thread/turns/list', {
      threadId, limit: 10, itemsView: 'full', sortDirection: 'desc',
    })
    if (!Array.isArray(result.data)) throw new Error('Codex did not return conversation history')
    return [...result.data].reverse()
  }

  reset(): void {
    if (this.busy) throw new Error('A Codex turn is running')
    this.saveThread(null)
    this.usage = undefined
    this.model = undefined
  }

  async run(text: string, imagePaths: readonly string[] = [], onStarted?: (turnId: string) => void,
    options: TurnOptions = {}): Promise<Result> {
    return this.withTurn(async (threadId, turn) => {
      if (options.untrusted) turn.untrusted = true
      const model = this.settings.selectedModel?.() ?? this.settings.model
      const effort = this.settings.selectedEffort?.()
      const response = await this.rpc.request('turn/start', {
        threadId,
        // A turn override stays for later turns; resending an unchanged model is noise.
        ...(model && model !== this.model ? { model } : {}),
        // The effort is sent with every turn: a fresh or resumed thread would otherwise fall back to the model default.
        ...(effort ? { effort } : {}),
        ...(this.settings.reasoningSummary ? { summary: 'auto' } : {}),
        ...this.turnPermissions(threadId, !!options.untrusted),
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

  get sideRunning(): number {
    return this.sides.size + this.startingSides.size
  }

  /** True when the running turn with this id answers untrusted (agent) input. */
  isUntrustedTurn(threadId: string, turnId: string): boolean {
    return this.runningTurns().some(turn => turn.threadId === threadId && turn.id === turnId && turn.untrusted === true)
  }

  // Turn overrides: an untrusted turn is restricted; the next trusted turn on
  // that thread restores the configured mode. Other turns send nothing extra.
  private turnPermissions(threadId: string, untrusted: boolean):
    { approvalPolicy?: 'on-request' | 'never'; sandboxPolicy?: CodexSandboxPolicy } {
    if (untrusted) {
      this.restrictedThreads.add(threadId)
      return { approvalPolicy: 'never', sandboxPolicy: this.workspaceWritePolicy() }
    }
    if (!this.restrictedThreads.delete(threadId)) return {}
    const { approvalPolicy, sandbox } = this.permissions()
    return {
      approvalPolicy,
      sandboxPolicy: sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : this.workspaceWritePolicy(),
    }
  }

  // Writes only inside the bridge workspace; network stays on because agent
  // tasks need git, gh and remote MCP servers. Temp directories keep their default access.
  private workspaceWritePolicy(): CodexSandboxPolicy {
    return {
      type: 'workspaceWrite',
      writableRoots: [resolvePath(this.settings.cwd)],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }

  // Runs one turn on a side thread next to the main conversation. `reuse`
  // continues an earlier side thread; otherwise an owner side forks the main
  // thread and an untrusted (agent) side starts a fresh one.
  // `onStarted` fires once Codex accepted the turn.
  async runSide(text: string, imagePaths: readonly string[] = [], reuse?: string,
    onStarted?: (threadId: string, turnId: string) => void, options: TurnOptions = {}): Promise<Result & { threadId: string; turnId?: string }> {
    if (reuse !== undefined && (!this.sideThreads.has(reuse) || this.sides.has(reuse))) {
      throw new Error('This side thread is not available')
    }
    // Model and effort are read together before the thread opens: a switch meanwhile never pairs one model with
    // another model's effort; it applies from the next turn.
    const model = this.settings.selectedModel?.() ?? this.settings.model
    const effort = this.settings.selectedEffort?.()
    // Registered before thread/start so a stop during start-up is never missed.
    const starting = { stop: false }
    this.startingSides.add(starting)
    let threadId: string
    try {
      threadId = reuse ?? await this.openSideThread(model, !!options.untrusted)
    } finally {
      this.startingSides.delete(starting)
    }
    if (starting.stop) return { status: 'interrupted', text: '', threadId }
    let finish!: Turn['finish']
    const completed = new Promise<Result>(resolve => { finish = resolve })
    const turn: Turn = {
      threadId, stop: false, toolItems: 0, lastText: '', fileChanges: new Map(), children: new Map(), approvedPolicy: new Map(), finish,
      ...(options.untrusted ? { untrusted: true as const } : {}),
    }
    this.sides.set(threadId, turn)
    try {
      const sendModel = !!model && model !== this.sideThreads.get(threadId)
      const response = await this.rpc.request('turn/start', {
        threadId,
        ...(sendModel ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...this.turnPermissions(threadId, !!options.untrusted),
        input: [
          { type: 'text', text, text_elements: [] },
          ...imagePaths.map(path => ({ type: 'localImage', path })),
        ],
      })
      const id = object(response.turn).id
      if (typeof id !== 'string') throw new Error('Codex did not return a side turn ID')
      if (sendModel && this.sideThreads.has(threadId)) this.sideThreads.set(threadId, model)
      if (!turn.id) this.setTurnId(turn, id)
      onStarted?.(threadId, id)
      return { ...await completed, threadId, turnId: id }
    } finally {
      if (this.sides.get(threadId) === turn) this.sides.delete(threadId)
    }
  }

  /**
   * Runs one member or guest turn on its own thread with the public profile
   * (read-only, no approvals, no shell, no MCP, no dynamic tools, own folder).
   * A saved thread is resumed with the same profile; one Codex lost starts fresh.
   */
  async runPublic(text: string, profile: PublicTurnProfile):
    Promise<Result & { threadId: string; toolItems: number }> {
    const threadId = await this.openPublicThread(profile)
    return this.runPublicTurn(threadId, text, profile.cwd, profile.onThread, undefined, profile.cancelled)
  }

  /**
   * The startup hook proof (multiuser-readiness.ts proveHookDenial): one turn on a fresh ephemeral
   * thread of this public home with the public profile but the shell tool on, read-only and without
   * approvals, so the model can make the one harmless call the permission hook must deny. The thread
   * is never resumed or reused for a chat. `onCommandRan` hears of every command item that may have executed.
   */
  async runHookProof(cwd: string, prompt: string, onThread: (threadId: string) => void, onCommandRan: () => void):
    Promise<Result & { threadId: string; toolItems: number }> {
    const params = publicThreadParams(cwd, 'Ты проверочный поток: проверяется, что хук запрещает вызов инструмента.', 'disabled')
    const reply = await this.rpc.request('thread/start', {
      ...params, config: { ...object(params.config), 'features.shell_tool': true }, ephemeral: true,
    })
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id || id === this.threadId || this.sideThreads.has(id) || this.publicThreads.has(id)) {
      throw new Error('Codex did not return a hook proof thread ID')
    }
    this.proofThreads.add(id)
    this.publicThreads.add(id)
    return this.runPublicTurn(id, prompt, cwd, onThread, onCommandRan)
  }

  private async runPublicTurn(threadId: string, text: string, cwd: string, onThread?: (threadId: string) => void,
    onCommandRan?: () => void, cancelled?: () => boolean): Promise<Result & { threadId: string; toolItems: number }> {
    if (this.publicTurns.has(threadId)) throw new Error('This public thread is busy')
    let finish!: Turn['finish']
    const completed = new Promise<Result>(resolve => { finish = resolve })
    const turn: Turn = {
      threadId, stop: false, untrusted: true, toolItems: 0, lastText: '',
      fileChanges: new Map(), children: new Map(), approvedPolicy: new Map(), finish,
      ...(onCommandRan ? { onCommandRan } : {}),
    }
    this.publicTurns.set(threadId, turn)
    onThread?.(threadId)
    try {
      // Stopped or cancelled while the thread opened: no turn starts at all.
      if (turn.stop || cancelled?.()) return { status: 'interrupted', text: '', threadId, toolItems: 0 }
      const response = await this.rpc.request('turn/start', {
        threadId,
        ...publicTurnParams(cwd),
        input: [{ type: 'text', text, text_elements: [] }],
      })
      const id = object(response.turn).id
      if (typeof id !== 'string') throw new Error('Codex did not return a public turn ID')
      if (!turn.id) this.setTurnId(turn, id)
      const result = await completed
      return { ...result, threadId, toolItems: turn.toolItems }
    } finally {
      if (this.publicTurns.get(threadId) === turn) this.publicTurns.delete(threadId)
    }
  }

  /** Interrupts the running public turn of this thread; true when there was one. */
  async stopPublic(threadId: string): Promise<boolean> {
    const turn = this.publicTurns.get(threadId)
    if (!turn || turn.stop) return false
    turn.stop = true
    if (turn.id) await this.rpc.request('turn/interrupt', { threadId, turnId: turn.id })
    return true
  }

  /** The role of a thread for the permission hook; only the bridge's own threads are known. */
  threadRole(threadId: string): ThreadRole {
    if (this.publicThreads.has(threadId)) return 'public'
    if (threadId === this.threadId) return 'owner'
    const side = this.sides.get(threadId)
    if (side) return side.untrusted ? 'agent' : 'owner'
    if (this.sideThreads.has(threadId)) return 'owner'
    for (const turn of this.runningTurns()) {
      if (turn.children.has(threadId)) return turn.untrusted ? 'agent' : 'owner'
    }
    return 'unknown'
  }

  /**
   * threadRole for the permission hook, plus the subagent race: a subagent's first tool call can reach
   * the hook before its turn/started put it in turn.children. Such a thread counts only when thread/read
   * on this (the owner's) app-server shows a subagent spawned under exactly one running turn of this
   * session, in its folder; it then takes that turn's role. A public thread lives on its own
   * app-server and is never vouched for here.
   */
  async resolveThreadRole(threadId: string): Promise<ThreadRole> {
    const known = this.threadRole(threadId)
    if (known !== 'unknown') return known
    if (!this.runningTurns().length) return 'unknown'
    const read = await this.rpc.request('thread/read', { threadId, includeTurns: false }).catch(() => undefined)
    // Rechecked after the await: the thread may have been registered or become public meanwhile.
    const now = this.threadRole(threadId)
    if (now !== 'unknown') return now
    const thread = object(read?.thread)
    const spawn = object(object(object(thread.source).subAgent).thread_spawn)
    if (thread.id !== threadId || thread.cwd !== this.settings.cwd || typeof thread.parentThreadId !== 'string' ||
        spawn.parent_thread_id !== thread.parentThreadId || typeof spawn.depth !== 'number' ||
        !Number.isSafeInteger(spawn.depth) || spawn.depth < 1) return 'unknown'
    const parents = this.runningTurns().filter(turn => turn.threadId === thread.sessionId &&
      (spawn.depth !== 1 || turn.threadId === thread.parentThreadId))
    if (parents.length !== 1) return 'unknown'
    return parents[0]!.untrusted ? 'agent' : 'owner'
  }

  /**
   * Startup and /doctor check: opens an ephemeral public thread and returns
   * Codex's reply (sandbox, approvalPolicy, cwd) and what that thread can
   * reach: MCP servers, skills and apps (connectors). A list RPC this Codex
   * refuses comes back undefined; publicCapabilitiesProblem fails it closed.
   */
  async probePublicProfile(cwd: string): Promise<PublicProbe> {
    const reply = await this.rpc.request('thread/start', {
      ...publicThreadParams(cwd, 'Проверка профиля.', this.settings.publicWebSearch), ephemeral: true,
    })
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id) return { reply, mcp: {} }
    this.publicThreads.add(id)
    const optional = (method: string, params: Record<string, unknown>) =>
      this.rpc.request(method, params, 10_000).catch(() => undefined)
    const [mcp, skills, apps, config] = await Promise.all([
      this.mcpServerStatus(id),
      optional('skills/list', { cwds: [cwd], forceReload: true }),
      optional('app/list', { threadId: id }),
      optional('config/read', { cwd, includeLayers: false }),
    ])
    return { reply, mcp, ...(skills ? { skills } : {}), ...(apps ? { apps } : {}), ...(config ? { config } : {}) }
  }

  // mcpServerStatus/list with every nextCursor page joined; {} on a refused page, a non-null
  // nextCursor when there are more than MCP_STATUS_PAGES pages (both fail the check).
  private async mcpServerStatus(threadId: string): Promise<Record<string, unknown>> {
    const data: unknown[] = []
    let cursor: unknown = null
    for (let page = 0; page < MCP_STATUS_PAGES; page++) {
      const params = typeof cursor === 'string' ? { threadId, cursor } : { threadId }
      const reply = await this.rpc.request('mcpServerStatus/list', params, 10_000).catch(() => undefined)
      if (!reply || !Array.isArray(reply.data)) return {}
      data.push(...reply.data)
      cursor = reply.nextCursor
      if (cursor == null) return { data, nextCursor: null }
      if (typeof cursor !== 'string' || !cursor) return {}
    }
    return { data, nextCursor: cursor }
  }

  private async openPublicThread(profile: PublicTurnProfile): Promise<string> {
    const params = publicThreadParams(profile.cwd, profile.instructions, this.settings.publicWebSearch)
    const saved = profile.threadId
    if (saved && saved !== this.threadId && !this.sideThreads.has(saved) && !this.proofThreads.has(saved)) {
      if (this.publicThreads.has(saved)) return saved
      try {
        const reply = await this.rpc.request('thread/resume', { ...params, threadId: saved, excludeTurns: true })
        if (object(reply.thread).id === saved) {
          await this.checkPublicThread(profile.cwd)
          this.publicThreads.add(saved)
          return saved
        }
      } catch (error) {
        if (error instanceof PublicThreadRefused) throw error
        this.settings.onWarning?.('Could not resume a public thread; it starts fresh')
      }
    }
    const reply = await this.rpc.request('thread/start', params)
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id || id === this.threadId || this.sideThreads.has(id)) {
      throw new Error('Codex did not return a public thread ID')
    }
    if (typeof reply.cwd === 'string' && reply.cwd !== profile.cwd) throw new PublicThreadRefused('Codex opened a public thread in another folder')
    await this.checkPublicThread(profile.cwd)
    this.publicThreads.add(id)
    return id
  }

  // Before the first turn of a newly opened public thread: the skills Codex loads for its own
  // folder must be exactly the role's allowlisted copies (a chat folder cannot bring its own).
  private async checkPublicThread(cwd: string): Promise<void> {
    const allow = this.settings.publicAllow
    if (!allow) return
    const skills = await this.rpc.request('skills/list', { cwds: [cwd], forceReload: true }, 10_000).catch(() => undefined)
    const problem = publicSkillsProblem(skills, allow)
    if (problem) {
      this.settings.onWarning?.('A public thread was refused before its first turn: ' + problem)
      throw new PublicThreadRefused(problem)
    }
  }

  // Interrupts every running side turn; true when there was one.
  async stopSide(): Promise<boolean> {
    const starting = [...this.startingSides].filter(side => !side.stop)
    for (const side of starting) side.stop = true
    const turns = [...this.sides.values()].filter(turn => !turn.stop)
    for (const turn of turns) turn.stop = true
    await Promise.all(turns.filter(turn => turn.id).map(turn =>
      this.rpc.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id })))
    return turns.length + starting.length > 0
  }

  private async openSideThread(model: string | undefined, untrusted: boolean): Promise<string> {
    // Deliberately not openThread: the main thread, its model and usage stay as they are.
    // A fork inherits its parent's tool catalog, which may still advertise send_component.
    const fork = untrusted || this.settings.widgetsAvailable?.() === false ? undefined : await this.forkMainThread()
    const reply = fork ?? await this.rpc.request('thread/start', {
      cwd: this.settings.cwd,
      ...this.permissions(),
      ...(model ? { model } : {}),
      // A guest (untrusted) thread gets no client tool catalog: it could never call them (requestApproval refuses
      // untrusted turns), and a tool it is not offered is a tool it cannot even try.
      ...(this.settings.chatAction && !untrusted ? { dynamicTools: this.advertisedTools() } : {}),
    })
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id || id === this.threadId) throw new Error('Codex did not return a side thread ID')
    this.sideThreads.set(id, typeof reply.model === 'string' ? reply.model : fork ? undefined : model)
    if (this.sideThreads.size > 64) {
      for (const old of this.sideThreads.keys()) {
        if (!this.sides.has(old)) { this.sideThreads.delete(old); break }
      }
    }
    return id
  }

  // An ephemeral fork of the main thread shares its prompt prefix and, per the
  // Codex source, its prompt-cache key. Undefined: start a fresh thread instead.
  private async forkMainThread(): Promise<Record<string, unknown> | undefined> {
    const main = this.threadId
    if (!this.forkSides || !main || this.needsResume) return
    // A running main turn is half-finished: fork up to the last finished turn
    // (ThreadForkParams.lastTurnId) or, with none known, start a fresh thread.
    const running = this.isRunning
    const lastTurnId = this.lastMainTurn?.threadId === main ? this.lastMainTurn.id : undefined
    if (running && !lastTurnId) return
    try {
      const reply = await this.rpc.request('thread/fork', {
        threadId: main, cwd: this.settings.cwd, excludeTurns: true, ephemeral: true, ...this.permissions(),
        ...(running ? { lastTurnId } : {}),
      })
      const id = object(reply.thread).id
      if (typeof id === 'string' && id && id !== main) return reply
    } catch {
      // Refused (older App Server, root relay): handled below like a bad reply.
    }
    this.forkSides = false
    this.settings.onWarning?.('Codex refused thread/fork for a side thread; side threads use thread/start from now on')
    return undefined
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
        threadId, stop: false, toolItems: 0, lastText: '', fileChanges: new Map(), children: new Map(), approvedPolicy: new Map(), finish,
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
    if (this.threadId && !this.needsResume) {
      // Retry after an earlier failure: a thread adopted without registration stays a guest's otherwise.
      if (this.mainRegistered !== this.threadId) await this.registerMain(this.threadId)
      return this.threadId
    }
    return this.openThread(this.threadId)
  }

  /** The single call of onMain; a failure is reported and leaves the thread unregistered for the next retry. */
  private async registerMain(id: string): Promise<void> {
    if (!this.settings.onMain) {
      this.mainRegistered = id
      return
    }
    try {
      if (await this.settings.onMain(id)) this.mainRegistered = id
    } catch (error) {
      this.settings.onWarning?.('Could not register the main Codex thread ' + id + ': ' +
        (error instanceof Error ? error.message : String(error)))
    }
  }

  private mainOpen<T>(open: () => Promise<T>): Promise<T> {
    return this.settings.aroundMainOpen ? this.settings.aroundMainOpen(open) : open()
  }

  private permissions(): { approvalPolicy: 'on-request' | 'never'; sandbox: CodexSandboxMode } {
    return {
      approvalPolicy: this.settings.approve ? 'on-request' : 'never',
      sandbox: this.settings.sandbox ?? 'workspace-write',
    }
  }

  private advertisedTools() {
    return this.settings.widgetsAvailable?.() === false
      ? agentTools.filter(tool => tool.name !== 'send_component') : agentTools
  }

  private async openThread(expected: string | null): Promise<string> {
    const model = this.settings.selectedModel?.() ?? this.settings.model
    const options = {
      cwd: this.settings.cwd,
      ...this.permissions(),
      ...(model ? { model } : {}),
    }
    // Registered before thread/resume: a SessionStart hook may resolve the registry during the RPC.
    if (expected && this.mainRegistered !== expected) await this.registerMain(expected)
    const reply = await this.mainOpen(() => expected
      ? this.rpc.request('thread/resume', { ...options, threadId: expected, excludeTurns: true })
      : this.rpc.request('thread/start', {
        ...options,
        ...(this.settings.chatAction ? { dynamicTools: this.advertisedTools() } : {}),
      }))
    const id = object(reply.thread).id
    if (typeof id !== 'string' || !id || (expected && id !== expected)) {
      throw new Error('Codex did not return the expected thread ID')
    }
    this.model = typeof reply.model === 'string' ? reply.model : undefined
    if (id !== this.threadId) this.usage = undefined
    this.saveThread(id)
    if (this.mainRegistered !== id) await this.registerMain(id)
    if (expected) await this.seedForkAnchor(id)
    return id
  }

  // A resumed thread finished its turns before this process saw any event, so
  // the fork anchor comes from its history: the latest terminal turn. Best
  // effort: with no answer an owner side starts a fresh thread, as before.
  private async seedForkAnchor(threadId: string): Promise<void> {
    if (!this.forkSides) return
    try {
      // The exact shape the root relay admits for thread/turns/list.
      const result = await this.rpc.request('thread/turns/list', {
        threadId, limit: 10, itemsView: 'full', sortDirection: 'desc',
      }, 5000)
      const turns = Array.isArray(result.data) ? result.data.map(object) : []
      const last = turns.find(turn => typeof turn.id === 'string' && turn.id !== '' &&
        (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed'))
      if (last && this.threadId === threadId) this.lastMainTurn = { threadId, id: last.id as string }
    } catch {
      this.settings.onWarning?.('Could not read the resumed Codex history; a side thread may start fresh')
    }
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
    // Public threads never reach the owner's progress, HUD or mirror, nor become subagents of an owner turn.
    if (typeof event.params.threadId === 'string' && this.publicThreads.has(event.params.threadId)) {
      const turn = this.publicTurns.get(event.params.threadId)
      if (turn) this.receiveTurnEvent(turn, event.method, event.params, false)
      return
    }
    this.settings.onActivity?.(event, this.threadId)
    const { method, params } = event
    if (typeof params.threadId === 'string' && method !== 'thread/status/changed' &&
        (params.threadId === this.active?.threadId || params.threadId === this.goalTurn?.threadId ||
         method === 'turn/started' && params.threadId === this.threadId && this.settings.mayRunGoal?.(params.threadId))) {
      this.lastActivity = Date.now()
    }
    if (method === 'thread/tokenUsage/updated' && typeof params.threadId === 'string') {
      try {
        this.settings.onTokenUsage?.(params.threadId, params.tokenUsage)
      } catch {
        // Statistics only: a failing counter never affects the turn.
      }
    }
    if (method === 'thread/tokenUsage/updated' && params.threadId === this.threadId) {
      const usage = object(params.tokenUsage)
      const last = object(usage.last)
      const usedTokens = last.totalTokens
      const windowTokens = usage.modelContextWindow
      if (typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens >= 0
          && typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0) {
        const cachePercent = cacheShare(last.inputTokens, last.cachedInputTokens)
        this.usage = { usedTokens, windowTokens, ...(cachePercent === undefined ? {} : { cachePercent }) }
      }
    }
    const observedId = typeof params.turnId === 'string' ? params.turnId : object(params.turn).id
    if (method === 'turn/completed' && typeof observedId === 'string' && typeof params.threadId === 'string' &&
        params.threadId === this.threadId) {
      this.lastMainTurn = { threadId: params.threadId, id: observedId }
    }
    if (typeof params.threadId === 'string' && this.sideThreads.has(params.threadId)) {
      const side = this.sides.get(params.threadId)
      if (side) this.receiveTurnEvent(side, method, params, false)
      return
    }
    if (method === 'turn/started' && typeof observedId === 'string' && typeof params.threadId === 'string' &&
        params.threadId === this.threadId && this.settings.mayRunGoal?.(params.threadId) &&
        (!this.active || !!this.active.id && this.active.id !== observedId)) {
      const threadId = params.threadId
      if (this.goalTurn?.id !== observedId) {
        this.goalTurn = {
          threadId, id: observedId, lastText: '', stop: false, toolItems: 0,
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
    this.receiveTurnEvent(active, method, params, true)
  }

  private receiveTurnEvent(active: Turn, method: string, params: Record<string, unknown>, progress: boolean): void {
    if (method === 'turn/started') {
      const id = object(params.turn).id
      if (!active.id && typeof id === 'string') this.setTurnId(active, id)
      if (progress) this.settings.onProgress?.('turn')
    } else if (method === 'item/started') {
      if (active.id && params.turnId !== active.id) return
      const item = object(params.item)
      if (progress && typeof item.type === 'string') this.settings.onProgress?.(item.type, item)
      if (typeof item.type === 'string' && !conversationItems.has(item.type)) active.toolItems++
      recordFileChange(active, item)
    } else if (method === 'item/completed') {
      if (active.id && params.turnId !== active.id) return
      const item = object(params.item)
      if (commandRan(item)) active.onCommandRan?.()
      if (item.type !== 'agentMessage' || item.delivery === 'async' || typeof item.text !== 'string') return
      if (item.phase === 'final_answer') active.finalText = item.text
      else if (item.phase !== 'commentary') active.lastText = item.text
    } else if (method === 'turn/completed') {
      const turn = object(params.turn)
      if (active.id && turn.id !== active.id) return
      const status = turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed'
      if (progress) this.settings.onTurnProgressEnd?.(status)
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
    return [this.active, this.goalTurn, ...this.sides.values(), ...this.publicTurns.values()].filter((turn): turn is Turn => !!turn?.id && !turn.stop)
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
    // A member or guest thread never reaches owner approval cards, running or not.
    if (operation && this.publicThreads.has(operation.threadId)) return 'decline'
    if (!operation || !request.cwd) return approve(request)
    const matches = this.runningTurns().filter(turn => turn.threadId === operation.threadId)
      .flatMap(owner => [owner, ...owner.children.values()].filter(execution => execution.id === operation.turnId)
        .map(execution => ({ owner, execution })))
    const scope = matches.length === 1 ? matches[0] : await this.approvalExecution(operation.threadId, operation.turnId)
    if (!scope) {
      const untrusted = this.runningTurns().some(turn => turn.untrusted && turn.threadId === operation.threadId)
      return untrusted ? 'decline' : approve(request)
    }
    if (scope.owner.untrusted) return 'decline'
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
      if (!run || !turn || turn.untrusted || namespace !== null || typeof tool !== 'string' ||
          !agentTools.some(entry => entry.name === tool) ||
          typeof callId !== 'string' || !/^[\w.:-]{1,128}$/u.test(callId)) return
      return this.withServerRequest(id, turn.threadId, signal =>
        run(JSON.stringify([threadId, turnId, callId]), args, () => !signal.aborted && this.runningTurns().includes(turn), tool))
    }
    if (method === 'item/tool/requestUserInput') {
      const current = this.goalTurn?.id === params.turnId ? this.goalTurn : this.active
      if (!current || current.stop || current.untrusted || current.threadId !== params.threadId ||
          current.id !== params.turnId) return { answers: {} }
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
        if (signal.aborted || !scope || scope.owner.untrusted) return 'cancel'
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
    if (!scope || scope.owner.untrusted) return { decision: 'decline' }
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
