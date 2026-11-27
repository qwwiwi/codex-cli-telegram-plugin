import { afterEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { type ApprovalEnv, resolveApprovalSetup } from '../../src/codex/approval-mode.js'
import { BOOT_GUARD_LINE, unitDrift } from '../../src/codex/unit-contract.js'
import { loadConfig } from '../../src/config.js'

const source = resolve(import.meta.dir, '../../..')
const temporary: string[] = []
const token = '123456789:setup_fixture_token'
const pairCode = 'krotov-12345678-4321-1234-4321-123456789abc'

function command(cwd: string, env: NodeJS.ProcessEnv, ...cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() }
}

function checkout(name = 'repo with spaces') {
  const root = mkdtempSync(join(tmpdir(), 'krotov-setup-test-'))
  temporary.push(root)
  const repo = join(root, name)
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  mkdirSync(join(repo, 'plugin/scripts'), { recursive: true })
  mkdirSync(bin)
  mkdirSync(home)
  for (const file of ['install.sh', 'update.sh', 'plugin/scripts/setup-common.sh', 'plugin/scripts/notify-failed.sh',
    'plugin/scripts/boot-guard.sh']) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(repo, file))
  }
  writeFileSync(join(repo, '.gitignore'), 'plugin/.env\nplugin/node_modules/\n')
  writeFileSync(join(repo, 'plugin/bun.lock'), 'fixture')
  const env = {
    PATH: bin + ':/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'), TELEGRAM_BOT_TOKEN: token, SETUP_CALLS: join(root, 'calls'),
    SETUP_REAL_BUN: process.execPath,
    GIT_AUTHOR_NAME: 'Setup test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Setup test', GIT_COMMITTER_EMAIL: 'test@example.test',
  }
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o700 })
  stub('bun', `printf 'bun %s\\n' "$*" >> "$SETUP_CALLS"
if [[ "$1" == --no-env-file && "$2" == --env-file=* && "$3" == -e ]]; then exec "$SETUP_REAL_BUN" "$@"; fi
if [[ "$1" == --no-env-file && "$2" == test && -f broken ]]; then exit 8; fi
if [[ "$*" == *'run doctor' && -v FAIL_DOCTOR ]]; then exit 9; fi
if [[ "$*" == --env-file* && "$1" != --env-file=* ]]; then exit 13; fi`)
  stub('codex', 'exit 0')
  stub('curl', `input=$(cat)
[[ "$*" != *"setup_fixture_token"* ]] || exit 10
case "$input" in
  *getMe*) printf '%s\\n' '{"ok":true,"result":{"id":123456789,"username":"setup_test_bot","first_name":"Личный помощник"}}' ;;
  *getWebhookInfo*) printf '%s\\n' '{"ok":true,"result":{"url":""}}' ;;
  *getUpdates*) printf '%s\\n' '{"ok":true,"result":[{"message":{"text":"${pairCode}","from":{"id":17,"is_bot":false},"chat":{"id":31,"type":"group"}}},{"message":{"text":"${pairCode}","from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"}}}]}' ;;
  *) exit 11 ;;
esac`)
  stub('systemctl', `printf 'systemctl %s\\n' "$*" >> "$SETUP_CALLS"
if [[ -v SETUP_MANAGER_UNAVAILABLE ]]; then exit 1; fi
if [[ "$2" == show && -v SETUP_UNIT_DIRECTORY ]]; then printf '%s\\n' "$SETUP_UNIT_DIRECTORY"; fi`)
  stub('loginctl', 'printf \'loginctl %s\\n\' "$*" >> "$SETUP_CALLS"')
  const git = (...args: string[]) => {
    const result = command(repo, env, 'git', ...args)
    if (result.code !== 0) throw Error(result.text)
    return result.text.trim()
  }
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'initial')
  return { root, repo, env, git, home }
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function localUpstream(root: string, git: ReturnType<typeof checkout>['git']): string {
  const remote = join(root, 'remote.git')
  git('init', '--bare', '-q', '-b', 'main', remote)
  git('remote', 'add', 'origin', remote)
  git('config', 'branch.main.remote', 'origin')
  git('config', 'branch.main.merge', 'refs/heads/main')
  return remote
}

