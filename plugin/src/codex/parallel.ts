// Parallel side threads: while the main Codex turn works on a long task, a new
// owner message that is not a correction of that task is answered by a second
// ("side") thread in the same app-server.
//
// Routing rule while the main thread is busy (documented in README):
//   1. A Telegram reply to a message of a side conversation continues that side thread.
//   2. Any other Telegram reply goes to the running main turn (steer), as before.
//   3. A message starting with a correction keyword (KROT_CODEX_CORRECTION_WORDS,
//      default «уточнение, поправка, к задаче, стоп») goes to the main turn.
//   4. Everything else starts a fresh side thread, if fewer than
//      KROT_CODEX_MAX_PARALLEL threads (main included, default 2) are running;
//      otherwise it is queued for the main thread and the owner is told what runs.

export interface ParallelSettings {
  enabled: boolean
  maxParallel: number
  keywords: string[]
}

export type BusyRoute = { route: 'main' } | { route: 'queue' } | { route: 'side'; thread?: string }

export interface RunningSummary {
  title: string
  step?: string
  elapsedMs: number
}

const defaultKeywords = ['уточнение', 'поправка', 'к задаче', 'стоп']
const rememberedMessages = 300

export function parallelSettings(env: Record<string, string | undefined>): ParallelSettings {
  const raw = env.KROT_CODEX_MAX_PARALLEL
  const parsed = raw !== undefined && /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : NaN
  const maxParallel = Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 2
  const custom = (env.KROT_CODEX_CORRECTION_WORDS ?? '').split(',')
    .map(word => word.trim().toLowerCase()).filter(Boolean)
  return { enabled: env.KROT_CODEX_PARALLEL === '1', maxParallel, keywords: custom.length ? custom : defaultKeywords }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function startsWithKeyword(text: string | undefined, keywords: readonly string[]): boolean {
  const phrase = (text ?? '').trim().toLowerCase()
  return keywords.some(word => new RegExp('^' + escape(word) + '(?![\\p{L}\\p{N}])', 'u').test(phrase))
}

/** Side conversations in flight and the Telegram messages that belong to them. */
export class SideRegistry {
  private readonly threads = new Map<number, string>()
  private readonly running = new Map<number, { title: string; thread?: string }>()

  get size(): number {
    return this.running.size
  }

  get titles(): string[] {
    return [...this.running.values()].map(side => side.title)
  }

  begin(messageId: number, title: string, thread?: string): void {
    this.running.set(messageId, { title, ...(thread ? { thread } : {}) })
  }

  attach(messageId: number, thread: string): void {
    const side = this.running.get(messageId)
    if (side) side.thread = thread
    this.remember(messageId, thread)
  }

  end(messageId: number): void {
    this.running.delete(messageId)
  }

  remember(messageId: number, thread: string): void {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return
    this.threads.delete(messageId)
    this.threads.set(messageId, thread)
    if (this.threads.size > rememberedMessages) this.threads.delete(this.threads.keys().next().value!)
  }

  threadOf(messageId: number): string | undefined {
    return this.threads.get(messageId)
  }

  isBusy(thread: string): boolean {
    return [...this.running.values()].some(side => side.thread === thread)
  }
}

export function routeWhileBusy(
  message: { text?: string | undefined; replyTo?: number | undefined },
  state: { keywords: readonly string[]; maxParallel: number; sides: SideRegistry },
): BusyRoute {
  const free = 1 + state.sides.size < state.maxParallel
  if (message.replyTo !== undefined) {
    const thread = state.sides.threadOf(message.replyTo)
    if (!thread) return { route: 'main' }
    return free && !state.sides.isBusy(thread) ? { route: 'side', thread } : { route: 'queue' }
  }
  if (startsWithKeyword(message.text, state.keywords)) return { route: 'main' }
  return free ? { route: 'side' } : { route: 'queue' }
}

function minutes(ms: number): string {
  return String(Math.max(1, Math.round(ms / 60_000))) + ' мин'
}

function clip(text: string, length: number): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > length ? line.slice(0, length - 1) + '…' : line
}

export function taskTitle(text: string | undefined): string {
  return clip(text ?? '', 80) || 'сообщение с вложением'
}

export function busyNotice(main: RunningSummary, sides: readonly string[], maxParallel: number): string {
  const lines = ['Все потоки заняты (' + maxParallel + '). Сообщение в очереди, возьму его после основной задачи.',
    'Основная задача: «' + clip(main.title, 80) + '», идёт ' + minutes(main.elapsedMs) + '.']
  if (sides.length) lines.push('Параллельно: ' + sides.map(title => '«' + clip(title, 60) + '»').join(', ') + '.')
  return lines.join('\n')
}

export function sideInstructions(main: RunningSummary): string {
  return [
    'Ты параллельный поток того же агента. Основной поток сейчас выполняет другую задачу владельца:',
    '«' + clip(main.title, 200) + '»' + (main.step ? ', текущий шаг: «' + clip(main.step, 160) + '»' : '') +
      ', идёт ' + minutes(main.elapsedMs) + '.',
    'Ответь на новое сообщение владельца сам и быстро, не дожидаясь основной задачи. ' +
      'Если просят о ней, коротко скажи, чем занят основной поток. ' +
      'Если это отдельная долгая задача, можешь выполнить её здесь.',
    'Рабочая папка общая: не меняй файлы, которые затрагивает основная задача, не останавливай её и не перезапускай мост. ' +
      'Если сообщение на самом деле уточняет основную задачу, скажи, что его нужно прислать ответом (reply) ' +
      'на сообщение задачи или начать со слова «уточнение».',
  ].join('\n')
}
