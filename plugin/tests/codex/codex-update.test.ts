import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexUpdate, compareVersions, changelogSince, CHANGELOG_URL, readCodexRecord, recoverCodexUpdate, RELEASES_URL, stagedCodexProbe } from '../../src/codex/codex-update.js'
import type { Runner } from '../../src/codex/self-update.js'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A home with an npm user prefix that holds codex, as `npm i -g` leaves it. */
function home() {
  const root = mkdtempSync(join(tmpdir(), 'krot-codex-'))
  temporary.push(root)
  const prefix = join(root, '.npm-global')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'lib', 'node_modules', '@openai', 'codex'), { recursive: true })
  writeFileSync(join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'VERSION'), '0.47.0')
  writeFileSync(join(prefix, 'bin', 'codex'), '')
  const active = () => readFileSync(join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'VERSION'), 'utf8')
  return { root, prefix, codex: join(prefix, 'bin', 'codex'), stage: join(prefix, '.krotov-codex-stage'), active }
}

const changelogMd = [
  '# Codex changelog',
  '',
  '## Codex CLI 0.48.0',
  '',
  '- New model gpt-next in the picker.',
  '',
  '## Codex CLI 0.47.1',
  '',
  '- Fixed resume.',
  '',
  '## Codex CLI 0.47.0',
  '',
  '- Already installed, must not show.',
].join('\n')

