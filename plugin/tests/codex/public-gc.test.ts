import { afterEach, expect, test } from 'bun:test'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { collectPublicHomes, planPublicGc, runPublicGc, type GcHooks, type GcInput } from '../../src/codex/public-gc.js'
import { createPublicGeneration, openPublicGenerations } from '../../src/codex/public-generations.js'
import { hookProofName, loadPublicPolicy, PUBLIC_ROLES } from '../../src/codex/public-home.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

type Store = ReturnType<typeof openPublicGenerations>

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'krot-public-gc-'))
  dirs.push(base)
  const root = join(base, 'codex-public')
  const ownerCodexHome = join(base, 'owner')
  mkdirSync(ownerCodexHome)
  writeFileSync(join(ownerCodexHome, 'auth.json'), '{}')
  writeFileSync(join(ownerCodexHome, 'config.toml'), '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\n' +
    'type = "command"\ncommand = "/opt/bun /opt/codex-permission-hook.js /opt/policy.yaml 8092 /opt/auth-file --thread-role"\n')
  const policy = loadPublicPolicy(base, {})
  const runtime = { bun: '/opt/bun', codex: '/opt/codex', codexBuild: 'test' }
  return { base, root, ownerCodexHome, policy, runtime }
}

// The token lock as the bridge holds it: bot.pid in the state directory names the given process.
function lockFile(store: Store, pid = process.pid): string {
  const file = join(dirname(store.root), 'bot.pid')
  writeFileSync(file, String(pid))
  return file
}

function gc(store: Store, keep: string[] = [], retire: string[] = [], keepProofs?: string[]) {
  return runPublicGc(store, { keep, retire, lockFile: lockFile(store), ...(keepProofs ? { keepProofs } : {}) })
}

// The collector in this process, as the child runs it: anchored at the state directory, parent = our parent.
function collectHere(store: Store, input: GcInput, hooks?: GcHooks) {
  const cwd = process.cwd()
  process.chdir(dirname(store.root))
  try {
    return collectPublicHomes(input, hooks)
  } finally {
    process.chdir(cwd)
  }
}

function planHere(store: Store, keep: string[] = []): GcInput {
  return { ...planPublicGc(store, { keep, lockFile: lockFile(store, process.ppid) }), parentPid: process.ppid }
}

const clean = { problems: [], legacy: [], quarantined: [], stopped: [] }

test('A4 the child keeps retention bounded across 20 starts with five interrupted builds', () => {
  const { root, policy, runtime, ownerCodexHome } = fixture()
  for (let attempt = 0; attempt < 20; attempt++) {
    const store = openPublicGenerations(root)
    expect(gc(store, store.keep, store.keep)).toEqual(clean)
    if (store.importId) {
      const oldState = join(store.directory, store.importId, 'guest', 'bridge-thread.json')
      expect(readFileSync(oldState, 'utf8')).toBe('"saved"')
    }
    const generation = createPublicGeneration(store, () => {})
    const interrupted = attempt >= 9 && attempt < 14
    if (interrupted) {
      generation.prepare({ role: 'member', policy, runtime, ownerCodexHome })
      // Interrupt the second role after the first role has already copied its login.
      expect(() => generation.prepare({ role: 'guest', policy, runtime, ownerCodexHome: join(ownerCodexHome, 'missing') })).toThrow()
    } else {
      for (const role of PUBLIC_ROLES) generation.prepare({ role, policy, runtime, ownerCodexHome })
      if (attempt === 0) writeFileSync(join(generation.path, 'guest', 'bridge-thread.json'), '"saved"')
      generation.publish()
      expect(gc(store, generation.keep())).toEqual(clean)
    }
    const ids = readdirSync(store.directory)
    expect(ids.length).toBeLessThanOrEqual(interrupted ? 2 : 1)
    for (const role of PUBLIC_ROLES) {
      const logins = ids.filter(id => existsSync(join(store.directory, id, role, 'auth.json')))
      expect(logins).toHaveLength(interrupted && role === 'guest' ? 0 : 1)
    }
  }
})