test('install configures a private owner and checks doctor without starting the bot by default', () => {
  const { repo, env, home } = checkout()
  const invocation = ['bash', './install.sh', '--non-interactive', '--owner-id', '987654321', '--agent-name', 'Полярная звезда']
  const result = command(repo, env, ...invocation)
  expect(result.code, result.text).toBe(0)
  expect(result.text).not.toContain(token)
  const file = join(repo, 'plugin/.env')
  const saved = readFileSync(file, 'utf8')
  expect(saved).toContain('KROT_CODEX_MEMORIES_DEFAULT=1')
  expect(saved).toContain('TELEGRAM_EXPECTED_BOT_ID=123456789')
  expect(saved).toContain('TELEGRAM_ALLOWED_CHAT_IDS=987654321')
  expect(saved).toContain('KROT_CODEX_AGENT_NAME="Полярная звезда"')
  expect(readFileSync(join(home, 'krotov-workspace/AGENTS.md'), 'utf8')).toContain('Полярная звезда')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const calls = readFileSync(env.SETUP_CALLS, 'utf8')
  expect(calls).toContain('run doctor')
  expect(calls).not.toContain('enable --now')
  expect(readFileSync(join(home, '.config/systemd/user/krotov-telegram.service'), 'utf8')).toContain(repo)
  const profile = join(home, 'krotov-workspace/AGENTS.md')
  writeFileSync(profile, 'A custom profile\n')
  const repeated = command(repo, { ...env, TELEGRAM_BOT_TOKEN: 'bad' }, ...invocation)
  expect(repeated.code, repeated.text).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe(saved)
  expect(readFileSync(profile, 'utf8')).toBe('A custom profile\n')
})

test('a fresh install accepts --no-memories and keeps the choice on rerun', () => {
  const { repo, env } = checkout()
  const invocation = ['bash', './install.sh', '--non-interactive', '--owner-id', '987654321']
  const optedOut = command(repo, env, ...invocation, '--no-memories')
  expect(optedOut.code, optedOut.text).toBe(0)
  const file = join(repo, 'plugin/.env')
  expect(readFileSync(file, 'utf8')).toContain('KROT_CODEX_MEMORIES_DEFAULT=0')
  const rerun = command(repo, env, ...invocation)
  expect(rerun.code, rerun.text).toBe(0)
  expect(readFileSync(file, 'utf8')).toContain('KROT_CODEX_MEMORIES_DEFAULT=0')
})

// Reads the approval lines of plugin/.env into the shape resolveApprovalSetup takes.
function approvalEnv(file: string): ApprovalEnv {
  const lines = readFileSync(file, 'utf8').split('\n')
  const value = (name: string) => lines.filter(line => line.startsWith(name + '=')).at(-1)?.slice(name.length + 1)
  return { KROT_CODEX_APPROVALS: value('KROT_CODEX_APPROVALS'), KROT_CODEX_APPROVAL_MODE: value('KROT_CODEX_APPROVAL_MODE') }
}

test('[R01] a fresh install defaults to approval mode never, so the agent never waits for a card', () => {
  const { repo, env } = checkout()
  const result = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(result.code, result.text).toBe(0)
  const saved = approvalEnv(join(repo, 'plugin/.env'))
  expect(saved).toEqual({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'never' })
  expect(resolveApprovalSetup(saved)).toEqual({ cards: false, risky: false })
  expect(result.text).toContain('Режим подтверждений: never')
})

test('[R02] a fresh install shows the agent thoughts in the working bubble and an existing one keeps its choice', () => {
  const { repo, env } = checkout()
  const file = join(repo, 'plugin/.env')
  const thoughts = () => {
    const saved = Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1).replace(/^"(.*)"$/, '$1')]
    }))
    return loadConfig({ ...saved, XDG_STATE_HOME: env.XDG_STATE_HOME }).status.thoughts?.enabled ?? false
  }
  const fresh = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(fresh.code, fresh.text).toBe(0)
  expect(readFileSync(file, 'utf8')).toContain('TELEGRAM_STATUS_THOUGHTS=1\n')
  expect(thoughts()).toBe(true)
  // An install made before this setting has no line; a rerun leaves it as it was.
  writeFileSync(file, readFileSync(file, 'utf8').replace('TELEGRAM_STATUS_THOUGHTS=1\n', ''), { mode: 0o600 })
  const rerun = command(repo, env, 'bash', './install.sh', '--non-interactive', '--approval-mode', 'standard')
  expect(rerun.code, rerun.text).toBe(0)
  expect(readFileSync(file, 'utf8')).not.toContain('TELEGRAM_STATUS_THOUGHTS')
  expect(thoughts()).toBe(false)
})

