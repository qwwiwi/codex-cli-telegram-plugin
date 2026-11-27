import { expect, test } from 'bun:test'
import { AppConfigSchema } from '../../src/config.js'
import { CodexWorkStatus } from '../../src/codex/work-status.js'
import { createLogger } from '../../src/log.js'
import { renderActivityBlock } from '../../src/status/activity-renderer.js'
import { StatusManager, type StatusHandle, type StatusState } from '../../src/status/status-manager.js'

function fixture(now = () => 1000, settings: Record<string, unknown> = { thoughts: { enabled: true, read_throttle_ms: 0 } }) {
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
  }, 'owner', AppConfigSchema.parse({ status: settings }).status, ['private-token'], now)
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

test('status teardown makes no Telegram edit for a zero message ID', async () => {
  const edits: number[] = []
  const manager = new StatusManager({
    config: AppConfigSchema.parse({ status: { delete_on_complete: false } }),
    log: createLogger('work-status-test'),
    telegramApi: {
      async sendMessage() { return { message_id: 0 } },
      async editMessageText(_chat, id) { edits.push(id) },
    },
  })
  await manager.start('123', undefined, { kind: 'tool', toolName: 'Bash' })
  await manager.cancel('123', '/new')
  await manager.start('123', undefined, { kind: 'tool', toolName: 'Bash' })
  await manager.complete('123')
  expect(edits).toEqual([])
})

