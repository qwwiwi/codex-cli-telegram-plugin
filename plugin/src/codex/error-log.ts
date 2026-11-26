// The bridge's error journal: every warn or error line the bridge logs is also appended as one JSON line to a daily
// file <state dir>/errors-YYYY-MM-DD.jsonl (UTC date), so the owner and the agent can look into problems later.
// Each line holds the time, level, area, message, error name/code/description and the turn, thread and chat message
// IDs. Free text is masked (maskDiagnostic: credential headers, key=value pairs, URL queries, opaque tokens) and
// redacted with the bridge's redactor. Only those fields are kept: no message bodies, payloads or env values.
// Files older than KROT_ERROR_LOG_DAYS days (default 14, at least 7) are deleted; above a total size cap the oldest
// day goes first, never the current one. Errors in the journal itself never reach the bridge.

import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { redactSecrets } from '../safety/redact.js'

const descriptionMax = 300
const messageMax = 300
const idMax = 128
const dayMs = 24 * 60 * 60 * 1000
/** A warn area repeating this many times in 24 hours counts as a /doctor problem. */
export const repeatedWarnLimit = 5
export const defaultErrorLogDays = 14
export const minimumErrorLogDays = 7
export const defaultErrorLogMaxBytes = 50 * 1024 * 1024
const filePattern = /^errors-(\d{4}-\d{2}-\d{2})\.jsonl$/u

/** The journal's file name pattern inside the state directory, for docs and /doctor. */
export const errorJournalPattern = 'errors-YYYY-MM-DD.jsonl'

// Names whose value is a credential when they appear as a header, a key=value pair or a JSON field.
const secretName = String.raw`[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|cookie|session|signature|credential|authorization)[A-Za-z0-9_-]*`
// The only names a credential-looking match keeps its value under, and the value shape that keeps it: token counts
// stay numbers (`max_tokens: 5000`), `session` keeps an upper-case error code (`session: ENOENT`). Only the unquoted
// form keeps it: a quoted value is masked under these names too. Every other credential name is masked whatever its
// value is, numbers and upper-case strings included.
const tokenCount = /^\d+$/u
const diagnosticValues: Readonly<Record<string, RegExp>> = {
  max_tokens: tokenCount, max_output_tokens: tokenCount, max_completion_tokens: tokenCount,
  input_tokens: tokenCount, output_tokens: tokenCount, prompt_tokens: tokenCount, completion_tokens: tokenCount,
  total_tokens: tokenCount, reasoning_tokens: tokenCount, cached_tokens: tokenCount,
  session: /^[A-Z][A-Z_]*$/u,
}
const isDiagnostic = (name: string, value: string): boolean =>
  diagnosticValues[name.toLowerCase().replaceAll('-', '_')]?.test(value) ?? false
// `x-api-key: value`, `password="value"`, `token: 'value'`: a bare value runs to the next separator, a quoted one to
// its closing quote; an auth scheme stays.
const authScheme = String.raw`(?:(?:Bearer|Basic|Token|Digest)\s+)?`
const bareValue = String.raw`[^\s;,&"'{}]+`
const headerValueRe = new RegExp(String.raw`(\b(${secretName})\s*[:=]\s*)(?!${authScheme}\[REDACTED\])` +
  String.raw`(${authScheme})("[^"\n]*"|'[^'\n]*'|${bareValue})`, 'giu')
const maskHeaderValue = (match: string, prefix: string, name: string, scheme: string, value: string): string =>
  isDiagnostic(name, value) ? match : prefix + scheme + '[REDACTED]'
// Headers whose whole value is a credential (every cookie, every Digest parameter): masked up to the next
// `Header: ` or the end of the line.
const wholeHeaderRe = /(\b(?:Set-)?Cookie\s*:\s*|\b(?:Proxy-)?Authorization\s*:\s*Digest\s+)(?!\s*\[REDACTED\])[^\n]*?(?=\s+[A-Za-z][A-Za-z0-9-]*:\s|\n|$)/giu
// `"api_key":"value"`, `'token': 'value'` or `"api_key": 12345` in an echoed JSON body. A quoted value is masked
// under every name, diagnostic names included (`"session": "ABC…"` is a credential); only a bare number under a
// diagnostic name (`"max_tokens": 4096`) stays.
const jsonValueRe = new RegExp(String.raw`(["'](${secretName})["']\s*:\s*)(?:(["'])(?:\\.|(?!\3).)*\3|(-?\d[\d.eE+-]*))`, 'giu')
const maskJsonValue = (match: string, prefix: string, name: string, quote: string | undefined,
  bare: string | undefined): string => bare !== undefined && isDiagnostic(name, bare) ? match
  : prefix + (quote === undefined ? '[REDACTED]' : quote + '[REDACTED]' + quote)
