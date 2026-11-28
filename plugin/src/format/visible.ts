// Visible text: what Telegram shows for a message, with its formatting as entities beside it.
//
// The bridge masks what the reader sees. A message leaves the process as `text` + `entities` (offsets in
// UTF-16 units, as on the wire) and never with a parse_mode, so the string we mask is, character for
// character, the string Telegram shows. Formatting travels beside the text and cannot hide, split or re-join
// a value.
//
//   render(source, format): the visible text of HTML, MarkdownV2 or plain text. The parsers are small and
//     strict: a tag they do not know is literal text, and input that does not parse is literal text too. A
//     parser that reads a tag differently from Telegram costs formatting, never text.
//   mask(visible, secrets): redact the text and carry the entities through each redaction edit.
//   cut(visible, limit): split into pieces of at most `limit` units whose texts join back to the input.

import { MaskFixedPointError } from '../safety/pre-send-error.js'
import { redactSecrets, redactWithEdits, type RedactEdit } from '../safety/redact.js'
import { htmlToPlainText, PreformattedDocumentError, tokenize } from './chunk.js'
import { escapeHtml, escapeHtmlAttr } from './html.js'

export type StyleEntityType =
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'spoiler' | 'code' | 'blockquote' | 'expandable_blockquote'

export interface StyleEntity {
  type: StyleEntityType
  offset: number
  length: number
}

export interface PreEntity {
  type: 'pre'
  offset: number
  length: number
  language?: string
}

export interface LinkEntity {
  type: 'text_link'
  offset: number
  length: number
  url: string
}

export type Entity = StyleEntity | PreEntity | LinkEntity
export type EntityType = Entity['type']

export interface VisibleText {
  text: string
  entities: Entity[]
}

/** The parse_mode a caller passes; undefined is plain text. */
export type SourceFormat = 'HTML' | 'MarkdownV2' | undefined

/** Telegram's hard message limit, the piece size the bridge prefers, and the caption limit (UTF-16 units). */
export const MESSAGE_HARD_LIMIT = 4096
export const MESSAGE_PREFERRED_LIMIT = 4000
export const CAPTION_LIMIT = 1024

// ─── Nesting ───────────────────────────────────────────────────────────
// Telegram: styles nest with anything but pre and code; blockquotes do not nest; links do not contain links,
// code or blockquotes. A code block or a link inside a blockquote is kept (clients render it). An entity
// that would break a rule is left out: its text stays.

const isCode = (type: EntityType): boolean => type === 'pre' || type === 'code'
const isQuote = (type: EntityType): boolean => type === 'blockquote' || type === 'expandable_blockquote'

function mayNest(outer: EntityType, inner: EntityType): boolean {
  if (isCode(outer)) return false
  if (isCode(inner)) return isQuote(outer)
  if (isQuote(inner)) return !isQuote(outer) && outer !== 'text_link'
  if (inner === 'text_link') return outer !== 'text_link'
  return true
}

function byPosition(a: Entity, b: Entity): number {
  return a.offset - b.offset || b.length - a.length
}

// ─── HTML ──────────────────────────────────────────────────────────────

