import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectDoctorReport, dependencyDrift, DoctorCommand, doctorFixTurn, formatDoctorReport, runDoctorScript, type DoctorReport,
} from '../../src/codex/doctor-command.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const lock = (version: string) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "zod": "^3.23.0",
      },
    },
  },
  "packages": {
    "zod": ["zod@${version}", "", {}, "sha512-fixture"],
  }
}
`

// A public "GitHub" repository (bare), a seed clone that publishes commits and the installed bridge.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'krot-doctor-cmd-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote)
  const seed = join(root, 'seed')
  git(root, 'clone', '--quiet', remote, seed)
  git(seed, 'checkout', '--quiet', '-b', 'main')
  mkdirSync(join(seed, 'plugin'))
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(seed, 'README.md'), 'bridge\n')
  writeFileSync(join(seed, 'plugin', 'bun.lock'), lock('3.25.76'))
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'initial')
  git(seed, 'push', '--quiet', 'origin', 'main')
  const repo = join(root, 'bridge')
  git(root, 'clone', '--quiet', remote, repo)
  git(repo, 'remote', 'rename', 'origin', 'public')
  mkdirSync(join(repo, 'plugin', 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(repo, 'plugin', 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"3.25.76"}')
  return { root, remote, seed, repo }
}

const healthy = async () => [{ status: 'ok' as const, message: 'Токен действителен и принадлежит указанному боту.' }]
const codexVersion = async () => '0.130.0'

test('[R17] doctor reports a clean installation that matches GitHub as all right', async () => {
  const { repo } = fixture()
  const report = await collectDoctorReport({ repo, env: {}, doctor: healthy, codexVersion })
  expect(report.problems).toEqual([])
  const text = formatDoctorReport(report)
  expect(text).toContain('всё в порядке')
  expect(text).toContain(git(repo, 'rev-parse', '--short', 'HEAD'))
  expect(text).toContain('0.130.0')
})

test('[R17] doctor counts the commits the installed bridge is behind GitHub', async () => {
  const { repo, seed } = fixture()
  for (const n of [1, 2, 3]) {
    writeFileSync(join(seed, `change-${n}.txt`), String(n))
    git(seed, 'add', '.')
    git(seed, 'commit', '--quiet', '-m', `change ${n}`)
  }
  git(seed, 'push', '--quiet', 'origin', 'main')
  const report = await collectDoctorReport({ repo, env: {}, doctor: healthy, codexVersion })
  const text = formatDoctorReport(report)
  expect(report.problems).toHaveLength(1)
  expect(text).toContain('отстаёт от GitHub на 3')
  expect(text).toContain('1. ')
  expect(text).toContain('./update.sh')
})

test('[R17] doctor lists local edits by file name only and hides secret paths', async () => {
  const { repo } = fixture()
  writeFileSync(join(repo, 'README.md'), 'PRIVATE_EDIT_CONTENT\n')
  writeFileSync(join(repo, 'notes.txt'), 'draft\n')
  writeFileSync(join(repo, 'plugin', '.env'), 'TELEGRAM_BOT_TOKEN=100001:fake-secret-value\n')
  mkdirSync(join(repo, 'secrets'))
  writeFileSync(join(repo, 'secrets', 'bot.key'), 'key')
  const report = await collectDoctorReport({ repo, env: {}, doctor: healthy, codexVersion })
  const text = formatDoctorReport(report)
  expect(text).toContain('README.md')
  expect(text).toContain('notes.txt')
  expect(text).toContain('скрыт')
  expect(text).not.toContain('PRIVATE_EDIT_CONTENT')
  expect(text).not.toContain('.env')
  expect(text).not.toContain('bot.key')
  expect(text).not.toContain('fake-secret-value')
})

test('[R17] a failed fetch from the configured remote is reported, not thrown, without the remote URL', async () => {
  const { repo } = fixture()
  git(repo, 'remote', 'add', 'mirror', 'https://user:hidden-credential@127.0.0.1:1/bridge.git')
  const report = await collectDoctorReport({
    repo, env: { KROT_UPDATE_REMOTE: 'mirror', KROT_UPDATE_BRANCH: 'main' }, doctor: healthy, codexVersion,
  })
  const text = formatDoctorReport(report)
  expect(text).toContain('Не удалось получить')
  expect(text).toContain('mirror')
  expect(text).not.toContain('hidden-credential')
  expect(text).not.toContain('127.0.0.1')
})

test('[R17] doctor lists failed self-checks, dependency drift and an old Codex CLI with their fixes', async () => {
  const { repo } = fixture()
  writeFileSync(join(repo, 'plugin', 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"3.20.0"}')
  const report = await collectDoctorReport({
    repo, env: {}, codexVersion, minimumCodexVersion: '0.200.0',
    doctor: async () => [{ status: 'error', message: 'Укажите токен BotFather в TELEGRAM_BOT_TOKEN.' }],
  })
  const text = formatDoctorReport(report)
  expect(report.problems).toHaveLength(3)
  expect(text).toContain('1. Укажите токен BotFather')
  expect(text).toContain('zod')
  expect(text).toContain('bun install --frozen-lockfile')
  expect(text).toContain('0.200.0')
})

test('[R17] the dependency check parses the real plugin/bun.lock format', () => {
  expect(dependencyDrift(join(import.meta.dir, '..', '..'))?.text ?? '').not.toContain('Не удалось прочитать')
})

test('[R17] the doctor script runs as a child and its lines become checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-doctor-script-'))
  roots.push(root)
  const script = join(root, 'doctor.ts')
  writeFileSync(script, 'console.log("[OK] Папка доступна.")\nconsole.log("[ОШИБКА] Нужен вход.")\n' +
    'console.log("Ошибок: 1.")\nprocess.exitCode = 1\n')
  chmodSync(script, 0o600)
  expect(await runDoctorScript(script, { PATH: process.env.PATH })).toEqual([
    { status: 'ok', message: 'Папка доступна.' },
    { status: 'error', message: 'Нужен вход.' },
  ])
  const missing = await runDoctorScript(join(root, 'absent.ts'), { PATH: process.env.PATH })
  expect(missing[0]?.status).toBe('error')
})

const broken: DoctorReport = {
  problems: [{ text: 'Мост отстаёт от GitHub на 2 коммита.', fix: 'Выполните ./update.sh.' }],
  commit: 'abc1234', upstream: 'public/main',
}

test('[R17] /doctor fix hands the report to Codex as an owner turn with safe-fix and no-restart rules', async () => {
  const sent: string[] = []
  const turns: string[] = []
  const command = new DoctorCommand({ collect: async () => broken, send: async text => { sent.push(text) }, repo: '/srv/bridge', selfRestart: true })
  await command.handle('fix', async text => { turns.push(text) })
  expect(sent.join('\n')).toContain('Мост отстаёт от GitHub на 2 коммита.')
  expect(turns).toHaveLength(1)
  expect(turns[0]).toContain('Мост отстаёт от GitHub на 2 коммита.')
  expect(turns[0]).toContain('резервную копию')
  expect(turns[0]).toContain('Не перезапускай')
  expect(turns[0]).toContain('Перезапусти мост')
  expect(doctorFixTurn(broken, '/srv/bridge', false)).toContain('systemctl --user restart krotov-telegram.service')

  const plain = new DoctorCommand({ collect: async () => broken, send: async text => { sent.push(text) }, repo: '/srv/bridge', selfRestart: true })
  await plain.handle('', async text => { turns.push(text) })
  expect(turns).toHaveLength(1)
})

test('[R17] /doctor reports a failed check run instead of throwing', async () => {
  const sent: string[] = []
  const command = new DoctorCommand({
    collect: async () => { throw new Error('/home/owner/.secrets/token') }, send: async text => { sent.push(text) },
    repo: '/srv/bridge', selfRestart: false,
  })
  await command.handle('fix', async () => { throw new Error('must not start a turn') })
  expect(sent.join('\n')).toContain('Не удалось')
  expect(sent.join('\n')).not.toContain('.secrets')
})