function fake(options: { installed?: string[]; latest?: string; installCodes?: number[]; probe?: boolean[]; docs?: string | undefined; releases?: string | undefined } = {}) {
  const calls: string[] = []
  const versions = [...(options.installed ?? ['codex-cli 0.47.0', 'codex-cli 0.48.0'])]
  const installs = [...(options.installCodes ?? [0])]
  const probes = [...(options.probe ?? [true])]
  const run: Runner = async (command, args) => {
    calls.push([command, ...args].join(' '))
    if (args[0] === '--version') return { code: 0, stdout: versions.shift() ?? 'codex-cli 0.48.0', stderr: '' }
    if (args[0] === 'view') return { code: 0, stdout: (options.latest ?? '0.48.0') + '\n', stderr: '' }
    if (args[0] === 'install') {
      // npm install -g --prefix <dir> @openai/codex@<version>: writes the package into <dir>.
      const code = installs.shift() ?? 0
      if (code === 0) {
        const pkg = join(args[3]!, 'lib', 'node_modules', '@openai', 'codex')
        mkdirSync(pkg, { recursive: true })
        writeFileSync(join(pkg, 'VERSION'), args[4]!.split('@').at(-1)!)
      }
      return { code, stdout: '', stderr: 'npm ERR! network' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  const fetched: string[] = []
  const fetchText = async (url: string) => {
    fetched.push(url)
    return url === CHANGELOG_URL ? ('docs' in options ? options.docs : changelogMd) : options.releases
  }
  const probe = async () => (probes.shift() ?? true) ? { ok: true as const, models: ['gpt-5', 'gpt-next'] } : { ok: false as const, detail: 'handshake failed' }
  return { run, calls, fetchText, fetched, probe }
}

test('[S9c] versions compare numerically and a prerelease sorts before its release', () => {
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('0.48.0', '0.48.0')).toBe(0)
  expect(compareVersions('0.48.0-alpha.1', '0.48.0')).toBeLessThan(0)
})

test('[S9c] the changelog shows only versions newer than the installed one up to the latest', () => {
  const text = changelogSince(changelogMd, '0.47.0', '0.48.0')
  expect(text).toContain('0.48.0')
  expect(text).toContain('gpt-next')
  expect(text).toContain('0.47.1')
  expect(text).not.toContain('Already installed')
  expect(changelogSince('no versions here', '0.47.0', '0.48.0')).toBeUndefined()
})

test('[S9c] /update codex shows installed vs latest, installs into the user prefix, checks the handshake and lists models', async () => {
  const box = home()
  const { run, calls, fetchText, probe } = fake()
  const update = new CodexUpdate({ run, fetchText, probe, home: box.root, stateDir: box.root, codexPath: () => box.codex })
  const status = await update.check()
  expect(status).toMatchObject({ kind: 'newer', installed: '0.47.0', latest: '0.48.0' })
  if (status.kind !== 'newer') throw new Error('no update')
  expect(status.changelog).toContain('gpt-next')
  const result = await update.apply(status)
  expect(result).toEqual({ ok: true, from: '0.47.0', to: '0.48.0', models: ['gpt-5', 'gpt-next'] })
  // Staged next to the active prefix, never written over it; switched in after the handshake.
  expect(calls).toContain(`npm install -g --prefix ${box.stage} @openai/codex@0.48.0`)
  expect(calls).not.toContain(`npm install -g --prefix ${box.prefix} @openai/codex@0.48.0`)
  expect(box.active()).toBe('0.48.0')
  expect(existsSync(box.stage)).toBe(false)
  expect(readCodexRecord(box.root)).toMatchObject({ phase: 'done', previous: '0.47.0', target: '0.48.0' })
  // /update codex rollback puts the kept package back.
  expect(update.rollback()).toEqual({ ok: true, from: '0.48.0', to: '0.47.0' })
  expect(box.active()).toBe('0.47.0')
  expect(readCodexRecord(box.root)).toBeUndefined()
  expect(update.rollback()).toMatchObject({ ok: false })
})

test('[S9c] the previous Codex version is on disk before npm starts', async () => {
  const box = home()
  const base = fake()
  let seen: unknown
  const run: Runner = async (command, args, options) => {
    if (args[0] === 'install') seen = readCodexRecord(box.root)
    return base.run(command, args, options)
  }
  const update = new CodexUpdate({ ...base, run, home: box.root, stateDir: box.root, codexPath: () => box.codex })
  const status = await update.check()
  if (status.kind !== 'newer') throw new Error('no update')
  await update.apply(status)
  expect(seen).toMatchObject({ phase: 'staging', previous: '0.47.0', target: '0.48.0', prefix: box.prefix })
})

test('[S9c] a bridge killed during the staged install or the switch leaves a whole Codex after the next start', () => {
  const box = home()
  const record = { v: 1, previous: '0.47.0', target: '0.48.0', prefix: box.prefix, at: 1 }
  // Killed while npm wrote the stage: the active Codex was never touched.
  mkdirSync(join(box.stage, 'lib'), { recursive: true })
  writeFileSync(join(box.root, 'codex-update.json'), JSON.stringify({ ...record, phase: 'staging' }))
  expect(recoverCodexUpdate(box.root)).toBe('cleaned')
  expect(existsSync(box.stage)).toBe(false)
  expect(box.active()).toBe('0.47.0')
  expect(readCodexRecord(box.root)).toBeUndefined()
  // Killed between the two renames: the active package is missing, the kept one goes back.
  const active = join(box.prefix, 'lib', 'node_modules', '@openai', 'codex')
  const previous = join(box.prefix, '.krotov-codex-previous')
  mkdirSync(previous)
  writeFileSync(join(previous, 'VERSION'), '0.47.0')
  rmSync(active, { recursive: true })
  writeFileSync(join(box.root, 'codex-update.json'), JSON.stringify({ ...record, phase: 'switching' }))
  expect(recoverCodexUpdate(box.root)).toBe('restored')
  expect(box.active()).toBe('0.47.0')
})

test('[S9c] the GitHub release notes are the fallback, then a link when neither source answers', async () => {
  const box = home()
  const releases = JSON.stringify([
    { tag_name: 'rust-v0.48.0', body: 'Release body with gpt-next' },
    { tag_name: 'rust-v0.47.0', body: 'old' },
  ])
  const withReleases = fake({ docs: undefined, releases })
  const status = await new CodexUpdate({ ...withReleases, home: box.root, stateDir: box.root, codexPath: () => box.codex }).check()
  expect(withReleases.fetched).toEqual([CHANGELOG_URL, RELEASES_URL])
  expect(status.kind === 'newer' && status.changelog).toContain('Release body with gpt-next')
  const offline = fake({ docs: undefined, releases: undefined })
  const bare = await new CodexUpdate({ ...offline, home: box.root, stateDir: box.root, codexPath: () => box.codex }).check()
  expect(bare.kind === 'newer' && bare.changelog).toContain('https://developers.openai.com/codex/changelog')
})

test('[S9c] a failed handshake of the staged Codex leaves the active one untouched', async () => {
  const box = home()
  const { run, calls, fetchText } = fake()
  const probed: string[] = []
  const probe = async (codex: string) => { probed.push(codex); return { ok: false as const, detail: 'handshake failed' } }
  const update = new CodexUpdate({ run, fetchText, probe, home: box.root, stateDir: box.root, codexPath: () => box.codex })
  const status = await update.check()
  if (status.kind !== 'newer') throw new Error('no update')
  const result = await update.apply(status)
  expect(result).toMatchObject({ ok: false, stage: 'handshake', restored: true })
  expect(probed).toEqual([join(box.stage, 'bin', 'codex')])
  expect(calls.filter(call => call.startsWith('npm install'))).toEqual([`npm install -g --prefix ${box.stage} @openai/codex@0.48.0`])
  expect(box.active()).toBe('0.47.0')
  expect(existsSync(box.stage)).toBe(false)
  expect(readCodexRecord(box.root)).toBeUndefined()
})

test('[S9c] an up-to-date Codex and a Codex outside the home npm prefix change nothing', async () => {
  const box = home()
  const current = fake({ installed: ['codex-cli 0.48.0'] })
  expect(await new CodexUpdate({ ...current, home: box.root, stateDir: box.root, codexPath: () => box.codex }).check())
    .toMatchObject({ kind: 'current', installed: '0.48.0' })
  const system = fake()
  const outside = await new CodexUpdate({ ...system, home: box.root, stateDir: box.root, codexPath: () => '/usr/local/bin/codex' }).check()
  expect(outside).toMatchObject({ kind: 'refused' })
  expect(system.calls.some(call => call.startsWith('npm install'))).toBe(false)
})

test('the staged Codex probe runs without any bridge credential in its environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-probe-'))
  temporary.push(dir)
  const codex = join(dir, 'codex')
  writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fake-env-app-server.ts')}' "$@"\n`, { mode: 0o755 })
  const bridgeEnv = { ...process.env, GBRAIN_BEARER: 'synthetic-bearer', TELEGRAM_BOT_TOKEN: 'synthetic-token',
    KROT_AGENT_WEBHOOK_TOKEN: 'synthetic-webhook' }
  const result = await stagedCodexProbe(dir, bridgeEnv)(codex)
  if (!result.ok) throw new Error(result.detail)
  expect(result.models).toContain('PATH')
  expect(result.models).not.toContain('GBRAIN_BEARER')
  expect(result.models).not.toContain('TELEGRAM_BOT_TOKEN')
  expect(result.models).not.toContain('KROT_AGENT_WEBHOOK_TOKEN')
})
