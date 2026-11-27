// Telegram message chunking.
//
// Telegram caps a message at 4096 characters, counted AFTER entity parsing:
// tags count nothing, `&amp;` counts one character, lengths are UTF-16 code
// units. We chunk at 4000 by default to leave headroom.
//
// The HTML is tokenized first (supported tags, the entities Telegram decodes,
// single code points), so a cut only ever lands between tokens: never inside
// a tag, an entity or a surrogate pair. Boundary preference (port of
// gateway.py:514-562):
//   1. Paragraph (\n\n) — the last paragraph break that fits
//   2. Line (\n) — the last line break that fits
//   3. Hard cut at the last token that fits — only when neither exists
//
// Every supported tag still open at a cut is closed on the emitted chunk and
// reopened (with its attributes, so a link keeps its href) on the next, so
// each chunk on its own is valid HTML Telegram accepts with parse_mode=HTML.

import { escapeHtml, escapeHtmlAttr } from './html.js'

export const TELEGRAM_MAX_MESSAGE = 4096
const DEFAULT_MAX = 4000

// Telegram's HTML tags (https://core.telegram.org/bots/api#html-style) and the
// aliases it accepts. Anything else is literal text to Telegram's parser.
const SUPPORTED_TAGS: ReadonlySet<string> = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'br',
])
const VOID_TAGS: ReadonlySet<string> = new Set(['br'])
// The only named entities Telegram decodes; every numeric entity is decoded too.
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"']])

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/y

interface Token {
  /** The source text of the token. */
  raw: string
  /** What Telegram shows for it; its length is what Telegram counts. */
  plain: string
  /** Set for a supported opening or closing tag. */
  tag?: { name: string; closing: boolean }
}

function decodeEntity(match: RegExpExecArray): string | undefined {
  const [, decimal, hex, name] = match
  if (name !== undefined) return NAMED_ENTITIES.get(name)
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16)
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined
  return String.fromCodePoint(code)
}

// `markup` false: plain text, where every code point is literal (no tags, no entities).
function tokenize(html: string, markup = true): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < html.length) {
    const char = markup ? html[i] : undefined
    if (char === '<') {
      TAG_RE.lastIndex = i
      const match = TAG_RE.exec(html)
      const name = match?.[2]?.toLowerCase()
      if (match && name !== undefined && SUPPORTED_TAGS.has(name)) {
        const closing = match[1] === '/'
        const plain = name === 'br' && !closing ? '\n' : ''
        tokens.push({ raw: match[0], plain, ...(VOID_TAGS.has(name) ? {} : { tag: { name, closing } }) })
        i += match[0].length
        continue
      }
    } else if (char === '&') {
      ENTITY_RE.lastIndex = i
      const match = ENTITY_RE.exec(html)
      const decoded = match ? decodeEntity(match) : undefined
      if (match && decoded !== undefined) {
        tokens.push({ raw: match[0], plain: decoded })
        i += match[0].length
        continue
      }
    }
    const point = String.fromCodePoint(html.codePointAt(i) ?? 0)
    tokens.push({ raw: point, plain: point })
    i += point.length
  }
  return tokens
}