// A Bearer value of any length (the shared redactor only catches 8+ characters); other schemes count only in an
// Authorization header, so prose like "Basic plan" or "Token expired" stays.
const schemeRe = /\b(Bearer)\s+(?!\[REDACTED\])[^\s;,"']+/giu
// Everything after `?` or `#` in a URL: query strings carry signed parameters under any name.
const urlQueryRe = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/giu
// A long opaque run (24+ characters mixing letters and digits) with a hyphen-free stretch of 16+ characters is a
// token; UUIDs and dated model names (`claude-sonnet-4-5-20250929`) are short segments and stay readable.
const opaqueRe = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/gu
const maskOpaque = (run: string): string => run.split('-').some(part => part.length >= 16) ? '[REDACTED]' : run

/**
 * Masks what a provider may echo back in an error before it is journaled: header values, key=value pairs and JSON
 * fields with a credential name, auth scheme values, URL query strings and long opaque tokens, then the bridge's
 * redactor. Status words, header names, hosts and paths stay readable for diagnosis.
 */
export function maskDiagnostic(value: string, secrets: readonly string[] = []): string {
  const masked = value
    .replace(urlQueryRe, '$1?[REDACTED]')
    .replace(jsonValueRe, maskJsonValue)
    .replace(wholeHeaderRe, '$1[REDACTED]')
    .replace(schemeRe, '$1 [REDACTED]')
    .replace(headerValueRe, maskHeaderValue)
    .replace(opaqueRe, maskOpaque)
  return redactSecrets(masked, secrets)
}

export interface ErrorDetail {
  name: string
  code?: number | string
  description: string
}

/**
 * What a caught error says about itself: its name, a numeric or short code (Telegram error_code, HTTP status) and its
 * description with credentials masked (maskDiagnostic), cut to 300 characters. No other field is kept.
 */
export function errorDetail(error: unknown, secrets: readonly string[] = []): ErrorDetail {
  const fields = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const name = error instanceof Error ? error.name : typeof error
  const rawCode = fields.error_code ?? fields.code ?? fields.status
  const code = typeof rawCode === 'number' || (typeof rawCode === 'string' && rawCode.length <= 64) ? rawCode : undefined
  const raw = typeof fields.description === 'string' ? fields.description
    : error instanceof Error ? error.message : String(error)
  const description = maskDiagnostic(raw, secrets).replace(/\s+/gu, ' ').trim().slice(0, descriptionMax)
  return { name, ...(code === undefined ? {} : { code: typeof code === 'string' ? redactSecrets(code, secrets) : code }), description }
}

/** KROT_ERROR_LOG_DAYS: how many days of error files are kept; default 14, never fewer than 7. */
export function errorLogDays(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(value)) return defaultErrorLogDays
  return Math.max(minimumErrorLogDays, value)
}

export type ErrorLevel = 'warn' | 'error'

export interface ErrorEntry {
  ts: string
  level: ErrorLevel
  area: string
  message: string
  error?: ErrorDetail
  status?: string
  turnId?: string
  threadId?: string
  messageId?: number
  delivered?: number
  component?: string
}

export interface ErrorSummary {
  /** Entries of the last 24 hours and the last 7 days. */
  day: number
  week: number
  /** Entries of the last 24 hours that need attention: level error, or a warn area seen at least 5 times. */
  problemCount: number
  /** The newest of those entries, newest first, at most 5. */
  problems: ErrorEntry[]
  /** Where the daily files live: <state dir>/errors-YYYY-MM-DD.jsonl. */
  path: string
}

export interface ErrorJournalOptions {
  dir: string
  days?: number
  maxBytes?: number
  secrets?: readonly string[]
  now?: () => number
}

function text(value: unknown, max: number, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return redactSecrets(value, secrets).replace(/\s+/gu, ' ').trim().slice(0, max) || undefined
}

