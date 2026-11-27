// Small readers for the Brain state files S3 reads directly (snapshot, boundaries, delta, plan,
// questions, note, handoff). Every value is parsed with its contract schema; a missing, torn or
// invalid file reads as absent, never as a guess.

import { existsSync, readFileSync } from 'node:fs'

import type { z } from 'zod'

export function readJson<S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Valid lines of a JSONL file, in file order; torn or invalid lines are skipped. */
export function readJsonLines<S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S>[] {
  if (!existsSync(path)) return []
  const out: z.infer<S>[] = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // A torn line from a crashed append: skip it.
    }
  }
  return out
}

export function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
