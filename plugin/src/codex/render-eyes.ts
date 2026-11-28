// R42 «eyes»: after every send to the owner the bridge records what Telegram actually shows (the HTML, plain text,
// Rich Message or document that went out, chunk by chunk) and diffs it against the text the model produced.
// A degradation (markup shown raw, broken tags that sent a part as plain text, a reply turned into a file, a block
// cut between two messages) is logged as a warn, so it lands in the error journal, and is told to the model once,
// as one short note in the volatile part of its next turn. /doctor shows the last 5 diffs.
// Owner sends only. The journal line carries the kind and the message ID, never text; the kept diff (the history
// file and /doctor) carries the kind, the message IDs and a fixed code from a closed list (`tag:b`, `entity:amp`),
// never the reply's text. The offending markup itself (at most 24 characters, masked like the journal) stays in
// memory for the pending note only, and the sent parts stay in memory for render_preview.

import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'

import type { SentMessage, SentText } from '../channel/tools.js'
import { htmlToPlainText } from '../format/chunk.js'
import { markdownToTelegramHtml } from '../format/html.js'
import type { Logger } from '../log.js'
import { errorDetail, maskDiagnostic } from './error-log.js'
import { object } from './rpc.js'

/** How a part reached the owner: Telegram HTML, plain text, a .txt document or a Rich Message (Markdown). */
export type ShownFormat = 'HTML' | 'plain' | 'document' | 'rich'

/** The recorded form of what the safe wrapper reports it sent (MarkdownV2 is never an owner reply format). */
export function shownSent(sent: SentText): { format: ShownFormat; text: string } {
  return { format: sent.format === 'HTML' || sent.format === 'rich' ? sent.format : 'plain', text: sent.text }
}

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

/** A file's identity: a rename over it or a rewrite of it changes at least one of these. */
export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

/** The render history's file operations: a test seam (like the poller's lock hooks); the defaults use node:fs. */
export interface RenderHistoryFiles {
  /** The body and the identity of the file it came from, taken before reading. Throws ENOENT when there is none. */
  read(file: string): { body: string; identity: FileIdentity }
  /** The identity of the file now at `file`, undefined when there is none. */
  identity(file: string): FileIdentity | undefined
  rename(from: string, to: string): void
}

const identityOf = (stats: Stats): FileIdentity =>
  ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs })
const sameFile = (now: FileIdentity | undefined, judged: FileIdentity): boolean => now !== undefined &&
  now.dev === judged.dev && now.ino === judged.ino && now.size === judged.size && now.mtimeMs === judged.mtimeMs
// Loading rereads a history that changed under it at most this often, then leaves the file alone.
const settleAttempts = 3

export const renderHistoryFiles: RenderHistoryFiles = {
  read(file) {
    const fd = openSync(file, 'r')
    try {
      // Taken before the read: a change during or after it makes the identity stale, so the file is judged again.
      const identity = identityOf(fstatSync(fd))
      return { body: readFileSync(fd, 'utf8'), identity }
    } finally {
      closeSync(fd)
    }
  },
  identity(file) {
    try {
      return identityOf(lstatSync(file))
    } catch (error) {
      if (object(error).code === 'ENOENT') return undefined
      throw error
    }
  },
  rename: (from, to) => renameSync(from, to),
}

export interface RenderEyesOptions {
  /** <state>/render-diffs.json: the last 20 diffs, read back after a restart. */
  file?: string
  /** A warn here also lands in the error journal (the logger's sink). */
  log?: Logger
  secrets?: readonly string[]
  now?: () => number
  files?: RenderHistoryFiles
}

/** A send with parts the outbox still holds: recorded once the outbox delivered every one of them. */
export interface WaitingSend {
  source: string
  parts: ShownPart[]
  brokenHtml: number
  /** The UUID of each part still queued and its index in the send. */
  queued: Map<string, number>
}

// Sends parked for the outbox; an older one past this (its parts dropped by the outbox) is forgotten.
const keptWaiting = 20

/** Collects the parts of one send; `finish` records them. Never throws. */
export class RenderView {
  private readonly parts: ShownPart[] = []
  private readonly queued = new Map<string, number>()
  private broken = 0

  constructor(private readonly eyes: RenderEyes, private readonly source: string) {}

  shown(format: ShownFormat, text: string, messageId?: number): void {
    this.parts.push(messageId === undefined ? { format, text } : { format, text, messageId })
  }

  /**
   * A message the transport sent, recorded with the payload and format the safe wrapper reports; `format` and
   * `text` (already masked) only when a raw transport reports none. An HTML part sent as plain text counts as refused.
   */
  sent(result: SentMessage, format: ShownFormat, text: string): void {
    const shown = result.sent === undefined ? { format, text } : shownSent(result.sent)
    if (format === 'HTML' && shown.format !== 'HTML') this.brokenHtml()
    this.shown(shown.format, shown.text, result.message_id)
  }

