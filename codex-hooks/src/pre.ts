// PreToolUse hooks: 4 safety (+ its snapshots), 5 git gate, 14a editing on
// main, and the turn's repository baseline for the Stop dirty-repo hook.
import { createHash } from 'node:crypto'
import { gitGate } from './git-gate.js'
import { branchOf, cwdOf, gitRaw, safetyView, toplevelOf } from './repo.js'
import { assess, assessPatch, type Assessment } from './safety.js'
import { DEFAULT_LIMITS, SnapshotRefused, takeSnapshots } from './snapshot.js'
import { commandOf, normalizePath, parseCommand, resolveDir, SHELL_TOOLS } from './shell.js'
import { readTurn, updateTurn } from './state.js'
import { record, type HookContext, type HookResult } from './types.js'

export function shellCommand(ctx: HookContext): string | undefined {
  const tool = ctx.input.tool_name
  return typeof tool === 'string' && SHELL_TOOLS.has(tool) ? commandOf(tool, ctx.input.tool_input) : undefined
}

// The patch text in the tool_input of an apply_patch tool call (freeform string or a field).
export function patchText(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  const fields = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const value = fields.input ?? fields.patch ?? fields.command
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => typeof part === 'string').join('\n') : undefined
}

// The patch text of an apply_patch call (its own tool, or `apply_patch '<patch>'` through a shell).
function patchOf(ctx: HookContext, command: string | undefined): string | undefined {
  if (command && /^\s*apply_patch\b/.test(command)) return command
  if (ctx.input.tool_name !== 'apply_patch') return
  return patchText(ctx.input.tool_input)
}

const merge = (first: Assessment, second: Assessment): Assessment => {
  const deny = first.deny ?? second.deny
  return deny ? { deny, plans: [] } : { plans: [...first.plans, ...second.plans] }
}

const compact =(ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

// The guard's decision, then the snapshots it planned: a snapshot that fails is a deny.
export function safetyHook(ctx: HookContext): HookResult {
  const command = shellCommand(ctx)
  const patch = patchOf(ctx, command)
  // An apply_patch whose patch cannot be read cannot be judged.
  if (ctx.input.tool_name === 'apply_patch' && !patch?.trim()) return { deny: 'Заблокировано: хук не смог прочитать патч apply_patch.' }
  if (!command && patch === undefined) return {}
  const view = safetyView(ctx)
  const workdir = record(ctx.input.tool_input).workdir
  if (command && typeof workdir === 'string' && workdir) view.cwd = resolveDir(workdir, view.cwd, ctx.home)
  // A shell call starting with apply_patch is a patch and a shell line: both are checked.
  const verdict: Assessment = patch === undefined ? assess(command ?? '', view) : merge(assessPatch(patch, view), command ? assess(command, view) : { plans: [] })
  if (verdict.deny) return { deny: verdict.deny }
  if (!verdict.plans.length) return {}
  const id = String(ctx.input.tool_use_id ?? ctx.input.call_id ?? sha256(`${ctx.now()}${command ?? patch}`).slice(0, 12)).replace(/[^\w-]/g, '_').slice(0, 64)
  const stamp = `${compact(ctx.now())}-${id}`
  const trash = `${normalizePath(ctx.home)}/.trash`
  const env = { dir: `${trash}/${stamp}`, stamp, run: ctx.run, limits: ctx.snapshotLimits ?? DEFAULT_LIMITS }
  for (const plan of verdict.plans) {
    try {
      takeSnapshots([plan], env)
    } catch (error) {
      const what = 'path' in plan ? plan.path : plan.dir
      const why = error instanceof SnapshotRefused ? error.message : 'снимок не удалось сделать или проверить'
      ctx.log(`safety: snapshot of ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
      const hint = 'path' in plan ? ` Перенеси в корзину сам: mkdir -p ${trash}/${stamp} && mv ${plan.path} ${trash}/${stamp}/, потом повтори.` : ' Сохрани работу сам (git stash push -u или ветка), потом повтори.'
      return { deny: `Заблокировано защитой: перед удалением хук делает снимок, а для ${what} его сделать нельзя (${why}).${hint}` }
    }
  }
  return {}
}

export function gitGateHook(ctx: HookContext): HookResult {
  const command = shellCommand(ctx)
  return command ? gitGate(command, { cwd: cwdOf(ctx), home: ctx.home }) : {}
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// The key that ties a PreToolUse to its PostToolUse: the tool call id, else the turn and command.
export function callKey(ctx: HookContext, command: string): string {
  const id = ctx.input.tool_use_id ?? ctx.input.call_id
  return typeof id === 'string' && id ? `id:${id}` : `cmd:${sha256(`${String(ctx.input.turn_id ?? ctx.input.session_id)}\n${cwdOf(ctx)}\n${command}`)}`
}

// The first time a turn touches a repository: remember a hash of its uncommitted changes, so Stop
// does not send the agent back for dirt that was there before the turn.
export function repoBaselineHook(ctx: HookContext): HookResult {
  const command = shellCommand(ctx)
  const dir = command ? parseCommand(command, cwdOf(ctx), ctx.home).at(-1)?.cwd ?? cwdOf(ctx) : cwdOf(ctx)
  const top = toplevelOf(ctx, dir)
  if (!top || readTurn(ctx).baseline[top] !== undefined) return {}
  const status = gitRaw(ctx, top, ['status', '--porcelain', '--untracked-files=no'])
  updateTurn(ctx, turn => { turn.baseline[top] = status === undefined ? '' : sha256(status) })
  return {}
}

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit'])
const SHELL_EDIT = /\bsed\s+-i\b|\bgit\s+commit\b|\btee\b|(?:^|[^0-9&>])>{1,2}\s*(?!\/dev\/)[\w.~/-]/

export function mainBranchEditHook(ctx: HookContext): HookResult {
  const tool = ctx.input.tool_name
  const command = shellCommand(ctx)
  if (!(typeof tool === 'string' && EDIT_TOOLS.has(tool)) && !(command && SHELL_EDIT.test(command))) return {}
  const top = toplevelOf(ctx, cwdOf(ctx))
  if (!top) return {}
  const branch = branchOf(ctx, top)
  if (branch !== 'main' && branch !== 'master') return {}
  if (readTurn(ctx).editReminded.includes(top)) return {}
  updateTurn(ctx, turn => { turn.editReminded.push(top) })
  return { context: `Ты правишь файлы в ${top} прямо на ветке ${branch}. Сначала создай ветку (git switch -c feature/… или fix/…), правь там и открой PR: в main не пушим.` }
}
