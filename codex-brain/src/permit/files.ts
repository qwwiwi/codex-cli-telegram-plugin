// Shared helpers for the one-JSON-file-per-record stores of this directory.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { z } from 'zod'

/** Parses one JSON file with `schema`; null when it is missing, unreadable or invalid. */
export function readJsonFile<S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? (parsed.data as z.infer<S>) : null
  } catch {
    return null
  }
}

/** Every valid record of `dir` (`*.json`, temp files skipped), in file name order. */
export function readJsonDir<S extends z.ZodTypeAny>(dir: string, schema: S): Array<z.infer<S>> {
  if (!existsSync(dir)) return []
  const records: Array<z.infer<S>> = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const record = readJsonFile(join(dir, name), schema)
    if (record !== null) records.push(record)
  }
  return records
}

export const compareBy = <T>(key: (item: T) => string) => (a: T, b: T): number => {
  const x = key(a)
  const y = key(b)
  return x < y ? -1 : x > y ? 1 : 0
}
