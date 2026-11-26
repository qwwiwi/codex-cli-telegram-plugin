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

const NBSP_ENTITY = '&#160;'

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

/**
 * Split the Telegram HTML `html` from source offset `offset` on, as splitMessage does, with every supported tag open
 * at that offset reopened on the first chunk. An offset inside a tag or an entity starts at that token, so a cut
 * taken from another chunker repeats a character rather than losing one.
 */
export function splitMessageFrom(html: string, offset: number, max: number = DEFAULT_MAX): string[] {
  const tokens = tokenize(html)
  const open: OpenTag[] = []
  let start = 0
  let position = 0
  while (start < tokens.length && position + tokens[start]!.raw.length <= offset) {
    track(open, tokens[start]!)
    position += tokens[start]!.raw.length
    start += 1
  }
  if (start === 0 && open.length === 0) return splitTokens(html, tokens, max)
  return splitTokens(html, tokens, max, start, open)
}

function splitTokens(text: string, tokens: readonly Token[], max: number, from = 0, inherited: OpenTag[] = []): string[] {
  if (max <= 0) throw new Error(`splitMessage: max must be positive, got ${max}`)
  if (text.length === 0) return []
  if (from === 0 && tokens.reduce((sum, token) => sum + token.plain.length, 0) <= max) return [text]

  const inPre = preformatted(tokens)
  // Whitespace after the last visible character is trailing: Telegram trims it, so a part of it alone is dropped.
  let lastContent = tokens.length - 1
  while (lastContent >= 0 && tokens[lastContent]!.plain.trim().length === 0) lastContent -= 1
  const chunks: string[] = []
  const open: OpenTag[] = [...inherited]
  let start = from
  while (start < tokens.length) {
    const cut = chooseCut(tokens, start, max)
    const prefix = open.map(tag => tag.raw).join('')
    let body = ''
    let shown = ''
    let preWhitespace = -1
    for (let i = start; i < cut; i++) {
      const token = tokens[i]!
      if (preWhitespace < 0 && inPre[i] === true && token.plain.length > 0) preWhitespace = body.length
      body += token.raw
      shown += token.plain
      track(open, token)
    }
    const suffix = [...open].reverse().map(tag => `</${tag.name}>`).join('')
    if (shown.trim().length > 0) chunks.push(prefix + body + suffix)
    else if (preWhitespace >= 0 && cut <= lastContent) {
      // Preformatted whitespace is content: a hard cut through a long run of it keeps the part, showing its first
      // space as a no-break space so Telegram does not refuse a message of whitespace alone (a part without a plain
      // space gets one no-break space added in front).
      const anchored = body[preWhitespace] === ' '
        ? body.slice(0, preWhitespace) + NBSP_ENTITY + body.slice(preWhitespace + 1)
        : body.slice(0, preWhitespace) + NBSP_ENTITY + body.slice(preWhitespace)
      chunks.push(prefix + anchored + suffix)
    }
    start = cut
  }
  return chunks
}
