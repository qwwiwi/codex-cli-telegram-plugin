// Runs the enabled hooks of one event and renders their results as the Codex hook output JSON.
// Output shapes follow the schemas embedded in Codex CLI 0.172.0 (see codex-hooks/README.md):
// PreToolUse deny = hookSpecificOutput.permissionDecision "deny" + permissionDecisionReason;
// context = hookSpecificOutput.additionalContext; Stop continuation = decision "block" + reason.
import { GBRAIN_HOOKS, type HookId } from './config.js'
import type { BrainHookResult } from './brain.js'
import { briefsAtFirstPrompt, briefsAtStart } from './briefs.js'
import { activityLogHook, appendActivity, recordTurn, secretWarningHook } from './post.js'
import { gitGateHook, mainBranchEditHook, repoBaselineHook, safetyHook } from './pre.js'
import { correctionHook, recallHook, subagentNudgeHook } from './prompt.js'
import { scrub } from './secrets.js'
import { gbrainInboxHook, sessionSanityHook } from './session.js'
import { readTurn, updateTurn } from './state.js'
import { dirtyRepoHook, doneEvidenceHook, hangingPrsHook, turnSummaryHook } from './stop.js'
import type { HookContext, HookEvent, HookResult, Json } from './types.js'

type Hook = (ctx: HookContext, brainCorrection?: boolean) => HookResult | Promise<HookResult>
// `id` undefined: internal bookkeeping that always runs. `closed`: an exception denies the call.
interface Step { id: HookId | undefined; hook: Hook; closed?: boolean }

const PLAN: Record<HookEvent, Step[]> = {
  SessionStart: [
    { id: 'session-sanity', hook: sessionSanityHook },
    { id: 'gbrain-inbox', hook: gbrainInboxHook },
    { id: 'active-briefs', hook: briefsAtStart },
  ],
  UserPromptSubmit: [
    { id: 'active-briefs', hook: briefsAtFirstPrompt },
    { id: 'correction', hook: correctionHook },
    { id: 'recall', hook: recallHook },
    { id: 'subagent-nudge', hook: subagentNudgeHook },
  ],
  PreToolUse: [
    { id: 'safety', hook: safetyHook, closed: true },
    { id: 'git-gate', hook: gitGateHook, closed: true },
    { id: 'main-branch-edit', hook: mainBranchEditHook },
    { id: 'dirty-repo', hook: repoBaselineHook },
  ],
  PostToolUse: [
    { id: undefined, hook: recordTurn },
    { id: 'secret-warning', hook: secretWarningHook },
    { id: 'activity-log', hook: activityLogHook },
  ],
  Stop: [
    { id: 'hanging-prs', hook: hangingPrsHook },
    { id: 'done-evidence', hook: doneEvidenceHook },
    { id: 'dirty-repo', hook: dirtyRepoHook },
  ],
  PreCompact: [],
}

// Another user of the host-wide managed pack: the destructive-command and snapshot guard only. The
// bridge workflow guards (git gate, main-branch reminder, repo baseline) are not theirs.
const SAFETY_ONLY: Step[] = [{ id: 'safety', hook: safetyHook, closed: true }]

// Contexts that already logged the remote MCP skip: one line per hook process, not one per hook.
const gbrainSkipLogged = new WeakSet<HookContext>()

async function runSteps(ctx: HookContext, steps: Step[], brainCorrection?: boolean): Promise<HookResult[]> {
  const results: HookResult[] = []
  for (const step of steps) {
    if (step.id && !ctx.config.enabled[step.id]) continue
    if (step.id && GBRAIN_HOOKS.includes(step.id) && !ctx.gbrain) {
      if (!gbrainSkipLogged.has(ctx)) ctx.log(`MCP hooks skipped: ${ctx.gbrainOff ?? 'remote MCP is not configured'}`)
      gbrainSkipLogged.add(ctx)
      continue
    }
    try {
      results.push(await step.hook(ctx, brainCorrection))
    } catch (error) {
      const message = scrub(ctx, error instanceof Error ? error.message : String(error))
      ctx.log(`${step.id ?? 'record'}: ${message}`)
      if (step.closed) {
        results.push({ deny: `Заблокировано: сбой проверки безопасности (${step.id}): ${message}` })
      }
    }
  }
  return results
}

async function runBrain(ctx: HookContext, phase?: 'before' | 'final'): Promise<BrainHookResult | undefined> {
  try {
    // Load the memory stack only from the non-guard events that use it.
    const { runBrainStep } = await import('./brain.js')
    return await runBrainStep(ctx, phase)
  } catch (error) {
    const message = scrub(ctx, error instanceof Error ? error.message : String(error)).replace(/[\r\n\u2028\u2029]+/g, ' ')
    ctx.log(`Brain ${ctx.event}: ${message}`)
    return undefined
  }
}

function join(results: HookResult[], key: keyof HookResult): string | undefined {
  const parts = results.map(result => result[key]).filter((part): part is string => Boolean(part))
  return parts.length ? parts.join('\n\n') : undefined
}

export async function dispatch(ctx: HookContext): Promise<Json> {
  const event = ctx.event
  if (ctx.safetyOnly) {
    if (event !== 'PreToolUse') return {}
    const deny = join(await runSteps(ctx, SAFETY_ONLY), 'deny')
    return deny ? { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: deny } } : {}
  }
  if (event === 'Stop') {
    const turn = readTurn(ctx)
    const quiet = ctx.input.stop_hook_active === true || turn.stopReturned
    if (!quiet) {
      // A failed Brain step is logged by runBrain; the other steps of the pack still run.
      const brain = await runBrain(ctx) ?? {}
      const blocks = brain.block || !readTurn(ctx).stopReturned ? await runSteps(ctx, PLAN.Stop) : []
      const reason = join([brain, ...blocks], 'block')
      if (reason) {
        if (!brain.block) updateTurn(ctx, current => { current.stopReturned = true })
        return { decision: 'block', reason }
      }
    }
    await runBrain(ctx, 'final')
    await runSteps(ctx, [{ id: 'turn-summary', hook: turnSummaryHook }])
    return {}
  }
  const brain: BrainHookResult = event === 'SessionStart' || event === 'PreCompact' || event === 'UserPromptSubmit'
    ? await runBrain(ctx) ?? {} : {}
  const results = [brain, ...await runSteps(ctx, PLAN[event], brain.brainCorrection)]
  const deny = event === 'PreToolUse' ? join(results, 'deny') : undefined
  if (deny && ctx.config.enabled['activity-log']) {
    try { appendActivity(ctx, 'denied') } catch (error) { ctx.log(`activity-log: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const context = join(results, 'context')
  if (!deny && !context) return {}
  return {
    hookSpecificOutput: {
      hookEventName: event,
      ...(deny ? { permissionDecision: 'deny', permissionDecisionReason: deny } : {}),
      ...(context ? { additionalContext: context } : {}),
    },
  }
}
