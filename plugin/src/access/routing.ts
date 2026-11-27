export type InboundRoute = 'owner' | 'access' | 'drop'

/**
 * Where an inbound message goes. Only the owner takes the existing Codex path;
 * with KROT_MULTIUSER=1 anyone else reaches the access controller, which never
 * forwards to Codex. With the flag off, anyone else is dropped as before.
 */
export function inboundRoute(fromId: number, ownerId: number, accessEnabled: boolean): InboundRoute {
  if (fromId === ownerId) return 'owner'
  return accessEnabled ? 'access' : 'drop'
}

/** Owner commands the access layer answers; undefined leaves the name to the existing handlers. */
export function accessCommand(name: string, accessEnabled: boolean): 'users' | 'start' | 'chats' | undefined {
  if (!accessEnabled) return undefined
  return name === 'users' || name === 'start' || name === 'chats' ? name : undefined
}