test('[R02] a fresh install switches the automatic 👀 off, an existing install keeps its setting', () => {
  const { repo, env } = checkout()
  const file = join(repo, 'plugin/.env')
  const ack = () => readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith('KROT_ACK_REACTION='))
  const fresh = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(fresh.code, fresh.text).toBe(0)
  expect(ack()).toEqual(['KROT_ACK_REACTION=off'])
  // An install that predates the setting: a rerun leaves it unset, so the legacy 👀 stays.
  writeFileSync(file, readFileSync(file, 'utf8').replace('KROT_ACK_REACTION=off\n', ''))
  expect(command(repo, env, 'bash', './install.sh', '--non-interactive').code).toBe(0)
  expect(ack()).toEqual([])
})

test('[R01] the installer offers never and keeps standard selectable, on a fresh and on an existing install', () => {
  const { repo, env } = checkout()
  const help = command(repo, env, 'bash', './install.sh', '--help')
  expect(help.text).toContain('--approval-mode never|standard|risky')
  const file = join(repo, 'plugin/.env')
  const fresh = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321', '--approval-mode', 'standard')
  expect(fresh.code, fresh.text).toBe(0)
  expect(approvalEnv(file)).toEqual({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'standard' })
  expect(resolveApprovalSetup(approvalEnv(file))).toEqual({ cards: true, risky: false })
  // A rerun without --approval-mode keeps the owner's earlier choice.
  expect(command(repo, env, 'bash', './install.sh', '--non-interactive').code).toBe(0)
  expect(approvalEnv(file).KROT_CODEX_APPROVAL_MODE).toBe('standard')
  const switched = command(repo, env, 'bash', './install.sh', '--approval-mode', 'never')
  expect(switched.code, switched.text).toBe(0)
  expect(approvalEnv(file)).toEqual({ KROT_CODEX_APPROVALS: '1', KROT_CODEX_APPROVAL_MODE: 'never' })
  expect(command(repo, env, 'bash', './install.sh', '--approval-mode', 'sometimes').code).not.toBe(0)
})

test('[R17] every install sets up the Codex hooks pack unless --no-hooks; full access is left to the hooks installer', () => {
  const envOf = (repo: string) => readFileSync(join(repo, 'plugin/.env'), 'utf8')
  const hooksOn = (repo: string) => envOf(repo).includes('KROT_CODEX_HOOKS=1')
  const autonomous = checkout()
  const result = command(autonomous.repo, autonomous.env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(result.code, result.text).toBe(0)
  expect(readFileSync(autonomous.env.SETUP_CALLS, 'utf8')).toContain('codex-hooks/src/install.ts')
  expect(hooksOn(autonomous.repo)).toBe(true)
  expect(envOf(autonomous.repo)).toContain('KROT_CODEX_APPROVAL_MODE=never')
  // Full access is written by the hooks installer only after it sees the managed guards active.
  expect(envOf(autonomous.repo)).not.toContain('KROT_CODEX_SANDBOX=danger-full-access')
  expect(readFileSync(autonomous.env.SETUP_CALLS, 'utf8')).toContain('--full-access')
  // No leftover copy of plugin/.env (it holds the bot token).
  expect(readdirSync(join(autonomous.repo, 'plugin')).filter(name => name.startsWith('.env.'))).toEqual([])
  const standard = checkout()
  expect(command(standard.repo, standard.env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321',
    '--approval-mode', 'standard').code).toBe(0)
  expect(hooksOn(standard.repo)).toBe(true)
  expect(envOf(standard.repo)).not.toContain('KROT_CODEX_SANDBOX=')
  const optedOut = checkout()
  expect(command(optedOut.repo, optedOut.env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321',
    '--no-hooks').code).toBe(0)
  expect(hooksOn(optedOut.repo)).toBe(false)
  // An existing install gets the pack by default too.
  expect(command(optedOut.repo, optedOut.env, 'bash', './install.sh').code).toBe(0)
  expect(hooksOn(optedOut.repo)).toBe(true)
  expect(readFileSync(optedOut.env.SETUP_CALLS, 'utf8')).toContain('--full-access')
})

for (const mode of ['standard', 'risky']) {
  test(`[R01/R17] rerunning the installer in saved ${mode} mode does not request full access`, () => {
    const { repo, env } = checkout()
    const fresh = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321',
      '--approval-mode', mode)
    expect(fresh.code, fresh.text).toBe(0)
    writeFileSync(env.SETUP_CALLS, '')
    const rerun = command(repo, env, 'bash', './install.sh', '--non-interactive')
    expect(rerun.code, rerun.text).toBe(0)
    expect(approvalEnv(join(repo, 'plugin/.env')).KROT_CODEX_APPROVAL_MODE).toBe(mode)
    const hooksCall = readFileSync(env.SETUP_CALLS, 'utf8').split('\n').find(line => line.includes('codex-hooks/src/install.ts'))
    expect(hooksCall).toBeDefined()
    expect(hooksCall).not.toContain('--full-access')
  })
}

