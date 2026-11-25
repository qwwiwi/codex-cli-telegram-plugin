import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteInRoot } from '../autonomy/store.js'
import { object } from './rpc.js'
import type { LeaseTicket } from './lease.js'

const filename = 'codex-controls.json'

export class ControlState {
  mirror: boolean
  model: string | undefined
  goalThread: string | undefined
  goalDeliveryPending: boolean | undefined
  goalTextDelivery: 'sending' | 'sent' | undefined
  private threads: string[]
  private goalLeases: Record<string, LeaseTicket>

  constructor(private root: string, defaultMirror: boolean) {
    let data: ReturnType<typeof object> = {}
    try {
      data = object(JSON.parse(readFileSync(join(root, filename), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid Codex control state')
    }
    this.mirror = typeof data.mirror === 'boolean' ? data.mirror : defaultMirror
    this.model = typeof data.model === 'string' && data.model ? data.model : undefined
    this.goalThread = typeof data.goalThread === 'string' ? data.goalThread : undefined
    this.goalDeliveryPending = typeof data.goalDeliveryPending === 'boolean' ? data.goalDeliveryPending : undefined
    this.goalTextDelivery = data.goalTextDelivery === 'sending' || data.goalTextDelivery === 'sent'
      ? data.goalTextDelivery : undefined
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

  selectMirror(value: boolean): void {
    this.save(value, this.model, this.threads)
  }

  selectModel(model: string | undefined): void {
    this.save(this.mirror, model, this.threads)
  }

  selectGoal(thread: string | undefined, deliveryPending = false): void {
    const previous = this.goalThread
    const previousDelivery = this.goalDeliveryPending
    const previousTextDelivery = this.goalTextDelivery
    this.goalThread = thread
    this.goalDeliveryPending = !!thread && deliveryPending
    this.goalTextDelivery = undefined
    try { this.save(this.mirror, this.model, this.threads) } catch (error) {
      this.goalThread = previous
      this.goalDeliveryPending = previousDelivery
      this.goalTextDelivery = previousTextDelivery
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

  remember(id: string): void {
    if (this.threads[0] !== id) this.save(this.mirror, this.model, [id, ...this.threads.filter(x => x !== id)].slice(0, 10))
  }

  private save(mirror: boolean, model: string | undefined, threads: string[]): void {
    atomicWriteInRoot({ root: this.root }, filename,
      JSON.stringify({
        mirror, model, threads, goalThread: this.goalThread, goalLeases: this.goalLeases,
        goalDeliveryPending: this.goalDeliveryPending, goalTextDelivery: this.goalTextDelivery,
      }) + '\n')
    this.mirror = mirror
    this.model = model
    this.threads = threads
  }
}
