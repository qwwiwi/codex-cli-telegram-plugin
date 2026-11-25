import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import { CodexWorkStatus } from '../../src/codex/work-status.js'
import { createLogger } from '../../src/log.js'
import { renderActivityBlock } from '../../src/status/activity-renderer.js'
import { StatusManager, type StatusHandle, type StatusState } from '../../src/status/status-manager.js'

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
    activeMessageId() { return active ? 1 : 0 },
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

test('moves the lazy working card below a burst of public messages with its original timer', async () => {
  const chatId = '123'
  let now = 1000
  let nextMessageId = 9
  const messages = new Map<number, string>()
  const config = AppConfigSchema.parse({ status: { delete_on_complete: false } })
  const manager = new StatusManager({
    config,
    log: createLogger('work-status-test'),
    now: () => now,
    telegramApi: {
      async sendMessage(_chatId, text) {
        messages.set(++nextMessageId, text)
        return { message_id: nextMessageId }
      },
      async editMessageText(_chatId, messageId, text) { messages.set(messageId, text) },
      async deleteMessage(_chatId, messageId) { messages.delete(messageId) },
    },
  })
  const status = new CodexWorkStatus(manager, chatId, config.status, [], () => now)
  try {
    status.begin(7)
    await Bun.sleep(0)
    expect(manager.activeMessageId(chatId)).toBe(10)

    now = 6000
    messages.set(++nextMessageId, 'Approval card')
    status.repost(nextMessageId)
    messages.set(++nextMessageId, 'Milestone')
    status.repost(nextMessageId)
    await Bun.sleep(180)
    expect([...messages.keys()]).toEqual([11, 12, 13])
    expect(manager.activeMessageId(chatId)).toBe(13)
    expect(messages.get(13)).toContain('working -- 5s')

    status.repost(12)
    await Bun.sleep(180)
    expect([...messages.keys()]).toEqual([11, 12, 13])

    messages.set(++nextMessageId, 'Final answer')
    status.repost(nextMessageId)
    status.finish()
    await Bun.sleep(180)
    expect([...messages.keys()]).toEqual([11, 12, 13, 14])
    expect(messages.get(13)).not.toContain('working --')
    expect(manager.isActive(chatId)).toBe(false)
  } finally {
    await status.close()
  }
})

test('shortens the commentary separately from the latest three command summaries', () => {
  const html = renderActivityBlock({
    startedAtMs: 1000,
    phase: 'tool',
    calls: [
      { toolName: 'Bash', detail: 'superseded command' },
      { toolName: 'Bash', detail: 'git status' },
      { toolName: 'Edit', detail: 'editing files', humanized: 'editing <code>a&amp;b.md</code>' },
      { toolName: 'Bash', detail: 'reading <b> & ' + '⚙️'.repeat(90) },
    ],
    thought: 'Checking progress.\n' + 'Long commentary '.repeat(12),
  }, 6000)
  const [timer, commentary = '', commands = ''] = html.slice(5, -6).split('\n\n')
  expect(timer).toBe('working -- 5s')
  expect(commentary).toStartWith('Checking progress. Long commentary')
  expect(commentary).toEndWith('…')
  expect([...commentary].length).toBeLessThanOrEqual(128)
  const lines = commands.split('\n')
  expect(lines).toHaveLength(3)
  expect(lines.slice(0, 2)).toEqual(['▸ git status', '▸ editing a&amp;b.md'])
  const last = lines[2] ?? ''
  expect(last).toStartWith('▸ reading &lt;b&gt; &amp;')
  expect(last).toEndWith('…')
  expect([...last.replace(/&(?:lt|gt|amp);/g, 'x')].length).toBeLessThanOrEqual(47)
})

test('an idle child probe does not erase more recent activity from the same child', async () => {
  const { status, completed } = fixture()
  status.begin(7)
  status.receive({ method: 'item/completed', params: { threadId: 'root', item: {
    type: 'subAgentActivity', agentThreadId: 'child', kind: 'started',
  } } }, 'root')
  status.finish()
  const firstProbe = Promise.withResolvers<boolean>()
  const pending = status.reconcileChildren(async () => firstProbe.promise)
  status.receive({ method: 'turn/started', params: { threadId: 'child' } }, 'root')
  firstProbe.resolve(true)
  await pending
  expect(status.busy).toBe(true)
  expect(completed()).toBe(0)
  await status.reconcileChildren(async () => true)
  await Bun.sleep(0)
  expect(status.busy).toBe(false)
  expect(completed()).toBe(1)
  await status.close()
})

test('a late aggregate active event cannot resurrect a completed working card', async () => {
  const { status, completed } = fixture()
  status.begin(7)
  status.receive({ method: 'turn/started', params: { threadId: 'root' } }, 'root')
  status.receive({ method: 'turn/completed', params: { threadId: 'root' } }, 'root')
  status.finish()
  await Bun.sleep(0)
  status.receive({ method: 'thread/status/changed', params: { threadId: 'root', status: { type: 'active' } } }, 'root')
  expect(status.busy).toBe(false)
  expect(completed()).toBe(1)
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
