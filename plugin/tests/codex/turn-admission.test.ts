import { expect, test } from 'bun:test'

import { TurnAdmission } from '../../src/codex/turn-admission.js'
import { UpdateCommands, type UpdateCommandDeps } from '../../src/codex/update-commands.js'

const plan = { kind: 'plan' as const, from: 'a'.repeat(40), to: 'b'.repeat(40), total: 1, commits: ['bbbbbbb Next'] }

/** An /update whose check hangs until release(): the maintenance reservation is held meanwhile. */
function pausedUpdate(busy: () => boolean = () => false) {
  let release: () => void = () => undefined
  const checked = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  const deps: UpdateCommandDeps = {
    send: async text => { events.push('send:' + text.slice(0, 20)) },
    acknowledge: async text => { events.push('send:' + text.slice(0, 20)) },
    busy,
    turnActive: () => false,
    sleep: async () => undefined,
    restart: () => { events.push('restart'); return { ok: true } },
    selfUpdate: {
      check: async () => { await checked; return plan },
      apply: async () => { events.push('apply'); return { ok: true, from: plan.from, to: plan.to } },
      rollback: async () => ({ ok: true, from: plan.to, to: plan.from }),
    },
    codexUpdate: undefined,
  }
  return { commands: new UpdateCommands(deps), release, events }
}

test('[S9] no owner turn starts from the inbox while an /update holds the maintenance reservation', async () => {
  const update = pausedUpdate()
  const admission = new TurnAdmission({ running: () => false, maintenance: () => update.commands.maintenance() })
  expect(admission.blocker()).toBeUndefined()
  const running = update.commands.handle('update', 'check', 1)
  expect(admission.blocker()).toBe('maintenance')
  update.release()
  await running
  expect(admission.blocker()).toBeUndefined()
})

test('[S9] /goal cannot start during /update: the claim is refused while the reservation is held', async () => {
  const update = pausedUpdate()
  const admission = new TurnAdmission({ running: () => false, maintenance: () => update.commands.maintenance() })
  const running = update.commands.handle('update', 'check', 1)
  expect(admission.claim()).toBeUndefined()
  expect(admission.claiming).toBe(false)
  update.release()
  await running
  const release = admission.claim()
  expect(release).toBeDefined()
  release?.()
})

test('[S9] a /goal start claimed before its first await keeps /update out until it is released', async () => {
  let admission: TurnAdmission | undefined
  const update = pausedUpdate(() => admission?.claiming ?? false)
  admission = new TurnAdmission({ running: () => false, maintenance: () => update.commands.maintenance() })
  const release = admission.claim()
  expect(release).toBeDefined()
  // Another start is refused as busy while the first one is still admitting.
  expect(admission.blocker()).toBe('busy')
  update.release()
  await update.commands.handle('update', '', 1)
  expect(update.events).not.toContain('apply')
  expect(update.events).not.toContain('restart')
  release?.()
  expect(admission.claiming).toBe(false)
  expect(admission.blocker()).toBeUndefined()
})

test('a running turn blocks a new one as busy', () => {
  let running = true
  const admission = new TurnAdmission({ running: () => running, maintenance: () => false })
  expect(admission.blocker()).toBe('busy')
  expect(admission.claim()).toBeUndefined()
  running = false
  expect(admission.blocker()).toBeUndefined()
})
