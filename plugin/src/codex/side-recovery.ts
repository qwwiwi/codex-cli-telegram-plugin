// Recovery of work that was in flight when the bridge stopped: an uncertain
// follow-up (turn/start sent, no answer yet) and side turns Codex accepted.
//
// Rules: a notice never quotes a synthetic (non-positive) message id, so it is
// sent as plain text; a notice Telegram refuses is logged and never blocks
// clearing the record or draining the queue; the body of a lost agent message
// is kept in the dead-letter store instead of being dropped.

import type { Message } from 'grammy/types'

import type { Logger } from '../log.js'
import type { CodexInbox } from './inbox.js'
import { taskTitle } from './parallel.js'
import { agentBody } from './provenance.js'

export interface RecoveryNotice {
  text: string
  replyTo?: number
}

export interface RecoveryDeps {
  send: (notice: RecoveryNotice) => Promise<void>
  /** Keeps the body of an agent message whose turn was lost. */
  deadLetter: (record: { agent: string; messageId: number; text: string; stage: 'unconfirmed' | 'interrupted' }) => void
  log: Logger
}

/** Settles follow-ups and side turns that were in flight when the bridge stopped. */
export async function recoverInterruptedWork(inbox: CodexInbox, deps: RecoveryDeps): Promise<void> {
  const followUp = inbox.uncertainFollowUp
  if (followUp) {
    await settle(inbox, followUp, 'unconfirmed', deps)
    inbox.finishFollowUp(followUp.message_id)
  }
  for (const job of inbox.sideJobs) {
    const first = job.messages[0]
    if (first) await settle(inbox, first, 'interrupted', deps)
    inbox.finishSide(job.id)
  }
}

async function settle(inbox: CodexInbox, message: Message, stage: 'unconfirmed' | 'interrupted',
  deps: RecoveryDeps): Promise<void> {
  const id = message.message_id
  const provenance = inbox.provenance(id)
  let text: string
  if (provenance.origin === 'agent') {
    const what = 'Сообщение от агента ' + provenance.agent + ' («' + taskTitle(agentBody(message.text)) + '»)'
    text = stage === 'unconfirmed'
      ? what + ': после перезапуска не удалось подтвердить, взял ли его Codex. Текст сохранён в журнале недоставленных.'
      : what + ': после перезапуска параллельная задача прервалась, результат не получен. Текст сохранён в журнале недоставленных.'
    try {
      deps.deadLetter({ agent: provenance.agent, messageId: id, text: message.text ?? '', stage })
    } catch { deps.log.warn('Could not keep a lost agent message') }
  } else {
    text = stage === 'unconfirmed'
      ? 'После перезапуска не удалось подтвердить, дошло ли это уточнение до Codex.'
      : 'После перезапуска параллельная задача прервалась, результат не получен. Проверь, что уже выполнено, прежде чем запускать её снова.'
  }
  try {
    await deps.send({ text, ...(id > 0 && provenance.origin === 'owner' ? { replyTo: id } : {}) })
  } catch {
    deps.log.warn('Could not send a recovery notice; clearing the record anyway')
  }
}
