import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { EXIT, fatalReason, PUBLISH_UNSUPPORTED_FATAL } from '../../src/codex/exit-codes.js'
import { runPublicGc, type GcResult } from '../../src/codex/public-gc.js'
import { createPublicGeneration, openPublicGenerations } from '../../src/codex/public-generations.js'
import { loadPublicPolicy, PUBLIC_ROLES } from '../../src/codex/public-home.js'
import { publishExclusive, type PublishFault, type PublishStep } from '../../src/codex/public-publish.js'
import { startupErrorMessage } from '../../src/codex/startup-error.js'
import { startupFailureExit } from '../../src/codex/startup-failure.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'krot-publish-'))
  dirs.push(base)
  const state = join(base, 'state')
  mkdirSync(state)
  const ownerCodexHome = join(base, 'owner')
  mkdirSync(ownerCodexHome)
  writeFileSync(join(ownerCodexHome, 'auth.json'), '{}')
  writeFileSync(join(ownerCodexHome, 'config.toml'), '[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\n' +
    'type = "command"\ncommand = "/opt/bun /opt/codex-permission-hook.js /opt/policy.yaml 8092 /opt/auth-file --thread-role"\n')
  const homesRoot = join(state, 'codex-public')
  const policy = loadPublicPolicy(state, {})
  const runtime = { bun: '/opt/bun', codex: '/opt/codex', codexBuild: 'test' }
  const lockFile = join(state, 'bot.pid')
  writeFileSync(lockFile, String(process.pid))
  const warnings: string[] = []
  // One bridge start as server.ts runs it: collect, build both roles, publish, collect again.
  const boot = (fault?: PublishFault) => {
    const store = openPublicGenerations(homesRoot)
    const gcs: GcResult[] = [runPublicGc(store, { keep: store.keep, retire: store.keep, lockFile })]
    const generation = createPublicGeneration(store, warning => warnings.push(warning))
    for (const role of PUBLIC_ROLES) generation.prepare({ role, policy, ownerCodexHome, runtime })
    generation.publish(fault)
    gcs.push(runPublicGc(store, { keep: generation.keep(), lockFile }))
    return { store, generation, gcs }
  }
  return { base, homesRoot, generations: join(homesRoot, 'generations'), boot, warnings }
}

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
}

// Stops the publish at `step`; a fault at `write` first leaves a partial `{` in the temporary file.
function faultAt(step: PublishStep, fired: PublishStep[] = []): PublishFault {
  return (current, tempPath) => {
    if (current !== step) return
    fired.push(current)
    if (step === 'write') writeFileSync(tempPath, '{')
    throw enospc()
  }
}

function marker(generation: string): string {
  return join(generation, 'complete.json')
}

function markerJson(generation: string): unknown {
  return JSON.parse(readFileSync(marker(generation), 'utf8'))
}

