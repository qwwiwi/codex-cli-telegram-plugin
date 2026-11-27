import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DaySchema, DeltaLineSchema, FactIdSchema, FactKindSchema, HandoffSchema, SOURCE_MIGRATION, SOURCE_TG_COMMAND,
  formatDigestLine, formatIndexLine, type BrainStatus, type Clock, type Exchange, type Fact, type FactId,
  type FactRemoveResult, type FactWriteResult, type Handoff, type HandoffBuilder, type JournalReader, type MemoryButton,
  type MemoryReply, type MemoryRequest, type Proposal, type ProposalStore, type ReceiptStore, type ReceiptWrite, type SummaryReader,
} from '../../../codex-brain/src/contract.js'
import { sha256, type FactStore } from '../../../codex-brain/src/facts/store.js'
import { renderExchange } from '../../../codex-brain/src/journal/index.js'
import { readJson, readJsonLines } from '../../../codex-brain/src/snapshot/files.js'
import { appendLine, writeFileAtomic } from '../../../codex-brain/src/store/atomic.js'
import { withLock } from '../../../codex-brain/src/store/lock.js'
import { ensureScope, type ScopePaths } from '../../../codex-brain/src/store/paths.js'
import { factDescription, legacyFactId } from './brain-migrate.js'
import { classifyBrainOrigin } from './brain-origin.js'

export const BRAIN_CALLBACK = /^krot:memory:[\da-f-]{36}$/u
export const BRAIN_UNAVAILABLE = 'Память: не сохранено. Хранилище Brain недоступно.'
const stale = 'этот факт изменился, откройте заново.'
export const MEMORY_REFUSED = 'Команды памяти доступны только владельцу в личном чате.'
export const MEMORY_WRITE_REFUSED = 'Менять память можно только своим сообщением: без пересылки и вставленной цитаты.'

/** `/memory` verbs that only read; every other verb (legacy ones included) may change memory or its state. */
const READ_ONLY_MEMORY_VERBS: ReadonlySet<string> = new Set(['', 'status', 'list', 'tasks', 'pending', 'show', 'search', 'day', 'handoff'])

/**
 * A changing `/memory` command runs only from the owner's own words (`owner-direct`): a pasted
 * block quote or other foreign text that carries `/memory pin …` must not write.
 */
export function mayRunMemoryCommand(message: Parameters<typeof classifyBrainOrigin>[0], owner: number, args: string): boolean {
  const [action = ''] = args.trim().split(/\s+/u)
  return READ_ONLY_MEMORY_VERBS.has(action) || classifyBrainOrigin(message, owner).origin === 'owner-direct'
}
const hooksLabel: Record<BrainStatus['hooks'], string> = {
  managed: 'managed', 'user-trusted': 'user-level trusted', 'user-needs-review': 'user-level needs review', none: 'no hooks',
}
const pageSize = 6
const reply = (text: string, buttons: MemoryButton[][] = []): MemoryReply => ({ text: text.slice(0, 3900), buttons })

interface CommandOptions {
  facts: FactStore
  proposals: ProposalStore
  receipts: ReceiptStore
  journal: JournalReader
  summaries: SummaryReader
  handoff: HandoffBuilder
  paths: ScopePaths
  clock: Clock
  reviewButtons: boolean
  clean(text: string): string
  status(): Promise<BrainStatus>
  enabled(): boolean
  setEnabled(enabled: boolean): Promise<void>
  migrate(): Promise<unknown>
  lastHandoff(): Handoff | null
}

