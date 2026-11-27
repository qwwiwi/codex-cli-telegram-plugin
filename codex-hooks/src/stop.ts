// Stop hooks: 8 hanging PRs, 9 done without evidence, 14b uncommitted or unpushed work, 10 turn
// summary. dispatch.ts returns at most one block per turn and none while stop_hook_active is set.
import { sha256 } from './pre.js'
import { gitOut } from './repo.js'
import { scrub } from './secrets.js'
import { readState, readTurn, writeState } from './state.js'
import { record, text, type HookContext, type HookResult } from './types.js'

export async function hangingPrsHook(ctx: HookContext): Promise<HookResult> {
  const window = ctx.config.prAgeHours * 3_600_000
  const state = readState(ctx, 'prs')
  if (typeof state.lastReminder === 'number' && ctx.now() - state.lastReminder < window) return {}
  const result = ctx.run(['gh', 'search', 'prs', '--author', '@me', '--state', 'open',
    '--json', 'number,title,url,createdAt', '--limit', '30'], { timeoutMs: 8000 })
  if (result.code !== 0) throw new Error(`hanging-prs: gh exit ${result.code}`)
  const parsed: unknown = JSON.parse(result.stdout || '[]')
  const old = (Array.isArray(parsed) ? parsed : []).map(record)
    .filter(pr => ctx.now() - Date.parse(text(pr.createdAt)) > window)
  if (!old.length) return {}
  writeState(ctx, 'prs', { lastReminder: ctx.now() })
  const list = old.slice(0, 5).map(pr => `- ${text(pr.url)} ${text(pr.title)}`).join('\n')
  return { block: `У тебя открыты PR старше ${ctx.config.prAgeHours} ч:\n${list}\nДоведи их: запусти bun codex-hooks/src/main.ts check <sha> на голове PR, смёрджи после зелёного статуса codex-hooks/check или напиши владельцу, что мешает.` }
}

const CLAIM = /(?<!\p{L})(?:готово|сделано|сделала?|выполнено|исправлено|исправила?|done|fixed|completed)(?!\p{L})/iu

export function doneEvidenceHook(ctx: HookContext): HookResult {
  if (!CLAIM.test(text(ctx.input.last_assistant_message))) return {}
  const turn = readTurn(ctx)
  if (turn.tools === 0 || turn.checked) return {}
  return { block: 'Ты пишешь, что готово, но в этом ходе не запускалась ни одна проверка. Запусти тесты или scripts/check.sh и приложи вывод как доказательство; если проверить нельзя, прямо так и напиши владельцу.' }
}

export function dirtyRepoHook(ctx: HookContext): HookResult {
  const notes: string[] = []
  const turn = readTurn(ctx)
  for (const repo of turn.repos) {
    // Untracked files (build output, local symlinks) are not unfinished work; changes that were
    // already there, unchanged, when the turn first touched the repo are not this turn's work.
    const status = gitOut(ctx, repo, ['status', '--porcelain', '--untracked-files=no'])
    if (status && turn.baseline[repo] !== sha256(status)) { notes.push(`${repo}: незакоммиченные изменения`); continue }
    // A branch that was never pushed has no upstream: compare with the remote default branch.
    const ahead = Number(gitOut(ctx, repo, ['rev-list', '--count', '@{u}..HEAD'])
      ?? gitOut(ctx, repo, ['rev-list', '--count', 'origin/HEAD..HEAD']) ?? '0')
    if (ahead > 0) notes.push(`${repo}: ${ahead} незапушенных коммитов`)
  }
  if (!notes.length) return {}
  return { block: `Работа не доведена:\n${notes.map(note => `- ${note}`).join('\n')}\nЗакоммить, запушь ветку и открой PR (или объясни владельцу, почему нет).` }
}

export async function turnSummaryHook(ctx: HookContext): Promise<HookResult> {
  if (!ctx.gbrain) throw new Error('turn-summary: remote MCP is not configured')
  const turn = readTurn(ctx)
  const message = scrub(ctx, text(ctx.input.last_assistant_message)).slice(0, 500)
  const spec = ctx.config.gbrain.tools.turnSummary
  // agent_heartbeat carries free text only in its optional `note`.
  await ctx.gbrain.call(spec.server, spec.name, { ...spec.arguments, note: `${message}\n(инструментов за ход: ${turn.tools})` })
  return {}
}
