// Codex 0.172 command hooks have no onFailure field: a PreToolUse hook that crashes, exits with
// another code, is killed or times out lets the tool run. The pack itself must turn every such
// failure of the bridge user's PreToolUse into the blocking form (exit 2, reason on stderr), and
// stay a pure no-op (exit 0, no output) for a user a trusted bridge-uid proves is not the bridge.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_DEADLINE_MS, launcherVerdict, runHook, runMain } from '../../../codex-hooks/src/entry.js'
import { BLOCK_PREFIX, fullAccessGuards, guardsActive, LAUNCHER_BUDGET_S, launcherScript, managedCheck, managedToml, stageManaged } from '../../../codex-hooks/src/install.js'
import { BRIDGE_UID_FILE, hookScope, readBridgeUid } from '../../../codex-hooks/src/scope.js'
import type { Runner } from '../../../codex-hooks/src/types.js'

const myUid = process.getuid?.() ?? 1000
const noProcess: Runner = () => ({ code: 1, stdout: '' })

let root = ''
let managedDir = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-hooks-fail-closed-'))
  managedDir = join(root, 'etc-codex', 'hooks')
  mkdirSync(managedDir, { recursive: true })
  chmodSync(join(root, 'etc-codex'), 0o755)
  chmodSync(managedDir, 0o755)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// A managed dir whose launcher trusts the test runner as the owner of bridge-uid, with a fake bun.
function fixture(bun: string | undefined, bridgeUid: number, options: { timeoutS?: number; judgeTimeoutS?: number; trustedOwnerUid?: number } = {}): string {
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${bridgeUid}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  if (bun !== undefined) {
    writeFileSync(join(managedDir, 'bun'), bun)
    chmodSync(join(managedDir, 'bun'), 0o755)
  }
  const launcher = join(managedDir, 'run')
  writeFileSync(launcher, launcherScript(managedDir, { trustedOwnerUid: options.trustedOwnerUid ?? myUid, ...(options.timeoutS ? { timeoutS: options.timeoutS } : {}),
    ...(options.judgeTimeoutS ? { judgeTimeoutS: options.judgeTimeoutS } : {}) }))
  chmodSync(launcher, 0o755)
  return launcher
}

const launch = (launcher: string, event: string, stdin = '{}') => {
  const child = Bun.spawnSync([launcher, event], { cwd: root, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', HOME: root } })
  return { code: child.exitCode, signal: child.signalCode ?? null, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

const expectBlocked = (result: ReturnType<typeof launch>) => {
  expect({ code: result.code, signal: result.signal }).toEqual({ code: 2, signal: null })
  // Codex takes the block reason of an exit 2 from stderr; it must not be empty.
  expect(result.stderr).toStartWith(BLOCK_PREFIX)
  expect(result.stderr.slice(BLOCK_PREFIX.length)).toMatch(/^\S.*\n$/)
  // Codex ignores stdout on exit 2; a failure must not leak half an answer there either.
  expect(result.stdout).toBe('')
}
const expectNoOp = (result: ReturnType<typeof launch>) => {
  expect(result).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })
}

const CRASH = '#!/bin/sh\necho "partial {" \necho boom >&2\nexit 1\n'
const KILLED = '#!/bin/sh\nkill -9 $$\n'
const HANG = '#!/bin/sh\nexec sleep 30\n'

test('[fail-closed] a crashing bun blocks the bridge user PreToolUse and is a no-op for another user', () => {
  expectBlocked(launch(fixture(CRASH, myUid), 'PreToolUse'))
  expectNoOp(launch(fixture(CRASH, myUid + 1), 'PreToolUse'))
  expectNoOp(launch(fixture(CRASH, myUid + 1), 'Stop'))
})

test('[fail-closed] a missing bun blocks the bridge user PreToolUse and is a no-op for another user', () => {
  expectBlocked(launch(fixture(undefined, myUid), 'PreToolUse'))
  expectNoOp(launch(fixture(undefined, myUid + 1), 'PreToolUse'))
})

test('[fail-closed] a bun killed by a signal blocks the bridge user PreToolUse', () => {
  expectBlocked(launch(fixture(KILLED, myUid), 'PreToolUse'))
  expectNoOp(launch(fixture(KILLED, myUid + 1), 'PreToolUse'))
})

test('[fail-closed] a hanging bun is stopped by the launcher deadline and blocks the bridge user PreToolUse', () => {
  const started = Date.now()
  expectBlocked(launch(fixture(HANG, myUid, { timeoutS: 1 }), 'PreToolUse'))
  expect(Date.now() - started).toBeLessThan(10_000)
  expectNoOp(launch(fixture(HANG, myUid + 1, { timeoutS: 1 }), 'PreToolUse'))
}, 30_000)

test('[fail-closed] an untrusted bridge-uid cannot make the bridge look like another user', () => {
  // bridge-uid names another uid, but its owner is not the trusted one: who the bridge is cannot be told.
  expectBlocked(launch(fixture(CRASH, myUid + 1, { trustedOwnerUid: myUid + 7 }), 'PreToolUse'))
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), 'garbage\n')
  expectBlocked(launch(join(managedDir, 'run'), 'PreToolUse'))
})