/** The text Telegram shows for `html`: supported tags dropped, its entities decoded, anything else literal. */
export function htmlToPlainText(html: string): string {
  return tokenize(html).map(token => token.plain).join('')
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/**
 * The plain fallback of `html`: the text Telegram shows, with each link's destination kept after its text as
 * «text (url)» (a link whose text is its URL stays as it is). Destinations are added in order only while the result
 * shows at most `budget` characters, so a part fitted to Telegram's limit still fits once downgraded.
 */
export function plainTextWithLinks(html: string, budget: number = TELEGRAM_MAX_MESSAGE): string {
  const segments = plainLinkSegments(html)
  let total = segments.reduce((sum, segment) => sum + (segment.link === true ? 0 : segment.text.length), 0)
  let out = ''
  for (const segment of segments) {
    if (segment.link !== true) out += segment.text
    else if (total + segment.text.length <= budget) {
      out += segment.text
      total += segment.text.length
    }
  }
  return out
}

function plainLinkSegments(html: string): { text: string; link?: boolean }[] {
  const tokens = tokenize(html)
  const segments: { text: string; link?: boolean }[] = []
  const links: { href: string; start: number }[] = []
  let shown = ''
  for (const token of tokens) {
    if (token.tag?.name === 'a' && !token.tag.closing) {
      const match = HREF_RE.exec(token.raw)
      links.push({ href: htmlToPlainText(match?.[1] ?? match?.[2] ?? ''), start: shown.length })
    } else if (token.tag?.name === 'a' && token.tag.closing) {
      const link = links.pop()
      const text = link === undefined ? '' : shown.slice(link.start)
      if (link !== undefined && link.href.trim() !== '' && text.trim() !== link.href.trim()) {
        segments.push({ text: shown }, { text: ' (' + link.href + ')', link: true })
        // Positions of still-open outer links restart at the new segment.
        for (const outer of links) outer.start = Math.max(0, outer.start - shown.length)
        shown = ''
      }
    }
    shown += token.plain
  }
  segments.push({ text: shown })
  return segments
}

/** Expand every destination before fitting the fallback to Telegram's message limit. */
export function splitPlainFallback(html: string, max: number = TELEGRAM_MAX_MESSAGE): string[] {
  const segments = plainLinkSegments(html)
  const tokens = segments.flatMap(({ text, link }) => {
    if (!link || text.length - 3 > max) return tokenize(text, false)
    if (text.length <= max) return [{ raw: text, plain: text }]
    // The URL itself still fits. Keep it together even if the parentheses spill over.
    const url = text.slice(2, -1)
    return [{ raw: ' (', plain: ' (' }, { raw: url, plain: url }, { raw: ')', plain: ')' }]
  })
  return splitTokens(segments.map(segment => segment.text).join(''), tokens, max)
}

/** The length Telegram checks against its message limit: the text after entity parsing, in UTF-16 units. */
export function telegramTextLength(html: string): number {
  return htmlToPlainText(html).length
}

interface OpenTag { name: string; raw: string }

// Apply a token to the stack of open tags. A closer without a matching opener
// is left alone: the input was malformed and the validator downgrades it.
function track(stack: OpenTag[], token: Token): void {
  if (token.tag === undefined) return
  if (!token.tag.closing) {
    stack.push({ name: token.tag.name, raw: token.raw })
    return
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.name === token.tag.name) {
      stack.splice(i, 1)
      return
    }
  }
}

// For each token: true when it sits inside a <pre> block, where whitespace is content Telegram shows as written.
function preformatted(tokens: readonly Token[]): boolean[] {
  let depth = 0
  return tokens.map(token => {
    if (token.tag?.name === 'pre') depth = Math.max(0, depth + (token.tag.closing ? -1 : 1))
    return depth > 0
  })
}

export class PreformattedDocumentError extends Error {
  constructor(readonly html: string) {
    super('Preformatted whitespace requires a document')
  }
}

// Find suffixes that can be split into nonblank parts. A suffix with no visible text can be
// left out at the end of a reply. Interior whitespace must still fit alongside visible text.
function balancedCuts(tokens: readonly Token[], from: number, max: number): (start: number, preferred: number) => number {
  const length = tokens.length
  const contentEnd = tokens.findLastIndex(token => token.plain.trim().length > 0) + 1
  const offsets = [0]
  for (const token of tokens) offsets.push(offsets[offsets.length - 1]! + token.plain.length)
  const firstEnd: number[] = new Array(length)
  let nextViable = contentEnd
  let endAfterVisible: number | undefined
  for (let start = contentEnd - 1; start >= from; start--) {
    if (tokens[start]!.plain.trim().length > 0) endAfterVisible = nextViable
    if (endAfterVisible !== undefined && offsets[endAfterVisible]! - offsets[start]! <= max) {
      firstEnd[start] = endAfterVisible
      nextViable = start
    }
  }
  const previousViable: number[] = new Array(length + 1)
  let previous = -1
  for (let end = from; end <= length; end++) {
    if (end >= contentEnd || firstEnd[end] !== undefined) previous = end
    previousViable[end] = previous
  }
  return (start, preferred) => {
    if (start >= contentEnd) return contentEnd > 0 ? start : -1
    const first = firstEnd[start]
    if (first === undefined) return -1
    const eligible = previousViable[preferred]!
    return eligible >= first ? eligible : first
  }
}

