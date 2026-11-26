import { afterEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { type ApprovalEnv, resolveApprovalSetup } from '../../src/codex/approval-mode.js'

const source = resolve(import.meta.dir, '../../..')
const temporary: string[] = []
const token = '123456789:setup_fixture_token'
const pairCode = 'krotov-12345678-4321-1234-4321-123456789abc'

function command(cwd: string, env: NodeJS.ProcessEnv, ...cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { code: result.exitCode, text: result.stdout.toString() + result.stderr.toString() }
}

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'krotov-setup-test-'))
  temporary.push(root)
  const repo = join(root, 'repo with spaces')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  mkdirSync(join(repo, 'plugin/scripts'), { recursive: true })
  mkdirSync(bin)
  mkdirSync(home)
  for (const file of ['install.sh', 'update.sh', 'plugin/scripts/setup-common.sh']) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(repo, file))
  }
  writeFileSync(join(repo, '.gitignore'), 'plugin/.env\nplugin/node_modules/\n')
  writeFileSync(join(repo, 'plugin/bun.lock'), 'fixture')
  const env = {
    PATH: bin + ':/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'), TELEGRAM_BOT_TOKEN: token, SETUP_CALLS: join(root, 'calls'),
    GIT_AUTHOR_NAME: 'Setup test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Setup test', GIT_COMMITTER_EMAIL: 'test@example.test',
  }
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o700 })
  stub('bun', `printf 'bun %s\\n' "$*" >> "$SETUP_CALLS"
if [[ "$*" == *' test' && -f broken ]]; then exit 8; fi
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
  stub('systemctl', 'printf \'systemctl %s\\n\' "$*" >> "$SETUP_CALLS"')
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

test('install configures a private owner and checks doctor without starting the bot by default', () => {
  const { repo, env, home } = checkout()
  const invocation = ['bash', './install.sh', '--non-interactive', '--owner-id', '987654321', '--agent-name', 'Полярная звезда']
  const result = command(repo, env, ...invocation)
  expect(result.code, result.text).toBe(0)
  expect(result.text).not.toContain(token)
  const file = join(repo, 'plugin/.env')
  const saved = readFileSync(file, 'utf8')
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

test('update validates upstream in isolation and leaves the checkout untouched on failing tests', () => {
  const { root, repo, env, git } = checkout()
  const remote = join(root, 'remote.git')
  const publisher = join(root, 'publisher')
  git('init', '--bare', '-q', '-b', 'main', remote)
  git('remote', 'add', 'origin', remote)
  git('push', '-qu', 'origin', 'main')
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
  publish('push', '-q')
  const failed = command(repo, env, 'bash', './update.sh')
  expect(failed.code).not.toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(old)
  expect(existsSync(join(repo, 'plugin/broken'))).toBe(false)
  publish('rm', '-q', 'plugin/broken')
  publish('commit', '-qm', 'working release')
  publish('push', '-q')
  const doctorFailure = command(repo, { ...env, FAIL_DOCTOR: '1' }, 'bash', './update.sh')
  expect(doctorFailure.code).not.toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(old)
  const working = command(repo, env, 'bash', './update.sh')
  expect(working.code, working.text).toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(publish('rev-parse', 'HEAD'))
  expect(readFileSync(join(repo, 'plugin/.env'), 'utf8')).toBe('saved fixture\n')
  expect(readFileSync(env.SETUP_CALLS, 'utf8')).not.toContain('systemctl')
})
