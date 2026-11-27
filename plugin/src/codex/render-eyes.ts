// R42 «eyes»: after every send to the owner the bridge records what Telegram actually shows (the HTML, plain text,
// Rich Message or document that went out, chunk by chunk) and diffs it against the text the model produced.
// A degradation (markup shown raw, broken tags that sent a part as plain text, a reply turned into a file, a block
// cut between two messages) is logged as a warn, so it lands in the error journal, and is told to the model once,
// as one short note in the volatile part of its next turn. /doctor shows the last 5 diffs.
// Owner sends only. The journal line carries the kind and the message ID, never text; the kept diff (the history
// file and /doctor) carries the kind, the message IDs and a fixed code from a closed list (`tag:b`, `entity:amp`),
// never the reply's text. The offending markup itself (at most 24 characters, masked like the journal) stays in
// memory for the pending note only, and the sent parts stay in memory for render_preview.

import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { z } from 'zod'

import { atomicWriteInRoot } from '../autonomy/store.js'
import { htmlToPlainText } from '../format/chunk.js'
import { markdownToTelegramHtml } from '../format/html.js'
import type { Logger } from '../log.js'
import { errorDetail, maskDiagnostic } from './error-log.js'

/** How a part reached the owner: Telegram HTML, plain text, a .txt document or a Rich Message (Markdown). */
export type ShownFormat = 'HTML' | 'plain' | 'document' | 'rich'

/** One message the owner got: its format, its text as sent and its Telegram message ID once known. */
export interface ShownPart {
  format: ShownFormat
  text: string
  messageId?: number
}

/** One send: the model's text (secrets already masked), the parts sent and how many HTML parts fell back to plain. */
export interface RenderSend {
  source: string
  parts: readonly ShownPart[]
  brokenHtml?: number
}

export const renderDegradationKinds = ['raw_markup', 'broken_tags', 'dropped_markup', 'split_mid_block'] as const
export type RenderDegradationKind = typeof renderDegradationKinds[number]

/**
 * What the owner saw instead of what the model meant; `literal`: `expected` is the exact text that should show.
 * `shown` and `expected` may quote the reply: they stay in memory. `code` is the fixed form the history keeps.
 */
export interface RenderDegradation {
  kind: RenderDegradationKind
  shown: string
  expected: string
  literal: boolean
  code: RenderCode
}

/** A degradation as the history file and /doctor keep it: its kind and a fixed code, never the reply's text. */
export interface RenderDegradationRecord {
  kind: RenderDegradationKind
  code: RenderCode
}

export interface RenderDiff {
  ts: string
  messageIds: number[]
  formats: ShownFormat[]
  /** Blank-line separators of the model's text the owner does not see. */
  collapsedBlankLines: number
  /** At most one per kind. */
  degradations: RenderDegradationRecord[]
}

// The codes are a closed list, so a code can never carry the reply's own words.
export const renderCodes = [
  'entity', 'entity:num', 'entity:amp', 'entity:apos', 'entity:gt', 'entity:lt', 'entity:nbsp', 'entity:quot',
  'tag', 'tag:a', 'tag:b', 'tag:blockquote', 'tag:br', 'tag:code', 'tag:del', 'tag:div', 'tag:em', 'tag:i', 'tag:ins',
  'tag:p', 'tag:pre', 'tag:s', 'tag:span', 'tag:strike', 'tag:strong', 'tag:tg-emoji', 'tag:tg-spoiler', 'tag:u',
  'bold', 'strike', 'escape', 'html_refused', 'document', 'plain', 'split:code', 'split:quote', 'split:line',
] as const
export type RenderCode = typeof renderCodes[number]

const isRenderCode = (value: string): value is RenderCode => renderCodes.some(code => code === value)
// An entity or a tag the bridge does not know is kept as the bare `entity` or `tag`.
function knownCode(prefix: 'entity' | 'tag', name: string | undefined): RenderCode {
  const code = `${prefix}:${name ?? ''}`
  return isRenderCode(code) ? code : prefix
}

type SplitBlock = 'code' | 'quote' | 'line'
const splitCodes: Readonly<Record<SplitBlock, RenderCode>> = { code: 'split:code', quote: 'split:quote', line: 'split:line' }

const excerptMax = 24
const keptDiffs = 20
const keptMessages = 50

const DiffSchema = z.object({
  ts: z.string(),
  messageIds: z.array(z.number().int().positive()),
  formats: z.array(z.enum(['HTML', 'plain', 'document', 'rich'])),
  collapsedBlankLines: z.number().int().nonnegative(),
  // Only the kind and the fixed code: an entry that carries anything else (an older file's excerpts) is dropped.
  degradations: z.array(z.object({ kind: z.enum(renderDegradationKinds), code: z.enum(renderCodes) }).strict()),
})
const FileSchema = z.object({ diffs: z.array(z.unknown()) })

