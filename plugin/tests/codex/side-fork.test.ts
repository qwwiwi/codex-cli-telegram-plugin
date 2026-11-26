import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSession } from '../../src/codex/session.js'
import { renderHud } from '../../src/status/context-hud.js'

// Prompt-cache behaviour of the bridge: side threads fork the main thread,
// agent input never does, the model is sent only when it changes and the HUD
// shows the cache hit share of the last main request.

const dirs: string[] = []
const sessions: CodexSession[] = []

type Logged = { method: string; params: Record<string, unknown> }

function fixture(options: { noFork?: boolean; model?: () => string | undefined } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'krot-codex-fork-'))
  dirs.push(cwd)
  const log = join(cwd, 'requests.jsonl')
  const warnings: string[] = []
  const session = new CodexSession({
    cwd: import.meta.dir, stateFile: join(cwd, 'thread.json'),
    env: { ...process.env, KROT_FAKE_LOG: log, ...(options.noFork ? { KROT_FAKE_NO_FORK: '1' } : {}) },
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts'), 'chatgpt'],
    ...(options.model ? { selectedModel: options.model } : {}),
    onWarning: message => { warnings.push(message) },
  }, () => {})
  sessions.push(session)
  const requests = (method?: string): Logged[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
    .filter(Boolean).map(line => JSON.parse(line) as Logged).filter(entry => !method || entry.method === method)
  return { session, requests, warnings }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

// Wrapped: an async function returning the bare promise would wait for the
// main turn itself, which only ends at session.stop().
async function mainBusy(session: CodexSession): Promise<{ main: Promise<unknown> }> {
  const main = session.run('wait')
  await until(() => session.steerableTurn !== undefined)
  return { main }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('an owner side thread is an ephemeral fork of the main thread and a reply reuses it', async () => {
  const { session, requests } = fixture()
  await session.initialize()
  await session.run('один')
  const { main } = await mainBusy(session)
  const mainThread = session.currentThread
  const side = await session.runSide('Какая погода?')
  expect(side).toEqual({ status: 'completed', text: 'side: Какая погода?', threadId: side.threadId })
  expect(side.threadId).not.toBe(mainThread)
  expect(session.currentThread).toBe(mainThread)
  const forks = requests('thread/fork')
  expect(forks).toHaveLength(1)
  // Forked up to the last finished main turn, never the one still running.
  expect(forks[0]!.params).toMatchObject({ threadId: mainThread, ephemeral: true, excludeTurns: true, lastTurnId: 'turn-1' })
  // Only the main thread was ever started.
  expect(requests('thread/start')).toHaveLength(1)
  const again = await session.runSide('ещё', [], side.threadId)
  expect(again.threadId).toBe(side.threadId)
  expect(requests('thread/fork')).toHaveLength(1)
  await session.stop()
  await main
})

test('after a resume an owner side forks at the last finished turn of the resumed history', async () => {
  const { session, requests } = fixture()
  await session.initialize()
  await session.resume('saved-thread')
  const { main } = await mainBusy(session)
  const side = await session.runSide('Какая погода?')
  expect(side).toEqual({ status: 'completed', text: 'side: Какая погода?', threadId: side.threadId })
  // Not a fresh thread: the fork keeps the resumed context up to its last finished turn.
  expect(requests('thread/start')).toHaveLength(0)
  expect(requests('thread/fork')).toHaveLength(1)
  expect(requests('thread/fork')[0]!.params).toMatchObject({ threadId: 'saved-thread', ephemeral: true, lastTurnId: 'turn-0' })
  await session.stop()
  await main
})

test('an agent side thread never forks the owner main thread', async () => {
  const { session, requests } = fixture()
  await session.initialize()
  const { main } = await mainBusy(session)
  const side = await session.runSide('Verify the summary.', [], undefined, undefined, { untrusted: true })
  expect(side.status).toBe('completed')
  expect(requests('thread/fork')).toHaveLength(0)
  expect(requests('thread/start')).toHaveLength(2)
  await session.stop()
  await main
})

test('a side during the first main turn starts a fresh thread instead of forking a half-finished turn', async () => {
  const { session, requests, warnings } = fixture()
  await session.initialize()
  const { main } = await mainBusy(session)
  const side = await session.runSide('Какая погода?')
  expect(side).toEqual({ status: 'completed', text: 'side: Какая погода?', threadId: side.threadId })
  expect(requests('thread/fork')).toHaveLength(0)
  expect(requests('thread/start')).toHaveLength(2)
  // Not a refusal: later sides may still fork once a main turn has finished.
  expect(warnings).toHaveLength(0)
  await session.stop()
  await main
})

test('without fork support a side thread falls back to thread/start once and says so', async () => {
  const { session, requests, warnings } = fixture({ noFork: true })
  await session.initialize()
  await session.run('один')
  const { main } = await mainBusy(session)
  const first = await session.runSide('раз')
  expect(first).toEqual({ status: 'completed', text: 'side: раз', threadId: first.threadId })
  const second = await session.runSide('два')
  expect(second.status).toBe('completed')
  // One refused fork is enough: later sides go straight to thread/start.
  expect(requests('thread/fork')).toHaveLength(1)
  expect(requests('thread/start')).toHaveLength(3)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('thread/start')
  await session.stop()
  await main
})

test('a turn sends the model only when it differs from the thread model', async () => {
  let model: string | undefined = 'gpt-test'
  const { session, requests } = fixture({ model: () => model })
  await session.initialize()
  await session.run('один')
  await session.run('два')
  model = 'gpt-other'
  await session.run('три')
  await session.run('четыре')
  const sent = requests('turn/start').map(entry => entry.params.model)
  // The thread opened on gpt-test, so only the switch to gpt-other carries a model.
  expect(sent).toEqual([undefined, undefined, 'gpt-other', undefined])
  expect(session.status.model).toBe('gpt-other')
})

test('the HUD shows the cache share of the last main request and omits it when unknown', async () => {
  const { session } = fixture()
  await session.initialize()
  await session.run('usage:cached')
  expect(session.status.usage).toEqual({ usedTokens: 5000, windowTokens: 100000, cachePercent: 82 })
  expect(renderHud(session.status.usage ?? null, 100000).text).toBe('🧠 <b>Контекст</b>: ▰▱▱▱▱▱▱▱▱▱ 5% (5k / 100k) · кеш 82%')
  await session.run('usage:plain')
  expect(session.status.usage).toEqual({ usedTokens: 5000, windowTokens: 100000 })
  expect(renderHud(session.status.usage ?? null, 100000).text).toBe('🧠 <b>Контекст</b>: ▰▱▱▱▱▱▱▱▱▱ 5% (5k / 100k)')
})
