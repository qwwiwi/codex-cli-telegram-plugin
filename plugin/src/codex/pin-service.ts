// Every HUD bump re-pins the fresh card and Telegram drops a «<bot> закрепил(а) …»
// service bubble into the chat each time. Delete only the service messages
// this bot caused; the owner's own pins are never touched.

export type PinServiceMessage = { chat: { id: number }; from?: { id: number } | undefined; pinned_message?: unknown }
export type PinServiceDeps = {
  botId: number
  remove: () => Promise<unknown>
  warn: (message: string, context: Record<string, unknown>) => void
}

/** Starts a best-effort delete of this bot's pin service message; returns whether it was ours. */
export function removeOwnPinService(message: PinServiceMessage, deps: PinServiceDeps): boolean {
  if (message.pinned_message === undefined || deps.botId <= 0 || message.from?.id !== deps.botId) return false
  void deps.remove().catch((error: unknown) => {
    deps.warn('Could not delete the pin service message', {
      chat_id: String(message.chat.id),
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return true
}