test('[R17] a saved workspace-write sandbox stays in place on an autonomous rerun', () => {
  const { repo, env } = checkout()
  const fresh = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(fresh.code, fresh.text).toBe(0)
  const file = join(repo, 'plugin/.env')
  const saved = readFileSync(file, 'utf8') + 'export KROT_CODEX_SANDBOX = "workspace-write" # owner preference\n'
  writeFileSync(file, saved)
  writeFileSync(env.SETUP_CALLS, '')
  const rerun = command(repo, env, 'bash', './install.sh', '--non-interactive')
  expect(rerun.code, rerun.text).toBe(0)
  expect(readFileSync(file, 'utf8') === saved).toBe(true)
  const hooksCall = readFileSync(env.SETUP_CALLS, 'utf8').split('\n').find(line => line.includes('codex-hooks/src/install.ts'))
  expect(hooksCall).toBeDefined()
  expect(hooksCall).not.toContain('--full-access')
})

test('[R18] the generated agent profile explains subagents and parallel side threads', () => {
  const { repo, env, home } = checkout()
  const result = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321', '--agent-name', 'Helper')
  expect(result.code, result.text).toBe(0)
  const profile = readFileSync(join(home, 'krotov-workspace/AGENTS.md'), 'utf8')
  const section = profile.slice(profile.indexOf('## Субагенты и параллельные потоки'))
  expect(section.startsWith('## Субагенты и параллельные потоки')).toBe(true)
  for (const word of ['multi_agent_v2', 'spawn_agent', 'wait', 'close_agent', 'KROT_CODEX_PARALLEL']) {
    expect(section).toContain(word)
  }
  expect(section).toMatch(/параллельн\S* поток/)
})

test('[R90] the generated agent profile says where the bridge error journal lives and how to read it', () => {
  const { repo, env, home } = checkout()
  const result = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321', '--agent-name', 'Helper')
  expect(result.code, result.text).toBe(0)
  const profile = readFileSync(join(home, 'krotov-workspace/AGENTS.md'), 'utf8')
  const section = profile.slice(profile.indexOf('## Журнал ошибок моста'))
  expect(section.startsWith('## Журнал ошибок моста')).toBe(true)
  expect(section).toContain(join(home, '.local/state/krotov-plugin') + '/errors-ГГГГ-ММ-ДД.jsonl')
  // The path is quoted in the commands, so a state directory with a space still works.
  expect(section).toContain(`'${join(home, '.local/state/krotov-plugin')}'/errors-$(date -u +%F).jsonl`)
  expect(section).toContain(`grep -h '"level":"error"'`)
})