// The end (exclusive) of the chunk starting at `start`, which shows at most `max` characters.
function chooseCut(tokens: readonly Token[], start: number, max: number): number {
  let used = 0
  let lastParagraph = -1
  let lastLine = -1
  let content = false
  let previous = ''
  let end = start
  for (; end < tokens.length; end++) {
    const token = tokens[end]!
    if (used + token.plain.length > max) break
    used += token.plain.length
    if (token.plain.length === 0) continue
    // A boundary counts only once the chunk shows something: a part of blank lines alone is not sent.
    if (token.plain === '\n' && content) {
      if (previous === '\n') lastParagraph = end + 1
      lastLine = end + 1
    }
    if (token.plain.trim().length > 0) content = true
    previous = token.plain
  }
  if (end >= tokens.length) return tokens.length
  const boundary = lastParagraph > start ? lastParagraph : lastLine > start ? lastLine : -1
  if (boundary > 0) {
    // Closing tags right after a line break still belong to this chunk.
    let cut = boundary
    while (cut < end && tokens[cut]!.tag?.closing === true) cut += 1
    return cut
  }
  // An opening tag right before a hard cut belongs to the next chunk.
  let cut = end
  while (cut > start + 1 && tokens[cut - 1]!.tag?.closing === false) cut -= 1
  return Math.max(cut, start + 1)
}

/**
 * Split Telegram HTML into chunks that each show at most `max` characters as
 * Telegram counts them (default 4000) and are valid HTML on their own: every
 * supported tag open at a cut is closed and reopened. A chunk that would show
 * only whitespace is dropped (Telegram refuses an empty message).
 */
export function splitMessage(text: string, max: number = DEFAULT_MAX): string[] {
  return splitTokens(text, tokenize(text), max)
}

/**
 * Split text sent WITHOUT parse_mode HTML (plain or MarkdownV2) by its raw
 * length: `<b>` and `&amp;` are literal there, so no tag is balanced and no
 * entity is decoded. Same boundary preference as splitMessage.
 */
export function splitPlainMessage(text: string, max: number = DEFAULT_MAX): string[] {
  return splitTokens(text, tokenize(text, false), max)
}

interface HtmlRedaction {
  redact: (html: string) => string
  secrets: readonly string[]
}

function balancedSeam(left: string, right: string): { close: number; reopen: number } {
  const closing = /(?:<\/[a-z][\w-]*>)+$/i.exec(left)
  if (!closing) return { close: 0, reopen: 0 }
  const open: OpenTag[] = []
  for (const token of tokenize(left.slice(0, closing.index))) track(open, token)
  const prefix = open.map(tag => tag.raw).join('')
  if (prefix && right.startsWith(prefix) &&
    open.slice().reverse().map(tag => `</${tag.name}>`).join('') === closing[0].toLowerCase()) {
    return { close: closing[0].length, reopen: prefix.length }
  }
  return { close: 0, reopen: 0 }
}

/** Rebuild only the unattempted tail of a saved plan when current redaction changes its source. */
export function resumeMessagePlan(parts: readonly string[], attempted: number, redaction: HtmlRedaction): string[] | undefined {
  if (attempted >= parts.length) return undefined
  const body: string[] = []
  let from = 0
  let offset = 0
  for (const [index, part] of parts.entries()) {
    const { close, reopen } = balancedSeam(part, parts[index + 1] ?? '')
    const text = part.slice(from, part.length - close)
    body.push(text)
    if (index < attempted) offset += text.length
    from = reopen
  }
  const html = body.join('')
  if (redaction.redact(html) === html) return undefined
  return splitMessageFrom(html, offset, DEFAULT_MAX, redaction)
}