test('a late missing-status edit cannot retire a replacement bubble', async () => {
  const edits: number[] = []
  const pending = Promise.withResolvers<void>()
  const missing = { error_code: 400, description: 'Bad Request: message to edit not found' }
  let nextMessageId = 16
  const manager = new StatusManager({
    config: AppConfigSchema.parse({ status: { delete_on_complete: false } }),
    log: createLogger('work-status-test'),
    telegramApi: {
      async sendMessage() { return { message_id: ++nextMessageId } },
      async editMessageText(_chat, id) {
        edits.push(id)
        if (edits.length === 1) return pending.promise
        if (id === 17) throw missing
      },
    },
  })
  const handle = await manager.start('123', undefined, { kind: 'tool', toolName: 'Start' })
  try {
    const late = manager.update(handle, { kind: 'tool', toolName: 'First' })
    await manager.update(handle, { kind: 'tool', toolName: 'Second' })
    expect(manager.activeMessageId('123')).toBe(18)
    pending.reject(missing)
    await late
    expect(manager.activeMessageId('123')).toBe(18)
  } finally {
    await manager.cancel('123', '/new')
  }
  expect(edits).toEqual([17, 17, 18])
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
  const rows = commentary.split('\n')
  expect(rows[0]).toBe('Checking progress.')
  expect(rows.slice(1).join(' ')).toBe(('Long commentary '.repeat(12)).trim())
  for (const row of rows) expect([...row].length).toBeLessThanOrEqual(45)
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

// Codex app-server v2 reasoning notifications (ReasoningSummaryPartAdded / ReasoningSummaryTextDelta).
const part = (summaryIndex: number, itemId = 'reasoning-1') => ({ method: 'item/reasoning/summaryPartAdded',
  params: { threadId: 'root', turnId: 'turn-1', itemId, summaryIndex } })
const delta = (text: string, summaryIndex = 0, itemId = 'reasoning-1') => ({ method: 'item/reasoning/summaryTextDelta',
  params: { threadId: 'root', turnId: 'turn-1', itemId, summaryIndex, delta: text } })
const lastSnapshot = (states: StatusState[]) => states.flatMap(s => s.kind === 'activity' ? [s.snapshot] : []).at(-1)

test('[R02] streams the Codex reasoning summary into the working bubble in place of reasoning...', async () => {
  const { status, states } = fixture()
  status.begin(7)
  await Bun.sleep(0)
  expect(renderActivityBlock(lastSnapshot(states)!, 1000)).toContain('reasoning...')
  status.receive(part(0), 'root')
  status.receive(delta('**Inspecting the config**\n\nI am reading '), 'root')
  status.receive(delta('the status block '), 'root')
  await Bun.sleep(0)
  const snapshot = lastSnapshot(states)!
  expect(snapshot.thought).toBe('Inspecting the config\nI am reading the status block')
  const html = renderActivityBlock(snapshot, 1000)
  expect(html).not.toContain('reasoning...')
  expect(html).not.toContain('**')
  // The completed item carries the whole summary; its last part stays in the bubble.
  status.receive({ method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: {
    type: 'reasoning', id: 'reasoning-1', summary: ['**First**\n\nold part', '**Checking tests**\n\nRunning the suite'], content: [],
  } } }, 'root')
  await Bun.sleep(0)
  expect(lastSnapshot(states)!.thought).toBe('Checking tests\nRunning the suite')
  await status.close()
})

test('[R02] redacts a secret in the reasoning summary, also while it is still streaming', async () => {
  const { status, states } = fixture()
  status.begin(7)
  status.receive(delta('Using private-to'), 'root')
  await Bun.sleep(0)
  expect(JSON.stringify(states)).not.toContain('private-to')
  status.receive(delta('ken to call the API and the ghp_'), 'root')
  status.receive(delta('abcdefghijklmnopqrstuvwxyz0123456789 token.'), 'root')
  await Bun.sleep(0)
  expect(lastSnapshot(states)!.thought).toContain('to call the API')
  expect(JSON.stringify(states)).not.toContain('private-to')
  expect(JSON.stringify(states)).not.toContain('abcdefghijklmnopqrstuvwxyz')
  await status.close()
})

test('[R02] collapses a long reasoning summary to its latest tail and starts over on a new part', async () => {
  const { status, states } = fixture()
  status.begin(7)
  status.receive(part(0), 'root')
  status.receive(delta('**Plan**\n\nline one\nline two\nline three\nline four\n' + 'x'.repeat(400) + ' end '), 'root')
  await Bun.sleep(0)
  const thought = lastSnapshot(states)!.thought ?? ''
  expect(thought.split('\n').length).toBeLessThanOrEqual(3)
  expect(thought.length).toBeLessThanOrEqual(280)
  expect(thought).toEndWith('end')
  expect(thought).not.toContain('Plan')
  status.receive(part(1), 'root')
  status.receive(delta('**Next step**\n\nshort ', 1), 'root')
  await Bun.sleep(0)
  expect(lastSnapshot(states)!.thought).toBe('Next step\nshort')
  await status.close()
})

test('[R02] clears the reasoning when the turn ends, even while a background command keeps the bubble', async () => {
  const { status, states } = fixture()
  status.begin(7)
  const item = { id: 'job', type: 'commandExecution', processId: 'process', command: '/bin/sleep 10' }
  status.receive({ method: 'item/started', params: { threadId: 'root', item: { ...item, status: 'inProgress' } } }, 'root')
  status.receive(delta('Waiting for the build '), 'root')
  await Bun.sleep(0)
  expect(lastSnapshot(states)!.thought).toBe('Waiting for the build')
  status.receive({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-1', status: 'completed' } } }, 'root')
  status.finish()
  await Bun.sleep(0)
  expect(status.busy).toBe(true)
  expect(lastSnapshot(states)!.thought).toBeUndefined()
  await status.close()
})

test('[R02] shows no reasoning and edits nothing when thoughts are disabled', async () => {
  const { status, states } = fixture(() => 1000, {})
  status.begin(7)
  await Bun.sleep(0)
  const before = states.length
  status.receive(part(0), 'root')
  status.receive(delta('**Hidden plan**\n\nnot for the chat '), 'root')
  status.receive({ method: 'item/completed', params: { threadId: 'root', item: {
    type: 'reasoning', id: 'reasoning-1', summary: ['not for the chat'], content: [],
  } } }, 'root')
  await Bun.sleep(0)
  expect(states).toHaveLength(before)
  expect(JSON.stringify(states)).not.toContain('not for the chat')
  await status.close()
})

test('[R02] throttles reasoning edits and still shows the latest text after the gap', async () => {
  let now = 1000
  const { status, states } = fixture(() => now, { thoughts: { enabled: true, read_throttle_ms: 30 } })
  status.begin(7)
  status.receive(delta('one '), 'root')
  await Bun.sleep(0)
  const before = states.length
  expect(lastSnapshot(states)!.thought).toBe('one')
  status.receive(delta('two '), 'root')
  status.receive(delta('three '), 'root')
  await Bun.sleep(0)
  expect(states).toHaveLength(before)
  now += 30
  await Bun.sleep(60)
  expect(states).toHaveLength(before + 1)
  expect(lastSnapshot(states)!.thought).toBe('one two three')
  await status.close()
})

const thoughtRows = (html: string): string[] => (html.slice(5, -6).split('\n\n')[1] ?? '').split('\n')
const unescape = (html: string): string => html.replace(/<\/?pre>/g, '')
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '')

test('[R02] the working bubble shows the thought tail up to max_lines and max_chars as separate wrapped lines', async () => {
  const { status, states } = fixture()
  status.begin(7)
  const long = 'Reading the status renderer and the work status to see where the thought is cut, '
    + 'then checking the private-token limits for lines and characters before the end'
  status.receive({ method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: {
    type: 'reasoning', id: 'reasoning-1', summary: ['**Plan**\n\nfirst line dropped\nsecond line kept\nthird line kept\n' + long],
    content: [],
  } } }, 'root')
  await Bun.sleep(0)
  const rows = thoughtRows(renderActivityBlock(lastSnapshot(states)!, 1000))
  expect(rows.slice(0, 2)).toEqual(['second line kept', 'third line kept'])
  expect(rows.length).toBeGreaterThan(3)
  for (const row of rows) expect([...row].length).toBeLessThanOrEqual(45)
  const shown = rows.slice(2).join(' ')
  // More than the old one-line 128-character cap, the whole tail, still redacted.
  expect(shown.length).toBeGreaterThan(128)
  expect(shown).toEndWith('before the end')
  expect(shown).not.toContain('private-token')
  expect(rows.join(' ')).not.toContain('first line dropped')
  await status.close()
})

test('[R02] the thought in the working bubble follows a larger max_lines and max_chars from config', async () => {
  const { status, states } = fixture(() => 1000, { thoughts: { enabled: true, read_throttle_ms: 0, max_lines: 5, max_chars: 600 } })
  status.begin(7)
  const lines = Array.from({ length: 6 }, (_, i) => `step ${i + 1} ` + 'checks the bridge state '.repeat(3).trim())
  status.receive({ method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: {
    type: 'reasoning', id: 'reasoning-1', summary: [lines.join('\n')], content: [],
  } } }, 'root')
  await Bun.sleep(0)
  const shown = thoughtRows(renderActivityBlock(lastSnapshot(states)!, 1000)).join(' ')
  expect(shown).not.toContain('step 1 ')
  expect(shown).toStartWith('step 2 ')
  expect(shown).toEndWith(lines[5]!.slice(-20))
  expect(shown.length).toBeGreaterThan(280)
  await status.close()
})

