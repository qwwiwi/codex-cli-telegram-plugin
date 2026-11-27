// Owner commands /restart and /update [check | rollback | codex [check]] (docs/design/self-update-spec.md, S6 and S9).
// Every answer goes to the owner before the restart; the restart itself is the caller's: it
// records the intent (restart-intent.ts) and exits 75, so systemd starts the bridge again.
import type { IdleApply, UpdateAttempt } from './auto-update.js'
import type { CodexCheck, CodexApply, CodexRollback } from './codex-update.js'
import type { RestartAdmission, RestartIntent } from './restart-intent.js'
import { refusedRestartText } from './restart-intent.js'
import type { ApplyResult, RollbackResult, UpdateCheck } from './self-update.js'

export interface UpdateCommandDeps {
  send: (text: string) => Promise<unknown>
  /** The notice before a committed step's restart: bounded, never rejects (RestartNotices.acknowledge). */
  acknowledge: (text: string) => Promise<void>
  /** True while a task, a goal or a queue is running: an update waits for it. */
  busy: () => boolean
  /** Records the intent and, when admitted, ends the process with exit 75. */
  restart: (kind: RestartIntent['kind'], ownerMessageId: number | undefined, toCommit?: string) => RestartAdmission
  selfUpdate: {
    check(): Promise<UpdateCheck>
    apply(plan: Extract<UpdateCheck, { kind: 'plan' }>): Promise<ApplyResult>
    rollback(): Promise<RollbackResult>
  }
  /** Undefined behind the root relay: there Codex belongs to the server, not to this bridge. */
  codexUpdate: {
    check(): Promise<CodexCheck>
    apply(check: Extract<CodexCheck, { kind: 'newer' }>): Promise<CodexApply>
    rollback(): CodexRollback
  } | undefined
  /** True while the boot after /update has not reached the health mark: a restart now would roll it back. */
  trialPending?: () => boolean
  /** True while an owner turn, goal or side thread runs (queued messages do not count): a restart waits for it. */
  turnActive: () => boolean
  sleep: (ms: number) => Promise<void>
  /** The reservation ended without a restart: the bridge may start the turns that queued meanwhile. */
  onIdle?: () => void
  /** R29: the last update attempt, shown by /doctor; must not throw. */
  recordAttempt?: (attempt: Omit<UpdateAttempt, 'at'>) => void
}

const short = (sha: string) => sha.slice(0, 12)
const busyText = 'Сейчас идёт задача. Дождись её конца или отправь /stop, потом повтори команду.'
const stageText: Record<string, string> = {
  state: 'проверка копии', guard: 'проверка запуска (boot-guard.sh)', merge: 'git fast-forward', install: 'установка зависимостей', tsc: 'проверка типов (tsc)',
  version: 'проверка версии', handshake: 'проверка связи с Codex App Server',
}

// «обнови кодекс», «обнови, пожалуйста, Codex», «update codex»: the whole message, nothing else in it.
const codexRequest = /^(?:обнови(?:ть)?|update)(?:[\s,]+(?:пожалуйста|please))?[\s,]+(?:кодекс|codex)(?:[\s,]+(?:пожалуйста|please))?[\s.!]*$/iu

/** The owner asked in plain words to update Codex («обнови кодекс»). */
export function isCodexUpdateRequest(text: string | undefined): boolean {
  return codexRequest.test((text ?? '').trim())
}

export class UpdateCommands {
  // One maintenance reservation for /restart, /update, /update rollback and /update codex. While it is
  // held no other of them starts and the bridge admits no new owner turn (maintenance()); it is taken
  // synchronously, before the first await, so two commands can never both pass the check.
  private reserved: 'restart' | 'update' | undefined

  constructor(readonly deps: UpdateCommandDeps) {}

  /** True while a restart or an update holds the reservation: the bridge must not start an owner turn. */
  maintenance(): boolean {
    return this.reserved !== undefined
  }