export function createBrainCommands(options: CommandOptions) {
  const { facts, proposals, receipts, summaries, journal, handoff, paths, clock, clean } = options
  const actions = new Map<string, () => Promise<MemoryReply>>()
  const writer = () => facts.writer({ turnId: 'tg-' + randomUUID() })
  function button(label: string, action: () => Promise<MemoryReply>): MemoryButton {
    const data = 'krot:memory:' + randomUUID()
    if (actions.size >= 512) actions.delete(actions.keys().next().value!)
    actions.set(data, action)
    return { label, data }
  }

  async function changed(id: FactId, action: 'changed' | 'removed', revision?: number): Promise<void> {
    ensureScope(paths.brainHome, paths.scope)
    await withLock(paths.lockDir, async () => {
      const entries = readJsonLines(paths.delta, DeltaLineSchema)
      const seq = entries.reduce((last, entry) => Math.max(last, entry.seq), 0) + 1
      if (!entries.some(line => line.id === id && line.action === action && line.revision === revision)) {
        appendLine(paths.delta, JSON.stringify(DeltaLineSchema.parse({ seq, id, action, revision, at: clock.now().toISOString() })))
      }
      if (action !== 'removed') return
      const current = readJson(paths.handoffMeta, HandoffSchema)
      if (current && !current.delivered) {
        const decisions = current.decisions.filter(line => line.id !== id)
        const tasks = current.tasks.filter(task => task.id !== id)
        if (decisions.length !== current.decisions.length || tasks.length !== current.tasks.length) {
          const filtered = { ...current, decisions, tasks }
          writeFileAtomic(paths.handoffMeta, JSON.stringify(filtered) + '\n')
          writeFileAtomic(paths.handoffCurrent, handoff.render(filtered))
        }
      }
    })
  }

  async function writeResult(result: FactWriteResult | FactRemoveResult, success: string): Promise<MemoryReply> {
    if (!result.ok) {
      if (result.error === 'conflict' || result.error === 'not-found') return reply(stale)
      return reply(result.error === 'secret' ? 'Уберите секреты из записи.' : 'Запись не прошла проверку.')
    }
    if ('fact' in result) await changed(result.fact.id, 'changed', result.fact.revision)
    else await changed(result.id, 'removed', result.revision)
    return reply(success)
  }

  async function show(id: string): Promise<MemoryReply> {
    const fact = await facts.get(id)
    if (!fact) return reply('Запись не найдена.')
    return reply(`${fact.id} · ${fact.kind} · ревизия ${fact.revision}\nИсточник: ${fact.source}\n/memory forget ${id}\n\n${fact.body}`, [[
      button('Изменить', async () => (await facts.get(id))?.revision === fact.revision
        ? reply(`/memory edit ${id} r${fact.revision} <новый текст>`) : reply(stale)),
    ]])
  }

  function paging<T>(items: T[], page: number, next: (page: number) => Promise<MemoryReply>, row: (item: T) => MemoryButton[]) {
    const buttons = items.slice((page - 1) * pageSize, page * pageSize).map(row)
    const nav: MemoryButton[] = []
    if (page > 1) nav.push(button('Назад', () => next(page - 1)))
    if (page * pageSize < items.length) nav.push(button('Далее', () => next(page + 1)))
    if (nav.length) buttons.push(nav)
    return buttons
  }

  async function list(page: number, kind?: Fact['kind']): Promise<MemoryReply> {
    const entries = await facts.list(kind)
    const text = entries.slice((page - 1) * pageSize, page * pageSize).map(formatIndexLine).join('\n')
    return reply(text || 'Сохранённых записей на этой странице нет.', paging(entries, page, p => list(p, kind),
      entry => [button(entry.id, () => show(entry.id))]))
  }

  async function review(id: string, accept: boolean, shown?: Proposal, revision?: number | null): Promise<MemoryReply> {
    const lock = join(ensureScope(paths.brainHome, paths.scope).stateDir, 'telegram-review-lock')
    mkdirSync(lock, { recursive: true, mode: 0o700 })
    return withLock(lock, async () => {
      const proposal = await proposals.get(id)
      if (!proposal || shown && JSON.stringify(shown) !== JSON.stringify(proposal)) return reply(stale)
      if (!accept) {
        await proposals.remove(id)
        return reply('Предложение отклонено.')
      }
      const operation = 'tg-approve-' + sha256(JSON.stringify(proposal))
      const committed = (await receipts.get(operation))?.writes[0]
      if (committed) {
        await changed(committed.id, 'changed', committed.revision)
        await proposals.remove(id)
        return reply('Предложение принято.')
      }
      const factId = proposal.fact.id ?? ('proposal-' + sha256(proposal.id).slice(0, 32))
      // Text approval uses the proposal's revision. A legacy proposal can only create an absent fact.
      const expectedRevision = revision === undefined ? proposal.target_revision : revision ?? undefined
      const result = await facts.writer({ turnId: operation }).put({
        ...proposal.fact, id: factId, source: proposal.source ?? (proposal.from === 'migration' ? SOURCE_MIGRATION : SOURCE_TG_COMMAND),
        ...(proposal.fact.kind === 'task' ? { status: 'open' as const } : {}),
      }, expectedRevision)
      const response = await writeResult(result, 'Предложение принято.')
      if (result.ok) await proposals.remove(id)
      return response
    })
  }

  async function pending(page: number): Promise<MemoryReply> {
    const entries = await proposals.list()
    const visible = entries.slice((page - 1) * pageSize, page * pageSize)
    const text = visible.map(p => `${p.id} · ${p.fact.description}\n${p.fact.body.slice(0, 350)}`).join('\n\n') ||
      'Предложений на этой странице нет.'
    if (!options.reviewButtons) {
      const hints: string[] = []
      if (visible.length) hints.push('/memory approve ID · /memory reject ID')
      if (page > 1) hints.push(`/memory pending ${page - 1}`)
      if (page * pageSize < entries.length) hints.push(`/memory pending ${page + 1}`)
      return reply([text, ...hints].join('\n\n'))
    }
    const revisions = new Map(await Promise.all(visible.map(async p =>
      [p.id, p.fact.id ? (await facts.get(p.fact.id))?.revision ?? null : null] as const)))
    return reply(text, paging(entries, page, pending, p => [
      button('Принять ' + p.id, () => review(p.id, true, p, revisions.get(p.id))),
      button('Отклонить ' + p.id, () => review(p.id, false, p)),
    ]))
  }

  async function search(words: string): Promise<MemoryReply> {
    if (!words) return reply('Используйте /memory search <слова>.')
    const results: Exchange[] = []
    const query = words.toLowerCase()
    for (const day of (await journal.days()).reverse()) {
      for (const entry of (await journal.fold(day)).reverse()) {
        if ([entry.input, entry.reply].some(text => text?.toLowerCase().includes(query))) results.push(entry)
        if (results.length >= pageSize) break
      }
      if (results.length >= pageSize) break
    }
    const hits = (await facts.search(words)).slice(0, pageSize)
    const text = [...hits.map(formatIndexLine), ...results.map(entry => renderExchange(entry).slice(0, 350))].join('\n\n')
    return reply(text || 'Совпадений нет.', hits.map(hit => [button(hit.id, () => show(hit.id))]))
  }

  function status(state: BrainStatus): MemoryReply {
    return reply([
      'Brain ' + (state.enabled ? 'включён' : 'выключен'),
      `Записи: ${state.facts} · предложения: ${state.pending} · журнал: ${state.journal_bytes} Б`,
      `Дайджест: ${state.last_digest ?? '—'} · хуки: ${hooksLabel[state.hooks]} · PreCompact: ${state.precompact}`,
      state.degraded ? 'degraded: no handoff inside a turn' : '',
      `Последняя передача контекста: ${state.last_handoff_delivery ?? '—'}`,
      `Приоритетные записи: ${state.priority_tokens} токенов`,
      state.priority_over_budget ? 'Бюджет приоритетов превышен. Открепите записи или закройте задачи.' : '',
      state.integrity.length ? 'Нарушение целостности записей: ' + state.integrity.length + '. Проверьте brain doctor.' : '',
      `Суммаризатор: ${state.summarizer.model} (${state.summarizer.effort})`,
      ...state.warnings,
      '/memory list · pending · day · handoff · search · on · off',
    ].filter(Boolean).join('\n'))
  }

  return {
    notice(writes: ReceiptWrite[]): MemoryReply {
      const visible = writes.filter(write => write.action !== 'remove').slice(-5)
      return reply(visible.length ? '💾 Сохранено: ' +
        visible.map(write => `${write.description}\n/memory forget ${write.id}`).join('\n\n') : '')
    },
    async handle(request: MemoryRequest): Promise<MemoryReply> {
      if (!request.ownerPrivateChat) return reply(MEMORY_REFUSED)
      const [action = '', ...args] = request.args.trim().split(/\s+/u)
      const body = request.args.trim().slice(action.length).trim()
      if (!request.callback && (action === 'off' || action === 'on') && !body) {
        await options.setEnabled(action === 'on')
        actions.clear()
        if (action === 'on') await options.migrate()
        return reply(action === 'on' ? 'Brain включён.' : 'Brain выключен.')
      }
      if (!request.callback && (!action || action === 'status')) return status(await options.status())
      if (!options.enabled()) return reply('Brain выключен. /memory on')
      await options.migrate()
      if (request.callback) {
        const run = actions.get(request.callback)
        actions.delete(request.callback)
        return run ? run() : reply(stale)
      }
      const id = legacyFactId(args[0] ?? '')
      const validId = FactIdSchema.safeParse(id).success
      if (action === 'list' || action === 'tasks') {
        const kind = FactKindSchema.safeParse(args[0])
        const page = Number((kind.success ? args[1] : args[0]) ?? 1)
        if (!Number.isSafeInteger(page) || page < 1) return reply('Укажите вид записи или номер страницы.')
        return list(page, action === 'tasks' ? 'task' : kind.success ? kind.data : undefined)
      }
      if (action === 'pending') {
        const page = Number(args[0] ?? 1)
        return Number.isSafeInteger(page) && page > 0 ? pending(page) : reply('Укажите номер страницы.')
      }
      if (action === 'approve' || action === 'reject') {
        if (!/^[\w-]{1,64}$/u.test(id) || args.length !== 1) return reply('Укажите ID предложения.')
        return review(id, action === 'approve')
      }
      if (action === 'show' && validId) return show(id)
      if (action === 'forget') {
        if (!validId || args.length !== 1) return reply('Укажите один ID записи.')
        const fact = await facts.get(id)
        return fact ? writeResult(await writer().remove(id, fact.revision), 'Запись удалена.') : reply('Запись не найдена.')
      }
      if (action === 'done' && validId) {
        const fact = await facts.get(id)
        return fact?.kind === 'task' ? writeResult(await writer().done(id, 'done', fact.revision), 'Задача закрыта.')
          : reply('Задача не найдена.')
      }
      if (action === 'edit' && validId) {
        const rest = body.slice(args[0]!.length).trim()
        const explicit = /^r(\d+)\s+([\s\S]+)$/u.exec(rest)
        const fact = await facts.get(id)
        if (!rest) return reply(`/memory edit ${id} <новый текст>`)
        if (!fact || (explicit && Number(explicit[1]) !== fact.revision)) return reply(stale)
        const text = (explicit?.[2] ?? rest).trim()
        if (!text || clean(text) !== text) return reply('Проверьте текст записи.')
        const { kind, owner_message_id, status: taskStatus } = fact
        return writeResult(await writer().put({
          id, kind, owner_message_id, status: taskStatus, source: SOURCE_TG_COMMAND, description: factDescription(text), body: text,
        }, fact.revision), 'Запись изменена.')
      }
      if ((action === 'add' || action === 'pin') && body) {
        if (clean(body) !== body) return reply('Уберите секреты из записи.')
        const existing = action === 'pin' && args.length === 1 && validId ? await facts.get(id) : null
        if (existing?.kind === 'pinned') return reply('Запись уже закреплена.')
        if (existing?.kind === 'task') return reply('Открытые задачи уже входят в приоритетную память.')
        if (existing) {
          return writeResult(await writer().put({
            id, kind: 'pinned', description: existing.description, body: existing.body, source: existing.source,
          }, existing.revision), 'Запись закреплена.')
        }
        return writeResult(await writer().put({
          id: 'tg-' + randomUUID(), kind: action === 'pin' ? 'pinned' : 'user',
          description: factDescription(body), body, source: SOURCE_TG_COMMAND,
        }), 'Запись сохранена.')
      }
      if (action === 'search') return search(body)
      if (action === 'day') {
        const date = DaySchema.safeParse(args[0] ?? (await summaries.digestDays()).at(-1) ?? clock.now().toISOString().slice(0, 10))
        if (!date.success) return reply('Укажите дату в формате ГГГГ-ММ-ДД.')
        const digest = await summaries.digest(date.data)
        return reply(digest ? [digest.day, ...digest.lines.map(formatDigestLine)].join('\n') : 'Дайджеста за этот день нет.')
      }
      if (action === 'handoff') {
        const current = await handoff.current()
        const delivered = current?.delivered ? current : options.lastHandoff()
        return reply(delivered ? handoff.render(delivered) : 'Переданный контекст пока отсутствует.')
      }
      return reply('Используйте /memory list|show|add|edit|forget|pin|tasks|done|pending|day|handoff|search|on|off.')
    },
  }
}