test('[R02] an oversized thought keeps its latest tail and the bubble stays within a Telegram edit', () => {
  const thought = Array.from({ length: 30 }, (_, i) => `line ${i} ` + '<&> wide '.repeat(40) + `tail ${i}`).join('\n')
  const html = renderActivityBlock({
    startedAtMs: 0,
    phase: 'tool',
    calls: Array.from({ length: 3 }, () => ({ toolName: 'Bash', detail: '&'.repeat(200) })),
    thought,
  }, 1000)
  const rows = thoughtRows(html)
  expect(rows.at(-1)).toEndWith('tail 29')
  expect(rows.join(' ')).not.toContain('line 0 ')
  for (const row of rows) expect([...unescape(row)].length).toBeLessThanOrEqual(45)
  // At most the schema maxima (8 lines, 2000 characters) of thought text.
  expect(unescape(rows.join('')).replace(/ /g, '').length).toBeLessThanOrEqual(2000)
  expect([...unescape(html)].length).toBeLessThanOrEqual(4096)
})

test('[R02] a Bearer credential folded onto its own line never reaches Telegram once the header scrolls out of the tail', async () => {
  const chatId = '123'
  const sent: string[] = []
  const config = AppConfigSchema.parse({ status: { thoughts: { enabled: true, read_throttle_ms: 0 } } })
  const manager = new StatusManager({
    config,
    log: createLogger('work-status-test'),
    now: () => 1000,
    telegramApi: {
      async sendMessage(_chatId, text) { sent.push(text); return { message_id: 10 } },
      async editMessageText(_chatId, _messageId, text) { sent.push(text) },
      async deleteMessage() {},
    },
  })
  const status = new CodexWorkStatus(manager, chatId, config.status, [], () => 1000)
  status.begin(7)
  status.receive(delta('Calling the API with Authorization: Bearer\n    '), 'root')
  status.receive(delta('fold3d.Cred-Value.x9QzLmNoPq\nprogress one\nprogress two '), 'root')
  await Bun.sleep(20)
  expect(sent.join('\n')).toContain('progress two')
  expect(sent.join('\n')).not.toContain('fold3d')
  expect(sent.join('\n')).not.toContain('x9QzLmNoPq')
  await status.close()
})
