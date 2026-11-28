import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { assertPublicHomesSafe, loadPublicPolicy, PUBLIC_ROLES } from '../../src/codex/public-home.js'
import { createPublicGeneration, GENERATION_ID, openPublicGenerations } from '../../src/codex/public-generations.js'
import { planPublicGc, runPublicGc } from '../../src/codex/public-gc.js'
import { CodexRpc, type Json } from '../../src/codex/rpc.js'
import { CodexSession, readSavedMainThread } from '../../src/codex/session.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// The token lock as the bridge holds it: bot.pid in the state directory names this process.
function lockFile(store: ReturnType<typeof openPublicGenerations>): string {
  const file = join(dirname(store.root), 'bot.pid')
  writeFileSync(file, String(process.pid))
  return file
}

function gc(store: ReturnType<typeof openPublicGenerations>, keep: string[]) {
  return runPublicGc(store, { keep, lockFile: lockFile(store) })
}

function fixture(stateAlias = false) {
  const base = mkdtempSync(join(tmpdir(), 'krot-generations-'))
  dirs.push(base)
  const realState = join(base, 'state')
  mkdirSync(realState)
  const state = stateAlias ? join(base, 'state-alias') : realState
  if (stateAlias) symlinkSync(realState, state)
  const ownerCodexHome = join(base, 'owner')
  const ownerWorkspace = join(base, 'workspace')
  mkdirSync(ownerCodexHome)
  mkdirSync(ownerWorkspace)
  writeFileSync(join(ownerWorkspace, 'keep.txt'), 'owner work')
  writeFileSync(join(ownerCodexHome, 'auth.json'), '{}')
  writeFileSync(join(ownerCodexHome, 'config.toml'), '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\n' +
    'type = "command"\ncommand = "/opt/bun /opt/codex-permission-hook.js /opt/policy.yaml 8092 /opt/auth-file --thread-role"\n')
  const homesRoot = join(state, 'codex-public')
  const policy = loadPublicPolicy(state, {})
  const runtime = { bun: '/opt/bun', codex: '/opt/codex', codexBuild: 'test' }
  const protectedPaths = { homesRoot, ownerCodexHome, ownerWorkspace, userHome: base }
  const warnings: string[] = []
  const build = (paths = protectedPaths, before?: (path: string) => void) => {
    assertPublicHomesSafe(paths)
    const store = openPublicGenerations(homesRoot, before)
    return createPublicGeneration(store, warning => warnings.push(warning), before)
  }
  const start = (paths = protectedPaths, before?: (path: string) => void) => {
    const generation = build(paths, before)
    for (const role of PUBLIC_ROLES) generation.prepare({ role, policy, ownerCodexHome: paths.ownerCodexHome, runtime })
    generation.publish()
    return generation
  }
  return { base, realState, homesRoot, ownerCodexHome, ownerWorkspace, protectedPaths, start, build, policy, runtime, warnings }
}

function snapshot(base: string, excluded: string): Map<string, string> {
  const result = new Map<string, string>()
  function visit(path: string): void {
    if (path === excluded) return
    const stat = lstatSync(path)
    const value = stat.isSymbolicLink() ? 'link:' + readlinkSync(path)
      : stat.isDirectory() ? 'dir' : createHash('sha256').update(readFileSync(path)).digest('hex')
    result.set(relative(base, path), value)
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
  }
  visit(base)
  return result
}

function expectPreserved(before: Map<string, string>, base: string, excluded: string): void {
  const after = snapshot(base, excluded)
  for (const [path, value] of before) expect(after.get(path)).toBe(value)
}