  /** A part the outbox queued (flood wait): its message ID comes with RenderEyes.delivered. */
  deferred(outboxId: string, format: ShownFormat, text: string): void {
    this.queued.set(outboxId, this.parts.length)
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
    if (this.queued.size === 0) return this.eyes.record(send)
    this.eyes.wait({ ...send, queued: new Map(this.queued) })
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
  private readonly files: RenderHistoryFiles
  // A corrupt history file is still in place (moving it aside failed) or could not be read: no save may replace it.
  private blocked = false

  // The bridge process is the history's single owner. Every file operation below is synchronous, so the load, the
  // migration, the quarantine and the saves of this process never interleave; a change by anyone else between a read
  // and a rename is caught by the identity check right before that rename.
  constructor(private readonly options: RenderEyesOptions) {
    this.secrets = options.secrets ?? []
    this.now = options.now ?? Date.now
    this.files = options.files ?? renderHistoryFiles
    if (!options.file) return
    const diffs = this.settle(options.file)
    this.blocked = diffs === undefined
    this.diffs = diffs ?? []
  }

  /**
   * Judges the history on disk and makes it safe to write: a corrupt file is moved aside, a legacy one rewritten
   * without excerpts. A file that changed since it was read is judged again, never moved or rewritten on the old
   * judgement. Returns the kept diffs, or undefined while a corrupt or unreadable file stays in place.
   */
  private settle(file: string): RenderDiff[] | undefined {
    for (let attempt = 0; attempt < settleAttempts; attempt++) {
      let read: { body: string; identity: FileIdentity }
      try {
        read = this.files.read(file)
      } catch (error) {
        if (object(error).code === 'ENOENT') return []
        // A history that exists but cannot be read (EACCES…) is never overwritten: saves wait until it can be.
        this.warnFailure('Could not read the render history', error)
        return undefined
      }
      let raw: unknown
      try {
        raw = JSON.parse(read.body)
      } catch { /* The parser's error can quote history contents. */ }
      const parsed = FileSchema.safeParse(raw)
      if (!parsed.success) {
        const moved = this.moveAside(file, read.identity)
        if (moved === 'changed') continue
        return moved === 'moved' ? [] : undefined
      }
      const diffs = parsed.data.diffs.flatMap(entry => {
        const diff = DiffSchema.safeParse(entry)
        return diff.success ? [diff.data] : []
      }).slice(-keptDiffs)
      if (diffs.length === parsed.data.diffs.length) return diffs
      try {
        if (!this.write(file, JSON.stringify({ diffs }) + '\n', read.identity)) continue
      } catch (error) {
        // The in-memory diffs still serve /doctor; the next save rewrites the file.
        this.warnFailure('Could not save the render history', error)
      }
      return diffs
    }
    this.warnFailure('Render history kept changing while it was loaded')
    return undefined
  }

  // Moves the corrupt file judged from the read with `identity` aside, unless the file changed since.
  private moveAside(file: string, identity: FileIdentity): 'moved' | 'changed' | 'failed' {
    try {
      if (!sameFile(this.files.identity(file), identity)) return 'changed'
      this.files.rename(file, file + '.corrupt-' + randomUUID())
    } catch (error) {
      this.warnFailure('Could not move aside corrupt render history', error)
      return 'failed'
    }
    this.warnFailure('Moved aside corrupt render history')
    return 'moved'
  }

  // Writes the history atomically (temp file, fsync, rename). With `expected`, the rename happens only while the
  // file still has that identity; false: it changed and nothing was written.
  private write(file: string, body: string, expected?: FileIdentity): boolean {
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = join(dir, `.${basename(file)}.tmp-${randomUUID()}`)
    let renamed = false
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeSync(fd, body)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (expected && !sameFile(this.files.identity(file), expected)) return false
      this.files.rename(temp, file)
      renamed = true
    } finally {
      if (!renamed) {
        try { unlinkSync(temp) } catch { /* The temp file may never have been created. */ }
      }
    }
    try {
      const dirFd = openSync(dir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch { /* Best effort: the rename itself is done. */ }
    return true
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

  private warnFailure(message: string, error?: unknown): void {
    try {
      this.options.log?.warn(message, { area: 'render',
        ...(error === undefined ? {} : { error: errorDetail(error, this.secrets) }) })
    } catch { /* A broken logger never breaks a send. */ }
  }

  /** Parks a send whose parts the outbox holds (RenderView.finish). */
  wait(waiting: WaitingSend): void {
    this.waiting.push(waiting)
    if (this.waiting.length > keptWaiting) this.waiting.shift()
  }

  /**
   * The outbox delivered a part identified by its UUID; `sent` is what it actually delivered when that differs from
   * the queued part (a document uploaded with the redactions current at the flush). Record the parked send after all
   * its queued parts arrive.
   * A part of no parked send (one queued by an earlier bridge run) is ignored. Never throws.
   */
  delivered(outboxId: string, messageId: number, sent?: { format: ShownFormat; text: string }): RenderDiff | undefined {
    try {
      const at = this.waiting.findIndex(({ queued }) => queued.has(outboxId))
      const waiting = this.waiting[at]
      const index = waiting?.queued.get(outboxId)
      if (!waiting || index === undefined) return undefined
      waiting.queued.delete(outboxId)
      const part = waiting.parts[index]
      if (part) waiting.parts[index] = { ...part, ...sent, messageId }
      if (waiting.queued.size > 0) return undefined
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

  /** An edit of a message this bridge run sent: its preview shows the payload the edit sent from now on. */
  edited(messageId: number, sent: SentText): void {
    if (this.messages.has(messageId)) this.messages.set(messageId, { ...shownSent(sent), messageId })
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
    if (this.blocked) {
      // Retry the quarantine first: a save must never replace a corrupt file that has no backup.
      const onDisk = this.settle(file)
      if (onDisk === undefined) return
      this.blocked = false
      this.diffs = [...onDisk, ...this.diffs].slice(-keptDiffs)
    }
    try {
      this.write(file, JSON.stringify({ diffs: this.diffs }) + '\n')
    } catch (error) {
      // The in-memory diffs still serve /doctor.
      this.warnFailure('Could not save the render history', error)
    }
  }
}