function addRollout(generation: string, text = 'previous history'): string {
  const file = join(generation, 'guest', 'sessions', '2026', 'rollout.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

test('R1 a partial marker of a faulted start never makes its unreadable import source collectable', () => {
  const f = fixture()
  const a = f.boot().generation
  const rollout = addRollout(a.path)
  chmodSync(rollout, 0)
  try {
    let b = ''
    expect(() => f.boot((step, temp) => {
      b = dirname(temp)
      faultAt('write')(step, temp)
    })).toThrow('ENOSPC')
    const c = f.boot().generation
    expect(existsSync(a.path)).toBe(true)
    expect(existsSync(rollout)).toBe(true)
    expect(existsSync(marker(b))).toBe(false)
    expect(existsSync(b)).toBe(false)
    expect(markerJson(c.path)).toMatchObject({ retry: [a.id] })
  } finally {
    if (existsSync(rollout)) chmodSync(rollout, 0o600)
  }
})

test('R2 a fault at any publish step leaves the marker absent or complete, and the history survives', () => {
  const steps: PublishStep[] = ['open', 'write', 'fsync', 'link', 'unlink', 'dirsync']
  for (const step of steps) {
    const f = fixture()
    const a = f.boot().generation
    addRollout(a.path)
    const fired: PublishStep[] = []
    let b = ''
    expect(() => f.boot((current, temp) => {
      b = dirname(temp)
      faultAt(step, fired)(current, temp)
    })).toThrow()
    expect(fired).toEqual([step])
    const final = lstatSync(marker(b), { throwIfNoEntry: false })
    if (final) expect(markerJson(b)).toEqual({ version: 1, id: b.split('/').at(-1), retry: [] })
    // The import source stays until a generation that imported it is published.
    expect(existsSync(a.path)).toBe(true)
    const c = f.boot().generation
    expect(readFileSync(join(c.path, 'guest', 'sessions', '2026', 'rollout.jsonl'), 'utf8')).toBe('previous history')
  }
})

test('R3 a crash between link and unlink leaves an unpublished generation that the next gc removes whole', () => {
  const f = fixture()
  const a = f.boot().generation
  addRollout(a.path)
  let b = ''
  expect(() => f.boot((step, temp) => {
    b = dirname(temp)
    faultAt('unlink')(step, temp)
  })).toThrow()
  expect(lstatSync(marker(b)).nlink).toBe(2)
  expect(openPublicGenerations(f.homesRoot).importId).toBe(a.id)
  const next = f.boot()
  expect(next.gcs[0]).toEqual({ problems: [], legacy: [], quarantined: [], stopped: [] })
  expect(existsSync(b)).toBe(false)
  expect(readFileSync(join(next.generation.path, 'guest', 'sessions', '2026', 'rollout.jsonl'), 'utf8')).toBe('previous history')
})

test('R4 any damaged marker stops gc: no generation is removed, the path is listed, logins are still retired', () => {
  const variants: Array<[string, (file: string, id: string, base: string) => void]> = [
    ['partial', file => writeFileSync(file, '{')],
    ['empty', file => writeFileSync(file, '')],
    ['array', file => writeFileSync(file, '[]')],
    ['wrong id', file => writeFileSync(file, JSON.stringify({ version: 1, id: '000000000009-aaaaaaaaaaaaaaaa', retry: [] }))],
    ['version 2', (file, id) => writeFileSync(file, JSON.stringify({ version: 2, id, retry: [] }))],
    ['no version', (file, id) => writeFileSync(file, JSON.stringify({ id, retry: [] }))],
    ['retry string', (file, id) => writeFileSync(file, JSON.stringify({ version: 1, id, retry: 'x' }))],
    ['unknown retry token', (file, id) => writeFileSync(file, JSON.stringify({ version: 1, id, retry: ['nope'] }))],
    ['symlink', (file, id, base) => {
      const real = join(base, 'marker.json')
      writeFileSync(real, JSON.stringify({ version: 1, id, retry: [] }))
      symlinkSync(real, file)
    }],
    ['hard link', (file, id, base) => {
      writeFileSync(file, JSON.stringify({ version: 1, id, retry: [] }))
      linkSync(file, join(base, 'marker-link.json'))
    }],
    ['mode 000', (file, id) => {
      writeFileSync(file, JSON.stringify({ version: 1, id, retry: [] }))
      chmodSync(file, 0)
    }],
  ]
  for (const [label, damage] of variants) {
    const f = fixture()
    const older = f.boot().generation
    const a = f.boot().generation
    // The collection after a's start removed older; plant it again as a published generation
    // that a working gc would collect.
    expect(existsSync(older.path)).toBe(false)
    mkdirSync(join(older.path, 'member'), { recursive: true })
    writeFileSync(join(older.path, 'member', 'auth.json'), '{}')
    writeFileSync(marker(older.path), JSON.stringify({ version: 1, id: older.id, retry: [] }))
    rmSync(marker(a.path))
    damage(marker(a.path), a.id, f.base)
    const next = f.boot()
    try {
      expect(readdirSync(f.generations).sort(), label).toEqual([older.id, a.id, next.generation.id].sort())
      for (const gc of next.gcs) expect(gc.stopped, label).toEqual([a.path])
      for (const role of PUBLIC_ROLES) expect(existsSync(join(a.path, role, 'auth.json')), label).toBe(false)
      expect(existsSync(join(older.path, 'member', 'auth.json')), label).toBe(false)
      expect(existsSync(join(next.generation.path, 'member', 'auth.json')), label).toBe(true)
    } finally {
      if (label === 'mode 000') chmodSync(marker(a.path), 0o600)
    }
  }
})

test('R5 a retry id naming a missing generation stops gc for that start', () => {
  const f = fixture()
  const a = f.boot().generation
  const missing = '000000000000-0000000000000000'
  rmSync(marker(a.path))
  writeFileSync(marker(a.path), JSON.stringify({ version: 1, id: a.id, retry: [missing] }))
  const b = f.boot()
  expect(readdirSync(f.generations).sort()).toEqual([a.id, b.generation.id].sort())
  for (const gc of b.gcs) expect(gc.stopped).toEqual([join(f.generations, missing)])
  const c = f.boot()
  expect(c.gcs.map(gc => gc.stopped)).toEqual([[], []])
  expect(readdirSync(f.generations)).toEqual([c.generation.id])
})

test('R5 a retry target whose marker was removed is still imported before any gc may collect it', () => {
  const f = fixture()
  // Boot A: its sole rollout cannot be read at the next start.
  const a = f.boot().generation
  const rollout = addRollout(a.path, 'sole history')
  chmodSync(rollout, 0)
  let b: ReturnType<typeof f.boot>
  try {
    // Boot B: the import from A fails, so B's marker names A for a retry.
    b = f.boot()
  } finally {
    chmodSync(rollout, 0o600)
  }
  expect(markerJson(b.generation.path)).toMatchObject({ retry: [a.id] })
  // A loses its marker; its history is readable again.
  rmSync(marker(a.path))
  // Boot C: A is still a referenced import source, so its history is copied and kept until then.
  const c = f.boot()
  const imported = join(c.generation.path, 'guest', 'sessions', '2026', 'rollout.jsonl')
  expect(readFileSync(imported, 'utf8')).toBe('sole history')
  expect(markerJson(c.generation.path)).toMatchObject({ retry: [] })
  // Boot D: whatever C's marker lets gc collect, the sole history lives on.
  const d = f.boot()
  expect(readFileSync(join(d.generation.path, 'guest', 'sessions', '2026', 'rollout.jsonl'), 'utf8')).toBe('sole history')
})

test('R6 publishing never replaces a file, a live link or a dangling link at the final name', () => {
  const f = fixture()
  mkdirSync(f.homesRoot)
  const outside = join(f.base, 'owner', 'keep.txt')
  writeFileSync(outside, 'owner work')
  const cases: Array<[string, () => void]> = [
    ['file.json', () => writeFileSync(join(f.homesRoot, 'file.json'), 'kept')],
    ['live.json', () => symlinkSync(outside, join(f.homesRoot, 'live.json'))],
    ['dangling.json', () => symlinkSync(join(f.base, 'absent.json'), join(f.homesRoot, 'dangling.json'))],
  ]
  for (const [name, plant] of cases) {
    plant()
    let code: unknown
    try {
      publishExclusive(f.homesRoot, name, '{"new":true}\n', () => {})
    } catch (error) {
      code = error instanceof Error && 'code' in error ? error.code : undefined
    }
    expect(code, name).toBe('EEXIST')
  }
  expect(readFileSync(join(f.homesRoot, 'file.json'), 'utf8')).toBe('kept')
  expect(readFileSync(outside, 'utf8')).toBe('owner work')
  expect(readlinkSync(join(f.homesRoot, 'live.json'))).toBe(outside)
  expect(existsSync(join(f.base, 'absent.json'))).toBe(false)
})

test('R11 the publish primitive is the only build-path unlink, and gc collects a stale publish temp', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/codex/public-publish.ts'), 'utf8')
  expect(source.match(/\bunlinkSync\(/gu) ?? []).toHaveLength(1)
  expect(source).not.toMatch(/\brenameSync\b/u)
  const f = fixture()
  f.boot()
  const outside = join(f.base, 'owner', 'keep.txt')
  writeFileSync(outside, 'owner work')
  const stale = join(f.homesRoot, '.publish-0123456789abcdef.tmp')
  const linked = join(f.homesRoot, '.publish-fedcba9876543210.tmp')
  writeFileSync(stale, '{')
  symlinkSync(outside, linked)
  const store = openPublicGenerations(f.homesRoot)
  runPublicGc(store, { keep: store.keep, keepProofs: [], lockFile: join(dirname(f.homesRoot), 'bot.pid') })
  expect(existsSync(stale)).toBe(false)
  expect(readlinkSync(linked)).toBe(outside)
  expect(readFileSync(outside, 'utf8')).toBe('owner work')
})

test('every imported file and created directory is fsynced before the marker is published', () => {
  const f = fixture()
  const a = f.boot().generation
  addRollout(a.path)
  writeFileSync(join(a.path, 'guest', 'bridge-thread.json'), '"saved"')
  const seen: string[] = []
  // Descriptor paths come from the opens themselves, so the test needs no /proc (macOS too).
  const opened = new Map<number, string>()
  const realOpen = fs.openSync
  const realFsync = fs.fsyncSync
  const openSpy = spyOn(fs, 'openSync').mockImplementation((path: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
    const fd = realOpen(path, flags, mode)
    opened.set(fd, String(path))
    return fd
  })
  const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
    const path = opened.get(fd)
    if (path === undefined) throw new Error('fsync of a descriptor the spy did not see opened: ' + fd)
    seen.push(path)
    realFsync(fd)
  })
  let b: ReturnType<typeof f.boot>
  try {
    b = f.boot()
  } finally {
    fsyncSpy.mockRestore()
    openSpy.mockRestore()
  }
  const guest = join(b.generation.path, 'guest')
  const markerSync = seen.findIndex(path => /\/\.publish-[0-9a-f]{16}\.tmp$/u.test(path) && path.startsWith(b.generation.path))
  expect(markerSync).toBeGreaterThan(-1)
  for (const path of [
    join(guest, 'sessions', '2026', 'rollout.jsonl'), join(guest, 'bridge-thread.json'),
    join(guest, 'sessions', '2026'), join(guest, 'sessions'), guest, b.generation.path, f.generations,
  ]) {
    const index = seen.indexOf(path)
    expect(index, path).toBeGreaterThan(-1)
    expect(index, path).toBeLessThan(markerSync)
  }
})

test('a filesystem without hard links stops multi-user mode with a clear message', () => {
  const f = fixture()
  const unsupported: PublishFault = step => {
    if (step === 'link') throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
  }
  expect(() => f.boot(unsupported)).toThrow('не поддерживает жёсткие ссылки')
})

test('the hard-link refusal reaches the startup line and exits as a fatal configuration error', async () => {
  const f = fixture()
  const unsupported: PublishFault = step => {
    if (step === 'link') throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
  }
  let refusal: unknown
  try {
    f.boot(unsupported)
  } catch (error) {
    refusal = error
  }
  expect(startupErrorMessage(refusal)).toContain('не поддерживает жёсткие ссылки')
  expect(fatalReason(refusal)).toBe(PUBLISH_UNSUPPORTED_FATAL)
  const sent: string[] = []
  const code = await startupFailureExit({
    error: refusal, watchdog: false, stateDir: join(f.base, 'state'), recordTrial: () => undefined,
    send: async text => { sent.push(text) },
  })
  expect(code).toBe(EXIT.fatalConfig)
  expect(sent.join('\n')).toContain(PUBLISH_UNSUPPORTED_FATAL)
})
