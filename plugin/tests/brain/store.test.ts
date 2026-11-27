import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readBrainConfig, writeBrainConfig } from '../../../codex-brain/src/config.js'
import { DEFAULT_SUMMARIZER } from '../../../codex-brain/src/contract.js'
import { appendLine, writeFileAtomic } from '../../../codex-brain/src/store/atomic.js'
import { estimateTokens } from '../../../codex-brain/src/store/estimate.js'
import { LockTimeoutError, withLock } from '../../../codex-brain/src/store/lock.js'
import {
  bridgeScope, ensureScope, homePaths, readDefaultScope, resolveBrainHome, safeSegment, scopePaths, writeDefaultScope,
} from '../../../codex-brain/src/store/paths.js'

const BRAIN_SRC = resolve(import.meta.dir, '../../../codex-brain/src')

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brain-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mode = (path: string): number => statSync(path).mode & 0o777

// ---------------------------------------------------------------- brain_home (K3)

test('brain_home resolves from CODEX_HOME, else HOME, and ignores CODEX_BRAIN_HOME by default', () => {
  expect(resolveBrainHome({ CODEX_HOME: '/srv/codex', HOME: '/home/u' })).toBe('/srv/codex/brain')
  expect(resolveBrainHome({ HOME: '/home/u' })).toBe('/home/u/.codex/brain')
  expect(resolveBrainHome({ HOME: '/home/u', CODEX_BRAIN_HOME: '/elsewhere' })).toBe('/home/u/.codex/brain')
  expect(resolveBrainHome({ HOME: '/home/u', CODEX_BRAIN_HOME: '/elsewhere' }, { allowOverride: true })).toBe('/elsewhere')
  expect(() => resolveBrainHome({})).toThrow()
  expect(() => resolveBrainHome({ CODEX_HOME: 'relative/codex' })).toThrow()
  expect(() => resolveBrainHome({ HOME: '/home/u', CODEX_BRAIN_HOME: 'rel' }, { allowOverride: true })).toThrow()
})

test('scope ids and path segments cannot escape the brain directory', () => {
  expect(bridgeScope('bot', 'owner')).toMatch(/^b-[0-9a-f]{16}$/)
  expect(bridgeScope('bot', 'owner')).toBe(bridgeScope('bot', 'owner'))
  expect(bridgeScope('bot', 'owner')).not.toBe(bridgeScope('bo', 'towner'))
  expect(safeSegment('019a-thread_1')).toBe('019a-thread_1')
  expect(safeSegment('../etc/passwd')).toMatch(/^h-[0-9a-f]{32}$/)
  expect(safeSegment('..')).toMatch(/^h-[0-9a-f]{32}$/)
  expect(() => scopePaths(dir, '../x')).toThrow()
  const paths = scopePaths(dir, 'local')
  expect(paths.permit('../../x').startsWith(join(dir, 'local', 'state', 'permits') + '/')).toBe(true)
  expect(() => paths.fact('../x')).toThrow()
  expect(() => paths.journal('2026-13-99/../x')).toThrow()
})

// ---------------------------------------------------------------- layout (§5.1)

test('a fresh directory gets the §5.1 layout with 0700 directories and 0600 files', () => {
  const home = join(dir, 'codex', 'brain')
  const paths = ensureScope(home, 'local')
  expect(mode(home)).toBe(0o700)
  const dirs = [paths.root, paths.factsDir, paths.journalDir, paths.digestDir, paths.archiveDir, paths.handoffDir,
    paths.handoffHistoryDir, paths.pendingDir, paths.stateDir, paths.snapshotDir, paths.permitsDir,
    paths.receiptsDir, paths.promptsDir, paths.lockDir]
  for (const d of dirs) {
    expect(statSync(d).isDirectory()).toBe(true)
    expect(mode(d)).toBe(0o700)
  }
  for (const f of [paths.index, paths.manifest]) {
    expect(statSync(f).isFile()).toBe(true)
    expect(mode(f)).toBe(0o600)
  }
  expect(JSON.parse(readFileSync(paths.manifest, 'utf8'))).toEqual({ version: 1, facts: {} })
  // Session -> scope registry sits above the scopes: a hook knows only session_id and brain_home (K3).
  expect(mode(homePaths(home).sessionsDir)).toBe(0o700)
})