/** Locate an old receipt cut in a separately rendered, redacted copy of the reply. */
export function redactedRenderOffset(original: string, redacted: string, cut: number): number {
  let prefix = 0
  while (prefix < cut && original[prefix] === redacted[prefix]) prefix += 1
  if (prefix === cut) return cut
  let oldEnd = original.length
  let newEnd = redacted.length
  while (oldEnd > prefix && newEnd > prefix && original[oldEnd - 1] === redacted[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  if (cut >= oldEnd) return newEnd + cut - oldEnd

  // Use Myers' edit frontier to map cuts between redactions. Keep only the furthest path on
  // each diagonal and the revised offset where that path crossed the old cut.
  type Path = { end: number; mapped: number | undefined }
  let frontier = new Map<number, Path>([[1, { end: prefix, mapped: undefined }]])
  for (let edits = 0; edits <= 512; edits++) {
    const next = new Map<number, Path>()
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      const insertion = frontier.get(diagonal + 1)
      const deletion = frontier.get(diagonal - 1)
      const fromInsertion = insertion && insertion.end - diagonal <= newEnd ? insertion.end : -1
      const fromDeletion = deletion && deletion.end < oldEnd ? deletion.end + 1 : -1
      let before = Math.max(fromInsertion, fromDeletion)
      if (before < 0) continue
      let after = before - diagonal
      let mapped = (fromDeletion > fromInsertion ? deletion : insertion)?.mapped
      do {
        if (before === cut && mapped === undefined) mapped = after
        if (before === oldEnd || after === newEnd || original[before] !== redacted[after]) break
        before += 1
        after += 1
      } while (true)
      if (before === oldEnd && after === newEnd) return mapped ?? newEnd
      next.set(diagonal, { end: before, mapped })
    }
    frontier = next
  }
  // Resume from the proven common prefix when the edit budget runs out. This may repeat text.
  return prefix
}

// Move a seam past any configured value it would otherwise split.
function afterCrossingValues(text: string, offset: number, values: Iterable<string>): number {
  let previous: number
  do {
    previous = offset
    for (const value of values) {
      const from = Math.max(0, offset - value.length + 1)
      const start = text.slice(from, offset + value.length - 1).indexOf(value)
      if (start >= 0 && from + start < offset) offset = from + start + value.length
    }
  } while (previous < offset && offset < text.length)
  return offset
}

/** Keep saved plain receipt slots, moving only fragments of newly configured secrets across a seam. */
export function protectPlainFallbackCuts(parts: readonly string[], secrets: readonly string[]): readonly string[] {
  const values = secrets.filter(secret => secret.length >= 4)
  if (parts.length < 2 || values.length === 0) return parts
  const body = parts.join('')
  let start = 0
  let originalEnd = 0
  return parts.map(part => {
    originalEnd += part.length
    const end = Math.max(start, afterCrossingValues(body, originalEnd, values))
    const piece = body.slice(start, end)
    start = end
    return piece
  })
}

/**
 * Split the Telegram HTML `html` from source offset `offset` on, as splitMessage does, with every supported tag open
 * at that offset reopened on the first chunk. An offset inside a tag or an entity starts at that token, so a cut
 * taken from another chunker repeats a character rather than losing one.
 */
export function splitMessageFrom(html: string, offset: number, max: number = DEFAULT_MAX,
  redaction?: HtmlRedaction): string[] {
  const tokens = tokenize(html)
  // Keep the original offset. If it cuts a newly configured secret in half, exclude the
  // unsent fragment before applying current redaction to the entire remaining HTML.
  if (redaction && offset > 0) {
    const forms = new Set(redaction.secrets.filter(secret => secret.length >= 4).flatMap(secret =>
      [secret, escapeHtml(secret), escapeHtmlAttr(secret), secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')]))
    offset = afterCrossingValues(html, offset, forms)
  }
  const open: OpenTag[] = []
  let start = 0
  let position = 0
  while (start < tokens.length && position + tokens[start]!.raw.length <= offset) {
    track(open, tokens[start]!)
    position += tokens[start]!.raw.length
    start += 1
  }
  if (redaction) {
    if (position >= html.length) return []
    const tail = open.map(tag => tag.raw).join('') + html.slice(position)
    return splitMessage(redaction.redact(tail), max)
  }
  return splitTokens(html, tokens, max, start, open)
}

function splitTokens(text: string, tokens: readonly Token[], max: number, from = 0, inherited: OpenTag[] = [],
  rebalance?: (start: number, preferred: number) => number): string[] {
  if (max <= 0) throw new Error(`splitMessage: max must be positive, got ${max}`)
  if (text.length === 0) return []
  const length = tokens.reduce((sum, token) => sum + token.plain.length, 0)
  if (from === 0 && length <= max) {
    if (length > 0 && tokens.some(token => token.tag?.name === 'pre') && tokens.every(token => token.plain.trim() === '')) {
      throw new PreformattedDocumentError(text)
    }
    return [text]
  }

  const inPre = preformatted(tokens)
  const chunks: string[] = []
  const open: OpenTag[] = [...inherited]
  let start = from
  while (start < tokens.length) {
    const preferred = chooseCut(tokens, start, max)
    const cut = rebalance ? rebalance(start, preferred) : preferred
    if (cut < 0) {
      throw new PreformattedDocumentError(inherited.map(tag => tag.raw).join('') +
        tokens.slice(from).map(token => token.raw).join(''))
    }
    if (cut === start) break
    const prefix = open.map(tag => tag.raw).join('')
    let body = ''
    let shown = ''
    let preWhitespace = false
    for (let i = start; i < cut; i++) {
      const token = tokens[i]!
      if (inPre[i] && token.plain.length > 0) preWhitespace = true
      body += token.raw
      shown += token.plain
      track(open, token)
    }
    const suffix = [...open].reverse().map(tag => `</${tag.name}>`).join('')
    if (shown.trim().length > 0) chunks.push(prefix + body + suffix)
    else if (preWhitespace) {
      return splitTokens(text, tokens, max, from, inherited, balancedCuts(tokens, from, max))
    }
    start = cut
  }
  return chunks
}