test('an agent can pair a new bot without requesting an ID and opt into service startup', () => {
  const { root, repo, env } = checkout()
  const secret = join(root, 'token')
  writeFileSync(secret, token + '\n', { mode: 0o600 })
  const result = command(repo, { ...env, TELEGRAM_BOT_TOKEN: '' }, 'bash', './install.sh',
    '--non-interactive', '--token-file', secret, '--pair-code', pairCode, '--start')
  expect(result.code, result.text).toBe(0)
  expect(result.text).not.toContain(token)
  const saved = readFileSync(join(repo, 'plugin/.env'), 'utf8')
  expect(saved).toContain('TELEGRAM_ALLOWED_USER_IDS=42')
  expect(saved).toContain('KROT_CODEX_AGENT_NAME="Личный помощник"')
  const calls = readFileSync(env.SETUP_CALLS, 'utf8')
  expect(calls).toContain('loginctl enable-linger')
  expect(calls).toContain('systemctl --user enable --now krotov-telegram.service')
})

test('installation dry-run leaves the checkout and home untouched', () => {
  const { repo, env, home } = checkout()
  const result = command(repo, env, 'bash', './install.sh', '--dry-run')
  expect(result.code, result.text).toBe(0)
  expect(existsSync(join(repo, 'plugin/.env'))).toBe(false)
  expect(existsSync(join(home, '.config'))).toBe(false)
  expect(existsSync(env.SETUP_CALLS)).toBe(false)
})

test('update.sh passes the default and configured per-test timeout to staged Bun', () => {
  const { root, repo, env, git } = checkout()
  const remote = localUpstream(root, git)
  git('checkout', '-qb', 'release')
  git('commit', '-qm', 'fixture release', '--allow-empty')
  git('-C', remote, 'fetch', '-q', repo, 'release:main')
  git('checkout', '-q', 'main')
  writeFileSync(join(repo, 'plugin/.env'), 'KROT_CODEX_SERVICE_NAME=fixture-bridge.service\n', { mode: 0o600 })

  const failed = command(repo, { ...env, FAIL_DOCTOR: '1' }, 'bash', './update.sh')
  expect(failed.code).not.toBe(0)
  expect(readFileSync(env.SETUP_CALLS, 'utf8').split('\n')).toContain('bun --no-env-file test --timeout=60000')
  const updated = command(repo, { ...env, KROT_UPDATE_TEST_TIMEOUT_MS: '90000', SETUP_UNIT_DIRECTORY: join(repo, 'plugin') },
    'bash', './update.sh', '--restart')
  expect(updated.code, updated.text).toBe(0)
  const calls = readFileSync(env.SETUP_CALLS, 'utf8').split('\n')
  expect(calls).toContain('bun --no-env-file test --timeout=90000')
  expect(calls).toContain('systemctl --user show --property=WorkingDirectory --value fixture-bridge.service')
  expect(calls).toContain('systemctl --user restart fixture-bridge.service')
})

test('install refuses a foreign default unit and retains a custom service name on rerun', () => {
  const { repo, env, home } = checkout()
  const units = join(home, '.config/systemd/user')
  mkdirSync(units, { recursive: true })
  const defaultUnit = join(units, 'krotov-telegram.service')
  const foreign = '[Service]\nWorkingDirectory="/another checkout/plugin"\n'
  writeFileSync(defaultUnit, foreign)
  const args = ['bash', './install.sh', '--non-interactive', '--owner-id', '987654321']

  const refused = command(repo, env, ...args)
  expect(refused.code).not.toBe(0)
  expect(refused.text).toContain('--service-name')
  expect(existsSync(join(repo, 'plugin/.env'))).toBe(false)

  const installed = command(repo, env, ...args, '--service-name', 'fixture-bridge.service')
  expect(installed.code, installed.text).toBe(0)
  expect(readFileSync(defaultUnit, 'utf8')).toBe(foreign)
  const unit = readFileSync(join(units, 'fixture-bridge.service'), 'utf8')
  expect(unit).toContain(`WorkingDirectory=${repo}/plugin\n`)
  expect(unit).toContain('OnFailure=fixture-bridge-failed.service')
  expect(unit).toContain('boot-guard.sh')
  expect(readFileSync(join(units, 'fixture-bridge-failed.service'), 'utf8')).toContain('"fixture-bridge.service"\n')
  expect(readFileSync(join(repo, 'plugin/.env'), 'utf8')).toContain('KROT_CODEX_SERVICE_NAME=fixture-bridge.service\n')

  const rerun = command(repo, env, 'bash', './install.sh', '--start')
  expect(rerun.code, rerun.text).toBe(0)
  expect(readFileSync(env.SETUP_CALLS, 'utf8')).toContain('systemctl --user enable --now fixture-bridge.service')
})

