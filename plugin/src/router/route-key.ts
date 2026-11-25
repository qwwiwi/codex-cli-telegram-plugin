// Route-key abstraction for per-topic session isolation.
//
// Background: the multichat router keys EVERYTHING (tmux session, inbox/outbox
// dirs, persona, status, maps) by a single opaque string that used to be the
// Telegram chat_id. To give each forum TOPIC its own claude context we need a
// finer key than chat_id alone — but Telegram sends still target the real
// chat_id (+ a message_thread_id for the topic).
//
// Design: keep ONE opaque key — the `routeKey` — flowing through the whole
// session/bridge/hook layer (which never needs to know it isn't a chat_id),
// and translate `routeKey → {chatId, topicId}` only at the Telegram boundary.
//
//   routeKey shape:
//     "<chatId>"                non-forum / non-per-topic chat (unchanged)
//     "<chatId>__t<topicId>"    a specific open forum topic
//
// The `__t` separator is filesystem-safe (path segment) and tmux-session-name
// safe (no `.`/`:`). `chatId` keeps its strict `/^-?\d+$/` shape; `topicId` is
// a positive integer (Telegram thread ids are positive message ids).
import { assertValidChatId } from '../chats/policy-loader.js'

// Separator between the chat id and the topic id inside a composite routeKey.
// Chosen so it cannot occur inside a numeric chat id or topic id, keeping
// split() unambiguous.
export const ROUTE_KEY_TOPIC_SEP = '__t'

// Telegram thread ids are message ids: positive integers, no leading zero,
// bounded well under the chat-id length cap. 18 digits is already past any
// real Telegram id.
const TOPIC_ID_PATTERN = /^[1-9]\d{0,17}$/

export interface RouteParts {
  chatId: string
  topicId?: string
}

/**
 * Build a routeKey from a chat id and an optional topic id.
 * With no topicId the routeKey IS the chat id (back-compat: existing
 * non-forum chats keep their current key, dirs, and sessions).
 *
 * @throws TypeError when chatId or topicId is malformed.
 */
export function buildRouteKey(chatId: string, topicId?: string): string {
  assertValidChatId(chatId)
  if (topicId === undefined || topicId === '') {
    return chatId
  }
  if (!TOPIC_ID_PATTERN.test(topicId)) {
    throw new TypeError(
      `invalid topic id ${JSON.stringify(topicId)}: must match /^[1-9]\\d*$/`,
    )
  }
  return `${chatId}${ROUTE_KEY_TOPIC_SEP}${topicId}`
}

/**
 * Validate a routeKey (composite OR plain chat id). Used at the bridge / pool
 * layer in place of {@link assertValidChatId}, which is kept strict for the
 * Telegram boundary where only real chat ids are allowed.
 *
 * @throws TypeError when the routeKey is malformed.
 */
export function assertValidRouteKey(routeKey: string): void {
  if (typeof routeKey !== 'string') {
    throw new TypeError(
      `invalid route key: expected string, got ${typeof routeKey}`,
    )
  }
  const sepIdx = routeKey.indexOf(ROUTE_KEY_TOPIC_SEP)
  if (sepIdx === -1) {
    // Plain chat id — defer entirely to the strict chat-id validator.
    assertValidChatId(routeKey)
    return
  }
  const chatId = routeKey.slice(0, sepIdx)
  const topicId = routeKey.slice(sepIdx + ROUTE_KEY_TOPIC_SEP.length)
  assertValidChatId(chatId)
  if (!TOPIC_ID_PATTERN.test(topicId)) {
    const sample = topicId.length > 32 ? `${topicId.slice(0, 32)}…` : topicId
    throw new TypeError(
      `invalid route key topic segment ${JSON.stringify(sample)}: ` +
        `must match /^[1-9]\\d*$/`,
    )
  }
}

/**
 * Split a routeKey back into its real chat id and optional topic id. The
 * inverse of {@link buildRouteKey}. Validates as a side effect.
 */
export function splitRouteKey(routeKey: string): RouteParts {
  assertValidRouteKey(routeKey)
  const sepIdx = routeKey.indexOf(ROUTE_KEY_TOPIC_SEP)
  if (sepIdx === -1) {
    return { chatId: routeKey }
  }
  return {
    chatId: routeKey.slice(0, sepIdx),
    topicId: routeKey.slice(sepIdx + ROUTE_KEY_TOPIC_SEP.length),
  }
}

// Minimal structural view of the policy needed to decide routing — just the
// `chats` map. Kept loose so this module does not couple to the full
// MultichatPolicy type (and its zod-derived shape).
export interface RoutablePolicy {
  chats: Record<string, unknown>
}

/**
 * Decide the routeKey for an inbound message.
 *
 * Rule: if the chat has a per-topic policy entry for THIS topic
 * (`policy.chats["<chatId>__t<topicId>"]` exists), route to that per-topic
 * session. Otherwise fall back to the plain chat id — so non-forum chats and
 * forum chats without per-topic config keep a single shared session exactly
 * as before.
 *
 * The open-topics gate (handlers.ts) runs BEFORE this, so by the time a forum
 * message reaches here its topicId is already one the operator allowed.
 */
export function deriveRouteKey(
  chatId: string,
  topicId: string | undefined,
  policy: RoutablePolicy | undefined,
): string {
  if (topicId === undefined || topicId === '' || policy === undefined) {
    return chatId
  }
  let composite: string
  try {
    composite = buildRouteKey(chatId, topicId)
  } catch {
    // Malformed topic id — degrade to the chat-level session rather than
    // dropping the message.
    return chatId
  }
  return Object.prototype.hasOwnProperty.call(policy.chats, composite)
    ? composite
    : chatId
}
