// Small JSON files under the state directory (default ~/.local/state/krotov-plugin/codex-hooks). Each hook process
// is short-lived, so everything a later hook needs (whether the turn ran a check, which
// reminders already fired) lives here. Writes go through a temp file and a rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { record, type HookContext, type Json } from './types.js'

export function readState(ctx: HookContext, name: string): Json {
  try {
    return record(JSON.parse(readFileSync(join(ctx.stateDir, `${name}.json`), 'utf8')))
  } catch {
    return {}
  }
}

export function writeState(ctx: HookContext, name: string, value: Json): void {
  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 })
  const file = join(ctx.stateDir, `${name}.json`)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, file)
}

// Keeps the newest `limit` keys of an object whose values carry a numeric `at`.
export function prune(entries: Json, limit: number): Json {
  const sorted = Object.entries(entries).sort(([, a], [, b]) => Number(record(b).at ?? 0) - Number(record(a).at ?? 0))
  return Object.fromEntries(sorted.slice(0, limit))
}

export interface Turn {
  at: number
  // True once a test, type check or check.sh ran this turn (the command text is not stored).
  checked: boolean
  repos: string[]
  tools: number
  stopReturned: boolean
  editReminded: string[]
  // Repository -> sha256 of its uncommitted changes when the turn first touched it ('' unknown).
  baseline: Record<string, string>
}

export function turnKey(ctx: HookContext): string {
  const id = ctx.input.turn_id ?? ctx.input.session_id
  return typeof id === 'string' && id ? id : 'unknown'
}

export function readTurn(ctx: HookContext): Turn {
  const turn = record(readState(ctx, 'turns')[turnKey(ctx)])
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    at: typeof turn.at === 'number' ? turn.at : ctx.now(),
    checked: turn.checked === true,
    repos: strings(turn.repos),
    tools: typeof turn.tools === 'number' ? turn.tools : 0,
    stopReturned: turn.stopReturned === true,
    editReminded: strings(turn.editReminded),
    baseline: Object.fromEntries(Object.entries(record(turn.baseline)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  }
}

export function updateTurn(ctx: HookContext, change: (turn: Turn) => void): void {
  const turns = readState(ctx, 'turns')
  const turn = readTurn(ctx)
  change(turn)
  turn.at = ctx.now()
  turns[turnKey(ctx)] = turn
  writeState(ctx, 'turns', prune(turns, 50))
}