test.each(['%h/other/plugin', '%u/plugin', '%h/%u/plugin'])(
  'install refuses foreign or unresolved WorkingDirectory=%s without a user manager', directory => {
    const { repo, env, home } = checkout()
    const units = join(home, '.config/systemd/user')
    mkdirSync(units, { recursive: true })
    const unit = join(units, 'krotov-telegram.service')
    const original = `[Service]\nWorkingDirectory="${directory}"\n`
    writeFileSync(unit, original)

    const result = command(repo, { ...env, SETUP_MANAGER_UNAVAILABLE: '1' },
      'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
    expect(result.code, result.text).not.toBe(0)
    expect(result.text).toContain('--service-name')
    expect(existsSync(join(repo, 'plugin/.env'))).toBe(false)
    expect(existsSync(join(home, 'krotov-workspace'))).toBe(false)
    expect(existsSync(join(home, '.local/state'))).toBe(false)
    expect(existsSync(join(units, 'krotov-telegram-failed.service'))).toBe(false)
    expect(readFileSync(unit, 'utf8')).toBe(original)
  },
)

test('install accepts its own WorkingDirectory with %h and an escaped percent', () => {
  const { repo, env, home } = checkout('repo with %h')
  const units = join(home, '.config/systemd/user')
  mkdirSync(units, { recursive: true })
  const unit = join(units, 'krotov-telegram.service')
  const original = '[Service]\nWorkingDirectory="%h/../repo with %%h/plugin"\n'
  writeFileSync(unit, original)

  const result = command(repo, { ...env, SETUP_MANAGER_UNAVAILABLE: '1' },
    'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(result.code, result.text).toBe(0)
  expect(readFileSync(unit, 'utf8')).toBe(original)
})

test('update validates upstream in isolation and leaves the checkout untouched on failing tests', () => {
  const { root, repo, env, git } = checkout()
  const remote = localUpstream(root, git)
  const publisher = join(root, 'publisher')
  git('-C', remote, 'fetch', '-q', repo, 'main:main')
  git('clone', '-q', remote, publisher)
  const old = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'plugin/.env'), 'saved fixture\n', { mode: 0o600 })
  const publish = (...args: string[]) => {
    const result = command(publisher, env, 'git', ...args)
    if (result.code !== 0) throw Error(result.text)
    return result.text.trim()
  }
  writeFileSync(join(publisher, 'plugin/broken'), 'test failure')
  publish('add', '.')
  publish('commit', '-qm', 'failing release')
  git('-C', remote, 'fetch', '-q', publisher, 'main:main')
  const failed = command(repo, env, 'bash', './update.sh')
  expect(failed.code).not.toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(old)
  expect(existsSync(join(repo, 'plugin/broken'))).toBe(false)
  publish('rm', '-q', 'plugin/broken')
  publish('commit', '-qm', 'working release')
  git('-C', remote, 'fetch', '-q', publisher, 'main:main')
  const doctorFailure = command(repo, { ...env, FAIL_DOCTOR: '1' }, 'bash', './update.sh')
  expect(doctorFailure.code).not.toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(old)
  const working = command(repo, env, 'bash', './update.sh')
  expect(working.code, working.text).toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(publish('rev-parse', 'HEAD'))
  expect(readFileSync(join(repo, 'plugin/.env'), 'utf8')).toBe('saved fixture\n')
  expect(readFileSync(env.SETUP_CALLS, 'utf8')).not.toContain('systemctl')
})

