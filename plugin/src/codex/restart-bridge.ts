import type { Message } from 'grammy/types'

const marker = '[[KROT_SELF_RESTART]]'
const verificationMarker = '[[KROT_SELF_RESTART_VERIFY]]'
const requestPrefix = /^(?:(?:пожалуйста|please|можешь(?:\s+ли)?|could you|can you)[\s,:]+|@?[\p{L}\p{N}_-]{1,32},\s+){0,2}/iu
const deferredPrefix = /^(?:когда\s+(?:закончишь|завершишь)(?:\s+(?:текущую\s+)?(?:задачу|работу))?\s*,\s*|(?:затем|потом|then)\s+)/iu
const restartBridge = /^(?:перезапустись|перезапуст(?:и|ить)\s+(?:себя|(?:(?:сам|свой|собственный)\s+)?(?:telegram[- ]?|телеграм[- ]?)?(?:мост|бота))|(?:restart|reboot)\s+(?:yourself|(?:(?:the|your|this)\s+)?(?:telegram\s+)?(?:bridge|bot)))(?![\p{L}\p{N}_-])/iu
const restartAppServer = /^(?:перезапуст(?:и|ить)|restart|reboot)\s+(?:(?:the|свой)\s+)?(?:codex[ -]+app[ -]+server|(?:сервер|апп-сервер)\s+codex)(?![\p{L}\p{N}_-])/iu
const negatedRestart = /(?:^|[^\p{L}])(?:не\s+(?:перезапускай|перезапусти|перезапускать|перезапустись)|(?:do\s+not|don['’]t|never)\s+(?:restart|reboot))(?!\p{L})/iu
const followUp = /(?:^|[,;.!?]\s+|\n+)\s*(?:(?:и|and)\s+)?(?:(?:после\s+(?:перезапуска|рестарта)|after\s+(?:(?:the|a)\s+)?(?:restart|reboot)|затем|потом|then)[,\s]+)?(?:проверь|подтверди|убедись|продолжи|сообщи|доложи|verify|check|confirm|resume|continue|report)(?![\p{L}\p{N}_-])/iu
const negatedFollowUp = /(?:^|[^\p{L}])(?:не\s+(?:проверяй|проверь|подтверждай|подтверди|продолжай|продолжи|сообщай)|(?:do\s+not|don['’]t|never|no\s+need\s+to)\s+(?:verify|check|confirm|resume|continue|report))(?!\p{L})/iu

function restartRequestTail(text: string | undefined, directBackend: boolean): string | undefined {
  if (!text || negatedRestart.test(text)) return undefined
  const request = text.trim().replace(requestPrefix, '').replace(deferredPrefix, '')
  const match = restartBridge.exec(request) ?? (directBackend ? restartAppServer.exec(request) : null)
  return match ? request.slice(match[0].length) : undefined
}

export function restartOwnerText(message: Message, voiceTranscript?: string): string | undefined {
  if (message.message_id <= 0 || message.forward_origin || message.reply_to_message) return undefined
  return message.text ?? (message.voice ? voiceTranscript : undefined)
}

export function ownerRequestedBridgeRestart(text: string | undefined, directBackend = false): boolean {
  return restartRequestTail(text, directBackend) !== undefined
}

export function ownerRequestedRestartVerification(text: string | undefined): boolean {
  const remainder = restartRequestTail(text, true)
  return remainder !== undefined && !negatedFollowUp.test(remainder) && followUp.test(remainder)
}

export const bridgeRestartInstructions = 'Если поручение владельца требует перезапуска самого Telegram-моста, ' +
  'сначала подготовь итоговый ответ и поставь отдельной последней строкой ' + marker +
  '. Мост доставит ответ, дождётся освобождения очереди и предупредит владельца перед перезапуском. ' +
  'Используй эту строку только для перезапуска Telegram-моста.'

export const bridgeRestartDirectInstructions = 'Этот мост запускает свой экземпляр Codex App Server. ' +
  'Перезапуск моста также перезапускает этот экземпляр Codex App Server.'

export const bridgeRestartVerificationInstructions = 'Владелец также попросил проверку после перезапуска. ' +
  'Подготовь итоговый ответ перед перезапуском и поставь отдельной последней строкой ' + verificationMarker +
  '. В новом процессе мост восстановит текущий диалог, проверит соединение и запросит короткий отчёт.'

export function bridgeRestartReply(reply: string, eligible: boolean, continuing: boolean, verificationEligible = false): {
  text: string; requested: boolean; verify?: true
} {
  const text = reply.trimEnd()
  const control = [marker, verificationMarker].find(value => text === value || text.endsWith('\n' + value))
  if (!eligible || !control) return { text: reply, requested: false }
  const answer = text.slice(0, -control.length).trimEnd()
  const verify = control === verificationMarker
  const requested = !!answer && !continuing && (verificationEligible || !verify)
  return { text: answer, requested, ...(requested && verify ? { verify: true } : {}) }
}

type RestartHooks = {
  idle: () => boolean
  notify: () => Promise<unknown>
  restart: () => void
  onNotifyError: () => void
}

export class BridgeRestart {
  private requested = false
  private notifying = false
  private notified = false
  private epoch = 0

  constructor(private hooks: RestartHooks) {}

  request(): void {
    this.requested = true
  }

  cancel(): void {
    this.epoch++
    this.requested = false
    this.notified = false
  }

  async check(): Promise<void> {
    if (!this.requested || this.notifying || !this.hooks.idle()) return
    if (!this.notified) {
      const epoch = this.epoch
      this.notifying = true
      try {
        await this.hooks.notify()
        if (epoch !== this.epoch) return
        this.notified = true
      } catch {
        this.hooks.onNotifyError()
        return
      } finally {
        this.notifying = false
      }
    }
    if (!this.hooks.idle()) return
    this.cancel()
    this.hooks.restart()
  }
}