test('[fail-closed] the launcher answers a bundle deny (exit 3) itself and passes only an allow', () => {
  const denied = '#!/bin/sh\necho "rm -rf / запрещён"\necho noise >&2\nexit 3\n'
  expect(launch(fixture(denied, myUid), 'PreToolUse'))
    .toEqual({ code: 2, signal: null, stdout: '', stderr: `${BLOCK_PREFIX}rm -rf / запрещён\n` })
  expect(launch(fixture('#!/bin/sh\necho ALLOW\necho "{}"\necho noise >&2\n', myUid), 'PreToolUse')).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
  expect(launch(fixture('#!/bin/sh\necho ALLOW\n', myUid), 'PreToolUse')).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })
  // An exit 0 that does not say ALLOW is no verdict.
  expectBlocked(launch(fixture('#!/bin/sh\nexit 0\n', myUid), 'PreToolUse'))
  expectBlocked(launch(fixture('#!/bin/sh\necho "{}"\n', myUid), 'PreToolUse'))
  // Other events are not judged: bun's exit code and streams pass as they are.
  expect(launch(fixture('#!/bin/sh\necho "{}"\n', myUid), 'Stop')).toMatchObject({ code: 0, stdout: '{}\n' })
  expect(launch(fixture('#!/bin/sh\necho x\nexit 3\n', myUid), 'Stop')).toMatchObject({ code: 3, stdout: 'x\n' })
})

test('[fail-closed] the launcher starts the bundle in verdict mode for PreToolUse only', () => {
  const args = '#!/bin/sh\necho "$*"\nexit 3\n'
  expect(launch(fixture(args, myUid), 'PreToolUse').stderr).toBe(`${BLOCK_PREFIX}--no-env-file --config=./bunfig.toml ./codex-hooks.js PreToolUse launcher-verdict\n`)
  expect(launch(fixture(args, myUid), 'Stop').stdout).toBe('--no-env-file --config=./bunfig.toml ./codex-hooks.js Stop\n')
})

test('[fail-closed] a crash of a non-PreToolUse event of the bridge user stays fail-open', () => {
  const result = launch(fixture(CRASH, myUid), 'Stop')
  expect(result.code).not.toBe(2)
})

