// The managed launcher's second hardening round: the bundle must end a PreToolUse verdict run with
// an explicit ALLOW line, the launcher checks the raw answer bytes before it reads them into the
// shell, and the whole run has one absolute deadline with no temporary-file call outside it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_DEADLINE_MS, launcherVerdict } from '../../../codex-hooks/src/entry.js'
import { BLOCK_PREFIX, LAUNCHER_BUDGET_S, launcherScript } from '../../../codex-hooks/src/install.js'
import { BRIDGE_UID_FILE } from '../../../codex-hooks/src/scope.js'

const myUid = process.getuid?.() ?? 1000

let root = ''
let managedDir = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-hooks-hardening2-'))
  managedDir = join(root, 'etc-codex', 'hooks')
  mkdirSync(managedDir, { recursive: true })
  chmodSync(join(root, 'etc-codex'), 0o755)
  chmodSync(managedDir, 0o755)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function fixture(bun: string, options: { timeoutS?: number; judgeTimeoutS?: number } = {}): string {
  writeFileSync(join(managedDir, BRIDGE_UID_FILE), `${myUid}\n`)
  chmodSync(join(managedDir, BRIDGE_UID_FILE), 0o644)
  writeFileSync(join(managedDir, 'bun'), bun)
  chmodSync(join(managedDir, 'bun'), 0o755)
  const launcher = join(managedDir, 'run')
  writeFileSync(launcher, launcherScript(managedDir, { trustedOwnerUid: myUid, ...options }))
  chmodSync(launcher, 0o755)
  return launcher
}

const launch = (launcher: string) => {
  const child = Bun.spawnSync([launcher, 'PreToolUse'], { cwd: root, stdin: Buffer.from('{}'), stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', HOME: root } })
  return { code: child.exitCode, signal: child.signalCode ?? null, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
// A fake bun that prints `out` (printf %b: \NNN is an octal byte, so \000 is a raw NUL) and exits 0.
const answers = (out: string) => fixture(`#!/bin/sh\nprintf '%b' ${quoted(out)}\nexit 0\n`)
const CONTEXT = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"ветка main"}}'

const expectBlocked = (out: string) => {
  const result = launch(answers(out))
  expect({ out, code: result.code, signal: result.signal, stdout: result.stdout }).toEqual({ out, code: 2, signal: null, stdout: '' })
  expect(result.stderr).toStartWith(BLOCK_PREFIX)
  expect(result.stderr.slice(BLOCK_PREFIX.length)).toMatch(/^\S.*\n$/)
}

test('[hardening2] a bundle that exits 0 without the ALLOW line is blocked', () => {
  // No verdict at all, and the allow shapes of the old contract.
  for (const out of ['', '{}', '{}\\n', `${CONTEXT}\\n`, '\\n', 'allow\\n', 'ALLOWED\\n', ' ALLOW\\n', 'ALLOW \\n', '{}\\nALLOW\\n']) expectBlocked(out)
})

test('[hardening2] a raw NUL or control byte anywhere in the answer is blocked, with or without a line break', () => {
  for (const out of ['{}\\000', 'ALLOW\\000', 'ALLOW\\000\\n', '\\000ALLOW\\n', 'ALL\\000OW\\n', 'ALLOW\\n\\000', 'ALLOW\\n{}\\000', 'ALLOW\\n{}\\000\\n',
    'ALLOW\\n{\\000}\\n', `ALLOW\\n${CONTEXT}\\000\\n`, `ALLOW\\n${CONTEXT.replace('main', 'ma\\000in')}\\n`, 'ALLOW\\r\\n', 'ALLOW\\n{}\\r\\n', 'ALLOW\\033\\n',
    'ALLOW\\n{}\\177\\n', 'ALLOW\\t\\n']) expectBlocked(out)
})

test('[hardening2] the answer is whole lines: a missing or doubled line break, or a third line, is blocked', () => {
  for (const out of ['ALLOW', 'ALLOW\\n\\n', 'ALLOW\\n{}', 'ALLOW\\n{}\\n\\n', `ALLOW\\n${CONTEXT}`, 'ALLOW\\n{}\\n{}\\n', `ALLOW\\n{}\\n${CONTEXT}\\n`, 'ALLOW\\nALLOW\\n',
    'ALLOW\\n\\n{}\\n', 'ALLOW\\n{} \\n', 'ALLOW\\n {}\\n', 'ALLOW\\nnull\\n']) expectBlocked(out)
})

test('[hardening2] ALLOW alone, ALLOW with {} and ALLOW with the context line pass with exit 0', () => {
  expect(launch(answers('ALLOW\\n'))).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })
  expect(launch(answers('ALLOW\\n{}\\n'))).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
  expect(launch(answers(`ALLOW\\n${CONTEXT}\\n`))).toEqual({ code: 0, signal: null, stdout: `${CONTEXT}\n`, stderr: '' })
})

test('[hardening2] the bundle in verdict mode states every allow, a no-op for another user included', () => {
  // runMain answers a verified other user with an empty stdout and exit 0.
  expect(launcherVerdict({ stdout: '', code: 0 })).toEqual({ stdout: 'ALLOW', code: 0 })
  expect(launcherVerdict({ stdout: '{}', code: 0 })).toEqual({ stdout: 'ALLOW\n{}', code: 0 })
  expect(launcherVerdict({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } }), code: 0 }))
    .toEqual({ stdout: `ALLOW\n${CONTEXT.replace('ветка main', 'c')}`, code: 0 })
  // An empty stdout of a failed run is no allow.
  expect(launcherVerdict({ stdout: '', code: 1 }).code).toBe(3)
})