const TAG_TYPES: ReadonlyMap<string, EntityType> = new Map<string, EntityType>([
  ['b', 'bold'], ['strong', 'bold'], ['i', 'italic'], ['em', 'italic'], ['u', 'underline'], ['ins', 'underline'],
  ['s', 'strikethrough'], ['strike', 'strikethrough'], ['del', 'strikethrough'], ['tg-spoiler', 'spoiler'],
  ['code', 'code'], ['pre', 'pre'], ['blockquote', 'blockquote'], ['a', 'text_link'],
])
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const CODE_LANGUAGE_RE = /\bclass\s*=\s*(?:"language-([^"]*)"|'language-([^']*)')/i
// Link targets the bridge sends as a text_link; anything else keeps its label as plain text.
const LINK_URL_RE = /^(?:https?:\/\/|tg:\/\/|mailto:)\S+$/i
const LANGUAGE_RE = /^[\w+#.-]{1,32}$/

interface OpenTag {
  name: string
  start: number
  entity?: Entity
}

function openEntity(type: EntityType, raw: string, offset: number): Entity | undefined {
  switch (type) {
    case 'text_link': {
      const match = HREF_RE.exec(raw)
      const url = htmlToPlainText(match?.[1] ?? match?.[2] ?? '').trim()
      return LINK_URL_RE.test(url) ? { type, offset, length: 0, url } : undefined
    }
    case 'pre': return { type, offset, length: 0 }
    case 'blockquote':
      return { type: /\bexpandable\b/i.test(raw.slice('<blockquote'.length)) ? 'expandable_blockquote' : type,
        offset, length: 0 }
    default: return { type, offset, length: 0 }
  }
}

function renderHtml(html: string): VisibleText {
  let text = ''
  const entities: Entity[] = []
  const open: OpenTag[] = []
  const finish = (tag: OpenTag): void => {
    if (tag.entity === undefined || text.length <= tag.start) return
    entities.push({ ...tag.entity, length: text.length - tag.start })
  }
  for (const token of tokenize(html)) {
    if (token.tag === undefined) {
      text += token.plain
      continue
    }
    const { name, closing } = token.tag
    if (closing) {
      // A closer ends its opener and everything opened after it; a closer with no opener shows nothing.
      const at = open.findLastIndex(tag => tag.name === name)
      if (at >= 0) for (const tag of open.splice(at).reverse()) finish(tag)
      continue
    }
    const type = TAG_TYPES.get(name)
    if (type === undefined) continue
    const parent = open.at(-1)
    // `<pre><code class="language-x">` names the block's language; the inner code is not an entity of its own.
    if (name === 'code' && parent?.entity?.type === 'pre' && parent.start === text.length) {
      const match = CODE_LANGUAGE_RE.exec(token.raw)
      const language = htmlToPlainText(match?.[1] ?? match?.[2] ?? '')
      if (language !== '') parent.entity = { ...parent.entity, language }
      open.push({ name, start: text.length })
      continue
    }
    const entity = openEntity(type, token.raw, text.length)
    const allowed = entity !== undefined &&
      open.every(tag => tag.entity === undefined || mayNest(tag.entity.type, entity.type))
    open.push(allowed ? { name, start: text.length, entity } : { name, start: text.length })
  }
  for (const tag of open.splice(0).reverse()) finish(tag)
  return { text, entities: entities.sort(byPosition) }
}

// ─── MarkdownV2 ────────────────────────────────────────────────────────
// A strict reader of Telegram's MarkdownV2: `*bold*`, `_italic_`, `__underline__`, `~strike~`, `||spoiler||`,
// `` `code` ``, fenced pre blocks with an optional language, `[label](url)` and `\`-escapes. Any other
// reserved character left unescaped, an unclosed marker or a bad escape makes the whole text literal.

const MD_RESERVED = new Set(['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'])

interface OpenMarker {
  marker: string
  start: number
  type: EntityType
  kept: boolean
}

class MarkdownParseError extends Error {}

function renderMarkdownV2(source: string): VisibleText {
  let text = ''
  const entities: Entity[] = []
  const open: OpenMarker[] = []
  let i = 0
  const fail = (): never => { throw new MarkdownParseError('not MarkdownV2') }
  const nestable = (type: EntityType): boolean => open.every(marker => !marker.kept || mayNest(marker.type, type))
  const push = (entity: Entity): void => { if (entity.length > 0) entities.push(entity) }
  // Code and pre bodies: only `\`` and `\\` are escapes there; the body ends at `close`.
  const readCode = (close: string): string => {
    let body = ''
    while (i < source.length) {
      if (source.startsWith(close, i)) {
        i += close.length
        return body
      }
      const char = source[i]
      if (char === '\\') {
        const next = source[i + 1]
        if (next !== '`' && next !== '\\') fail()
        body += next
        i += 2
        continue
      }
      if (char === '`') fail()
      const point = String.fromCodePoint(source.codePointAt(i) ?? 0)
      body += point
      i += point.length
    }
    return fail()
  }
  // A marker always stands for the same style, so the closer's `type` is the opener's.
  const toggle = (marker: string, type: StyleEntityType): void => {
    const top = open.at(-1)
    if (top?.marker === marker) {
      open.pop()
      if (top.kept) push({ type, offset: top.start, length: text.length - top.start })
      return
    }
    if (open.some(entry => entry.marker === marker)) fail()
    open.push({ marker, start: text.length, type, kept: nestable(type) })
  }
  while (i < source.length) {
    const char = source[i]!
    if (char === '\\') {
      const code = source.charCodeAt(i + 1)
      if (!(code >= 1 && code <= 126)) fail()
      text += source[i + 1]
      i += 2
      continue
    }
    if (source.startsWith('```', i)) {
      i += 3
      const lineEnd = source.indexOf('\n', i)
      const head = lineEnd < 0 ? undefined : source.slice(i, lineEnd)
      let language: string | undefined
      if (head !== undefined && (head === '' || LANGUAGE_RE.test(head))) {
        if (head !== '') language = head
        i = lineEnd + 1
      }
      const start = text.length
      text += readCode('```')
      if (nestable('pre')) push({ type: 'pre', offset: start, length: text.length - start, ...(language ? { language } : {}) })
      continue
    }
    if (char === '`') {
      i += 1
      const start = text.length
      text += readCode('`')
      if (nestable('code')) push({ type: 'code', offset: start, length: text.length - start })
      continue
    }
    if (char === '*') { toggle('*', 'bold'); i += 1; continue }
    if (char === '~') { toggle('~', 'strikethrough'); i += 1; continue }
    if (char === '_') {
      if (source[i + 1] === '_') { toggle('__', 'underline'); i += 2 } else { toggle('_', 'italic'); i += 1 }
      continue
    }
    if (char === '|') {
      if (source[i + 1] !== '|') fail()
      toggle('||', 'spoiler')
      i += 2
      continue
    }
    if (char === '[') {
      open.push({ marker: '[', start: text.length, type: 'text_link', kept: nestable('text_link') })
      i += 1
      continue
    }
    if (char === ']') {
      const top = open.pop()
      if (top?.marker !== '[' || source[i + 1] !== '(') fail()
      i += 2
      let url = ''
      while (i < source.length && source[i] !== ')') {
        if (source[i] === '\\') {
          if (source[i + 1] !== ')' && source[i + 1] !== '\\') fail()
          i += 1
        }
        url += source[i]
        i += 1
      }
      if (source[i] !== ')') fail()
      i += 1
      if (top!.kept && LINK_URL_RE.test(url)) {
        push({ type: 'text_link', offset: top!.start, length: text.length - top!.start, url })
      }
      continue
    }
    if (MD_RESERVED.has(char)) fail()
    const point = String.fromCodePoint(source.codePointAt(i) ?? 0)
    text += point
    i += point.length
  }
  if (open.length > 0) fail()
  return { text, entities: entities.sort(byPosition) }
}

/** The text Telegram shows for `source` sent with `format`, its formatting as entities. Never fails. */
export function render(source: string, format: SourceFormat): VisibleText {
  if (format === 'HTML') return renderHtml(source)
  if (format === 'MarkdownV2') {
    try {
      return renderMarkdownV2(source)
    } catch (error) {
      if (!(error instanceof MarkdownParseError)) throw error
    }
  }
  return { text: source, entities: [] }
}

// ─── Masking ───────────────────────────────────────────────────────────

// A start inside an edit moves past the replacement and an end inside it to its start: an entity keeps only
// the text that survived. An entity around the whole edit spans the replacement.
function mapStart(position: number, edits: readonly RedactEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (position <= edit.at) break
    if (position < edit.at + edit.removed) return edit.at + edit.inserted.length + delta
    delta += edit.inserted.length - edit.removed
  }
  return position + delta
}