test('[fail-closed] garbage stdin through the real launcher and bundle blocks PreToolUse', async () => {
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-e2e')
  await stageManaged({ codexHome: join(root, '.codex'), configFile: join(root, 'x.json'), bun: process.execPath,
    main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts') }, staging, etc)
  mkdirSync(join(etc, 'hooks'), { recursive: true })
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml', 'run', BRIDGE_UID_FILE]) copyFileSync(join(staging, name), join(etc, 'hooks', name))
  chmodSync(join(etc, 'hooks', 'bun'), 0o755)
  chmodSync(join(etc, 'hooks', 'run'), 0o755)
  const result = launch(join(etc, 'hooks', 'run'), 'PreToolUse', 'not json at all')
  expectBlocked(result)
  expect(result.stderr).toContain('хук не смог прочитать вызов инструмента')
}, 30_000)

test('[fail-closed] the real bundle behind the real launcher blocks rm -rf / with exit 2 and lets ls run', async () => {
  const staging = join(root, 'staging')
  const etc = join(root, 'etc-e2e')
  await stageManaged({ codexHome: join(root, '.codex'), configFile: join(root, 'x.json'), bun: process.execPath,
    main: join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts') }, staging, etc)
  mkdirSync(join(etc, 'hooks'), { recursive: true })
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml', 'run', BRIDGE_UID_FILE]) copyFileSync(join(staging, name), join(etc, 'hooks', name))
  chmodSync(join(etc, 'hooks', 'bun'), 0o755)
  chmodSync(join(etc, 'hooks', 'run'), 0o755)
  const call = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', cwd: root,
    tool_name: 'shell', tool_input: { command }, tool_use_id: 'u' })
  const deny = launch(join(etc, 'hooks', 'run'), 'PreToolUse', call('rm -rf /'))
  expectBlocked(deny)
  expect(deny.stderr).not.toContain('hookSpecificOutput')
  expect(launch(join(etc, 'hooks', 'run'), 'PreToolUse', call('ls'))).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
}, 30_000)

test('[fail-closed] garbage stdin of another user is a pure no-op in the entry', async () => {
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${myUid + 1}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  const scopeOf = (env: Record<string, string | undefined>) => hookScope(env, myUid, () => true)
  expect(await runMain('PreToolUse', 'not json', { HOME: root, CODEX_HOOKS_MANAGED_DIR: managedDir }, noProcess, undefined, scopeOf))
    .toEqual({ stdout: '', code: 0 })
})

test('[fail-closed] a PreToolUse hook that overruns the entry deadline is denied with exit 2', async () => {
  const never = () => new Promise<string>(() => { /* never settles */ })
  const pre = await runMain('PreToolUse', '{}', { HOME: root }, noProcess, never, () => 'full', 50)
  expect(pre.code).toBe(2)
  expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(pre.stderr).toBeTruthy()
  expect(await runMain('PreToolUse', '{}', { HOME: root }, noProcess, never, () => 'other', 50)).toEqual({ stdout: '', code: 0 })
})

test('[fail-closed] the managed TOML carries no onFailure field (Codex 0.172 has none) and keeps the timeouts', () => {
  const toml = managedToml('/etc/codex/hooks')
  expect(toml).not.toContain('onFailure')
  expect(toml.match(/timeout = 30/g)).toHaveLength(6)
})

test('[fail-closed] doctor accepts the managed TOML without onFailure and never claims it', () => {
  const etc = join(root, 'etc-codex')
  writeFileSync(join(etc, 'requirements.toml'), managedToml(managedDir))
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml']) writeFileSync(join(managedDir, name), '')
  writeFileSync(join(managedDir, 'run'), launcherScript(managedDir))
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${myUid}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  const owned = () => true
  const probe = () => ({ ok: true, why: 'ok' })
  const me = (uid: number) => uid === myUid
  expect(guardsActive(etc, owned, probe, me)).toEqual({ active: true, why: 'ok' })
  const check = managedCheck(etc, me, owned, probe)
  expect(check.status).toBe('ok')
  expect(check.message).not.toContain('onFailure')
  const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'install.ts'), 'utf8')
  expect(source).not.toContain('onFailure = block')
})

const DENY_JSON = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}'
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const CONTEXT_JSON = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"ветка main\\u000aне для правок"}}'
// A fake bun that prints `out` (printf %b: \\NNN is an octal byte) and exits with `code`.
const answers = (out: string, code = 0, raw = false) =>
  fixture(`#!/bin/sh\nprintf '%b' ${shQuote(raw ? out : out.replace(/\\/g, '\\\\'))}\nexit ${code}\n`, myUid)

test('[fail-closed] no JSON that is or could be a deny passes at exit 0: the launcher blocks it', () => {
  const nbsp = DENY_JSON.replace('"x"', '"\u00a0"')
  for (const out of [DENY_JSON, `${DENY_JSON}\n`, nbsp, DENY_JSON.replace('"x"', '"\\n"'), DENY_JSON.replace('"x"', '""'), DENY_JSON.slice(0, -2),
    `{}${DENY_JSON}`, `{}\n${DENY_JSON}\n`, `${DENY_JSON}{}`, '{"decision":"block","reason":"x"}', 'partial {', 'null', '{} ', ' {}', '{}\n\n', '{}\n{}',
    // The context shape with a quote, a non-\u escape or a second line in its text is not the known allow shape.
    CONTEXT_JSON.replace('main', 'main","permissionDecision":"deny","permissionDecisionReason":"x'), CONTEXT_JSON.replace('main', 'ma\\"in'),
    CONTEXT_JSON.replace('main', 'ma\\\\in'), CONTEXT_JSON.replace('правок', 'правок\\'), `${CONTEXT_JSON}\n${CONTEXT_JSON}`, CONTEXT_JSON.replace('main', 'ma\nin')]) {
    // Bare, and as the second line behind the ALLOW line (with and without its line break).
    for (const answer of [out, `ALLOW\n${out}`, `ALLOW\n${out}\n`]) {
      const result = launch(answers(answer), 'PreToolUse')
      expect({ answer, code: result.code, stdout: result.stdout }).toEqual({ answer, code: 2, stdout: '' })
      expectBlocked(result)
      expect(result.stderr).not.toContain('permissionDecision')
    }
  }
})