// Free text of errors and log messages may quote a provider response, so credentials are masked there too.
function diagnosticText(value: unknown, max: number, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return maskDiagnostic(value, secrets).replace(/\s+/gu, ' ').trim().slice(0, max) || undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function detail(value: unknown, secrets: readonly string[]): ErrorDetail | undefined {
  if (value instanceof Error) return errorDetail(value, secrets)
  // Older log lines carry the error as its message string.
  if (typeof value === 'string') return { name: 'Error', description: diagnosticText(value, descriptionMax, secrets) ?? '' }
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const description = diagnosticText(fields.description, descriptionMax, secrets)
  const name = text(fields.name, 64, secrets) ?? 'Error'
  const code = typeof fields.code === 'number' ? fields.code : text(fields.code, 64, secrets)
  return { name, ...(code === undefined ? {} : { code }), description: description ?? '' }
}

/** Daily JSON-lines error files in the bridge's state directory, kept for a number of days under a size cap. */
export class ErrorJournal {
  private readonly days: number
  private readonly maxBytes: number
  private readonly secrets: readonly string[]
  private readonly now: () => number
  private total = 0
  private prunedFor = ''

  constructor(private readonly options: ErrorJournalOptions) {
    this.days = Math.max(minimumErrorLogDays, options.days ?? defaultErrorLogDays)
    this.maxBytes = options.maxBytes ?? defaultErrorLogMaxBytes
    this.secrets = options.secrets ?? []
    this.now = options.now ?? Date.now
    this.prune()
  }

  /** Appends one entry; only the known fields of `context` are kept. Never throws. */
  record(level: ErrorLevel, area: string, message: string, context: Record<string, unknown> = {}): void {
    try {
      const at = this.now()
      if (this.prunedFor !== dateOf(at)) this.prune()
      const entry: ErrorEntry = {
        ts: new Date(at).toISOString(), level,
        area: text(context.area, 64, this.secrets) ?? text(area, 64, this.secrets) ?? 'bridge',
        message: diagnosticText(message, messageMax, this.secrets) ?? '',
      }
      const error = detail(context.error, this.secrets)
      if (error && error.code === undefined && typeof context.code === 'number') error.code = context.code
      if (error) entry.error = error
      const status = text(context.status, 32, this.secrets)
      if (status) entry.status = status
      const turnId = text(context.turnId, idMax, this.secrets)
      if (turnId) entry.turnId = turnId
      const threadId = text(context.threadId, idMax, this.secrets)
      if (threadId) entry.threadId = threadId
      const messageId = count(context.messageId)
      if (messageId !== undefined) entry.messageId = messageId
      const delivered = count(context.delivered)
      if (delivered !== undefined) entry.delivered = delivered
      const component = text(context.component, 64, this.secrets)
      if (component) entry.component = component
      const line = JSON.stringify(entry) + '\n'
      const bytes = Buffer.byteLength(line)
      if (this.total + bytes > this.maxBytes) this.prune(bytes)
      // A log storm on one day stops at the cap instead of filling the disk.
      if (this.total + bytes > this.maxBytes) return
      appendFileSync(join(this.options.dir, `errors-${dateOf(at)}.jsonl`), line, { mode: 0o600 })
      this.total += bytes
    } catch { /* The journal is best effort: logging never breaks the bridge. */ }
  }

  /** Counts for the last 24 hours and 7 days and the newest 5 entries that need attention. Never throws. */
  recent(): ErrorSummary {
    const at = this.now()
    const entries: ErrorEntry[] = []
    for (const file of this.files().filter(file => file.time >= startOfDay(at - 7 * dayMs))) {
      let raw = ''
      try { raw = readFileSync(join(this.options.dir, file.name), 'utf8') } catch { continue }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as ErrorEntry
          if (typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts))) entries.push(entry)
        } catch { /* A cut line (disk full, crash) is skipped. */ }
      }
    }
    // Reversed first: among entries of the same millisecond the later line is the newer one.
    const recent = entries.reverse().filter(entry => Date.parse(entry.ts) > at - 7 * dayMs && Date.parse(entry.ts) <= at)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    const day = recent.filter(entry => Date.parse(entry.ts) > at - dayMs)
    const warnsByArea = new Map<string, number>()
    for (const entry of day) if (entry.level === 'warn') warnsByArea.set(entry.area, (warnsByArea.get(entry.area) ?? 0) + 1)
    // A single warning is noise (a flaky network, a refused edit); an error or a warning that keeps repeating is not.
    const problems = day.filter(entry => entry.level === 'error' ||
      (entry.level === 'warn' && (warnsByArea.get(entry.area) ?? 0) >= repeatedWarnLimit))
    return {
      day: day.length,
      week: recent.length,
      problemCount: problems.length,
      problems: problems.slice(0, 5),
      path: join(this.options.dir, errorJournalPattern),
    }
  }

  private files(): Array<{ name: string; time: number; size: number }> {
    let names: string[]
    try { names = readdirSync(this.options.dir) } catch { return [] }
    return names.flatMap(name => {
      const date = filePattern.exec(name)?.[1]
      const time = date === undefined ? Number.NaN : Date.parse(date + 'T00:00:00Z')
      if (!Number.isFinite(time)) return []
      try { return [{ name, time, size: statSync(join(this.options.dir, name)).size }] } catch { return [] }
    }).sort((a, b) => a.time - b.time)
  }

  // Deletes days past the retention, then the oldest days while the total (plus `incoming`) is above the cap.
  private prune(incoming = 0): void {
    const at = this.now()
    const today = startOfDay(at)
    const oldest = today - this.days * dayMs
    const kept: Array<{ name: string; time: number; size: number }> = []
    for (const file of this.files()) {
      if (file.time < oldest && this.remove(file.name)) continue
      kept.push(file)
    }
    let total = kept.reduce((sum, file) => sum + file.size, 0)
    for (const file of kept) {
      if (total + incoming <= this.maxBytes || file.time >= today) break
      if (this.remove(file.name)) total -= file.size
    }
    this.total = total
    this.prunedFor = dateOf(at)
  }

  private remove(name: string): boolean {
    try {
      unlinkSync(join(this.options.dir, name))
      return true
    } catch { return false }
  }
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function startOfDay(ms: number): number {
  return Date.parse(dateOf(ms) + 'T00:00:00Z')
}
