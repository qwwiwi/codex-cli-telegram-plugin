// Masking for everything the pack stores or sends: exact values of configured secrets first (they
// may have no recognisable shape), then the bridge redactor's token shapes.
import { redactSecrets } from '../../plugin/src/safety/redact.js'
import type { HookContext } from './types.js'

// Shorter values would mask ordinary words.
const MIN_SECRET = 8

export function maskKnown(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of [...secrets].filter(item => item.length >= MIN_SECRET).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[REDACTED]')
  }
  return out
}

export function scrub(ctx: Pick<HookContext, 'secrets'>, value: string): string {
  return redactSecrets(maskKnown(value, ctx.secrets ?? []))
}

// Values of environment variables that look like secrets (names with TOKEN, KEY, SECRET, PASS,
// BEARER), plus any extra known value such as the MCP credential read from its file.
export function knownSecrets(env: Record<string, string | undefined>, extra: Array<string | undefined>): string[] {
  const values = Object.entries(env)
    .filter(([name, value]) => /TOKEN|KEY|SECRET|PASS|BEARER/i.test(name) && typeof value === 'string')
    .map(([, value]) => value as string)
  return [...new Set([...values, ...extra.filter((item): item is string => Boolean(item))])].filter(item => item.length >= MIN_SECRET)
}
