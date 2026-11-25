import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import { CodexWorkStatus } from '../../src/codex/work-status.js'
import { renderActivityBlock } from '../../src/status/activity-renderer.js'
import type { StatusHandle, StatusState } from '../../src/status/status-manager.js'

function fixture(now = () => 1000) {
  const states: StatusState[] = []
  let active = false
  let completed = 0
  const status = new CodexWorkStatus({
    async start(chatId, _reply, state = { kind: 'typing' }) {
      active = true
      states.push(state)
      return { chatId, messageId: 1, generation: 1, startedAt: 1000 }
    },
    async update(_handle: StatusHandle, state: StatusState) { states.push(state) },
    async complete() { active = false; completed++ },
    isActive() { return active },
  }, 'owner', AppConfigSchema.parse({ status: { thoughts: { enabled: true } } }).status, ['private-token'], now)
  return { status, states, completed: () => completed }
}

test('busy acknowledgement uses recent activity from the owner turn', async () => {
  let now = 1000
  const { status } = fixture(() => now)
  status.begin(7)
  expect(status.recentlyBusy(500)).toBe(true)
  now += 500
  expect(status.recentlyBusy(500)).toBe(false)
  status.receive({ method: 'item/started', params: { threadId: 'foreign', item: {
    type: 'commandExecution', id: 'foreign-job',
  } } }, 'root')
  expect(status.recentlyBusy(500)).toBe(false)
  status.receive({ method: 'item/started', params: { threadId: 'root', item: {
    type: 'commandExecution', id: 'owner-job',
  } } }, 'root')
  expect(status.recentlyBusy(500)).toBe(true)
  status.finish()
  expect(status.recentlyBusy(500)).toBe(false)
  await status.close()
})

test('moves the working card below a public report and retains its activity timer', async () => {
  let now = 1000
  const { status, states, completed } = fixture(() => now)
  status.begin(7)
  await Bun.sleep(0)
  now = 3200
  status.repost()
  await Bun.sleep(0)
  expect(completed()).toBe(1)
  const state = states.at(-1)
  expect(state?.kind === 'activity' && renderActivityBlock(state.snapshot, 6000)).toContain('working -- 5s')
  await status.close()
})

test('keeps the legacy working card open while a managed subagent outlives the turn', async () => {
  const { status, states, completed } = fixture()
  status.begin(7)
  status.receive({ method: 'item/started', params: { threadId: 'root', item: {
    id: 'tool', type: 'commandExecution', command: "/bin/bash -lc '/bin/sleep 18 private-token'",
  } } }, 'root')
  status.receive({ method: 'item/completed', params: { threadId: 'root', item: {
    type: 'subAgentActivity', agentThreadId: 'child', kind: 'started',
  } } }, 'root')
  status.receive({ method: 'turn/completed', params: { threadId: 'root' } }, 'root')
  status.finish()
  await Bun.sleep(0)
  expect(status.busy).toBe(true)
  expect(completed()).toBe(0)
  const rendered = states.flatMap(s => s.kind === 'activity' ? [renderActivityBlock(s.snapshot, 6000)] : []).at(-1)
  expect(rendered).toContain('working -- 5s')
  expect(rendered).toContain('/bin/sleep 18')
  expect(rendered).not.toContain('private-token')
  status.receive({ method: 'item/completed', params: { threadId: 'root', item: {
    type: 'subAgentActivity', agentThreadId: 'child', kind: 'completed',
  } } }, 'root')
  await Bun.sleep(0)
  expect(status.busy).toBe(false)
  expect(completed()).toBe(1)
  await status.close()
})

test('lists tool activity only for the owner thread and stops after the managed process exits', async () => {
  const { status, states, completed } = fixture()
  status.receive({ method: 'turn/started', params: { threadId: 'foreign' } }, 'root')
  expect(states).toHaveLength(0)
  status.begin()
  const item = { id: 'job', type: 'commandExecution', processId: 'process', command: '/bin/sleep 10' }
  status.receive({ method: 'item/started', params: { threadId: 'root', item: { ...item, status: 'inProgress' } } }, 'root')
  status.receive({ method: 'turn/completed', params: { threadId: 'root' } }, 'root')
  status.finish()
  await Bun.sleep(0)
  expect(status.busy).toBe(true)
  expect(completed()).toBe(0)
  status.receive({ method: 'item/completed', params: { threadId: 'root', item: { ...item, status: 'completed' } } }, 'root')
  await Bun.sleep(0)
  expect(completed()).toBe(1)
  await status.close()
})
