// Seal before validation (secret hand-over design v2, section 7.1, minimal S0 version).
//
// A Mini App `sendData` payload arrives as `message.web_app_data`. It must never reach
// validation, the normal update handlers, the inbox, a dead letter or a log line. The poller
// runs `sealWebAppData` on every raw update first: a direct submission is taken out as a small
// hand-over object picked field by field; any nested copy (a reply, a pin) is blanked.

export interface WebAppHandover {
  update_id: number | undefined
  chat_id: number | undefined
  chat_type: string | undefined
  from_id: number | undefined
  from_is_bot: boolean | undefined
  message_id: number | undefined
  data: string
}

export type SealResult =
  | { kind: 'handover', handover: WebAppHandover }
  | { kind: 'update', update: unknown }

const MAX_DEPTH = 16
const MESSAGE_KEYS = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Replaces every nested web_app_data with an empty one. Returns the input itself when nothing
// changed, so updates without a hand-over stay byte-identical.
function strip(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(item => {
      const next = strip(item, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  const source = value as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'web_app_data') {
      out[key] = { data: '', button_text: '' }
      changed = true
      continue
    }
    const next = strip(item, depth + 1)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

/** Never throws. A direct web_app_data submission becomes `handover`; everything else passes, stripped. */
export function sealWebAppData(raw: unknown): SealResult {
  try {
    const update = record(raw)
    if (!update) return { kind: 'update', update: raw }
    for (const key of MESSAGE_KEYS) {
      const message = record(update[key])
      const webApp = message ? record(message.web_app_data) : undefined
      if (!message || !webApp) continue
      const chat = record(message.chat)
      const from = record(message.from)
      return {
        kind: 'handover',
        handover: {
          update_id: num(update.update_id),
          chat_id: num(chat?.id),
          chat_type: typeof chat?.type === 'string' ? chat.type : undefined,
          from_id: num(from?.id),
          from_is_bot: typeof from?.is_bot === 'boolean' ? from.is_bot : undefined,
          message_id: num(message.message_id),
          data: typeof webApp.data === 'string' ? webApp.data : '',
        },
      }
    }
    return { kind: 'update', update: strip(raw, 0) }
  } catch {
    // A hostile getter or a cycle: keep nothing of it.
    return { kind: 'update', update: undefined }
  }
}
