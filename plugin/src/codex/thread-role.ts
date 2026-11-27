// Thread roles for the Codex permission hook (S4, defence in depth).
//
// The hook runs inside Codex for every tool call and asks the bridge on
// loopback which thread made it. A member or guest thread already has no
// tools by profile; this second layer denies anything that still gets through.

import { object } from './rpc.js'
import type { ThreadRole } from './session.js'

export const THREAD_ROLE_PATH = '/hooks/thread-role'

/**
 * Whether a thread may run tools. With multi-user on, only threads the bridge
 * can vouch for (the owner's own, his subagents, agent turns) may; a public or
 * unknown thread may not. With it off there are no public threads and the
 * hook keeps its old behaviour.
 */
export function threadToolAccess(role: ThreadRole, multiuser: boolean): boolean {
  if (role === 'public') return false
  if (!multiuser) return true
  return role === 'owner' || role === 'agent'
}

/** The hook side: asks the bridge and returns true only on an explicit allow. Never throws. */
export async function askThreadRole(port: number, token: string, threadId: unknown): Promise<boolean> {
  if (typeof threadId !== 'string' || !/^[\w:-]{1,128}$/u.test(threadId)) return false
  try {
    const result = await fetch('http://127.0.0.1:' + port + THREAD_ROLE_PATH, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId }),
    })
    if (!result.ok) return false
    const body: unknown = await result.json()
    return object(body).allow === true
  } catch {
    return false
  }
}
