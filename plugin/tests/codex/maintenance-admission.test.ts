// S9: while /restart or /update holds the maintenance reservation, no new Codex turn starts:
// not a compaction (/compact, /cc compact, the HUD button) and not a parallel side turn.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TurnAdmission } from '../../src/codex/turn-admission.js'

// Bind the production server code like server-side-brain.test.ts, without starting a Telegram poller.
const server = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
function section(start: string, end: string): string {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate server code: ' + start)
  return server.slice(from, to)
}

interface Bound {
  compact: () => Promise<void>
  launchSide: (message: { message_id: number }, reuse: string | undefined, provenance: { origin: string }) => boolean
}

function isBound(value: unknown): value is Bound {
  return typeof value === 'object' && value !== null && 'compact' in value && typeof value.compact === 'function' &&
    'launchSide' in value && typeof value.launchSide === 'function'
}

function bind(maintenance: boolean) {
  const sent: string[] = []
  const events: string[] = []
  const admission = new TurnAdmission({ running: () => false, maintenance: () => maintenance })
  const deps = {
    admission,
    send: async (text: string) => { sent.push(text) },
    codex: {
      isRunning: false, status: { hasThread: true },
      compact: () => { events.push('codex.compact'); return Promise.resolve('completed') },
    },
    work: { begin: () => { events.push('work.begin') }, finish: () => undefined },
    inbox: { beginFollowUp: () => { events.push('inbox.beginFollowUp'); return 'accepted' } },
  }
  const bound: unknown = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    const { admission, send, codex, work, inbox } = deps
    let task = undefined
    const stopping = false, memory = undefined, brain = { enabled: true }, hudReady = false
    const hudAnchor = { refresh: () => {} }, finishMirror = () => {}, startNext = () => {}
    ${section('    async function compact(): Promise<void> {', '    function cancelPendingBridgeRestart()')}
    ${section('    function launchSide(', '      if (hudReady) hudAnchor.ownerMessage()')}
      return true
    }
    return { compact, launchSide }
  `))(deps)
  if (!isBound(bound)) throw new Error('Could not bind the server code')
  return { ...bound, sent, events }
}

test('[S9] /compact under the maintenance reservation starts no Codex turn and answers «обновляюсь»', async () => {
  const server = bind(true)
  await server.compact()
  expect(server.events).toEqual([])
  expect(server.sent).toHaveLength(1)
  expect(server.sent[0]).toContain('обновляюсь')
})

test('[S9] /compact outside maintenance still compacts the thread', async () => {
  const server = bind(false)
  await server.compact()
  expect(server.events).toEqual(['work.begin', 'codex.compact'])
})

test('[S9] a parallel side turn is not launched under the maintenance reservation: the message waits in the inbox', () => {
  const blocked = bind(true)
  expect(blocked.launchSide({ message_id: 5 }, undefined, { origin: 'owner' })).toBe(false)
  expect(blocked.events).toEqual([])
  const open = bind(false)
  expect(open.launchSide({ message_id: 5 }, undefined, { origin: 'owner' })).toBe(true)
  expect(open.events).toEqual(['inbox.beginFollowUp'])
})