test('[fail-closed] the launcher passes the context line only in its known allow shape', () => {
  expect(launch(answers(`ALLOW\n${CONTEXT_JSON}\n`), 'PreToolUse')).toEqual({ code: 0, signal: null, stdout: `${CONTEXT_JSON}\n`, stderr: '' })
  expect(JSON.parse(CONTEXT_JSON).hookSpecificOutput.additionalContext).toBe('ветка main\nне для правок')
})

test('[fail-closed] a deny whose reason has no visible character still blocks, with a fallback reason', () => {
  for (const reason of ['', '\n', '\n\n\n', ' \t ', '\u00a0', '\u00a0\u00a0\n', '\u2003\u3000\u2028\ufeff', '\\001\\033']) {
    const result = launch(answers(reason, 3, true), 'PreToolUse')
    expect({ reason, ...result }).toEqual({ reason, code: 2, signal: null, stdout: '', stderr: `${BLOCK_PREFIX}причина не указана\n` })
  }
})

test('[fail-closed] control characters are stripped from the reason and it stays one line', () => {
  // A reason of Cyrillic letters alone is visible (no ASCII in it).
  expect(launch(answers('запрещено\n', 3, true), 'PreToolUse').stderr).toBe(`${BLOCK_PREFIX}запрещено\n`)
  expect(launch(answers('первая\\033[31m строка\n\nвторая\\001\n', 3, true), 'PreToolUse').stderr).toBe(`${BLOCK_PREFIX}первая[31m строка  вторая\n`)
})

test('[fail-closed] every exit code but 0 and 3 blocks with the cause, whatever the bundle printed', () => {
  for (const code of [1, 2, 4, 10, 124, 137, 255]) {
    const result = launch(fixture(`#!/bin/sh\necho "{}"\necho reason >&2\nexit ${code}\n`, myUid), 'PreToolUse')
    expect({ code, exit: result.code, stdout: result.stdout }).toEqual({ code, exit: 2, stdout: '' })
    expectBlocked(result)
    expect(result.stderr).not.toContain('reason')
  }
  expect(launch(fixture('#!/bin/sh\nexit 2\n', myUid), 'PreToolUse').stderr).toContain('код выхода 2')
})

test('[fail-closed] an oversized answer or reason is never read whole: the launcher stays bounded', () => {
  const flood = (code: number) => `#!/bin/sh\nhead -c 20000000 /dev/zero | tr '\\0' x\nhead -c 20000000 /dev/zero | tr '\\0' y >&2\nexit ${code}\n`
  for (const code of [0, 2, 3]) {
    const result = launch(fixture(flood(code), myUid), 'PreToolUse')
    expectBlocked(result)
    expect(result.stderr.length).toBeLessThan(10_000)
  }
}, 30_000)