test('hooks and the CLI find the scope from files under brain_home alone (K3)', () => {
  const home = join(dir, 'brain')
  const h = homePaths(home)
  expect(h.session('../x').startsWith(join(home, 'sessions') + '/')).toBe(true)
  expect(h.config).toBe(join(home, 'config.json'))
  expect(readDefaultScope(home)).toBe('local')
  writeDefaultScope(home, bridgeScope('bot', 'owner'))
  expect(readDefaultScope(home)).toBe(bridgeScope('bot', 'owner'))
  expect(mode(h.defaultScope)).toBe(0o600)
  writeFileSync(h.defaultScope, '{"scope": "../etc"}')
  expect(readDefaultScope(home)).toBe('local')
  expect(() => writeDefaultScope(home, '../etc')).toThrow()
})

test('ensureScope is idempotent and never overwrites existing data or config', () => {
  const home = join(dir, 'brain')
  const paths = ensureScope(home, 'local')
  writeFileSync(paths.index, '- a · user · kept\n')
  writeFileSync(join(home, 'config.json'), '{"enabled": false}')
  ensureScope(home, 'local')
  expect(readFileSync(paths.index, 'utf8')).toBe('- a · user · kept\n')
  expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"enabled": false}')
})

test('ensureScope tightens modes of a pre-existing looser directory', () => {
  const home = join(dir, 'brain')
  mkdirSync(join(home, 'local', 'facts'), { recursive: true, mode: 0o755 })
  const paths = ensureScope(home, 'local')
  expect(mode(paths.factsDir)).toBe(0o700)
  expect(mode(home)).toBe(0o700)
})

// ---------------------------------------------------------------- atomic write

test('writeFileAtomic writes 0600 via a temp file and leaves no temp behind', () => {
  const target = join(dir, 'f.json')
  writeFileAtomic(target, 'one')
  writeFileAtomic(target, 'two')
  expect(readFileSync(target, 'utf8')).toBe('two')
  expect(mode(target)).toBe(0o600)
  expect(readdirSync(dir)).toEqual(['f.json'])
})

test('a failure before rename leaves the old file intact and removes the temp file', () => {
  const target = join(dir, 'f.json')
  writeFileAtomic(target, 'old')
  expect(() => writeFileAtomic(target, 'new', { beforeRename: () => { throw new Error('boom') } })).toThrow('boom')
  expect(readFileSync(target, 'utf8')).toBe('old')
  expect(readdirSync(dir)).toEqual(['f.json'])
})

test('a process killed between temp write and rename leaves the old file intact', async () => {
  const target = join(dir, 'fact.md')
  writeFileAtomic(target, 'old content')
  const script = join(dir, 'kill.ts')
  writeFileSync(script, [
    `import { writeFileAtomic } from ${JSON.stringify(join(BRAIN_SRC, 'store', 'atomic.ts'))}`,
    `writeFileAtomic(${JSON.stringify(target)}, 'new content', { beforeRename: () => process.kill(process.pid, 'SIGKILL') })`,
  ].join('\n'))
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  expect(child.signalCode).toBe('SIGKILL')
  expect(readFileSync(target, 'utf8')).toBe('old content')
  // The orphaned temp file holds the new bytes but never replaced the target.
  expect(readdirSync(dir).filter(name => name.startsWith('.fact.md.tmp-')).length).toBe(1)
})

test('appendLine starts a new line after a torn tail, so a crashed append cannot swallow the next line', () => {
  const target = join(dir, 'j.jsonl')
  writeFileSync(target, '{"n":1}\n{"n":2,"tor')
  appendLine(target, '{"n":3}')
  expect(readFileSync(target, 'utf8')).toBe('{"n":1}\n{"n":2,"tor\n{"n":3}\n')
})