test('A1 preserves configured HOME and CODEX_HOME links in previous role homes', () => {
  for (const name of ['userHome', 'ownerCodexHome']) {
    const f = fixture()
    const oldRole = join(f.homesRoot, 'guest')
    mkdirSync(oldRole, { recursive: true })
    const link = join(oldRole, name)
    const target = name === 'userHome' ? f.ownerWorkspace : f.ownerCodexHome
    symlinkSync(target, link)
    const excluded = join(f.homesRoot, 'generations')
    const before = snapshot(f.base, excluded)
    const paths = { ...f.protectedPaths, [name]: link }
    const first = f.start(paths)
    const second = f.start(paths)
    expect(second.id).not.toBe(first.id)
    expect(gc(openPublicGenerations(f.homesRoot), [second.id]).problems).toEqual([])
    expect(existsSync(join(second.path, 'guest', name))).toBe(false)
    expectPreserved(before, f.base, excluded)
    expect(readlinkSync(link)).toBe(target)
  }
})

test('A2 preserves pre-existing files when the parent state directory is aliased', () => {
  const f = fixture(true)
  const oldRole = join(f.homesRoot, 'guest')
  mkdirSync(oldRole, { recursive: true })
  writeFileSync(join(oldRole, 'keep.txt'), 'legacy work')
  writeFileSync(join(f.realState, 'keep.txt'), 'state owner work')
  const excluded = join(f.realState, 'codex-public', 'generations')
  const before = snapshot(f.base, excluded)
  const first = f.start()
  const second = f.start()
  expect(gc(openPublicGenerations(f.homesRoot), [second.id]).problems).toEqual([])
  expect(existsSync(first.path)).toBe(false)
  expectPreserved(before, f.base, excluded)
})

test('A3 a substituted config entry is preserved with its target intact', () => {
  const f = fixture()
  const oldRole = join(f.homesRoot, 'guest')
  mkdirSync(oldRole, { recursive: true })
  const config = join(oldRole, 'config.toml')
  symlinkSync(join(f.ownerCodexHome, 'config.toml'), config)
  const excluded = join(f.homesRoot, 'generations')
  const before = snapshot(f.base, excluded)
  f.start()
  expectPreserved(before, f.base, excluded)
})

test('A3 substituting a role or config destination at creation fails closed', () => {
  for (const destination of ['role', 'config.toml', 'auth.json']) {
    const f = fixture()
    const excluded = join(f.homesRoot, 'generations')
    const before = snapshot(f.base, excluded)
    let swapped = false
    expect(() => f.start(f.protectedPaths, path => {
      if (destination === 'role' ? !path.endsWith('/guest/skills') : !path.endsWith('/guest/' + destination)) return
      swapped = true
      if (destination === 'role') {
        const role = join(path, '..')
        renameSync(role, role + '-displaced')
        symlinkSync(f.ownerCodexHome, role)
      } else {
        symlinkSync(join(f.ownerCodexHome, destination), path)
      }
    })).toThrow()
    expect(swapped).toBe(true)
    expectPreserved(before, f.base, excluded)
    expect(readdirSync(f.ownerCodexHome).sort()).toEqual(['auth.json', 'config.toml'])
    expect(openPublicGenerations(f.homesRoot).importId).toBeUndefined()
  }
})

test('A3 substituting a source sessions directory, nested directory or file skips it', () => {
  for (const entry of ['sessions', 'sessions/nested', 'sessions/nested/history.jsonl']) {
    const f = fixture()
    const first = f.start()
    const sessions = join(first.path, 'guest', 'sessions')
    mkdirSync(join(sessions, 'nested'), { recursive: true })
    writeFileSync(join(sessions, 'nested', 'history.jsonl'), 'previous history')
    const source = join(first.path, 'guest', entry)
    const excluded = join(f.homesRoot, 'generations')
    const before = snapshot(f.base, excluded)
    let swapped = false
    const second = f.start(f.protectedPaths, path => {
      if (path !== source || swapped) return
      swapped = true
      renameSync(source, source + '-displaced')
      symlinkSync(entry.endsWith('.jsonl') ? join(f.ownerWorkspace, 'keep.txt') : f.ownerWorkspace, source)
    })
    expect(swapped).toBe(true)
    expect(f.warnings).toHaveLength(1)
    expect(existsSync(join(second.path, 'guest', entry))).toBe(false)
    expectPreserved(before, f.base, excluded)
  }
})