test('[fail-closed] everything after the uid lookup runs under one watchdog inside the Codex timeout', () => {
  const script = launcherScript(managedDir)
  // The judge (bun, the capped read of its answer, the verdict) is this launcher run again under timeout.
  expect(script).toContain(`"$T" -k 1 25 '${managedDir}/run' PreToolUse judge "$$"`)
  expect(script.indexOf(`'${managedDir}/run' PreToolUse judge`)).toBeLessThan(script.indexOf('mktemp -d "/tmp/codex-hooks.'))
  // The bundle's output is never read through an unbounded command substitution.
  expect(script).not.toMatch(/\$\(hook\b|\$\(cat "\$(?:out|errors)"/)
  expect(LAUNCHER_BUDGET_S).toBe(29)
})

test('[fail-closed] a judge that outlives its watchdog blocks', () => {
  // bun ignores TERM and its own timeout is longer than the judge's: only the outer watchdog ends the run.
  const launcher = fixture('#!/bin/sh\ntrap "" TERM\nsleep 6\necho "{}"\n', myUid, { timeoutS: 30, judgeTimeoutS: 1 })
  const started = Date.now()
  const result = launch(launcher, 'PreToolUse')
  expectBlocked(result)
  expect(result.stderr).toContain('не ответил')
  expect(Date.now() - started).toBeLessThan(5_000)
}, 30_000)

test('[fail-closed] the bundle in verdict mode answers a deny with exit 3 and the bare reason', () => {
  const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  expect(launcherVerdict({ stdout: deny('Заблокировано: rm -rf /'), code: 0 })).toEqual({ stdout: 'Заблокировано: rm -rf /', code: 3 })
  // The crash/deadline form (deny JSON, exit 2) and a deny that also carries context are denies too.
  expect(launcherVerdict({ stdout: deny('сбой'), code: 2, stderr: 'сбой' })).toEqual({ stdout: 'сбой', code: 3 })
  expect(launcherVerdict({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x', additionalContext: 'c' } }), code: 0 }))
    .toEqual({ stdout: 'x', code: 3 })
  expect(launcherVerdict({ stdout: deny(''), code: 0 }).code).toBe(3)
  expect(launcherVerdict({ stdout: '{}', code: 0 })).toEqual({ stdout: 'ALLOW\n{}', code: 0 })
  expect(launcherVerdict({ stdout: '', code: 0 })).toEqual({ stdout: 'ALLOW', code: 0 })
  // Anything the bundle does not know as an allow is a deny: it never guesses.
  for (const stdout of ['not json', 'null', '[]', '{"decision":"block","reason":"x"}', '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":7}}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"c"},"continue":false}']) {
    expect({ stdout, code: launcherVerdict({ stdout, code: 0 }).code }).toEqual({ stdout, code: 3 })
  }
  expect(launcherVerdict({ stdout: '{}', code: 1 }).code).toBe(3)
})

test('[fail-closed] the bundle in verdict mode renders context as the one line the launcher can check', () => {
  const context = 'ветка "main"\nпуть C:\\x\t\u007f конец\\'
  const line = launcherVerdict({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }), code: 0 })
  expect(line.code).toBe(0)
  expect(line.stdout).toStartWith('ALLOW\n')
  const json = line.stdout.slice('ALLOW\n'.length)
  expect(JSON.parse(json)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } })
  const text = json.slice('{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"'.length, -'"}}'.length)
  expect(text).not.toMatch(/["\n]|\\(?!u[0-9a-f]{4})/)
  expect(launch(answers(`${line.stdout}\n`), 'PreToolUse')).toEqual({ code: 0, signal: null, stdout: `${json}\n`, stderr: '' })
})

test('[fail-closed] requirements.toml counts only when it is exactly the generated file', () => {
  const etc = join(root, 'etc-codex')
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml']) writeFileSync(join(managedDir, name), '')
  writeFileSync(join(managedDir, 'run'), launcherScript(managedDir))
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${myUid}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  const active = (toml: string) => {
    writeFileSync(join(etc, 'requirements.toml'), toml)
    return guardsActive(etc, () => true, () => ({ ok: true, why: 'ok' }), uid => uid === myUid)
  }
  const good = managedToml(managedDir)
  expect(active(good)).toEqual({ active: true, why: 'ok' })
  const block = `[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "'${managedDir}/run' PreToolUse"\ntimeout = 30\n`
  expect(good).toContain(block)
  // The real PreToolUse handler has timeout = 1; the expected block survives only as string data.
  const hidden = `${good.replace(block, block.replace('timeout = 30', 'timeout = 1'))}\n[notes]\nold = '''\n${block}'''\n`
  expect(hidden).toContain(block)
  const fooled = active(hidden)
  expect(fooled.active).toBe(false)
  expect(fooled.why).toContain('requirements.toml')
  for (const toml of [good.replace(block, `${block}timeout = 1\n`), good.replace(block, block.replace('timeout = 30', 'timeout = 30_0')),
    `${good}${block}`, `${good}\n[[hooks.PreToolUse]]\n${block.replace('timeout = 30', 'timeout = 1')}`, good.replace('timeout = 30', 'timeout = 3'), `${good}# x\n`]) {
    expect({ toml, active: active(toml).active }).toEqual({ toml, active: false })
  }
})

test('[fail-closed] a bun killed by SIGKILL is reported as killed or timed out', () => {
  expect(launch(fixture(KILLED, myUid), 'PreToolUse').stderr).toContain('убит или не ответил')
})

test('[fail-closed] the launcher bounds its uid lookup and stays inside the Codex handler timeout', () => {
  const script = launcherScript(managedDir)
  expect(script).toMatch(/"\$T" -k 1 2 \/bin\/sh -c '[^']*find[^']*cat[^']*id -ru/)
  expect(script).toContain('[ -x /usr/bin/timeout ] && T=/usr/bin/timeout')
  // lookup (2 s + 1 s kill) and the judge (25 s + 1 s kill; the stdin drain 2 s + 1 s and bun's 20 s + 1 s inside it) stay below the 30 s Codex timeout.
  expect(LAUNCHER_BUDGET_S).toBeLessThan(30)
})

test('[fail-closed] the launcher shell and readBridgeUid validate bridge-uid identically', () => {
  const owner = () => true
  const other = myUid + 1
  const cases: [string, boolean][] = [
    [` ${other}\n`, false], [`${other} \n`, false], ['9007199254740992\n', false], [`${4294967296 + other}\n`, false],
    ['4294967295\n', false], ['0\n', false], ['\n', false], [`${other}\n\n`, false], [`${other}\0\n`, false], [`${other}\n`, true], [`${other}`, true],
  ]
  for (const [content, valid] of cases) {
    const launcher = fixture(CRASH, other)
    writeFileSync(join(managedDir, BRIDGE_UID_FILE), content)
    expect({ content, ok: readBridgeUid(managedDir, owner).ok }).toEqual({ content, ok: valid })
    expect({ content, scope: hookScope({ CODEX_HOOKS_MANAGED_DIR: managedDir }, myUid, owner) }).toEqual({ content, scope: valid ? 'other' : 'safety' })
    const result = launch(launcher, 'PreToolUse')
    expect({ content, code: result.code }).toEqual({ content, code: valid ? 0 : 2 })
    if (valid) expectNoOp(result)
    else expectBlocked(result)
  }
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), '4294967294\n')
  expect(readBridgeUid(managedDir, owner)).toEqual({ ok: true, uid: 4294967294 })
})

