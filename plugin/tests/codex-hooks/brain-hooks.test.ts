import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateTokens, HandoffSchema, PROVENANCE_VERSION, PromptCaptureSchema } from '../../../codex-brain/src/contract.js'
import { openJournal, FileJournalWriter } from '../../../codex-brain/src/journal/index.js'
import { FilePermitStore } from '../../../codex-brain/src/permit/permits.js'
import { FileReceiptStore } from '../../../codex-brain/src/permit/receipts.js'
import { FileSessionRegistry } from '../../../codex-brain/src/permit/sessions.js'
import { scopePaths } from '../../../codex-brain/src/store/paths.js'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { dispatch } from '../../../codex-hooks/src/dispatch.js'
import { launcherVerdict, runMain } from '../../../codex-hooks/src/entry.js'
import type { Scope } from '../../../codex-hooks/src/scope.js'
import type { HookContext, Json, Runner } from '../../../codex-hooks/src/types.js'

let root: string
let codexHome: string
let brainHome: string
const ownerScope = 'owner-test'
const configFile = () => join(root, 'hooks.json')
const stateDir = () => join(root, 'hook-state')
const paths = (scope = ownerScope) => scopePaths(brainHome, scope)
const sessions = () => new FileSessionRegistry(brainHome)
const clock = { now: () => new Date() }
const journal = (scope = ownerScope) => openJournal(brainHome, scope, clock)
const run: Runner = () => ({ code: 0, stdout: '[]' })
const input = { session_id: 'owner-session', turn_id: 'active-turn' }
const terminal = { session_id: 'terminal-session', turn_id: 'terminal-turn' }
const reply = { last_assistant_message: 'The answer is ready.' }
const quietConfig = Object.fromEntries(Object.keys(DEFAULT_CONFIG.enabled)
  .map(key => [key, ['safety', 'git-gate', 'correction'].includes(key)]))

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codex-hooks-brain-'))
  codexHome = join(root, 'codex')
  brainHome = join(codexHome, 'brain')
  await register(input.session_id, 'owner', ownerScope)
  await register(terminal.session_id, 'terminal', 'local')
  writeFileSync(configFile(), JSON.stringify({ enabled: quietConfig }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function register(session_id: string, role: 'owner' | 'terminal' | 'side' | 'guest', scope: string) {
  return sessions().register({ session_id, scope, role, registered: clock.now().toISOString() })
}
function event(name: string, fields: Json = input, scope: Scope = 'full', runner = run, env = {}) {
  return runMain(name, JSON.stringify(fields), {
    HOME: root, CODEX_HOME: codexHome, CODEX_BRAIN_HOME: join(root, 'ignored'),
    CODEX_HOOKS_CONFIG: configFile(), CODEX_HOOKS_STATE_DIR: stateDir(), ...env,
  }, runner, undefined, () => scope)
}
const context = (answer: { stdout: string }): string => JSON.parse(answer.stdout).hookSpecificOutput?.additionalContext ?? ''
const snapshotText = () => readFileSync(paths().snapshotText(input.session_id), 'utf8')
const start = (source: string, fields: Json = input) => event('SessionStart', { ...fields, source })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function grant(origin: 'owner-direct' | 'owner-forward' = 'owner-direct', cue = true,
  fields = input, scope = ownerScope) {
  const ref = await journal(scope).writer.bind({
    key: fields.turn_id, origin, input_kind: 'text', input: 'Remember my preference.',
    thread: fields.session_id, turn: fields.turn_id,
  })
  await new FilePermitStore(brainHome, scope).put({
    ...fields, scope, origin, cue, journal_ref: ref, expires: new Date(Date.now() + 60_000).toISOString(),
  })
  return ref
}

test('startup prefixes the stored HOT and recent tail, with identical bytes on concurrent retry and across ten turns', async () => {
  const ref = await grant()
  await journal().writer.answered(ref, 'Saved this exchange.')
  await journal().writer.delivered(ref)
  const makeContext = (): HookContext => ({
    event: 'SessionStart', input: { ...input, source: 'startup' },
    config: { ...DEFAULT_CONFIG, enabled: { ...DEFAULT_CONFIG.enabled, 'session-sanity': false, 'active-briefs': false } },
    home: root, codexHome, stateDir: stateDir(), log: () => {}, now: Date.now, run,
    gbrain: { call: async (_server, tool) => tool === 'list_my_pending' ? 'Inbox follows memory' : '', ping: async () => {} },
  })
  const [first, retry] = await Promise.all([dispatch(makeContext()), dispatch(makeContext())])
  const output = context({ stdout: JSON.stringify(first) })
  expect(output).not.toBe('')
  expect(output.startsWith(snapshotText())).toBe(true)
  expect(output.indexOf(ref)).toBeGreaterThan(snapshotText().length)
  expect(output.indexOf('Inbox follows memory')).toBeGreaterThan(output.indexOf(ref))
  expect(retry).toEqual(first)
  const boundary = readFileSync(paths().boundary(input.session_id), 'utf8')
  for (let i = 0; i < 10; i++) {
    expect(await event('UserPromptSubmit', { ...input, turn_id: `turn-${i}`, prompt: 'Continue' })).toEqual({ stdout: '{}', code: 0 })
    expect(digest(context(await start('startup')))).toBe(digest(output.split('\n\nВходящие задачи')[0]!))
  }
  expect(readFileSync(paths().boundary(input.session_id), 'utf8')).toBe(boundary)
})

test('PreCompact flushes before writing the active handoff and answers empty JSON', async () => {
  const ref = await grant()
  const flush = spyOn(FileJournalWriter.prototype, 'flush').mockImplementation(async () => {
    expect(existsSync(paths().handoffCurrent)).toBe(false)
  })
  try {
    expect(await event('PreCompact', { ...input, trigger: 'auto' })).toEqual({ stdout: '{}', code: 0 })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(readFileSync(paths().handoffCurrent, 'utf8')).toContain(ref)
    expect(readFileSync(paths().handoffCurrent, 'utf8')).toContain('Remember my preference.')
  } finally {
    flush.mockRestore()
  }
})

test('a failed PreCompact flush returns empty JSON and logs one line', async () => {
  const flush = spyOn(FileJournalWriter.prototype, 'flush').mockRejectedValue(new Error('fixture disk unavailable\nextra detail'))
  try {
    expect(await event('PreCompact', { ...input, trigger: 'manual' })).toEqual({ stdout: '{}', code: 0 })
    const log = readFileSync(join(stateDir(), 'hooks.log'), 'utf8').trimEnd().split('\n')
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('fixture disk unavailable')
    expect(existsSync(paths().handoffCurrent)).toBe(false)
  } finally {
    flush.mockRestore()
  }
})

test('compact rebuilds HOT, emits the matching handoff once and stays within 3000 tokens', async () => {
  const { FactStore } = await import('../../../codex-brain/src/facts/store.js')
  const before = context(await start('startup'))
  const ref = await grant()
  expect((await new FactStore(brainHome, ownerScope).writer({ turnId: 'fixture-write' }).put({
    id: 'compact-preference', kind: 'pinned', description: 'Use the compact preference', source: ref, body: 'Keep it visible',
  })).ok).toBe(true)
  await event('PreCompact', { ...input, trigger: 'auto' })
  const [a, b] = await Promise.all([start('compact'), start('compact')])
  const after = [context(a), context(b)]
  expect(after.every(text => text.startsWith(snapshotText()) && estimateTokens(text) <= 3000)).toBe(true)
  expect(snapshotText()).not.toBe(before)
  expect(snapshotText()).toContain('Use the compact preference')
  expect(after.filter(text => text.includes(ref))).toHaveLength(1)
  const { provenance, ...handoff } = JSON.parse(readFileSync(paths().handoffMeta, 'utf8'))
  expect(provenance).toBe(PROVENANCE_VERSION)
  expect(HandoffSchema.parse(handoff).delivered).toBeDefined()
  expect(context(await start('compact'))).toBe(snapshotText())
})

test('a missed owner save shares one Stop continuation with an existing blocker', async () => {
  await grant()
  writeFileSync(configFile(), JSON.stringify({ enabled: { ...quietConfig, 'hanging-prs': true } }))
  const gh: Runner = () => ({ code: 0, stdout: JSON.stringify([{ createdAt: '2000-01-01', title: 'Old PR', url: 'https://example.invalid/pr' }]) })
  const first = JSON.parse((await event('Stop', { ...input, ...reply }, 'full', gh)).stdout)
  expect(first.decision).toBe('block')
  expect(first.reason).toContain('brain remember')
  expect(first.reason).toContain('Old PR')
  expect(await event('Stop', { ...input, ...reply }, 'full', gh)).toEqual({ stdout: '{}', code: 0 })
})

test('Stop ignores continuation, forwarded or unflagged turns and turns with receipts', async () => {
  const ref = await grant()
  expect(await event('Stop', { ...input, ...reply, stop_hook_active: true })).toEqual({ stdout: '{}', code: 0 })
  expect((await event('Stop', { ...input, ...reply })).stdout).toContain('brain remember')
  const saved = { ...input, turn_id: 'saved' }
  await grant('owner-direct', true, saved)
  await new FileReceiptStore(brainHome, ownerScope).add(saved.turn_id, ref, {
    id: 'saved-preference', kind: 'decision', description: 'Saved preference', action: 'put', revision: 1, at: clock.now().toISOString(),
  })
  for (const fields of [saved, { ...input, turn_id: 'forwarded' }, { ...input, turn_id: 'ordinary' }]) {
    if (fields.turn_id === 'forwarded') await grant('owner-forward', true, fields)
    if (fields.turn_id === 'ordinary') await grant('owner-direct', false, fields)
    expect(await event('Stop', { ...fields, ...reply })).toEqual({ stdout: '{}', code: 0 })
  }
  expect(await journal().reader.tail(10)).toHaveLength(4)
})

test('other and safety scopes stay silent on Brain events and retain the safety guard', async () => {
  for (const [name, fields] of [
    ['SessionStart', { ...terminal, source: 'startup' }],
    ['PreCompact', { ...terminal, trigger: 'auto' }],
    ['UserPromptSubmit', { ...terminal, prompt: 'Run the tests.' }],
    ['Stop', { ...terminal, ...reply }],
  ] as const) {
    for (const scope of ['other', 'safety'] as const) {
      expect(await event(name, fields, scope)).toEqual({ stdout: '', code: 0 })
    }
  }
  const tool = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }
  expect(launcherVerdict(await event('PreToolUse', tool, 'safety')).code).toBe(3)
  expect(await event('PreToolUse', tool, 'other')).toEqual({ stdout: '', code: 0 })
  expect(existsSync(paths('local').root)).toBe(false)
  expect(context(await start('startup', terminal))).toContain('memory')
})

test('disabled Brain leaves no Brain state while preserving the legacy correction', async () => {
  const prompt = { ...terminal, prompt: 'Так не работает, используй другой формат.' }
  expect(context(await event('UserPromptSubmit', prompt))).toContain('brain remember')
  const captureFile = paths('local').prompt(terminal.turn_id)
  const capture = readFileSync(captureFile, 'utf8')
  writeFileSync(join(brainHome, 'config.json'), '{"enabled":false}')
  const disabled = { ...terminal, turn_id: 'disabled-turn' }
  expect(await start('startup', terminal)).toEqual({ stdout: '{}', code: 0 })
  expect(await event('PreCompact', { ...terminal, trigger: 'manual' })).toEqual({ stdout: '{}', code: 0 })
  expect(context(await event('UserPromptSubmit', { ...prompt, ...disabled }))).toContain('learning/')
  expect(await event('Stop', { ...terminal, ...reply })).toEqual({ stdout: '{}', code: 0 })
  expect(existsSync(paths('local').handoffCurrent)).toBe(false)
  expect(existsSync(paths('local').prompt(disabled.turn_id))).toBe(false)
  expect(existsSync(paths('local').snapshotText(terminal.session_id))).toBe(false)
  expect((await journal('local').reader.tail(10))).toEqual([])
  expect(readFileSync(captureFile, 'utf8')).toBe(capture)
})

test('the terminal journals one redacted exchange on final Stop, even with concurrent retries', async () => {
  const fakeSecret = 'fixture-' + 'private-value'
  const env = { FIXTURE_SECRET: fakeSecret }
  const prompt = { ...terminal, prompt: `Input ${fakeSecret}` }
  await event('UserPromptSubmit', prompt, 'full', run, env)
  const file = paths('local').prompt(terminal.turn_id)
  const capture = PromptCaptureSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  expect(capture.prompt).toBe('Input [REDACTED]')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const stop = { ...terminal, last_assistant_message: `Reply ${fakeSecret}` }
  await Promise.all([event('Stop', stop, 'full', run, env), event('Stop', stop, 'full', run, env)])
  expect(await journal('local').reader.tail(10)).toEqual([
    expect.objectContaining({ origin: 'terminal', status: 'delivered', input: 'Input [REDACTED]', reply: 'Reply [REDACTED]' }),
  ])
  expect(existsSync(file)).toBe(false)
  const [day] = await journal('local').reader.days()
  const lines = readFileSync(paths('local').journal(day!), 'utf8').trim().split('\n')
  expect(lines.map(line => JSON.parse(line).status)).toEqual(['bound', 'answered', 'delivered'])
})

test('only personal sessions receive memory or capture and a registered bridge thread gets memory', async () => {
  await register('guest-session', 'guest', ownerScope)
  await register('side-session', 'side', ownerScope)
  for (const session_id of ['guest-session', 'side-session', 'unknown-session']) {
    const fields = { session_id, turn_id: 'non-owner-turn' }
    expect(await start('startup', fields)).toEqual({ stdout: '{}', code: 0 })
    expect(await event('PreCompact', { ...fields, trigger: 'manual' })).toEqual({ stdout: '{}', code: 0 })
    expect(await start('compact', fields)).toEqual({ stdout: '{}', code: 0 })
    expect(await event('UserPromptSubmit', { ...fields, prompt: 'Private input' })).toEqual({ stdout: '{}', code: 0 })
    expect(await event('Stop', { ...fields, ...reply })).toEqual({ stdout: '{}', code: 0 })
  }
  expect(existsSync(paths().handoffCurrent)).toBe(false)
  expect(existsSync(paths('local').promptsDir)).toBe(false)
  await register('bridge-thread', 'owner', ownerScope)
  expect(context(await start('startup', { session_id: 'bridge-thread' }))).toContain('memory')
})

test('a live bridge intent gives no memory or owner role to an unrelated session', async () => {
  const intent = await sessions().intend({ role: 'owner', scope: ownerScope }, clock.now())
  for (const source of ['startup', 'clear', 'compact']) {
    expect(await start(source, { session_id: 'unrelated-session' })).toEqual({ stdout: '{}', code: 0 })
  }
  expect(await sessions().resolve('unrelated-session')).toBeNull()
  expect(existsSync(join(brainHome, 'intents', `${intent.id}.json`))).toBe(true)
})

test('SessionStart stays quiet when the bridge already injected the boundary HOT', async () => {
  expect(context(await start('startup'))).toContain('memory')
  const boundary = JSON.parse(readFileSync(paths().boundary(input.session_id), 'utf8')).boundary
  writeFileSync(join(paths().snapshotDir, `${input.session_id}.bridge.json`), JSON.stringify({ boundary }) + '\n')
  expect(await start('startup')).toEqual({ stdout: '{}', code: 0 })
})

test('a late bridge permit discards the terminal capture before Stop can be retried', async () => {
  await event('UserPromptSubmit', { ...terminal, prompt: 'Bridge-owned input.' })
  const capture = paths('local').prompt(terminal.turn_id)
  expect(existsSync(capture)).toBe(true)
  await grant('owner-direct', true, terminal, 'local')
  await event('Stop', { ...terminal, ...reply })
  expect(existsSync(capture)).toBe(false)
  await new FilePermitStore(brainHome, 'local').remove(terminal.turn_id)
  await event('Stop', { ...terminal, ...reply })
  expect((await journal('local').reader.tail(10)).map(exchange => exchange.origin)).toEqual(['owner-direct'])
})

test('terminal capture failure preserves the pending delta for the next prompt', async () => {
  await start('startup', terminal)
  const local = paths('local')
  writeFileSync(local.delta, JSON.stringify({ seq: 1, id: 'preference', action: 'changed', at: clock.now().toISOString() }) + '\n')
  rmSync(local.promptsDir, { recursive: true, force: true })
  writeFileSync(local.promptsDir, 'fixture')
  const prompt = { ...terminal, prompt: 'Continue' }
  expect(await event('UserPromptSubmit', prompt)).toEqual({ stdout: '{}', code: 0 })
  rmSync(local.promptsDir)
  mkdirSync(local.promptsDir, { mode: 0o700 })
  expect(context(await event('UserPromptSubmit', prompt))).toContain('memory update: fact preference changed')
})

test('resume and fork are quiet by default, optional resume emits stored HOT, and delta is emitted once', async () => {
  expect(context(await start('startup'))).not.toBe('')
  expect(await start('resume')).toEqual({ stdout: '{}', code: 0 })
  expect(await start('fork')).toEqual({ stdout: '{}', code: 0 })
  writeFileSync(join(brainHome, 'config.json'), '{"resume_reemit":true}')
  expect(context(await start('resume'))).toBe(snapshotText())
  writeFileSync(paths().delta, JSON.stringify({ seq: 1, id: 'preference', action: 'changed', at: clock.now().toISOString() }) + '\n')
  const outputs = await Promise.all([event('UserPromptSubmit'), event('UserPromptSubmit')])
  expect(outputs.map(context).filter(Boolean)).toEqual(['memory update: fact preference changed by the owner, read it before use\n'])
})

test('the Brain store can be unavailable while guard verdicts remain identical', async () => {
  const brokenHome = join(root, 'not-a-directory')
  writeFileSync(brokenHome, 'fixture')
  const tool = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }
  const expected = await event('PreToolUse', tool)
  await expect(event('PreToolUse', tool, 'full', run, { CODEX_HOME: brokenHome })).resolves.toEqual(expected)
  await expect(start('startup')).resolves.toMatchObject({ stdout: expect.stringContaining('additionalContext') })
  await expect(event('PreCompact', { ...input, trigger: 'manual' }, 'full', run, { CODEX_HOME: brokenHome })).resolves.toEqual({ stdout: '{}', code: 0 })
  expect(readdirSync(root)).not.toContain('ignored')
  expect(existsSync(join(root, 'ignored'))).toBe(false)
  rmSync(paths().root, { recursive: true, force: true })
  writeFileSync(paths().root, 'fixture')
  expect(await start('clear')).toEqual({ stdout: '{}', code: 0 })
  const log = readFileSync(join(stateDir(), 'hooks.log'), 'utf8').trimEnd().split('\n').filter(line => line.includes('Brain '))
  expect(log.map(line => line.match(/Brain (\w+):/)?.[1])).toEqual(['PreCompact', 'SessionStart'])
})

test('a failing Brain step never skips the other steps of the pack', async () => {
  const brokenHome = join(root, 'not-a-directory')
  writeFileSync(brokenHome, 'fixture')
  const env = { CODEX_HOME: brokenHome }
  writeFileSync(configFile(), JSON.stringify({ enabled: { ...quietConfig, 'hanging-prs': true } }))
  const gh: Runner = () => ({ code: 0, stdout: JSON.stringify([{ createdAt: '2000-01-01', title: 'Old PR', url: 'https://example.invalid/pr' }]) })
  const stop = JSON.parse((await event('Stop', { ...input, ...reply }, 'full', gh, env)).stdout)
  expect(stop).toMatchObject({ decision: 'block', reason: expect.stringContaining('Old PR') })
  const prompt = { ...input, turn_id: 'broken-turn', prompt: 'Так не работает, используй другой формат.' }
  expect(context(await event('UserPromptSubmit', prompt, 'full', run, env))).toContain('learning/')
  const log = readFileSync(join(stateDir(), 'hooks.log'), 'utf8')
  expect(log).toContain('Brain Stop:')
  expect(log).toContain('Brain UserPromptSubmit:')
})
