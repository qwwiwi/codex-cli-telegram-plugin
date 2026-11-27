// SessionStart hooks: 1 remote inbox + tasks + heartbeat, 13 session config sanity.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../../plugin/src/safety/redact.js'
import { rulesetCheck } from './install.js'
import { cwdOf } from './repo.js'
import { maskKnown } from './secrets.js'
import type { HookContext, HookResult } from './types.js'

const clip = (value: string, secrets: string[] = []) => redactSecrets(maskKnown(value.trim(), secrets)).slice(0, 1500)

export async function gbrainInboxHook(ctx: HookContext): Promise<HookResult> {
  if (!ctx.gbrain) throw new Error('gbrain-inbox: remote MCP is not configured')
  const { inbox, tasks, heartbeat } = ctx.config.gbrain.tools
  const parts: string[] = []
  const calls: [string, typeof inbox][] = [['Входящие задачи', inbox], ['Твои задачи', tasks], ['', heartbeat]]
  for (const [label, spec] of calls) {
    try {
      const answer = clip(await ctx.gbrain.call(spec.server, spec.name, spec.arguments), ctx.secrets)
      if (label && answer) parts.push(`${label}:\n${answer}`)
    } catch (error) {
      ctx.log(`gbrain-inbox: ${spec.name} failed: ${(error as Error).message}`)
    }
  }
  return parts.length ? { context: parts.join('\n\n') } : {}
}

// Top-level keys of a TOML file: the lines before the first [table].
function topLevel(toml: string): string {
  const table = toml.search(/^\s*\[/m)
  return table < 0 ? toml : toml.slice(0, table)
}

export async function sessionSanityHook(ctx: HookContext): Promise<HookResult> {
  const problems: string[] = []
  let toml = ''
  try { toml = readFileSync(join(ctx.codexHome, 'config.toml'), 'utf8') } catch { problems.push('нет config.toml в CODEX_HOME') }
  const top = topLevel(toml)
  if (!/^\s*model\s*=\s*"[^"]+"/m.test(top)) problems.push('в config.toml не задан model')
  const approval = /^\s*approval_policy\s*=\s*"([^"]*)"/m.exec(top)?.[1]
  if (approval !== undefined && approval !== 'never') problems.push(`approval_policy = "${approval}", а агент должен работать с approval never`)
  if (!/^\s*multi_agent(?:_v2)?\s*=\s*true/m.test(toml)) problems.push('субагенты выключены: нет multi_agent_v2 = true в [features]')
  // Every configured MCP server the tools use, pinged in parallel so a dead one costs one timeout, not several.
  // Hooks log a skip when remote MCP is unconfigured.
  const gbrain = ctx.gbrain
  if (gbrain) {
    const servers = [...new Set(Object.values(ctx.config.gbrain.tools).map(spec => spec.server))]
    const pinged = await Promise.allSettled(servers.map(server => gbrain.ping(server)))
    const silent = servers.filter((_, index) => pinged[index]?.status === 'rejected')
    if (silent.length) problems.push(`Сервер MCP недоступен: ${silent.join(', ')}`)
  }
  if (!existsSync(join(ctx.codexHome, 'AGENTS.md'))) problems.push('нет ~/.codex/AGENTS.md')
  const ruleset = rulesetCheck(ctx.run, cwdOf(ctx))
  if (ruleset?.status === 'warning') problems.push(ruleset.message)
  if (!problems.length) return {}
  // /doctor is the owner's Telegram command: the agent cannot send it, so it asks the owner to.
  return { context: `Проверка сессии нашла проблемы:\n${problems.map(problem => `- ${problem}`).join('\n')}\nСообщи владельцу, что не так, и попроси: «запусти /doctor» в чате с ботом. /doctor проверит установку, включая хуки Codex, а /doctor fix передаст отчёт тебе на исправление.` }
}