test('GC pre-walk preserves whole unsafe generations and removes only legacy auth', () => {
  const { base, root } = fixture()
  const store = openPublicGenerations(root)
  const outside = join(base, 'owner', 'keep.txt')
  writeFileSync(outside, 'owner work')
  const legacy = join(root, 'member')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'auth.json'), '{}')
  writeFileSync(join(legacy, 'keep.txt'), 'legacy work')
  const guest = join(root, 'guest')
  mkdirSync(guest)
  symlinkSync(outside, join(guest, 'auth.json'))
  const bad: string[] = []
  for (const makeUnsafe of [symlinkSync, linkSync]) {
    const generation = createPublicGeneration(openPublicGenerations(root), () => {})
    writeFileSync(join(generation.path, 'a.txt'), 'preserve')
    makeUnsafe(outside, join(generation.path, 'z.txt'))
    bad.push(generation.path)
  }
  const kept = createPublicGeneration(openPublicGenerations(root), () => {})
  const collected = createPublicGeneration(openPublicGenerations(root), () => {})
  writeFileSync(join(collected.path, 'normal.txt'), 'normal')
  const unrelated = join(store.directory, 'unmanaged')
  mkdirSync(unrelated)
  const result = gc(store, [kept.id])
  expect(result.problems.sort()).toEqual([...bad, guest].sort())
  expect(result.quarantined.sort()).toEqual([...bad].sort())
  expect(result.legacy.sort()).toEqual([guest, legacy].sort())
  for (const path of bad) expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('preserve')
  expect(existsSync(kept.path)).toBe(true)
  expect(existsSync(collected.path)).toBe(false)
  expect(existsSync(unrelated)).toBe(true)
  expect(existsSync(join(legacy, 'auth.json'))).toBe(false)
  expect(readFileSync(join(legacy, 'keep.txt'), 'utf8')).toBe('legacy work')
  expect(readFileSync(outside, 'utf8')).toBe('owner work')
})

test('GC reports a stale store identity without collecting from its replacement', () => {
  const { root } = fixture()
  const store = openPublicGenerations(root)
  const replacement = join(store.directory, '000000000001-0000000000000000')
  // Reuse the existing fixture directory at an unexpected identity.
  const other = fixture()
  const otherStore = openPublicGenerations(other.root)
  mkdirSync(replacement)
  const input = { ...planPublicGc(store, { keep: [], lockFile: lockFile(store) }), identities: otherStore.identities }
  expect(collectHere(store, { ...input, parentPid: process.ppid }, {}).problems).toEqual([root])
  expect(existsSync(replacement)).toBe(true)
})

test('GC preserves login files if the import source identity changes', () => {
  const { root, policy, runtime, ownerCodexHome } = fixture()
  const generation = createPublicGeneration(openPublicGenerations(root), () => {})
  for (const role of PUBLIC_ROLES) generation.prepare({ role, policy, runtime, ownerCodexHome })
  generation.publish()
  const store = openPublicGenerations(root)
  const displaced = generation.path + '-displaced'
  renameSync(generation.path, displaced)
  const replacement = join(generation.path, 'guest')
  mkdirSync(replacement, { recursive: true })
  writeFileSync(join(replacement, 'auth.json'), '{}')
  expect(gc(store, [generation.id], [generation.id]).problems).toEqual([generation.path])
  expect(existsSync(join(replacement, 'auth.json'))).toBe(true)
  expect(existsSync(join(displaced, 'guest', 'auth.json'))).toBe(true)
})