test('[fail-closed] the entry deadline covers reading stdin', async () => {
  const stdin = () => new Promise<string>(() => { /* stdin never closes */ })
  const pre = await runMain('PreToolUse', stdin, { HOME: root }, noProcess, undefined, () => 'full', 50)
  expect(pre.code).toBe(2)
  expect(pre.stderr).toBeTruthy()
})

test('[fail-closed] the entry deadline applies to PreToolUse only: Stop and SessionStart are not cut', async () => {
  const slow = () => new Promise<string>(resolve => setTimeout(() => resolve('{"systemMessage":"done"}'), 150))
  for (const event of ['Stop', 'SessionStart']) {
    expect(await runMain(event, '{}', { HOME: root }, noProcess, slow, () => 'full', 20)).toEqual({ stdout: '{"systemMessage":"done"}', code: 0 })
  }
})

test('[fail-closed] an envelope without a usable tool call is denied for the bridge user', async () => {
  const env = { HOME: root, CODEX_HOOKS_STATE_DIR: join(root, 'state'), CODEX_HOOKS_CONFIG: join(root, 'none.json') }
  for (const stdin of ['{"tool_name":"","tool_input":{}}', '{"tool_name":"apply_patch","tool_input":null}', '{"tool_name":"apply_patch","tool_input":{"input":5}}',
    '{"tool_name":"apply_patch","tool_input":{}}', '{"tool_name":"apply_patch","tool_input":"  "}', '{"tool_name":"mcp__x__y"}',
    '{"tool_name":"mcp__x__y","tool_input":null}', '{"tool_name":"mcp__x__y","tool_input":[1]}', '{"tool_name":"mcp__x__y","tool_input":7}']) {
    for (const scope of ['full', 'safety'] as const) {
      const out = JSON.parse(await runHook('PreToolUse', stdin, env, root, noProcess, scope))
      expect({ stdin, scope, decision: out.hookSpecificOutput?.permissionDecision }).toEqual({ stdin, scope, decision: 'deny' })
    }
  }
  expect(JSON.parse(await runHook('PreToolUse', '{"tool_name":"mcp__x__y","tool_input":{}}', env, root, noProcess, 'safety'))).toEqual({})
})

