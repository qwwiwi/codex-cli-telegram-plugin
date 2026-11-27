// UserPromptSubmit hooks: 2 recall, 3 correction, 12 subagent nudge (11 lives in briefs.ts).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hasMemoryCue } from '../../codex-brain/src/cue.js'
import { scrub } from './secrets.js'
import { text, type HookContext, type HookResult } from './types.js'

const prompt = (ctx: HookContext) => text(ctx.input.prompt).trim()

export async function recallHook(ctx: HookContext): Promise<HookResult> {
  const message = prompt(ctx)
  if (message.length < 12 || message.startsWith('/')) return {}
  if (!ctx.gbrain) throw new Error('recall: remote MCP is not configured')
  const spec = ctx.config.gbrain.tools.recall
  // The owner's message leaves the machine only scrubbed.
  const answer = await ctx.gbrain.call(spec.server, spec.name, { ...spec.arguments, query: recallQuery(ctx, message) })
  const facts = answer.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5)
  if (!facts.length) return {}
  return { context: `Из внешней памяти по сообщению владельца:\n${facts.map(fact => `- ${scrub(ctx, fact).slice(0, 300)}`).join('\n')}` }
}

// The words of a message that may leave the machine as a recall query: known secrets and token
// shapes masked, then every path, link, address, number-carrying or long token-like word dropped.
export function recallQuery(ctx: Pick<HookContext, 'secrets'>, message: string): string {
  return scrub(ctx, message).split(/\s+/)
    .filter(word => word && !/[\d/\\@=]|\[REDACTED\]|:\/\//.test(word) && word.length <= 32)
    .join(' ').slice(0, 500)
}

const CORRECTION = /не\s+надо|так\s+не\s+работает|неправильно|я\s+же\s+просил[аи]?/i

// The cue the bridge uses too (one shared pattern); CORRECTION stays the legacy learning/ trigger.
export { hasMemoryCue }

export function correctionHook(ctx: HookContext, brainCorrection = false): HookResult {
  const message = prompt(ctx)
  const quote = scrub(ctx, message).slice(0, 200)
  if (brainCorrection) {
    if (!hasMemoryCue(message)) return {}
    return { context: `Запрос на сохранение или поправка: «${quote}». Учти её в работе и сохрани правило командой \`brain remember\` до конца хода.` }
  }
  if (!CORRECTION.test(message)) return {}
  // learning/ belongs to the agent's own workspace, never to whatever repository the session is in.
  const dir = ctx.workspace ? join(ctx.workspace, 'learning') : undefined
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const where = dir ? `learning/ (${dir})` : 'learning/ своей рабочей папки (не в репозитории проекта)'
  return { context: `Владелец поправил тебя: «${quote}». Исправь работу и до конца хода запиши урок в ${where}: файл learning/<дата>-<тема>.md с тем, что было не так, правилом на будущее и одной строкой «почему».` }
}

const RESEARCH = /параллельн|изучи|сравни|исследуй|ресёрч|ресерч|проанализируй/i

export function subagentNudgeHook(ctx: HookContext): HookResult {
  const message = prompt(ctx)
  const items = message.split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length
  const questions = (message.match(/\?/g) ?? []).length
  if (!RESEARCH.test(message) && items < 3 && questions < 3) return {}
  return { context: 'Это задача из нескольких частей: раздай независимые части субагентам (multi_agent: spawn_agent, затем wait и close_agent), каждому дай узкую задачу и критерий готовности. В основном контексте держи только план и итоги, результаты субагентов проверь сама.' }
}