  /** Handles /restart and /update; false for any other command. */
  async handle(name: string, args: string, messageId: number | undefined): Promise<boolean> {
    if (name !== 'restart' && name !== 'update') return false
    const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (name === 'update' && words.length > 0 && !['codex', 'кодекс', 'rollback', 'check'].includes(words[0]!)) {
      // Unknown subcommand: help only; the reservation of a running command stays untouched.
      await this.deps.send('/update — обновить мост\n/update check — только показать обновления\n' +
        '/update rollback — вернуть версию до последнего /update\n/update codex — обновить Codex\n' +
        '/update codex rollback — вернуть Codex до последнего /update codex')
      return true
    }
    if (this.reserved) {
      await this.deps.send(this.reserved === 'restart' ? 'Уже перезапускаюсь.'
        : name === 'restart' ? 'Сейчас идёт обновление. Не перезапускаюсь: перезапущусь сам, когда оно закончится.'
          : 'Обновление уже идёт.')
      return true
    }
    if (name === 'restart' && this.deps.trialPending?.()) {
      await this.deps.send('Новая версия ещё проверяется после /update (до 3 минут). Перезапуск сейчас откатил бы её. ' +
        'Повтори /restart чуть позже или верни прежнюю версию командой /update rollback.')
      return true
    }
    this.reserved = name
    let restarting = false
    try {
      if (name === 'restart') {
        // The owner asked for it: no wait for idle (a /restart often ends a stuck turn). The planned
        // restart's own stop notice («Перезапускаю мост…», with the measured time) is the only message.
        restarting = await this.restart('restart', messageId, undefined, false)
      } else if ((words[0] === 'codex' || words[0] === 'кодекс') && words[1] === 'rollback') restarting = await this.codexRollback(messageId)
      else if (words[0] === 'codex' || words[0] === 'кодекс') restarting = await this.codex(words[1] === 'check', messageId)
      else if (words[0] === 'rollback') restarting = await this.rollback(messageId)
      else restarting = await this.update(words[0] === 'check', messageId)
    } finally {
      // An admitted restart keeps the reservation until the process exits: no turn starts in between.
      if (!restarting) {
        this.reserved = undefined
        this.deps.onIdle?.()
      }
    }
    return true
  }

  /**
   * R29: applies a plan whose staged check passed, only while nothing runs: no owner turn, goal or side
   * thread, no queued message, no other /restart or /update, no trial boot. The reservation is taken
   * synchronously after the idle check, so no turn can start between the check and the apply.
   */
  async applyWhenIdle(plan: Extract<UpdateCheck, { kind: 'plan' }>, trigger: 'auto' | 'owner' = 'auto'): Promise<IdleApply> {
    if (this.reserved || this.deps.busy() || this.deps.turnActive() || this.deps.trialPending?.()) return { kind: 'busy' }
    this.reserved = 'update'
    let restarting = false
    try {
      const result = await this.deps.selfUpdate.apply(plan)
      if (!result.ok) {
        const detail = (stageText[result.stage] ?? result.stage) + ': ' + result.detail
        this.deps.recordAttempt?.({ trigger, result: 'apply_failed', from: plan.from, to: plan.to, detail })
        return { kind: 'failed', detail, restored: result.restored }
      }
      this.deps.recordAttempt?.({ trigger, result: 'applied', from: plan.from, to: plan.to })
      await this.notify(`${trigger === 'owner' ? 'Обновление по /cc update' : 'Автообновление'}: установил ` +
        `${short(plan.from)} → ${short(plan.to)} (новых коммитов: ${plan.total}). ` +
        'Перезапускаюсь. Если новая версия не заработает, сам верну прежнюю и напишу.')
      restarting = await this.restart('update', undefined, result.to)
      // A refused restart (loop guard) leaves the new commit installed; it starts with the next restart.
      return restarting ? { kind: 'restarting' } : { kind: 'installed' }
    } finally {
      if (!restarting) {
        this.reserved = undefined
        this.deps.onIdle?.()
      }
    }
  }

  /** A notice before a committed step: a failed or silent Telegram send must never stop the restart. */
  private async notify(text: string): Promise<void> {
    await this.deps.acknowledge(text)
  }

  /** Restarts once no turn runs (a turn admitted before the reservation finishes first); true when admitted. */
  private async restart(kind: RestartIntent['kind'], messageId: number | undefined, toCommit?: string, waitIdle = true): Promise<boolean> {
    if (waitIdle && this.deps.turnActive()) {
      await this.notify('Жду, пока закончится текущая задача, потом перезапущусь.')
      while (this.deps.turnActive()) await this.deps.sleep(1000)
    }
    const admitted = this.deps.restart(kind, messageId, toCommit)
    if (!admitted.ok) await this.notify(refusedRestartText(admitted.reason))
    return admitted.ok
  }