test('[hardening2] the real entry in verdict mode prints ALLOW first for an allowed call', () => {
  const main = join(import.meta.dir, '..', '..', '..', 'codex-hooks', 'src', 'main.ts')
  const call = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', cwd: root, tool_name: 'shell', tool_input: { command: 'ls' }, tool_use_id: 'u' })
  const child = Bun.spawnSync([process.execPath, main, 'PreToolUse', 'launcher-verdict'], { cwd: root, stdin: Buffer.from(call), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOOKS_MANAGED_DIR: managedDir } })
  expect({ code: child.exitCode, stdout: child.stdout.toString() }).toEqual({ code: 0, stdout: 'ALLOW\n{}\n' })
}, 30_000)

const OUTER_START = 'if [ "$stage" != judge ]; then\n'
const outerEnd = (script: string) => script.indexOf('\nfi\n', script.indexOf(OUTER_START))

// The launcher text of the process Codex waits for: everything up to the end of its own block.
function outerPart(script: string): string[] {
  expect(script.indexOf(OUTER_START)).toBeGreaterThan(0)
  expect(outerEnd(script)).toBeGreaterThan(script.indexOf(OUTER_START))
  // The script of a timed `sh -c` child spans several lines: it runs inside the child, not here.
  return script.slice(0, outerEnd(script)).replace(/("\$T" -k \d+ \d+ \/bin\/sh -c )'[^']*'/g, '$1SCRIPT').split('\n')
}
const timed = (line: string) => line.trim().startsWith('"$T" -k ')
const detached = (line: string) => / <\/dev\/null >\/dev\/null 2>&1 &$/.test(line)

test('[hardening2] the outer launcher makes no blocking temporary-file call: only timed children and a detached cleanup', () => {
  const script = launcherScript(managedDir)
  const own = outerPart(script).filter(line => !timed(line) && !detached(line))
  expect(own.length).toBeGreaterThan(10)
  for (const line of own) {
    expect(line).not.toMatch(/\b(?:mktemp|wc|rm|cat|head|find|sed|tr|od)\b/)
    expect(line).not.toMatch(/\/tmp|[<>]\s*"\$/)
  }
  // The one cleanup of the outer launcher is detached with its stdio closed.
  const cleanups = outerPart(script).filter(line => /\brm\b/.test(line) && !timed(line))
  expect(cleanups.map(line => line.trim())).toEqual(['rm -rf /tmp/codex-hooks."$$".* </dev/null >/dev/null 2>&1 &'])
  // Every temporary file is made by the judge, in one directory named after the outer launcher.
  expect(script.match(/mktemp/g)?.length).toBe(1)
  expect(script.indexOf('mktemp -d "/tmp/codex-hooks.$owner.XXXXXXXXXX"')).toBeGreaterThan(outerEnd(script))
  // The judge never waits for a cleanup either: no rm of its own and no EXIT trap anywhere.
  expect(script).not.toContain('trap ')
  expect(script.slice(outerEnd(script))).not.toMatch(/\brm\b/)
})

test('[hardening2] one absolute deadline: lookup and the judge are the whole budget, and the judge holds the drain and bun', () => {
  const script = launcherScript(managedDir)
  expect(script).toContain(`"$T" -k 1 25 '${managedDir}/run' PreToolUse judge "$$"`)
  expect(script).toMatch(/"\$T" -k 1 2 \/bin\/sh -c '[^']*find/)
  // lookup 2 + 1 and the judge 25 + 1; inside the judge the drain 2 + 1 and bun 20 + 1 (the entry's 18 s inside that).
  expect(LAUNCHER_BUDGET_S).toBe(2 + 1 + 25 + 1)
  expect(LAUNCHER_BUDGET_S).toBeLessThan(30)
  const judge = script.slice(outerEnd(script))
  expect(judge).toContain(`"$T" -k 1 2 /bin/sh -c 'head -c 4194305 && cat >/dev/null' >"$call"`)
  expect(judge).toContain('"$T" -k 1 20 ./bun')
  expect(2 + 1 + 20 + 1).toBeLessThan(25)
  expect(HOOK_DEADLINE_MS).toBe(18_000)
  // The outer launcher starts exactly two timed children: the lookup and the judge.
  expect(outerPart(script).filter(timed).length).toBe(2)
})

const leftovers = () => readdirSync('/tmp').filter(name => name.startsWith('codex-hooks.')).sort()
async function settled(before: string[]): Promise<string[]> {
  for (let attempt = 0; attempt < 50 && leftovers().join() !== before.join(); attempt++) await Bun.sleep(100)
  return leftovers()
}

test('[hardening2] the temporary directory is removed after an allow, a block and a judge that timed out', async () => {
  const before = leftovers()
  expect(launch(answers('ALLOW\\n{}\\n')).code).toBe(0)
  expect(launch(answers('nonsense')).code).toBe(2)
  expect(launch(fixture('#!/bin/sh\necho "нельзя"\nexit 3\n')).code).toBe(2)
  const started = Date.now()
  const timedOut = launch(fixture('#!/bin/sh\ntrap "" TERM\nsleep 6\n', { timeoutS: 30, judgeTimeoutS: 1 }))
  expect(timedOut.code).toBe(2)
  expect(timedOut.stderr).toContain('не ответил')
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(await settled(before)).toEqual(before)
}, 30_000)