test('appendLine appends whole lines with mode 0600 and rejects embedded newlines', () => {
  const target = join(dir, 'j.jsonl')
  appendLine(target, '{"n":1}')
  appendLine(target, '{"n":2}')
  expect(readFileSync(target, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
  expect(mode(target)).toBe(0o600)
  expect(() => appendLine(target, 'a\nb')).toThrow()
})

// ---------------------------------------------------------------- lock

function assertNoInterleave(log: string): number {
  const lines = log.trim().split('\n')
  expect(lines.length % 2).toBe(0)
  for (let i = 0; i < lines.length; i += 2) {
    const [who, what] = (lines[i] ?? '').split(' ')
    expect(what).toBe('start')
    expect(lines[i + 1]).toBe(`${who} end`)
  }
  return lines.length / 2
}

test('concurrent writers in one process never interleave under the lock', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const log = join(dir, 'log')
  await Promise.all(Array.from({ length: 8 }, (_, i) => withLock(lockDir, async () => {
    appendLine(log, `w${i} start`)
    await Bun.sleep(2)
    appendLine(log, `w${i} end`)
  })))
  expect(assertNoInterleave(readFileSync(log, 'utf8'))).toBe(8)
})

test('two writer processes never interleave under the lock', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const log = join(dir, 'log')
  const script = join(dir, 'writer.ts')
  writeFileSync(script, [
    `import { withLock } from ${JSON.stringify(join(BRAIN_SRC, 'store', 'lock.ts'))}`,
    `import { appendLine } from ${JSON.stringify(join(BRAIN_SRC, 'store', 'atomic.ts'))}`,
    'const tag = process.argv[2]',
    'for (let i = 0; i < 15; i++) {',
    `  await withLock(${JSON.stringify(lockDir)}, async () => {`,
    `    appendLine(${JSON.stringify(log)}, tag + ' start')`,
    '    await Bun.sleep(3)',
    `    appendLine(${JSON.stringify(log)}, tag + ' end')`,
    '  }, { timeoutMs: 20000 })',
    '}',
  ].join('\n'))
  const children = ['A', 'B'].map(tag => Bun.spawn([process.execPath, script, tag], { stdout: 'ignore', stderr: 'pipe' }))
  const codes = await Promise.all(children.map(child => child.exited))
  expect(codes).toEqual([0, 0])
  expect(assertNoInterleave(readFileSync(log, 'utf8'))).toBe(30)
  expect(existsSync(join(lockDir, 'held'))).toBe(false)
}, 30000)

test('the lock is released when the critical section throws', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  await expect(withLock(lockDir, async () => { throw new Error('inner') })).rejects.toThrow('inner')
  expect(await withLock(lockDir, async () => 'next')).toBe('next')
})

test('a lock left by a dead process is broken; a live holder makes the caller time out', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const dead = Bun.spawn(['true'])
  await dead.exited
  writeFileSync(join(lockDir, 'held'), JSON.stringify({ pid: dead.pid, pidns: readlinkSync('/proc/self/ns/pid'), acquired: new Date().toISOString() }))
  expect(await withLock(lockDir, async () => 'took over')).toBe('took over')

  writeFileSync(join(lockDir, 'held'), JSON.stringify({ pid: process.pid, acquired: new Date().toISOString() }))
  await expect(withLock(lockDir, async () => 'never', { timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
  expect(existsSync(join(lockDir, 'held'))).toBe(true)
})

test('an empty lock file left by a crash between create and write is broken once it is old', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const held = join(lockDir, 'held')
  writeFileSync(held, '')
  const old = new Date(Date.now() - 60_000)
  utimesSync(held, old, old)
  expect(await withLock(lockDir, async () => 'recovered', { timeoutMs: 500 })).toBe('recovered')
})

test('a nested lock on the same scope times out instead of deadlocking', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const inner = withLock(lockDir, async () => withLock(lockDir, async () => 'inner', { timeoutMs: 80 }))
  await expect(inner).rejects.toBeInstanceOf(LockTimeoutError)
  expect(existsSync(join(lockDir, 'held'))).toBe(false)
}, 3000)