test('GC deletes only the candidates fixed under the lock, never a home published after the plan', () => {
  const { root, policy, runtime, ownerCodexHome } = fixture()
  const retired = createPublicGeneration(openPublicGenerations(root), () => {})
  const store = openPublicGenerations(root)
  const input = planHere(store)
  // A replacement bridge builds and publishes its active home while the old child is paused.
  const active = createPublicGeneration(openPublicGenerations(root), () => {})
  for (const role of PUBLIC_ROLES) active.prepare({ role, policy, runtime, ownerCodexHome })
  active.publish()
  expect(collectHere(store, input)).toEqual(clean)
  expect(existsSync(retired.path)).toBe(false)
  expect(existsSync(join(active.path, 'guest', 'auth.json'))).toBe(true)
})

test('GC child whose bridge is gone or lost the token lock deletes nothing', () => {
  for (const lost of ['parent', 'lock']) {
    const { root } = fixture()
    const retired = createPublicGeneration(openPublicGenerations(root), () => {})
    writeFileSync(join(retired.path, 'a.txt'), 'old')
    const store = openPublicGenerations(root)
    const input = planHere(store)
    if (lost === 'lock') writeFileSync(input.lockFile, String(process.ppid + 1))
    const stale = lost === 'parent' ? { ...input, parentPid: process.ppid + 1 } : input
    expect(collectHere(store, stale).problems).toEqual([root])
    expect(readFileSync(join(retired.path, 'a.txt'), 'utf8')).toBe('old')
  }
})

test('GC re-checks identity right before each removal; a swap after the check removes at most the swapped-in link', () => {
  const { base, root } = fixture()
  const outsideDir = join(base, 'owner-dir')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'keep.txt'), 'owner work')
  const outsideFile = join(base, 'owner', 'keep.txt')
  writeFileSync(outsideFile, 'owner file')
  const retired = createPublicGeneration(openPublicGenerations(root), () => {})
  writeFileSync(join(retired.path, 'a.txt'), 'old')
  const withDirectory = createPublicGeneration(openPublicGenerations(root), () => {})
  mkdirSync(join(withDirectory.path, 'd'))
  const store = openPublicGenerations(root)
  const swapped: string[] = []
  const result = collectHere(store, planHere(store), {
    afterCheck: path => {
      if (path.endsWith('/a.txt')) {
        renameSync(path, join(base, 'moved.txt'))
        symlinkSync(outsideFile, path)
        swapped.push(path)
      } else if (path.endsWith('/d')) {
        rmdirSync(path)
        symlinkSync(outsideDir, path)
        swapped.push(path)
      }
    },
  })
  expect(swapped).toHaveLength(2)
  // The file link itself was removed, the directory link was refused (rmdir never follows it).
  expect(existsSync(retired.path)).toBe(false)
  expect(lstatSync(join(withDirectory.path, 'd')).isSymbolicLink()).toBe(true)
  expect(result.problems).toEqual([withDirectory.path])
  expect(readFileSync(outsideFile, 'utf8')).toBe('owner file')
  expect(readFileSync(join(outsideDir, 'keep.txt'), 'utf8')).toBe('owner work')
  expect(readFileSync(join(base, 'moved.txt'), 'utf8')).toBe('old')
})

async function socketAt(path: string, scratch: string): Promise<Server> {
  // Unix socket paths are short; bind nearby and move the socket inode into place.
  const server = createServer()
  await new Promise<void>(resolve => server.listen(scratch, resolve))
  renameSync(scratch, path)
  return server
}