  /** True when the restart was admitted (the process is ending). */
  private async update(checkOnly: boolean, messageId: number | undefined): Promise<boolean> {
    if (!checkOnly && this.deps.busy()) {
      await this.deps.send(busyText)
      return false
    }
    const plan = await this.deps.selfUpdate.check()
    if (plan.kind === 'refused') {
      await this.deps.send(plan.text)
      return false
    }
    if (plan.kind === 'current') {
      await this.deps.send('Мост уже последней версии (' + short(plan.head) + ').')
      return false
    }
    const list = plan.commits.map(line => '• ' + line).join('\n') +
      (plan.total > plan.commits.length ? `\n… и ещё ${plan.total - plan.commits.length}` : '')
    const head = `Новых коммитов: ${plan.total} (${short(plan.from)} → ${short(plan.to)}).\n\n${list}`
    if (checkOnly) {
      await this.deps.send(head + '\n\nЧтобы установить, отправь /update.')
      return false
    }
    await this.deps.send(head + '\n\nОбновляю. После перезапуска проверю, что новая версия работает; если нет, сам верну прежнюю и напишу.')
    const result = await this.deps.selfUpdate.apply(plan)
    this.deps.recordAttempt?.(result.ok ? { trigger: 'manual', result: 'applied', from: plan.from, to: plan.to }
      : { trigger: 'manual', result: 'apply_failed', from: plan.from, to: plan.to, detail: (stageText[result.stage] ?? result.stage) + ': ' + result.detail })
    if (!result.ok) {
      await this.deps.send('Не обновился: ' + (stageText[result.stage] ?? result.stage) + '.\n\n' + result.detail + '\n\n' +
        (result.restored ? 'Копия осталась на прежней версии, бот работает как раньше.'
          : '⚠️ Вернуть прежнюю версию автоматически не получилось. Проверь на сервере git status и bun install.'))
      return false
    }
    // Committed: the checkout is on the new commit, so the restart happens whatever Telegram does.
    await this.notify('Обновление установлено, перезапускаюсь.')
    return this.restart('update', messageId, result.to)
  }

  private async rollback(messageId: number | undefined): Promise<boolean> {
    if (this.deps.busy()) {
      await this.deps.send(busyText)
      return false
    }
    const result = await this.deps.selfUpdate.rollback()
    if (!result.ok) {
      await this.deps.send(result.text)
      return false
    }
    await this.notify('Вернул версию ' + short(result.to) + ' (была ' + short(result.from) + '). Перезапускаюсь.')
    return this.restart('rollback', messageId, result.to)
  }

  private async codexRollback(messageId: number | undefined): Promise<boolean> {
    const codex = this.deps.codexUpdate
    if (!codex) {
      await this.deps.send('Откат Codex из чата недоступен: этот мост работает с Codex сервера через root relay.')
      return false
    }
    if (this.deps.busy()) {
      await this.deps.send(busyText)
      return false
    }
    const result = codex.rollback()
    if (!result.ok) {
      await this.deps.send(result.text)
      return false
    }
    await this.notify('Вернул Codex ' + result.to + ' (был ' + result.from + '). Перезапускаюсь.')
    return this.restart('codex', messageId)
  }

  private async codex(checkOnly: boolean, messageId: number | undefined): Promise<boolean> {
    const codex = this.deps.codexUpdate
    if (!codex) {
      await this.deps.send('Обновление Codex из чата недоступно: этот мост работает с Codex сервера через root relay. Обнови Codex на сервере.')
      return false
    }
    if (!checkOnly && this.deps.busy()) {
      await this.deps.send(busyText)
      return false
    }
    const check = await codex.check()
    if (check.kind === 'refused') {
      await this.deps.send(check.text)
      return false
    }
    if (check.kind === 'current') {
      await this.deps.send('Codex уже последней версии: ' + check.installed + '.')
      return false
    }
    const head = `Codex: установлен ${check.installed}, доступен ${check.latest}.\n\nЧто нового:\n${check.changelog}`
    if (checkOnly) {
      await this.deps.send(head + '\n\nЧтобы установить, отправь /update codex.')
      return false
    }
    await this.deps.send(head + '\n\nОбновляю Codex.')
    const result = await codex.apply(check)
    if (!result.ok) {
      await this.deps.send('Не обновил Codex: ' + (stageText[result.stage] ?? result.stage) + '. ' + result.detail + '\n\n' +
        (result.restored ? 'Вернул прежнюю версию ' + check.installed + ', всё работает как раньше.'
          : '⚠️ Прежнюю версию ' + check.installed + ' вернуть не удалось. /doctor покажет сохранённую копию; ' +
            'на сервере: npm install -g @openai/codex@' + check.installed))
      return false
    }
    await this.notify(`Codex обновлён: ${result.from} → ${result.to}.\nМодели: ${result.models.join(', ') || 'список пуст'}\n\n` +
      'Перезапускаюсь, чтобы работать на новом Codex. Новые модели будут в /cc → Модель сразу после перезапуска.')
    return this.restart('codex', messageId)
  }
}
