// Hook 11: active briefs. Finds agent-jobs briefs (brief/BRIEF.md + brief/CHECKLIST.md) in the
// repositories under the configured roots and tells the agent where each one stands. Injected at
// SessionStart and on the first prompt of a session that had none; summaries are cached by mtime.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { prune, readState, writeState } from './state.js'
import { record, type HookContext, type HookResult } from './types.js'

// One table row of CHECKLIST.md: ID, brief quote, contract. Cells may hold escaped pipes.
function rows(markdown: string): Array<{ id: string; quote: string; contract: string }> {
  const found: Array<{ id: string; quote: string; contract: string }> = []
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.replace(/\\\|/g, '\u0001').split('|').map(cell => cell.trim().replace(/\u0001/g, '|'))
    const [, id = '', quote = '', contract = ''] = cells
    if (/^[A-Z]\d+i?$/.test(id)) found.push({ id, quote, contract: contract.toLowerCase() })
  }
  return found
}

export function summarize(name: string, checklist: string): string {
  const all = rows(checklist)
  const open = all.find(row => /\blive\b/.test(row.contract) && !/\bdone\b/.test(row.contract))
  const next = open ? `следующая открытая: ${open.id} ${open.quote}` : 'открытых строк нет'
  return `${name} – ${all.length} строк – ${next}`
}

function repositories(ctx: HookContext): string[] {
  const found: string[] = []
  for (const root of ctx.config.briefRoots) {
    const dir = root.replace(/^~(?=\/|$)/, ctx.home)
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const candidate of [dir, ...entries.map(entry => join(dir, entry))]) {
      if (existsSync(join(candidate, 'brief', 'BRIEF.md')) && existsSync(join(candidate, 'brief', 'CHECKLIST.md'))) found.push(candidate)
    }
  }
  return found
}

export function activeBriefs(ctx: HookContext): string | undefined {
  const cache = readState(ctx, 'briefs')
  const lines: string[] = []
  for (const repo of repositories(ctx)) {
    const checklist = join(repo, 'brief', 'CHECKLIST.md')
    const mtime = Math.max(statSync(checklist).mtimeMs, statSync(join(repo, 'brief', 'BRIEF.md')).mtimeMs)
    const cached = record(cache[repo])
    let line = cached.mtime === mtime && typeof cached.line === 'string' ? cached.line : undefined
    if (!line) {
      line = summarize(repo.slice(repo.lastIndexOf('/') + 1), readFileSync(checklist, 'utf8'))
      cache[repo] = { at: ctx.now(), mtime, line }
    }
    lines.push(line)
  }
  writeState(ctx, 'briefs', prune(cache, 100))
  return lines.length ? `Активные брифы, продолжи их:\n${lines.map(line => `- ${line}`).join('\n')}` : undefined
}

// Marks the session as briefed; true when it already was.
function briefed(ctx: HookContext): boolean {
  const sessions = readState(ctx, 'sessions')
  const id = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : 'unknown'
  if (record(sessions[id]).briefed === true) return true
  sessions[id] = { at: ctx.now(), briefed: true }
  writeState(ctx, 'sessions', prune(sessions, 100))
  return false
}

export function briefsAtStart(ctx: HookContext): HookResult {
  briefed(ctx)
  const context = activeBriefs(ctx)
  return context ? { context } : {}
}

export function briefsAtFirstPrompt(ctx: HookContext): HookResult {
  if (briefed(ctx)) return {}
  const context = activeBriefs(ctx)
  return context ? { context } : {}
}