function mapEnd(position: number, edits: readonly RedactEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (position <= edit.at) break
    if (position < edit.at + edit.removed) return edit.at + delta
    delta += edit.inserted.length - edit.removed
  }
  return position + delta
}

/**
 * Where a position of a pass's input lands in its output. A position inside an edit, or inside the part of its
 * match the replacement kept after it, maps to the start of the replacement, so the whole marker lies after it (a cut between sent and pending text keeps the marker pending).
 */
export function mapPosition(position: number, passes: readonly (readonly RedactEdit[])[]): number {
  let mapped = position
  for (const edits of passes) mapped = mapCut(mapped, edits)
  return mapped
}

// mapEnd over the whole match: a cut in the kept suffix of a match (`MASKME]` → `[REDACTED]` keeps the `]`) splits
// the value too, so it maps to the start of the replacement and the kept suffix is never sent after the sent part.
function mapCut(position: number, edits: readonly RedactEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    if (position <= edit.at) break
    if (position < edit.at + edit.removed + edit.kept) return edit.at + delta
    delta += edit.inserted.length - edit.removed
  }
  return position + delta
}

function touches(entity: Entity, edit: RedactEdit): boolean {
  const end = entity.offset + entity.length
  return edit.removed > 0
    ? entity.offset < edit.at + edit.removed && end > edit.at
    : entity.offset < edit.at && end > edit.at
}

function moveEntities(entities: readonly Entity[], edits: readonly RedactEdit[]): Entity[] {
  const moved: Entity[] = []
  for (const entity of entities) {
    // A link whose label was edited no longer says where it goes.
    if (entity.type === 'text_link' && edits.some(edit => touches(entity, edit))) continue
    const start = mapStart(entity.offset, edits)
    const end = mapEnd(entity.offset + entity.length, edits)
    if (end > start) moved.push({ ...entity, offset: start, length: end - start })
  }
  return moved
}

