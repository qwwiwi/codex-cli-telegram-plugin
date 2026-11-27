// PostToolUse: the turn record (always on; Stop hooks read it), 6 secret warning and 7 activity log. Command text is never
// stored: the turn keeps only whether a check ran, the activity log only program names.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findSecretKinds } from '../../plugin/src/safety/redact.js'
import { shellCommand } from './pre.js'
import { cwdOf, toplevelOf } from './repo.js'
import { scrub } from './secrets.js'
import { basename, parseCommand, program, readCommand } from './shell.js'
import { updateTurn } from './state.js'
import { record, type HookContext, type HookResult } from './types.js'

// The exit code of a finished tool call, or undefined when the response does not say.
export function exitCode(response: unknown): number | undefined {
  const value = record(response)
  for (const key of ['exit_code', 'exitCode', 'exit_status']) {
    if (typeof value[key] === 'number') return value[key] as number
  }
  const metadata = record(value.metadata)
  if (typeof metadata.exit_code === 'number') return metadata.exit_code
  const output = typeof response === 'string' ? response : typeof value.output === 'string' ? value.output : ''
  const match = /(?:Process exited with code|Exit code:)\s*(\d+)/.exec(output)
  return match ? Number(match[1]) : undefined
}

function commandDir(ctx: HookContext, command: string): string {
  const parsed = parseCommand(command, cwdOf(ctx), ctx.home)
  return parsed.at(-1)?.cwd ?? cwdOf(ctx)
}

export const EVIDENCE = /\b(?:test|tests|pytest|vitest|jest|check\.sh|tsc|lint|ruff|mypy|manifest-check)\b|\bcargo\s+test\b|\bgo\s+test\b|\bmake\s+check\b/

export function recordTurn(ctx: HookContext): HookResult {
  const command = shellCommand(ctx)
  const dir = command ? commandDir(ctx, command) : cwdOf(ctx)
  const top = toplevelOf(ctx, dir)
  updateTurn(ctx, turn => {
    turn.tools += 1
    if (command && EVIDENCE.test(command)) turn.checked = true
    if (top && !turn.repos.includes(top)) turn.repos.push(top)
  })
  return {}
}

export function secretWarningHook(ctx: HookContext): HookResult {
  const response = ctx.input.tool_response
  const kinds = findSecretKinds(typeof response === 'string' ? response : JSON.stringify(response ?? ''))
  if (!kinds.length) return {}
  return { context: `В выводе инструмента похоже есть секрет (${kinds.join(', ')}). Не повторяй его в ответе, не пересылай в Telegram и не сохраняй в файлы; если нужно сослаться, пиши [REDACTED].` }
}

// The program names of a shell command (no arguments, no text), and whether it parsed.
function programsOf(command: string): { programs: string[]; unparsed?: true } {
  const reading = readCommand(command, '/', '')
  const programs = reading.commands.map(item => basename(program(item.argv)[0] ?? '')).filter(Boolean)
  return reading.unparsed ? { programs, unparsed: true } : { programs }
}

// One activity line: tool metadata, program names, verdict and exit code. Never the command text,
// the tool input values or the output.
export function appendActivity(ctx: HookContext, verdict: 'ran' | 'denied'): void {
  const command = shellCommand(ctx)
  const input = record(ctx.input.tool_input)
  const entry = {
    at: new Date(ctx.now()).toISOString(),
    session: ctx.input.session_id,
    turn: ctx.input.turn_id,
    tool: ctx.input.tool_name,
    cwd: ctx.input.cwd,
    ...(command ? programsOf(command) : { input: Object.keys(input) }),
    verdict,
    exit: verdict === 'ran' ? exitCode(ctx.input.tool_response) : undefined,
  }
  // Program names, cwd and ids are free text too: every string field is scrubbed.
  const line = JSON.stringify(entry, (_key, value: unknown) => typeof value === 'string' ? scrub(ctx, value) : value) + '\n'
  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 })
  const file = join(ctx.stateDir, 'activity.jsonl')
  let size = 0
  try { size = statSync(file).size } catch { /* first line */ }
  if (size > 0 && size + Buffer.byteLength(line) > ctx.config.activityMaxBytes) renameSync(file, `${file}.1`)
  appendFileSync(file, line, { mode: 0o600 })
}

export function activityLogHook(ctx: HookContext): HookResult {
  appendActivity(ctx, 'ran')
  return {}
}
