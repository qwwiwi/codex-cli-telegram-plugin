import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteInRoot } from '../autonomy/store.js'
import { object } from './rpc.js'
import type { LeaseTicket } from './lease.js'
import { ownerExecutionTask } from './continuation.js'

const filename = 'codex-controls.json'
type FileDelivery = 'sending' | 'sent' | 'failed' | 'uncertain'

export class ControlState {
  mirror: boolean
  model: string | undefined
  // Reasoning effort for the next turns; undefined: the model's own default.
  effort: string | undefined
  goalThread: string | undefined
  goalDeliveryPending: boolean | undefined
  goalTextDelivery: 'sending' | 'sent' | undefined
  pendingOwnerTask: { thread: string; objective: string } | undefined
  private threads: string[]
  private goalLeases: Record<string, LeaseTicket>
  private goalFiles: Record<string, FileDelivery>

  constructor(private root: string, defaultMirror: boolean) {
    let data: ReturnType<typeof object> = {}
    try {
      data = object(JSON.parse(readFileSync(join(root, filename), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid Codex control state')
    }
    this.mirror = typeof data.mirror === 'boolean' ? data.mirror : defaultMirror
    this.model = typeof data.model === 'string' && data.model ? data.model : undefined
    this.effort = typeof data.effort === 'string' && /^[a-z]{1,16}$/.test(data.effort) ? data.effort : undefined
    this.goalThread = typeof data.goalThread === 'string' ? data.goalThread : undefined
    this.goalDeliveryPending = typeof data.goalDeliveryPending === 'boolean' ? data.goalDeliveryPending : undefined
    this.goalTextDelivery = data.goalTextDelivery === 'sending' || data.goalTextDelivery === 'sent'
      ? data.goalTextDelivery : undefined
    const pending = object(data.pendingOwnerTask)
    if (typeof pending.thread === 'string' && /^[a-z0-9-]{1,100}$/i.test(pending.thread) &&
        typeof pending.objective === 'string' && pending.objective.length <= 4000 &&
        ownerExecutionTask(pending.objective)) {
      this.pendingOwnerTask = { thread: pending.thread, objective: pending.objective }
    }
    this.goalFiles = Object.fromEntries(Object.entries(object(data.goalFiles)).flatMap(([key, value]) =>
      /^[a-f0-9]{64}$/.test(key) && (value === 'sending' || value === 'sent' || value === 'failed' || value === 'uncertain')
        ? [[key, value]] : []))
    this.goalLeases = Object.fromEntries(Object.entries(object(data.goalLeases)).flatMap(([key, raw]) => {
      const { nonce, ids } = object(raw)
      return /^[a-z0-9-]{1,100}$/i.test(key) && typeof nonce === 'string' && /^[a-f0-9-]{36}$/u.test(nonce) &&
        Array.isArray(ids) && ids.length <= 10 && ids.every(id => typeof id === 'string' && /^L-\d{8}-[a-f0-9]{8}$/u.test(id))
        ? [[key, { nonce, ids }]] : []
    }))
    this.threads = Array.isArray(data.threads)
      ? [...new Set(data.threads.filter((id): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id)))].slice(0, 10)
      : []
  }

  get recent(): readonly string[] {
    return this.threads
  }

  goalLease(thread: string): LeaseTicket | undefined {
    return this.goalLeases[thread]
  }

  setGoalLease(thread: string, ticket?: LeaseTicket): void {
    const entries = Object.entries(this.goalLeases).filter(([id]) => id !== thread)
    if (ticket?.ids.length) entries.push([thread, ticket])
    const previous = this.goalLeases
    this.goalLeases = Object.fromEntries(entries.slice(-10))
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.goalLeases = previous
      throw error
    }
  }

  setPendingOwnerTask(thread: string | null, objective?: string): void {
    const previous = this.pendingOwnerTask
    if (!thread || (!objective && previous?.thread !== thread) ||
        (previous?.thread === thread && previous.objective === objective)) return
    this.pendingOwnerTask = objective ? { thread, objective } : undefined
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.pendingOwnerTask = previous
      throw error
    }
  }

  selectMirror(value: boolean): void {
    this.save(value, this.model, this.threads)
  }

  selectModel(model: string | undefined): void {
    this.save(this.mirror, model, this.threads)
  }

  selectEffort(effort: string | undefined): void {
    const previous = this.effort
    this.effort = effort
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.effort = previous
      throw error
    }
  }

  /** Sets the model and the effort that goes with it in one write: a failed write keeps the previous pair. */
  selectModelAndEffort(model: string | undefined, effort: string | undefined): void {
    const previous = this.effort
    this.effort = effort
    try { this.save(this.mirror, model, this.threads) } catch (error) {
      this.effort = previous
      throw error
    }
  }

  selectGoal(thread: string | undefined, deliveryPending = false): void {
    const previous = this.goalThread
    const previousDelivery = this.goalDeliveryPending
    const previousTextDelivery = this.goalTextDelivery
    const previousFiles = this.goalFiles
    this.goalThread = thread
    this.goalDeliveryPending = !!thread && deliveryPending
    this.goalTextDelivery = undefined
    this.goalFiles = {}
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.goalThread = previous
      this.goalDeliveryPending = previousDelivery
      this.goalTextDelivery = previousTextDelivery
      this.goalFiles = previousFiles
      throw error
    }
  }

  setGoalTextDelivery(thread: string, value: ControlState['goalTextDelivery']): void {
    if (thread !== this.goalThread) throw new Error('Goal conversation changed during delivery')
    const previous = this.goalTextDelivery
    this.goalTextDelivery = value
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.goalTextDelivery = previous
      throw error
    }
  }

  goalFileDelivery(key: string): FileDelivery | undefined {
    return this.goalFiles[key]
  }

  setGoalFileDelivery(thread: string, key: string, value?: FileDelivery): void {
    if (thread !== this.goalThread) throw new Error('Goal conversation changed during attachment delivery')
    const previous = this.goalFiles
    this.goalFiles = { ...previous }
    if (value) this.goalFiles[key] = value
    else delete this.goalFiles[key]
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.goalFiles = previous
      throw error
    }
  }

  remember(id: string): void {
    if (this.threads[0] !== id) this.save(this.mirror, this.model, [id, ...this.threads.filter(x => x !== id)].slice(0, 10))
  }

  private save(mirror: boolean, model: string | undefined, threads: string[]): void {
    atomicWriteInRoot({ root: this.root }, filename,
      JSON.stringify({
        mirror, model, effort: this.effort, threads, goalThread: this.goalThread, goalLeases: this.goalLeases,
        goalDeliveryPending: this.goalDeliveryPending, goalTextDelivery: this.goalTextDelivery, goalFiles: this.goalFiles,
        pendingOwnerTask: this.pendingOwnerTask,
      }) + '\n')
    this.mirror = mirror
    this.model = model
    this.threads = threads
  }
}