test('GC removes the Codex runtime links and sockets, and retires the login of a quarantined generation', async () => {
  const { base, root, policy, runtime, ownerCodexHome } = fixture()
  const retired = createPublicGeneration(openPublicGenerations(root), () => {})
  for (const role of PUBLIC_ROLES) retired.prepare({ role, policy, runtime, ownerCodexHome })
  retired.publish()
  const servers: Server[] = []
  for (const role of PUBLIC_ROLES) {
    const home = join(retired.path, role)
    const arg0 = join(home, 'tmp', 'arg0-linux', 'codex-arg0Ab12Cd')
    mkdirSync(arg0, { recursive: true })
    for (const name of ['codex-linux-sandbox', 'applypatch', 'apply_patch']) symlinkSync('/opt/codex', join(arg0, name))
    mkdirSync(join(home, 'packages', 'app-server-daemon'), { recursive: true })
    symlinkSync('0.1.0', join(home, 'packages', 'app-server-daemon', 'current'))
    mkdirSync(join(home, 'app-server-daemon'))
    mkdirSync(join(home, 'app-server-control'))
    servers.push(await socketAt(join(home, 'app-server-daemon', 'daemon-updater.sock'), join(base, role + '1.sock')))
    servers.push(await socketAt(join(home, 'app-server-control', 'app-server-control.sock'), join(base, role + '2.sock')))
  }
  const odd = createPublicGeneration(openPublicGenerations(root), () => {})
  for (const role of PUBLIC_ROLES) odd.prepare({ role, policy, runtime, ownerCodexHome })
  odd.publish()
  // An unknown link (not on the Codex list) still quarantines its generation.
  symlinkSync(ownerCodexHome, join(odd.path, 'member', 'packages-current'))
  const store = openPublicGenerations(root)
  try {
    const result = gc(store)
    expect(result.quarantined).toEqual([odd.path])
    expect(result.problems).toEqual([odd.path])
  } finally {
    for (const server of servers) server.close()
  }
  expect(existsSync(retired.path)).toBe(false)
  for (const role of PUBLIC_ROLES) expect(existsSync(join(odd.path, role, 'auth.json'))).toBe(false)
  expect(lstatSync(join(odd.path, 'member', 'packages-current')).isSymbolicLink()).toBe(true)
  expect(readdirSync(ownerCodexHome).sort()).toEqual(['auth.json', 'config.toml'])
})

test('GC removes hook proofs of another home hash only when they are regular own files', () => {
  const { base, root } = fixture()
  const store = openPublicGenerations(root)
  const current = hookProofName('member', 'hash-now')
  const stale = hookProofName('member', 'hash-old')
  const linked = hookProofName('guest', 'hash-old')
  const outside = join(base, 'owner', 'keep.txt')
  writeFileSync(outside, 'owner work')
  writeFileSync(join(root, current), JSON.stringify({ version: 1, configHash: 'hash-now' }))
  for (const name of [stale, 'member.hook-proof.json']) writeFileSync(join(root, name), '{}')
  symlinkSync(outside, join(root, linked))
  expect(gc(store, [], [], [current])).toEqual(clean)
  expect(existsSync(join(root, current))).toBe(true)
  expect(existsSync(join(root, stale))).toBe(false)
  expect(lstatSync(join(root, linked)).isSymbolicLink()).toBe(true)
  expect(existsSync(join(root, 'member.hook-proof.json'))).toBe(true)
  expect(readFileSync(outside, 'utf8')).toBe('owner work')
})

test('A5 public home construction has no deletion, replacement or truncation primitives', () => {
  for (const file of ['public-home.ts', 'public-generations.ts', 'public-backends.ts']) {
    const source = readFileSync(join(import.meta.dir, '../../src/codex', file), 'utf8')
    expect(source).not.toMatch(/\b(?:rmSync|unlinkSync|rmdirSync|renameSync|truncateSync)\b/u)
  }
  // The publish primitive removes only its own temporary name, once, and never renames over a final.
  const publish = readFileSync(join(import.meta.dir, '../../src/codex/public-publish.ts'), 'utf8')
  expect(publish.match(/\bunlinkSync\(/gu) ?? []).toHaveLength(1)
  expect(publish).not.toMatch(/\b(?:rmSync|rmdirSync|renameSync|truncateSync)\b/u)
  const gc = readFileSync(join(import.meta.dir, '../../src/codex/public-gc.ts'), 'utf8')
  expect(gc).not.toContain('recursive')
})