test('[fail-closed] an old launcher keeps the guards inactive at install and at bridge start-up', async () => {
  const etc = join(root, 'etc-codex')
  writeFileSync(join(etc, 'requirements.toml'), managedToml(managedDir))
  for (const name of ['codex-hooks.js', 'bun', 'bunfig.toml']) writeFileSync(join(managedDir, name), '')
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${myUid}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  const owned = () => true
  const probe = () => ({ ok: true, why: 'ok' })
  const me = (uid: number) => uid === myUid
  writeFileSync(join(managedDir, 'run'), '#!/bin/sh\ncd /etc/codex/hooks && exec ./bun ./codex-hooks.js "$1"\n')
  const old = guardsActive(etc, owned, probe, me)
  expect(old.active).toBe(false)
  expect(old.why).toContain('launcher отличается от текущей версии – перезапусти установщик и строку sudo')
  // The bridge start-up gate (server.ts) goes through fullAccessGuards: no full access either.
  expect(await fullAccessGuards(etc, async () => [], dir => guardsActive(dir, owned, probe, me))).toEqual(old)
  writeFileSync(join(managedDir, 'run'), launcherScript(managedDir))
  expect(guardsActive(etc, owned, probe, me)).toEqual({ active: true, why: 'ok' })
  // A handler without our 30 s timeout runs with another one: not the guard the launcher was sized for.
  writeFileSync(join(etc, 'requirements.toml'), managedToml(managedDir).replace(/timeout = 30\n$/, 'timeout = 600\n'))
  expect(guardsActive(etc, owned, probe, me).active).toBe(false)
})

// Runs the launcher with a stdin pipe the test writes itself; `closeStdin: false` keeps the pipe
// open like a writer that stalls.
async function launchPiped(launcher: string, stdin: Uint8Array, closeStdin = true) {
  const started = Date.now()
  const child = Bun.spawn([launcher, 'PreToolUse'], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: root } })
  child.stdin.write(stdin)
  await child.stdin.flush()
  if (closeStdin) await child.stdin.end()
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitedMs = Date.now() - started
  if (!closeStdin) { try { await child.stdin.end() } catch { /* already closed */ } }
  return { result: { code, signal: child.signalCode ?? null, stdout, stderr }, exitedMs }
}

// Runs `head -c bytes /dev/zero | launcher PreToolUse`: a writer that blocks in write(2) like Codex
// does. `writtenMs` is when that writer was done (all written, or the pipe closed on it), `totalMs`
// when the pipeline ended; the shell waits for both, as Codex waits for the write and the result.
function pipeInto(launcher: string, bytes: number) {
  const marker = join(root, 'written')
  const started = Date.now()
  const child = Bun.spawnSync(['/bin/sh', '-c', '{ head -c "$1" /dev/zero 2>/dev/null; date +%s%N >"$2"; } | "$3" PreToolUse', 'sh', String(bytes), marker, launcher],
    { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 25_000, env: { PATH: '/usr/bin:/bin', HOME: root } })
  const totalMs = Date.now() - started
  const writtenMs = Number(BigInt(readFileSync(marker, 'utf8').trim()) / 1_000_000n) - started
  return { result: { code: child.exitCode, signal: child.signalCode ?? null, stdout: child.stdout.toString(), stderr: child.stderr.toString() }, writtenMs, totalMs }
}

const bigEnvelope = (bytes: number) => Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'x'.repeat(bytes) } }))

test('[fail-closed] the launcher drains a large envelope itself: a bun that stalls before reading never holds the writer', () => {
  // bun ignores TERM and never reads stdin; its own timeout is longer than the judge's, so it outlives the launcher's answer.
  const launcher = fixture('#!/bin/sh\ntrap "" TERM\nsleep 8\necho "{}"\n', myUid, { timeoutS: 30, judgeTimeoutS: 1 })
  const { result, writtenMs, totalMs } = pipeInto(launcher, 1_000_000)
  expectBlocked(result)
  // The whole envelope (far above a pipe buffer) is taken at once, long before the block, and
  // nothing holds the pipe after the launcher's answer.
  expect(writtenMs).toBeLessThan(1_500)
  expect(totalMs).toBeLessThan(6_000)
}, 30_000)

test('[fail-closed] bun reads the drained envelope byte for byte from its stdin', async () => {
  const envelope = bigEnvelope(300_000)
  const sum = new Bun.CryptoHasher('sha256').update(envelope).digest('hex')
  // Deny with the checksum of what bun read as the reason.
  const launcher = fixture('#!/bin/sh\nsha256sum | cut -c1-64\nexit 3\n', myUid)
  const { result } = await launchPiped(launcher, envelope)
  expect(result).toEqual({ code: 2, signal: null, stdout: '', stderr: `${BLOCK_PREFIX}${sum}\n` })
}, 30_000)

