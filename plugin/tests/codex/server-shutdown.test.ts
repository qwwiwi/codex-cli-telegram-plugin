// shutdown() of the production server, bound with fakes like server-side-brain.test.ts:
// the public lane stops first, before Brain, the sessions and the poller.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'codex', 'server.ts'), 'utf8')
function section(start: string, end: string): string {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate server shutdown code')
  return server.slice(from, to)
}

interface ShutdownDeps { calls: string[]; publicLane: { stop: () => void } | undefined }

const compiled = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { calls, publicLane } = deps
  let stopping = false
  const mark = name => () => { calls.push(name) }
  const armShutdownWatchdog = mark('watchdog')
  const startup = { ready: mark('startup.ready') }
  const health = { cancel: mark('health.cancel') }
  const learningAbort = { abort: mark('learning.abort') }
  const brain = { stop: mark('brain.stop') }
  const albums = { flushAll: mark('albums.flushAll') }
  const outboxTimer = undefined, watchdogTimer = undefined, workerStatusTimer = undefined, groupSweepTimer = undefined
  const questionTimer = undefined, recoveryTimer = undefined, goalRecoveryTimer = undefined
  const approvals = { cancelAll: mark('approvals.cancelAll') }
  const questions = { suspend: mark('questions.suspend') }
  const externalTasks = { close: mark('externalTasks.close') }
  const agentWebhook = { stop: async () => { calls.push('agentWebhook.stop') } }
  const session = { close: mark('session.close') }
  const publicSessions = [{ close: mark('publicSession.close') }]
  const poller = { stop: async () => { calls.push('poller.stop') } }
  ${section('  function shutdown(): void {', '  process.once(\'SIGINT\', shutdown)')}
  return shutdown
`))

function bindShutdown(deps: ShutdownDeps): () => void {
  const shutdown: unknown = compiled(deps)
  if (typeof shutdown !== 'function') throw new Error('The server shutdown section did not return a function')
  return () => { shutdown() }
}

test('F3 shutdown: the public lane stops first, so no queued public turn runs, apologizes or is journaled during the stop', () => {
  const calls: string[] = []
  const shutdown = bindShutdown({ calls, publicLane: { stop: () => { calls.push('publicLane.stop') } } })
  shutdown()
  expect(calls[0]).toBe('publicLane.stop')
  expect(calls).toContain('brain.stop')
  expect(calls).toContain('publicSession.close')
  // A second signal does nothing.
  shutdown()
  expect(calls.filter(call => call === 'publicLane.stop')).toHaveLength(1)
})

test('F3 shutdown: flag off (no public lane) still shuts down', () => {
  const calls: string[] = []
  bindShutdown({ calls, publicLane: undefined })()
  expect(calls).toContain('poller.stop')
})