test('a waiter queued behind a long holder in the same process still gives up on time', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  const long = withLock(lockDir, async () => { await Bun.sleep(400); return 'long' })
  const started = Date.now()
  await expect(withLock(lockDir, async () => 'late', { timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
  expect(Date.now() - started).toBeLessThan(300)
  expect(await long).toBe('long')
})

test('a live holder is not broken just because it holds the lock for a while', async () => {
  const lockDir = join(dir, 'lock')
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'held'), JSON.stringify({ pid: process.pid, acquired: new Date(Date.now() - 60_000).toISOString() }))
  await expect(withLock(lockDir, async () => 'stolen', { timeoutMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
})

// ---------------------------------------------------------------- estimateTokens

test('estimateTokens is pure, deterministic and does not under-count Russian text', () => {
  expect(estimateTokens('')).toBe(0)
  const ru = 'Еженедельный отчёт нужно сдавать по пятницам, а не по понедельникам.'
  expect(estimateTokens(ru)).toBe(estimateTokens(ru))
  // Russian BPE runs at roughly 2.5-4 characters per token; never estimate fewer than 1 per 2 chars.
  expect(estimateTokens(ru)).toBeGreaterThanOrEqual(Math.ceil(ru.length / 2))
  const en = 'Weekly report is due on Fridays, not Mondays.'
  expect(estimateTokens(en)).toBeGreaterThanOrEqual(Math.ceil(en.length / 4))
  // Punctuation-dense text: every symbol may be its own token.
  const symbols = '{}[]();:,.!?<>|'.repeat(4)
  expect(estimateTokens(symbols)).toBeGreaterThanOrEqual(symbols.length)
})

// ---------------------------------------------------------------- config (K10, R1)

test('missing config.json means Brain is on with the default summarizer', () => {
  const config = readBrainConfig(join(dir, 'brain'))
  expect(config).toEqual({ enabled: true, summarizer: DEFAULT_SUMMARIZER, resume_reemit: false, problems: [] })
  expect(DEFAULT_SUMMARIZER).toEqual({ model: 'gpt-6.1-terra', effort: 'high' })
})

test('{"enabled": false} disables Brain and survives a second init', () => {
  const home = join(dir, 'brain')
  ensureScope(home, 'local')
  writeFileSync(join(home, 'config.json'), '{"enabled": false}')
  expect(readBrainConfig(home).enabled).toBe(false)
  ensureScope(home, 'local')
  ensureScope(home, 'local')
  expect(readBrainConfig(home).enabled).toBe(false)
})

test('the legacy plugin memory.enabled=false changes nothing', () => {
  const home = join(dir, 'brain')
  mkdirSync(home, { recursive: true })
  // The legacy writer's shape, as if copied from the bridge config.json.
  writeFileSync(join(home, 'config.json'), '{"memory": {"enabled": false, "workspace_path": "/w"}}')
  const config = readBrainConfig(home)
  expect(config.enabled).toBe(true)
  expect(config.problems).toEqual([])
})

test('writeBrainConfig keeps other keys, writes 0600 and round-trips', async () => {
  const home = join(dir, 'brain')
  await writeBrainConfig(home, { summarizer: { model: 'm', effort: 'low' }, resume_reemit: true })
  await writeBrainConfig(home, { enabled: false })
  expect(mode(join(home, 'config.json'))).toBe(0o600)
  expect(readBrainConfig(home)).toEqual({
    enabled: false, summarizer: { model: 'm', effort: 'low' }, resume_reemit: true, problems: [],
  })
  await writeBrainConfig(home, { enabled: true })
  expect(readBrainConfig(home).enabled).toBe(true)
  expect(readBrainConfig(home).resume_reemit).toBe(true)
})

test('an unreadable or mistyped config is reported; a mistyped enabled reads as off', () => {
  const home = join(dir, 'brain')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), '{not json')
  const broken = readBrainConfig(home)
  expect(broken.enabled).toBe(false)
  expect(broken.problems.length).toBe(1)

  writeFileSync(join(home, 'config.json'), '{"enabled": "false", "summarizer": {"model": 5}}')
  const mistyped = readBrainConfig(home)
  expect(mistyped.enabled).toBe(false)
  expect(mistyped.summarizer).toEqual(DEFAULT_SUMMARIZER)
  expect(mistyped.problems.length).toBe(2)

  writeFileSync(join(home, 'config.json'), '{"summarizer": {"effort": "medium"}}')
  const partial = readBrainConfig(home)
  expect(partial.enabled).toBe(true)
  expect(partial.summarizer).toEqual({ model: DEFAULT_SUMMARIZER.model, effort: 'medium' })
  expect(partial.problems).toEqual([])
})