test('[fail-closed] an envelope above the cap blocks without starting bun and without holding the writer', () => {
  const marker = join(root, 'bun-started')
  // A bun that would allow, and that never reads its stdin.
  const launcher = fixture(`#!/bin/sh\ntouch '${marker}'\nsleep 4\necho ALLOW\necho "{}"\n`, myUid)
  const over = pipeInto(launcher, 4 * 1024 * 1024 + 1)
  expectBlocked(over.result)
  expect(over.result.stderr).toContain('4194304')
  expect(over.writtenMs).toBeLessThan(3_000)
  expect(over.totalMs).toBeLessThan(3_500)
  expect(existsSync(marker)).toBe(false)
  // At the cap itself the call is judged as usual.
  expect(pipeInto(launcher, 4 * 1024 * 1024).result).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
  expect(existsSync(marker)).toBe(true)
}, 30_000)

test('[fail-closed] a writer that never closes stdin is cut off by the drain timeout and blocks', async () => {
  const marker = join(root, 'bun-started')
  const launcher = fixture(`#!/bin/sh\ntouch '${marker}'\necho "{}"\n`, myUid)
  const { result, exitedMs } = await launchPiped(launcher, Buffer.from('{}'), false)
  expectBlocked(result)
  expect(result.stderr).toContain('вызов инструмента не прочитан')
  expect(exitedMs).toBeLessThan(5_000)
  expect(existsSync(marker)).toBe(false)
}, 30_000)

test('[fail-closed] the drained envelope is removed, stdin is closed before bun and the budget stays under 30 s', async () => {
  const leftovers = () => readdirSync('/tmp').filter(name => name.startsWith('codex-hooks.')).sort()
  const before = leftovers()
  expect(launch(fixture('#!/bin/sh\necho ALLOW\necho "{}"\n', myUid), 'PreToolUse').code).toBe(0)
  expectBlocked(launch(fixture(CRASH, myUid), 'PreToolUse'))
  // The removal is detached from the launcher: it is done a moment after the answer.
  for (let attempt = 0; attempt < 50 && leftovers().join() !== before.join(); attempt++) await Bun.sleep(100)
  expect(leftovers()).toEqual(before)
  const script = launcherScript(managedDir)
  const judge = script.indexOf(`'${managedDir}/run' PreToolUse judge "$$"`)
  const drain = script.indexOf('head -c 4194305')
  const closed = script.indexOf('exec 0</dev/null')
  const bun = script.indexOf('hook launcher-verdict <"$call" >"$out"')
  expect(judge).toBeGreaterThan(0)
  expect(drain).toBeGreaterThan(judge)
  expect(closed).toBeGreaterThan(drain)
  expect(bun).toBeGreaterThan(closed)
  // lookup 2+1, judge 25+1 (drain 2+1 and bun 20+1 inside it, the entry deadline of 18 s inside that).
  expect(script).toContain(`"$T" -k 1 25 '${managedDir}/run' PreToolUse judge "$$"`)
  expect(script).toContain('"$T" -k 1 20 ./bun')
  expect(HOOK_DEADLINE_MS).toBe(18_000)
  expect(LAUNCHER_BUDGET_S).toBe(29)
})

test('[fail-closed] a context line with a malformed escape or a raw control character blocks', () => {
  for (const out of [CONTEXT_JSON.replace('main', 'ma\\uZZZZin'), CONTEXT_JSON.replace('main', 'ma\\u00in'), CONTEXT_JSON.replace('main', 'ma\\u12'),
    CONTEXT_JSON.replace('правок', 'правок\\u000'), CONTEXT_JSON.replace('main', 'ma\\u000Ain'), CONTEXT_JSON.replace('main', 'ma\\\\u0041u0041in'),
    CONTEXT_JSON.replace('main', 'ma\tin'), CONTEXT_JSON.replace('main', 'ma\rin'), CONTEXT_JSON.replace('main', 'ma\u0001in'),
    CONTEXT_JSON.replace('main', 'ma\u001fin'), CONTEXT_JSON.replace('main', 'ma\u007fin')]) {
    const result = launch(answers(`ALLOW\n${out}\n`), 'PreToolUse')
    expect({ out, code: result.code, stdout: result.stdout }).toEqual({ out, code: 2, stdout: '' })
    expectBlocked(result)
  }
  // Every escape the bundle writes still passes.
  const good = CONTEXT_JSON.replace('main', 'ma\\u0022\\u005c\\u0009\\u007f\\u001fin')
  expect(launch(answers(`ALLOW\n${good}\n`), 'PreToolUse')).toEqual({ code: 0, signal: null, stdout: `${good}\n`, stderr: '' })
})
