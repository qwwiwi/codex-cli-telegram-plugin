// The shape of an inter-agent worker delivery to the agent webhook: a worker header
// line, the sender's own words, then the worker's delivery protocol block.
// The body's agentId is the RECIPIENT, not the sender. Ids are placeholders.

export const workerSender = 'sender-agent'
export const workerRecipient = 'recipient-agent'

export const senderWords = 'Проверь, что очередь уведомлений пуста, и ответь коротко.'

export const protocolBlock = [
  'ПОРЯДОК ДЕЙСТВИЙ:',
  '1. Выполни просьбу из сообщения выше.',
  '2. Ответь отправителю через swarm.send.',
  '3. Подтверди получение: swarm.ack с delivery_id из этого сообщения.',
].join('\n')

export const workerMessage = [
  '[Inter-agent от ' + workerSender + ' → ' + workerRecipient + ']',
  '',
  senderWords,
  '',
  '---',
  protocolBlock,
].join('\n')

// The worker's ack-only variant: same --- separator, a parenthetical before the
// colon. The header line is verbatim; the step line is illustrative.
export const ackOnlyProtocolHeader = 'ПОРЯДОК ДЕЙСТВИЙ (ack-only fast path, без dual-report):'

export const ackOnlyProtocolBlock = [
  ackOnlyProtocolHeader,
  '1. Подтверди получение: swarm.ack с delivery_id из этого сообщения.',
].join('\n')

export const ackOnlyWorkerMessage = [
  '[Inter-agent от ' + workerSender + ' → ' + workerRecipient + ']',
  '',
  senderWords,
  '',
  '---',
  ackOnlyProtocolBlock,
].join('\n')

/** The JSON body the worker posts; agentId names the recipient. */
export function workerBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message: workerMessage, chatId: 1, agentId: workerRecipient, ...extra }
}
