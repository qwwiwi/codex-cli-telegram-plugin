// Fact file format (spec §5.2): a front matter block of `key: value` lines between `---` lines,
// then the Markdown body. Values are written raw (no YAML quoting): every front matter field is
// one line by schema, so the first `: ` of a line separates key and value. The key order is fixed,
// so the same fact always gives the same bytes.

import { type Fact, FactSchema } from '../contract.js'

const KEYS = ['id', 'kind', 'description', 'revision', 'source', 'created', 'updated', 'status', 'owner_message_id'] as const
type Key = (typeof KEYS)[number]

export function serializeFact(fact: Fact): string {
  const valid = FactSchema.parse(fact)
  const lines = ['---']
  for (const key of KEYS) {
    const value = valid[key]
    if (value === undefined) continue
    const text = String(value)
    if (/[\r\n]/.test(text)) throw new Error(`fact field ${key} must be one line`)
    lines.push(`${key}: ${text}`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n${valid.body}`
}

/** Parses a fact file; null when it is not a valid fact. */
export function parseFact(text: string): Fact | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 3)
  if (end < 0) return null
  const fields: Partial<Record<Key, string>> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(': ')
    if (at <= 0) return null
    const key = line.slice(0, at)
    if (!(KEYS as readonly string[]).includes(key) || fields[key as Key] !== undefined) return null
    fields[key as Key] = line.slice(at + 2)
  }
  const revision = fields.revision === undefined || !/^\d{1,9}$/.test(fields.revision) ? Number.NaN : Number(fields.revision)
  const parsed = FactSchema.safeParse({ ...fields, revision, body: text.slice(end + 5) })
  return parsed.success ? parsed.data : null
}
