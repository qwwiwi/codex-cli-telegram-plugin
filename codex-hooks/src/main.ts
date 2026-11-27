#!/usr/bin/env bun
// Entry point Codex runs for every hook event: `bun codex-hooks/src/main.ts <Event>`.
// Reads the hook input JSON on stdin and prints the output JSON on stdout. Fails closed: any crash
// or deadline overrun of a PreToolUse run prints a deny, the reason on stderr and exits 2; every
// other event fails open (exit 0).
// The managed launcher runs `<bundle> PreToolUse launcher-verdict` instead: a deny is then exit 3
// with the bare reason on stdout and no JSON, an allow is exit 0 with the line ALLOW first (the
// contract in scope.ts); the launcher answers Codex.
// The process runner lives only here, so the tests (which drive entry.ts) never spawn programs.
import { launcherVerdict, runMain } from './entry.js'
import { VERDICT_ARG } from './scope.js'
import type { Runner } from './types.js'

const run: Runner = (argv, options) => {
  const result = Bun.spawnSync([...argv], {
    ...(options.cwd ? { cwd: options.cwd } : {}), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: options.timeoutMs,
  })
  return { code: result.exitCode, stdout: result.stdout.toString() }
}

const event = process.argv[2]
if (event === 'check') {
  // codex-hooks check <sha>: scripts/check.sh in a clean worktree at the sha, then a GitHub status.
  const { runCheck } = await import('./check.js')
  const { tmpdir } = await import('node:os')
  const checkRun: Runner = (argv, options) => {
    const result = Bun.spawnSync([...argv], {
      ...(options.cwd ? { cwd: options.cwd } : {}), stdin: 'inherit', stdout: argv[0] === 'gh' || argv[0] === 'git' ? 'pipe' : 'inherit', stderr: 'inherit', timeout: options.timeoutMs,
    })
    return { code: result.exitCode, stdout: result.stdout?.toString() ?? '' }
  }
  try {
    const result = runCheck(process.cwd(), process.argv[3] ?? '', { run: checkRun, tmp: tmpdir(), log: line => console.error(line) })
    console.log(`codex-hooks check: ${result.state} on ${result.sha} (status codex-hooks/check posted)`)
    process.exit(result.state === 'success' ? 0 : 1)
  } catch (error) {
    console.error(`codex-hooks check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
// stdin is read inside runMain, so a PreToolUse deadline also covers a caller that never closes it.
const readStdin = () => Bun.stdin.text().catch((error: unknown) => {
  throw new Error(`хук не смог прочитать вызов инструмента: ${error instanceof Error ? error.message : String(error)}`)
})
const answer = await runMain(event, readStdin, process.env, run)
const result = event === 'PreToolUse' && process.argv[3] === VERDICT_ARG ? launcherVerdict(answer) : answer
// An empty answer (another user's event) prints nothing at all. A PreToolUse process exits as
// soon as the answer is written: work still pending after its deadline must not hold it until
// Codex kills it. Other events have no deadline and end on their own once their work is done.
const write = (stream: NodeJS.WriteStream, text: string) => new Promise<void>(resolve => { stream.write(`${text}\n`, () => resolve()) })
if (result.stdout) await write(process.stdout, result.stdout)
if (result.stderr) await write(process.stderr, result.stderr)
if (event === 'PreToolUse') process.exit(result.code)
process.exitCode = result.code