test('publishes both roles, retries generation collisions, and ignores an incomplete higher sequence', () => {
  const f = fixture()
  let collided = false
  const generation = f.build(f.protectedPaths, path => {
    if (!collided && GENERATION_ID.test(path.split('/').at(-1) ?? '')) {
      mkdirSync(path)
      collided = true
    }
  })
  expect(generation.id).toMatch(/^000000000002-/)
  generation.prepare({ role: 'member', policy: f.policy, runtime: f.runtime, ownerCodexHome: f.ownerCodexHome })
  expect(() => generation.publish()).toThrow('both roles')
  generation.prepare({ role: 'guest', policy: f.policy, runtime: f.runtime, ownerCodexHome: f.ownerCodexHome })
  generation.publish()
  expect(() => generation.publish()).toThrow()
  const aborted = f.build()
  expect(aborted.id).toMatch(/^000000000003-/)
  expect(openPublicGenerations(f.homesRoot).importId).toBe(generation.id)
})

test('refuses symlinks at the public root and generations directory', () => {
  const root = fixture()
  symlinkSync(root.ownerWorkspace, root.homesRoot)
  expect(() => openPublicGenerations(root.homesRoot)).toThrow('bridge-owned directory')
  const generations = fixture()
  mkdirSync(generations.homesRoot)
  symlinkSync(generations.ownerWorkspace, join(generations.homesRoot, 'generations'))
  expect(() => openPublicGenerations(generations.homesRoot)).toThrow('bridge-owned directory')
})

test('A6 resumes a saved chat using the imported history and skips linked files', async () => {
  const f = fixture()
  const first = f.start()
  const guest = join(first.path, 'guest')
  mkdirSync(join(guest, 'sessions', '2026'), { recursive: true })
  const chatThread = 'saved-chat'
  const rollout = JSON.stringify({ id: chatThread })
  writeFileSync(join(guest, 'sessions', '2026', 'rollout.jsonl'), rollout)
  writeFileSync(join(guest, 'bridge-thread.json'), JSON.stringify('saved-thread'))
  writeFileSync(join(guest, 'stale.txt'), 'stale')
  symlinkSync(f.ownerWorkspace, join(guest, 'sessions', 'linked'))
  linkSync(join(f.ownerWorkspace, 'keep.txt'), join(guest, 'sessions', 'hard-link'))
  const excluded = join(f.homesRoot, 'generations')
  const before = snapshot(f.base, excluded)
  const second = f.start()
  const next = join(second.path, 'guest')
  const stateFile = join(next, 'bridge-thread.json')
  expect(readSavedMainThread(stateFile)).toBe('saved-thread')
  const copiedRollout = join(next, 'sessions', '2026', 'rollout.jsonl')
  expect(readFileSync(copiedRollout, 'utf8')).toBe(rollout)
  expect(readdirSync(join(next, 'sessions'))).toEqual(['2026'])
  expect(existsSync(join(next, 'stale.txt'))).toBe(false)
  expect(existsSync(join(guest, 'stale.txt'))).toBe(true)
  expect(f.warnings).toHaveLength(1)

  const session = new CodexSession({
    cwd: f.ownerWorkspace, stateFile, env: {},
    command: [process.execPath, '--no-env-file', '-e', ''],
  }, () => {})
  const childRpc: unknown = Object.getOwnPropertyDescriptor(session, 'rpc')?.value
  if (!(childRpc instanceof CodexRpc)) throw new Error('Expected the session RPC fixture')
  childRpc.close()
  const resumes: unknown[] = []
  Object.defineProperty(session, 'rpc', { value: {
    request: async (method: string, params: Json) => {
      if (method !== 'thread/resume') throw new Error('Expected to resume the saved chat')
      resumes.push(params.threadId)
      if (readFileSync(copiedRollout, 'utf8') !== JSON.stringify({ id: params.threadId })) {
        throw new Error('Missing rollout in the new role home')
      }
      return { thread: { id: params.threadId } }
    },
    close: () => {},
  } })
  try {
    const turn = await session.runPublic('resume', {
      cwd: f.ownerWorkspace, instructions: 'fixture', threadId: chatThread, cancelled: () => true,
    })
    expect(session.currentThread).toBe('saved-thread')
    expect(turn.threadId).toBe(chatThread)
    expect(resumes).toEqual([chatThread])
    expectPreserved(before, f.base, excluded)
  } finally {
    session.close()
  }
})

