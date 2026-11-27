import { expect, test } from 'bun:test'

import { PublicRouter, PublicUnavailableError } from '../../src/codex/public-lane.js'
import type { PublicTurnProfile } from '../../src/codex/session.js'

function backend(name: string) {
  const calls: string[] = []
  const stopped: string[] = []
  let alive = true
  return {
    calls, stopped,
    kill: () => { alive = false },
    entry: {
      alive: () => alive,
      runner: {
        runPublic: async (text: string, _profile: PublicTurnProfile) => {
          calls.push(text)
          return { status: 'completed' as const, text: name, threadId: name + '-t', toolItems: 0 }
        },
        stopPublic: async (threadId: string) => { stopped.push(threadId); return threadId.startsWith(name) },
      },
    },
  }
}

test('S4 router: each role runs on its own public app-server, never another one', async () => {
  const member = backend('member')
  const guest = backend('guest')
  const router = new PublicRouter({ member: member.entry, guest: guest.entry })
  expect((await router.runPublic('a', { cwd: '/c', instructions: 'i', role: 'member' })).text).toBe('member')
  expect((await router.runPublic('b', { cwd: '/c', instructions: 'i', role: 'guest' })).text).toBe('guest')
  expect(member.calls).toEqual(['a'])
  expect(guest.calls).toEqual(['b'])
  expect(await router.stopPublic('guest-t')).toBe(true)
})

test('S4 router: a dead or missing public app-server is unavailable, with no fallback', async () => {
  const member = backend('member')
  const guest = backend('guest')
  const router = new PublicRouter({ member: member.entry, guest: guest.entry })
  guest.kill()
  await expect(router.runPublic('b', { cwd: '/c', instructions: 'i', role: 'guest' })).rejects.toBeInstanceOf(PublicUnavailableError)
  await expect(router.runPublic('c', { cwd: '/c', instructions: 'i' })).rejects.toBeInstanceOf(PublicUnavailableError)
  expect(member.calls).toEqual([])
  expect(guest.calls).toEqual([])
})