// The fields that ride with the text: a link whose target holds a value is dropped, a language that is not a
// plain identifier or holds a value is removed.
function maskHiddenFields(entities: readonly Entity[], secrets: ReadonlyArray<string> | undefined): Entity[] {
  const out: Entity[] = []
  for (const entity of entities) {
    if (entity.type === 'text_link') {
      if (redactSecrets(entity.url, secrets) === entity.url) out.push(entity)
    } else if (entity.type === 'pre' && entity.language !== undefined &&
      (!LANGUAGE_RE.test(entity.language) || redactSecrets(entity.language, secrets) !== entity.language)) {
      out.push({ type: 'pre', offset: entity.offset, length: entity.length })
    } else out.push(entity)
  }
  return out
}

const MASK_ROUNDS = 3

export interface MaskResult {
  visible: VisibleText
  /** Every redaction pass applied, in order, with its edits in the offsets of that pass's input. */
  passes: RedactEdit[][]
}

/** mask() with the edits it made, for callers that map saved offsets (cuts) into the masked text. */
export function maskWithEdits(visible: VisibleText, secrets: ReadonlyArray<string> | undefined): MaskResult {
  let { text } = visible
  let entities = visible.entities
  const passes: RedactEdit[][] = []
  for (let round = 0; ; round++) {
    const result = redactWithEdits(text, secrets)
    if (result.passes.length === 0) break
    // Masking is idempotent; a result that keeps changing holds a value overlapping the marker itself.
    if (round === MASK_ROUNDS) throw new MaskFixedPointError('the masked text does not settle; nothing was sent')
    for (const edits of result.passes) {
      entities = moveEntities(entities, edits)
      passes.push(edits)
    }
    text = result.text
  }
  // A registered value that is still there after masking settled is one the marker cannot hide: the value is the
  // marker itself (replacing it changes nothing) or a pattern rule wrote it. Sending it would show the value.
  if ((secrets ?? []).some(secret => secret.length >= MIN_SECRET_LENGTH && text.includes(secret))) {
    throw new MaskFixedPointError('a registered value survives masking; nothing was sent')
  }
  return { visible: { text, entities: maskHiddenFields(entities, secrets) }, passes }
}

// redactWithEdits ignores shorter registered values (a guard against masking common words).
const MIN_SECRET_LENGTH = 4

/** Mask every registered value and pattern match in the visible text, keeping the formatting around it. */
export function mask(visible: VisibleText, secrets: ReadonlyArray<string> | undefined): VisibleText {
  return maskWithEdits(visible, secrets).visible
}

/**
 * Mask `piece` as the continuation of `before`, the shown text already sent ahead of it in the same reply: the two
 * are masked as one text and the piece is what lies after the mapped seam. A value that spans the seam (registered
 * after the reply was cut) has its whole marker in this piece, so the rest of the value is never sent.
 */
export function maskPiece(piece: VisibleText, secrets: ReadonlyArray<string> | undefined, before = ''): VisibleText {
  if (before === '') return mask(piece, secrets)
  const { visible, passes } = maskWithEdits(joinPieces([{ text: before, entities: [] }, piece]), secrets)
  return slice(visible, mapPosition(before.length, passes), visible.text.length)
}

/** A plain string (a button label, a url, a file name) masked the way shown text is. */
export function maskString(text: string, secrets: ReadonlyArray<string> | undefined): string {
  return mask({ text, entities: [] }, secrets).text
}

// ─── Back to HTML (records and previews only, never the wire) ──────────

function openTag(entity: Entity): string {
  switch (entity.type) {
    case 'bold': return '<b>'
    case 'italic': return '<i>'
    case 'underline': return '<u>'
    case 'strikethrough': return '<s>'
    case 'spoiler': return '<tg-spoiler>'
    case 'code': return '<code>'
    case 'blockquote': return '<blockquote>'
    case 'expandable_blockquote': return '<blockquote expandable>'
    case 'text_link': return `<a href="${escapeHtmlAttr(entity.url)}">`
    case 'pre': return entity.language === undefined ? '<pre>'
      : `<pre><code class="language-${escapeHtmlAttr(entity.language)}">`
  }
}

function closeTag(entity: Entity): string {
  switch (entity.type) {
    case 'bold': return '</b>'
    case 'italic': return '</i>'
    case 'underline': return '</u>'
    case 'strikethrough': return '</s>'
    case 'spoiler': return '</tg-spoiler>'
    case 'code': return '</code>'
    case 'blockquote': case 'expandable_blockquote': return '</blockquote>'
    case 'text_link': return '</a>'
    case 'pre': return entity.language === undefined ? '</pre>' : '</code></pre>'
  }
}