interface RawMeaning {
  expected: string
  literal: boolean
  code: RenderCode
}

// Markup the owner sees as characters. Code is left out first: it shows its content literally on purpose.
const rawMarkup: ReadonlyArray<{ re: RegExp; meaning: (match: string) => RawMeaning }> = [
  { re: /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,7});/u, meaning: match => {
    const decoded = match === '&nbsp;' ? ' ' : htmlToPlainText(match)
    const code = match.startsWith('&#') ? 'entity:num' : knownCode('entity', match.slice(1, -1).toLowerCase())
    return decoded === match ? { expected: 'символа', literal: false, code } : { expected: decoded, literal: true, code }
  } },
  { re: /<\/?[a-zA-Z][\w-]*(?:\s[^<>\n]*)?>/u, meaning: match => ({ expected: 'форматирования', literal: false,
    code: knownCode('tag', /^<\/?([a-zA-Z][\w-]*)/u.exec(match)?.[1]?.toLowerCase()) }) },
  { re: /\*\*/u, meaning: () => ({ expected: 'жирного текста', literal: false, code: 'bold' }) },
  { re: /~~/u, meaning: () => ({ expected: 'зачёркнутого текста', literal: false, code: 'strike' }) },
  { re: /\\[_*[\]()~`>#+\-=|{}.!]/u, meaning: match => ({ expected: match.slice(1), literal: true, code: 'escape' }) },
]

const withoutCode = (html: string): string =>
  html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/giu, '\nx\n').replace(/<code\b[^>]*>[\s\S]*?<\/code>/giu, 'x')
// Runs of blank lines (a paragraph break counts once, however many empty lines it has).
const blankRuns = (text: string): number => (text.match(/\n(?:[^\S\n]*\n)+/gu) ?? []).length
const fencesOut = (markdown: string): string => markdown.replace(/```[\s\S]*?```/gu, 'x')
// The block a cut split, and its name in the genitive of «разрез …».
const blockTags: Readonly<Record<string, SplitBlock>> = { pre: 'code', code: 'code', blockquote: 'quote' }
const blockNames: Readonly<Record<SplitBlock, string>> = { code: 'блока кода', quote: 'цитаты', line: 'абзаца' }

function shownText(part: ShownPart): string {
  return part.format === 'HTML' ? htmlToPlainText(withoutCode(part.text)) : part.text
}

// A cut that the chunker closed and reopened: the left part ends with closers, the right one reopens a block.
function splitBlock(left: string, right: string): SplitBlock | undefined {
  const closers = /(?:<\/[a-z][\w-]*>)+$/iu.exec(left)?.[0].toLowerCase()
  const reopened = /^<(pre|code|blockquote)\b/iu.exec(right)?.[1]?.toLowerCase()
  if (closers && reopened && closers.includes(`</${reopened}>`)) return blockTags[reopened]
  // A hard cut inside a line: neither side of the seam is a line break.
  if (!/\n\s*$/u.test(htmlToPlainText(left)) && !/^\s*\n/u.test(htmlToPlainText(right))) return 'line'
  return undefined
}

/** Compares the model's text with what the owner was shown. Pure; at most one degradation per kind. */
export function diffRender(send: RenderSend): { collapsedBlankLines: number; degradations: RenderDegradation[] } {
  const found = new Map<RenderDegradationKind, Omit<RenderDegradation, 'kind'>>()
  const add = (kind: RenderDegradationKind, shown: string, expected: string, code: RenderCode, literal = false): void => {
    if (!found.has(kind)) found.set(kind, { shown, expected, literal, code })
  }
  const broken = send.brokenHtml ?? 0
  if (broken > 0) add('broken_tags', 'простой текст', 'форматирования: HTML-теги не сошлись', 'html_refused')
  for (const part of send.parts) {
    if (part.format === 'document') add('dropped_markup', 'файл .txt', 'сообщения', 'document')
    if (part.format === 'rich' || part.format === 'document' || (part.format === 'plain' && broken > 0)) continue
    const text = shownText(part)
    for (const { re, meaning } of rawMarkup) {
      const match = re.exec(text)?.[0]
      if (match === undefined) continue
      const meant = meaning(match)
      add('raw_markup', match, meant.expected, meant.code, meant.literal)
      break
    }
  }
  // Plain parts that are no fallback: the reply went without its formatting.
  if (broken === 0 && send.parts.some(part => part.format === 'plain') &&
      /<(?:b|i|s|u|a|code|pre|blockquote)\b/u.test(markdownToTelegramHtml(send.source))) {
    add('dropped_markup', 'простой текст', 'форматирования', 'plain')
  }
  for (let index = 0; index + 1 < send.parts.length; index++) {
    const [left, right] = [send.parts[index]!, send.parts[index + 1]!]
    if (left.format !== 'HTML' || right.format !== 'HTML') continue
    const block = splitBlock(left.text, right.text)
    if (block) add('split_mid_block', `разрез ${blockNames[block]} между сообщениями`, 'целого блока', splitCodes[block])
  }
  const shownBreaks = send.parts.reduce((sum, part) => sum + (part.format === 'rich' ? 0 : blankRuns(shownText(part))), 0) +
    Math.max(0, send.parts.length - 1)
  return {
    collapsedBlankLines: Math.max(0, blankRuns(fencesOut(send.source)) - shownBreaks),
    degradations: [...found].map(([kind, rest]) => ({ kind, ...rest })),
  }
}

/** The next-turn note about `degradations` (one per kind), or '' when the owner saw the replies as meant. */
export function renderNote(degradations: readonly Omit<RenderDegradation, 'code'>[]): string {
  if (degradations.length === 0) return ''
  const items = degradations.map(({ kind, shown, expected, literal }) => kind === 'raw_markup'
    ? `«${shown}» вместо ${literal ? `«${expected}»` : expected}` : `${shown} вместо ${expected}`)
  return 'Проверка моста (данные, не просьба владельца): в прошлом ответе Telegram показал ' + items.join('; ') +
    '. Учти это в оформлении.'
}

export interface RenderEyesOptions {
  /** <state>/render-diffs.json: the last 20 diffs, read back after a restart. */
  file?: string
  /** A warn here also lands in the error journal (the logger's sink). */
  log?: Logger
  secrets?: readonly string[]
  now?: () => number
}

/** A send with parts the outbox still holds: recorded once the outbox delivered every one of them. */
export interface WaitingSend {
  source: string
  parts: ShownPart[]
  brokenHtml: number
  /** Indexes of the parts still queued, in delivery (FIFO) order. */
  queued: number[]
}

// Sends parked for the outbox; an older one past this (its parts dropped by the outbox) is forgotten.
const keptWaiting = 20

/** Collects the parts of one send; `finish` records them. Never throws. */
export class RenderView {
  private readonly parts: ShownPart[] = []
  private readonly queued: number[] = []
  private broken = 0

  constructor(private readonly eyes: RenderEyes, private readonly source: string) {}

  shown(format: ShownFormat, text: string, messageId?: number): void {
    this.parts.push(messageId === undefined ? { format, text } : { format, text, messageId })
  }

  /** A part the outbox queued (flood wait) with exactly this text: its message ID comes with RenderEyes.delivered. */
  deferred(format: ShownFormat, text: string): void {
    this.queued.push(this.parts.length)
    this.parts.push({ format, text })
  }

  /** An HTML part Telegram or the pre-send validator refused: it went as plain text. */
  brokenHtml(): void {
    this.broken += 1
  }

  /** Records the send now, or, with queued parts, once the outbox delivered them (undefined until then). */
  finish(): RenderDiff | undefined {
    if (this.parts.length === 0 && this.broken === 0) return undefined
    const send = { source: this.source, parts: [...this.parts], brokenHtml: this.broken }
    if (this.queued.length === 0) return this.eyes.record(send)
    this.eyes.wait({ ...send, queued: [...this.queued] })
    return undefined
  }
}

/** The bridge's record of what the owner saw: recent diffs, the pending note and the sent parts of this run. */
export class RenderEyes {
  private diffs: RenderDiff[] = []
  private readonly pending = new Map<RenderDegradationKind, RenderDegradation>()
  private readonly messages = new Map<number, ShownPart>()
  private readonly waiting: WaitingSend[] = []
  private readonly secrets: readonly string[]
  private readonly now: () => number

  constructor(private readonly options: RenderEyesOptions) {
    this.secrets = options.secrets ?? []
    this.now = options.now ?? Date.now
    if (!options.file) return
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(options.file, 'utf8')))
      if (parsed.success) {
        this.diffs = parsed.data.diffs.flatMap(entry => {
          const diff = DiffSchema.safeParse(entry)
          return diff.success ? [diff.data] : []
        }).slice(-keptDiffs)
      }
    } catch { /* No diffs yet or an unreadable file: start empty. */ }
  }

  /** Starts recording one send of `source` (the model's text with secrets masked). */
  begin(source: string): RenderView {
    return new RenderView(this, source)
  }

  /** Records one send: diff, journal warn per degradation kind, pending note, /doctor history. Never throws. */
  record(send: RenderSend): RenderDiff | undefined {
    try {
      const { collapsedBlankLines, degradations } = diffRender(send)
      // Only raw markup quotes the model's text; the other kinds carry the bridge's own fixed words.
      const masked = degradations.map(item => item.kind !== 'raw_markup' ? item
        : { ...item, shown: this.excerpt(item.shown), expected: this.excerpt(item.expected) })
      const messageIds = send.parts.flatMap(part => part.messageId === undefined ? [] : [part.messageId])
      // The kept diff (file and /doctor) carries metadata only; the excerpts live on in the pending note alone.
      const diff: RenderDiff = { ts: new Date(this.now()).toISOString(), messageIds,
        formats: send.parts.map(part => part.format), collapsedBlankLines,
        degradations: degradations.map(({ kind, code }) => ({ kind, code })) }
      for (const part of send.parts) {
        if (part.messageId === undefined) continue
        this.messages.delete(part.messageId)
        this.messages.set(part.messageId, part)
        if (this.messages.size > keptMessages) this.messages.delete(this.messages.keys().next().value!)
      }
      for (const item of masked) {
        if (!this.pending.has(item.kind)) this.pending.set(item.kind, item)
      }
      this.diffs = [...this.diffs, diff].slice(-keptDiffs)
      this.later(() => {
        for (const item of masked) {
          // The journal gets the kind and the message ID only, never the text.
          this.options.log?.warn('Telegram showed the reply degraded', {
            area: 'render', status: item.kind, ...(messageIds[0] === undefined ? {} : { messageId: messageIds[0] }),
          })
        }
        this.save()
      })
      return diff
    } catch {
      return undefined
    }
  }

  // The journal and the history fsync their files: that I/O runs a macrotask after the send path returned, so a
  // delivery result or a transport rejection reaches its caller first (a microtask would still run before the
  // caller's continuation). The diff, the pending note and the sent parts are in memory at once.
  private later(write: () => void): void {
    setImmediate(() => {
      try {
        write()
      } catch (error) {
        this.warnFailure('Could not write render diagnostics', error)
      }
    })
  }

  private warnFailure(message: string, error: unknown): void {
    try {
      this.options.log?.warn(message, { area: 'render', error: errorDetail(error, this.secrets) })
    } catch { /* A broken logger never breaks a send. */ }
  }

  /** Parks a send whose parts the outbox holds (RenderView.finish). */
  wait(waiting: WaitingSend): void {
    this.waiting.push(waiting)
    if (this.waiting.length > keptWaiting) this.waiting.shift()
  }

  /**
   * The outbox delivered an owner part with this text as `messageId`. The part goes to the oldest parked send whose
   * next queued part it is (the outbox keeps per-chat FIFO); a send whose queued parts all arrived is recorded.
   * A part of no parked send (one queued by an earlier bridge run) is ignored. Never throws.
   */
  delivered(text: string, messageId: number): RenderDiff | undefined {
    try {
      const at = this.waiting.findIndex(({ parts, queued }) => {
        const next = queued[0]
        return next !== undefined && parts[next]?.text === text
      })
      const waiting = this.waiting[at]
      const index = waiting?.queued.shift()
      if (!waiting || index === undefined) return undefined
      const part = waiting.parts[index]
      if (part) waiting.parts[index] = { ...part, messageId }
      if (waiting.queued.length > 0) return undefined
      this.waiting.splice(at, 1)
      return this.record({ source: waiting.source, parts: waiting.parts, brokenHtml: waiting.brokenHtml })
    } catch {
      return undefined
    }
  }

  /** The note for the next turn, once: each degradation kind seen since the last call, then nothing. */
  takeNote(): string {
    const note = renderNote([...this.pending.values()])
    this.pending.clear()
    return note
  }

  /** The newest diffs first, at most `limit`. */
  recent(limit = 5): RenderDiff[] {
    return this.diffs.slice(-limit).reverse()
  }

  /** A part this bridge run sent to the owner, by its Telegram message ID. */
  shown(messageId: number): ShownPart | undefined {
    return this.messages.get(messageId)
  }

  private excerpt(value: string): string {
    const clean = maskDiagnostic(value, this.secrets).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    return clean.length > excerptMax ? clean.slice(0, excerptMax - 1) + '…' : clean
  }

  private save(): void {
    const file = this.options.file
    if (!file) return
    try {
      atomicWriteInRoot({ root: dirname(file) }, basename(file), JSON.stringify({ diffs: this.diffs }) + '\n')
    } catch (error) {
      // The in-memory diffs still serve /doctor.
      this.warnFailure('Could not save the render history', error)
    }
  }
}