test('A1 GC quarantines old generations holding either configured owner alias', () => {
  for (const name of ['userHome', 'ownerCodexHome']) {
    const f = fixture()
    const first = f.start()
    const link = join(first.path, 'guest', name)
    const target = name === 'userHome' ? f.ownerWorkspace : f.ownerCodexHome
    symlinkSync(target, link)
    const excluded = join(f.homesRoot, 'generations')
    const before = snapshot(f.base, excluded)
    const second = f.start({ ...f.protectedPaths, [name]: link })
    expect(gc(openPublicGenerations(f.homesRoot), [second.id]).problems).toEqual([first.path])
    expect(readlinkSync(link)).toBe(target)
    expect(existsSync(join(second.path, 'guest', name))).toBe(false)
    expectPreserved(before, f.base, excluded)
  }
})

test('A3 the GC child stops when a role or nested directory is substituted before deletion', () => {
  for (const entry of ['guest', 'guest/sessions']) {
    const f = fixture()
    const first = f.start()
    const held = f.start()
    const previous = join(first.path, entry)
    const sessions = join(first.path, 'guest', 'sessions')
    mkdirSync(sessions)
    writeFileSync(join(sessions, 'rollout.jsonl'), 'previous history')
    const store = openPublicGenerations(f.homesRoot)
    const before = snapshot(f.base, store.directory)
    const childSource = `
      import { renameSync, symlinkSync } from 'node:fs';
      const [module, request, previous, outside] = process.argv.slice(1);
      const { collectPublicHomes } = await import(module);
      let swapped = false;
      const result = collectPublicHomes(JSON.parse(request), { before: path => {
        if (swapped || !path.startsWith(previous + '/')) return;
        swapped = true;
        renameSync(previous, previous + '-displaced');
        symlinkSync(outside, previous);
      } });
      console.log(JSON.stringify({ ...result, swapped }));
    `
    const child = Bun.spawnSync([
      process.execPath, '--no-env-file', '-e', childSource,
      join(import.meta.dir, '../../src/codex/public-gc.ts'),
      JSON.stringify(planPublicGc(store, { keep: [held.id], lockFile: lockFile(store) })),
      previous, f.ownerWorkspace,
    ], { cwd: dirname(store.root), env: {}, stdout: 'pipe' })
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ problems: expect.arrayContaining([first.path]), swapped: true })
    expect(readlinkSync(previous)).toBe(f.ownerWorkspace)
    expectPreserved(before, f.base, store.directory)
    expect(existsSync(held.path)).toBe(true)
  }
})

test('an unreadable history file fails the import: the source is kept and the import is retried next start', () => {
  const f = fixture()
  const first = f.start()
  const history = join(first.path, 'guest', 'sessions', 'rollout.jsonl')
  mkdirSync(dirname(history))
  writeFileSync(history, 'previous history')
  chmodSync(history, 0)
  const second = f.start()
  expect(second.importFailures()).toEqual([first.path])
  expect(second.keep()).toEqual([second.id, first.id])
  expect(f.warnings.join('\n')).toContain('retried at the next start')
  // The second collection of the start (server.ts) keeps the failed source.
  expect(gc(openPublicGenerations(f.homesRoot), second.keep()).problems).toEqual([])
  expect(existsSync(history)).toBe(true)
  chmodSync(history, 0o600)
  const store = openPublicGenerations(f.homesRoot)
  expect(store.keep).toEqual([second.id, first.id])
  const third = f.start()
  expect(third.importFailures()).toEqual([])
  expect(readFileSync(join(third.path, 'guest', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('previous history')
  expect(gc(openPublicGenerations(f.homesRoot), third.keep()).problems).toEqual([])
  expect(readdirSync(store.directory)).toEqual([third.id])
})