/**
 * Telegram HTML that shows `visible`: for render records and previews, which draw HTML. Nothing sends it.
 * Entities are properly nested (render and mask keep them so), so tags close in reverse order of opening.
 */
export function visibleToHtml(visible: VisibleText): string {
  const sorted = [...visible.entities].sort(byPosition)
  let html = ''
  let position = 0
  const open: Entity[] = []
  const closeUntil = (offset: number): void => {
    while (open.length > 0 && open.at(-1)!.offset + open.at(-1)!.length <= offset) {
      const entity = open.pop()!
      html += escapeHtml(visible.text.slice(position, entity.offset + entity.length)) + closeTag(entity)
      position = entity.offset + entity.length
    }
  }
  for (const entity of sorted) {
    closeUntil(entity.offset)
    html += escapeHtml(visible.text.slice(position, entity.offset)) + openTag(entity)
    position = entity.offset
    open.push(entity)
  }
  closeUntil(Infinity)
  return html + escapeHtml(visible.text.slice(position))
}

// ─── Cutting ───────────────────────────────────────────────────────────

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

function hasContent(text: string, start: number, end: number): boolean {
  return /\S/.test(text.slice(start, end))
}

/**
 * The end offsets of the pieces of `text[from..]`, each at most `limit` units: the last paragraph break that
 * fits, else the last line break, else a hard cut (never inside a surrogate pair). A piece always shows
 * something; text that cannot be cut that way throws PreformattedDocumentError (it goes as a document).
 */
export function cutPoints(text: string, limit: number = MESSAGE_PREFERRED_LIMIT, from = 0): number[] {
  if (limit <= 1) throw new Error(`cut: limit must be above 1, got ${limit}`)
  const ends: number[] = []
  let start = from
  while (start < text.length) {
    if (text.length - start <= limit) {
      if (!hasContent(text, start, text.length)) {
        // A blank tail rides on the piece before it when it fits; on its own it is no message.
        const previous = ends.length > 0 ? (ends.at(-2) ?? from) : undefined
        if (previous === undefined || text.length - previous > limit) throw new PreformattedDocumentError(text)
        ends[ends.length - 1] = text.length
      } else ends.push(text.length)
      break
    }
    const windowEnd = start + limit
    let end = -1
    const paragraph = text.lastIndexOf('\n\n', windowEnd - 2)
    if (paragraph >= start && hasContent(text, start, paragraph)) end = paragraph + 2
    else {
      const line = text.lastIndexOf('\n', windowEnd - 1)
      if (line >= start && hasContent(text, start, line)) end = line + 1
    }
    if (end < 0) {
      end = windowEnd
      if (isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1
      if (!hasContent(text, start, end)) {
        // A blank run longer than a piece: the piece before it takes as much of the run as it can hold, so the
        // next piece reaches the text after the run. Only when it cannot does the text go as a document.
        const next = text.slice(end).search(/\S/)
        const reach = next < 0 ? -1 : end + next - limit + 1
        const previousStart = ends.length > 0 ? (ends.at(-2) ?? from) : undefined
        if (previousStart === undefined || reach < 0 || reach - previousStart > limit) {
          throw new PreformattedDocumentError(text)
        }
        ends[ends.length - 1] = reach
        start = reach
        continue
      }
    }
    ends.push(end)
    start = end
  }
  return ends
}

/** The part of `visible` between `start` and `end`, its entities clipped to it and rebased. */
export function slice(visible: VisibleText, start: number, end: number): VisibleText {
  const entities: Entity[] = []
  for (const entity of visible.entities) {
    const from = Math.max(entity.offset, start)
    const to = Math.min(entity.offset + entity.length, end)
    if (to > from) entities.push({ ...entity, offset: from - start, length: to - from })
  }
  return { text: visible.text.slice(start, end), entities }
}

/** Pieces joined back into one text, their entities shifted into place (the inverse of cut). */
export function joinPieces(pieces: readonly VisibleText[]): VisibleText {
  let text = ''
  const entities: Entity[] = []
  for (const piece of pieces) {
    for (const entity of piece.entities) entities.push({ ...entity, offset: entity.offset + text.length })
    text += piece.text
  }
  return { text, entities }
}

/** `visible` split into pieces of at most `limit` units; joining their texts gives back `visible.text`. */
export function cut(visible: VisibleText, limit: number = MESSAGE_PREFERRED_LIMIT): VisibleText[] {
  if (visible.text.length === 0) return []
  let start = 0
  return cutPoints(visible.text, limit).map(end => {
    const piece = slice(visible, start, end)
    start = end
    return piece
  })
}
