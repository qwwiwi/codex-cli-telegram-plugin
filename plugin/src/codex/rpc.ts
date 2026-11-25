import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type Json = Record<string, unknown>

export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json
    : {}
}

export interface CodexEvent {
  method: string
  params: Json
}
export interface CodexServerRequest extends CodexEvent {
  id: number | string
}

type Pending = {
  resolve: (value: Json) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private stopped = false

  constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    onEvent: (event: CodexEvent) => void,
    private readonly onClose: () => void,
    command: readonly [string, ...string[]] = ['codex', 'app-server', '--listen', 'stdio://'],
    onRequest?: (request: CodexServerRequest) => Promise<Json | undefined>,
  ) {
    const [executable, ...args] = command
    this.child = spawn(executable, args, { cwd, env })
    this.child.stderr.resume()
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
    this.child.stdin.on('error', () => this.close())
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const message = object(JSON.parse(line))
        if (typeof message.method === 'string') {
          if (typeof message.id === 'number' || typeof message.id === 'string') {
            const request = { id: message.id, method: message.method, params: object(message.params) }
            void Promise.resolve(onRequest?.(request)).catch(() => undefined).then(result => {
              if (this.stopped) return
              this.write(result ? { id: request.id, result } : {
                id: request.id,
                error: { code: -32601, message: 'Interactive request is unsupported' },
              })
            }).catch(() => this.close())
          } else {
            onEvent({ method: message.method, params: object(message.params) })
          }
          return
        }
        if (typeof message.id !== 'number') return
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        clearTimeout(request.timer)
        if ('error' in message) request.reject(new Error('Codex rejected the request'))
        else request.resolve(object(message.result))
      } catch {
        this.close()
      }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'krot_telegram', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.write({ method: 'initialized' })
  }

  request(method: string, params: Json, nonFatalTimeoutMs?: number): Promise<Json> {
    if (this.stopped) return Promise.reject(new Error('Codex App Server has stopped'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (nonFatalTimeoutMs === undefined) this.close()
        else {
          this.pending.delete(id)
          reject(new Error('Codex did not answer the request'))
        }
      }, nonFatalTimeoutMs ?? 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.child.kill()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Connection to Codex App Server closed'))
    }
    this.pending.clear()
    this.onClose()
  }

  private write(message: Json): void {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
}