test('update.sh refuses an upstream that starts tracking an ignored local file instead of overwriting it', () => {
  const { root, repo, env, git } = checkout()
  const remote = localUpstream(root, git)
  const publisher = join(root, 'publisher')
  git('-C', remote, 'fetch', '-q', repo, 'main:main')
  git('clone', '-q', remote, publisher)
  const old = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'plugin/.env'), 'saved fixture\n', { mode: 0o600 })
  const publish = (...args: string[]) => {
    const result = command(publisher, env, 'git', ...args)
    if (result.code !== 0) throw Error(result.text)
    return result.text.trim()
  }
  writeFileSync(join(publisher, 'plugin/.env'), 'upstream template\n')
  publish('add', '-f', 'plugin/.env')
  publish('commit', '-qm', 'track the env file')
  git('-C', remote, 'fetch', '-q', publisher, 'main:main')
  const result = command(repo, env, 'bash', './update.sh')
  expect(result.code, result.text).not.toBe(0)
  expect(readFileSync(join(repo, 'plugin/.env'), 'utf8')).toBe('saved fixture\n')
  expect(git('rev-parse', 'HEAD')).toBe(old)
})

test('[S2] install writes a unit that ends restart loops and a one-message failure notifier', () => {
  const { repo, env, home } = checkout()
  const result = command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321')
  expect(result.code, result.text).toBe(0)
  const unit = readFileSync(join(home, '.config/systemd/user/krotov-telegram.service'), 'utf8')
  expect(unitDrift(unit)).toEqual([])
  for (const line of ['Restart=on-failure', 'RestartSec=10s', 'RestartForceExitStatus=75', 'SuccessExitStatus=75',
    'RestartPreventExitStatus=78', 'TimeoutStopSec=90', 'StartLimitIntervalSec=300', 'StartLimitBurst=6',
    'OnFailure=krotov-telegram-failed.service']) expect(unit.split('\n')).toContain(line)
  // Start-limit settings live in [Unit]; systemd ignores them in [Service].
  expect(unit.indexOf('StartLimitBurst=6')).toBeLessThan(unit.indexOf('[Service]'))
  const failed = readFileSync(join(home, '.config/systemd/user/krotov-telegram-failed.service'), 'utf8')
  expect(failed.split('\n')).toContain('Type=oneshot')
  expect(failed).toContain(join(repo, 'plugin/scripts/notify-failed.sh'))
  expect(failed).not.toContain('bun')
  // S9: the bash boot guard runs before every start and never blocks it.
  // It is the copy in the state directory, outside the checkout an update could change.
  const guard = join(realpathSync(join(home, '.local/state/krotov-plugin')), 'boot-guard.sh')
  expect(unit.split('\n')).toContain('ExecStartPre=-/bin/bash "' + guard + '"')
  expect(readFileSync(guard, 'utf8')).toBe(readFileSync(join(repo, 'plugin/scripts/boot-guard.sh'), 'utf8'))
  // The guard's rollback reinstalls dependencies inside the start; the default 90 s can cut it off.
  expect(unit.split('\n')).toContain('TimeoutStartSec=300')
})

test('[S2] a rerun migrates a unit an earlier installer generated and leaves a custom unit untouched', () => {
  const { repo, env, home } = checkout()
  expect(command(repo, env, 'bash', './install.sh', '--non-interactive', '--owner-id', '987654321').code).toBe(0)
  const unitFile = join(home, '.config/systemd/user/krotov-telegram.service')
  const current = readFileSync(unitFile, 'utf8')
  // The v0.3.2 unit before this change ran the guard from inside the checkout.
  const legacy = current.split('\n').map(line => line.startsWith('ExecStartPre=')
    ? 'ExecStartPre=-/bin/bash "' + join(repo, 'plugin/scripts/boot-guard.sh') + '"' : line).join('\n')
  writeFileSync(unitFile, legacy)
  expect(unitDrift(legacy)).toEqual([BOOT_GUARD_LINE])
  const rerun = command(repo, env, 'bash', './install.sh', '--non-interactive')
  expect(rerun.code, rerun.text).toBe(0)
  expect(readFileSync(unitFile, 'utf8')).toBe(current)
  expect(readFileSync(unitFile + '.bak', 'utf8')).toBe(legacy)
  // A unit the owner edited is theirs: kept as it is.
  const custom = legacy + '# my own line\n'
  writeFileSync(unitFile, custom)
  expect(command(repo, env, 'bash', './install.sh', '--non-interactive').code).toBe(0)
  expect(readFileSync(unitFile, 'utf8')).toBe(custom)
})
