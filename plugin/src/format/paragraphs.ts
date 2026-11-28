// Delivery-side paragraph safety net for final answers (TOV rule 6, see format-check.ts P450).
//
// When an answer arrives as one block longer than SPLIT_ABOVE characters with no blank line, runs of
// prose lines are grouped into paragraphs of 1-3 sentences (at most PARAGRAPH_MAX characters) and a
// prose line longer than PARAGRAPH_MAX is split at sentence ends. A bold-only line becomes a heading
// and a list stays one contiguous block; both get a blank line around them. A paragraph ends only
// after a finished sentence unless it would grow past PARAGRAPH_MAX. Only whitespace
// between two sentences or lines changes (to a blank line); no word is added, removed or moved. Code
// fences, multi-line <pre> and <blockquote> elements, list items, headings, quotes and tables (outer pipes or
// not) stay as written, and no split lands
// inside inline code, a link, a URL, an HTML element or tag or a bold/italic/strike/spoiler span.

import { BLOCK_START_RE } from './format-check.js'
import { fenceProtectedLines } from './rich.js'

const SPLIT_ABOVE = 600
const PARAGRAPH_MAX = 450
const SENTENCES_MAX = 3

// Spans a sentence split must never cut: inline code, links, bold/italic/strike/spoiler spans, a whole
// HTML element on one line (`<pre>…</pre>`, `<i>…</i>`), any other tag and URLs.
const PROTECTED_RE = new RegExp([
  '`[^`\\n]*`', '\\[[^\\]\\n]*\\]\\([^)\\s]*\\)', '\\*\\*[^*\\n]+\\*\\*', '__[^_\\n]+__',
  '(?<![*\\p{L}\\d])\\*[^*\\s][^*\\n]*\\*(?![*\\p{L}\\d])', '(?<![_\\p{L}\\d])_[^_\\s][^_\\n]*_(?![_\\p{L}\\d])',
  '~~[^~\\n]+~~', '\\|\\|[^|\\n]+\\|\\|', '<([a-z][a-z0-9]*)\\b[^>\\n]*>[^\\n]*?</\\1\\s*>', '<[^>\\n]+>', 'https?://\\S+',
].join('|'), 'giu')

// A multi-line <pre> or <blockquote> element: its lines stay as written, like a code fence.
const BLOCK_ELEMENTS: ReadonlyArray<{ open: RegExp; close: RegExp }> = [
  { open: /<pre\b[^>]*>/giu, close: /<\/pre\s*>/giu },
  { open: /<blockquote\b[^>]*>/giu, close: /<\/blockquote\s*>/giu },
]

function elementProtectedLines(lines: readonly string[], open: RegExp, close: RegExp): boolean[] {
  let depth = 0
  return lines.map(line => {
    const wasOpen = depth > 0
    depth = Math.max(0, depth + (line.match(open)?.length ?? 0) - (line.match(close)?.length ?? 0))
    return wasOpen || depth > 0
  })
}

// A GFM table delimiter row, with or without outer pipes: `--- | :---:` or `| --- | --- |`.
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u

/** Marks GFM tables (header row, delimiter row and the body rows that carry a pipe), outer pipes or not. */
function tableProtectedLines(lines: readonly string[]): boolean[] {
  const table = lines.map(() => false)
  for (const [index, line] of lines.entries()) {
    const header = lines[index - 1]
    if (!TABLE_DELIMITER_RE.test(line) || header === undefined || !header.includes('|')) continue
    table[index - 1] = true
    table[index] = true
    for (let row = index + 1; row < lines.length && (lines[row] ?? '').includes('|') && (lines[row] ?? '').trim(); row++) {
      table[row] = true
    }
  }
  return table
}

// Sentence end: terminal punctuation and closing marks, whitespace, then an upper-case letter or a
// digit (optionally behind opening marks). Lower-case continuations ("т. е. так") never split.
const SENTENCE_END_RE = /([.!?…]+[»"”')\]*_`~|]*)(\s+)(?=[«"“(*_`[~|]*[\p{Lu}\d])/gu

// Words that end with a period without ending the sentence: initials and common abbreviations.
const ABBREVIATION_RE = /(?:^|[^\p{L}])(?:\p{L}|г|ул|им|стр|рис|см|Dr|Mr|Mrs|Ms|St|vs)\.$/u

function protectedRanges(line: string): Array<[number, number]> {
  return [...line.matchAll(PROTECTED_RE)].map(match => [match.index, match.index + match[0].length])
}

/** Cuts a prose line into sentences; each piece keeps the whitespace that followed it. */
function sentences(line: string): Array<{ text: string; gap: string }> {
  const ranges = protectedRanges(line)
  const pieces: Array<{ text: string; gap: string }> = []
  let start = 0
  for (const match of line.matchAll(SENTENCE_END_RE)) {
    const end = match.index + (match[1] as string).length
    if (ranges.some(([from, to]) => from < end && end < to)) continue
    if (match[1] === '.' && ABBREVIATION_RE.test(line.slice(start, end))) continue
    pieces.push({ text: line.slice(start, end), gap: match[2] as string })
    start = end + (match[2] as string).length
  }
  pieces.push({ text: line.slice(start), gap: '' })
  return pieces
}

/** Groups sentences into paragraphs of at most SENTENCES_MAX sentences and PARAGRAPH_MAX chars. */
function splitLine(line: string): string {
  const paragraphs: string[] = []
  let current = ''
  let count = 0
  let gap = ''
  for (const piece of sentences(line)) {
    if (count > 0 && (count >= SENTENCES_MAX || current.length + gap.length + piece.text.length > PARAGRAPH_MAX)) {
      paragraphs.push(current)
      current = ''
      count = 0
    }
    current += (count > 0 ? gap : '') + piece.text
    count++
    gap = piece.gap
  }
  paragraphs.push(current)
  return paragraphs.join('\n\n')
}

type LineKind = 'prose' | 'list' | 'heading' | 'other'

const LIST_ITEM_RE = /^\s*(?:[-*+]\s|\d+[.)]\s)/u
// A line that is only a bold span: the answer's title or a section title.
const BOLD_LINE_RE = /^\s*(?:\*\*[^*\n]+\*\*|<b>[^<\n]+<\/b>|<strong>[^<\n]+<\/strong>)\s*$/u
// A line whose last sentence is finished: a paragraph may end after it.
const SENTENCE_DONE_RE = /[.!?…][»"”')\]*_`~|]*\s*$/u

function lineKind(line: string, inFence: boolean, previous: LineKind | undefined): LineKind {
  if (inFence) return 'other'
  if (LIST_ITEM_RE.test(line)) return 'list'
  if (BLOCK_START_RE.test(line)) return 'other'
  // An indented line under a list item continues that item.
  if (previous === 'list' && /^\s+\S/u.test(line)) return 'list'
  if (BOLD_LINE_RE.test(line)) return 'heading'
  return 'prose'
}

/** Groups consecutive prose lines into paragraphs of at most SENTENCES_MAX sentences and PARAGRAPH_MAX chars. */
function groupProse(lines: readonly string[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  let count = 0
  let length = 0
  const flush = (): void => {
    if (current.length) paragraphs.push(current.join('\n'))
    current = []
    count = 0
    length = 0
  }
  for (const line of lines) {
    if (line.length > PARAGRAPH_MAX) {
      flush()
      paragraphs.push(splitLine(line))
      continue
    }
    const added = sentences(line).length
    // A hard-wrapped sentence stays whole: the sentence limit cuts only after a finished sentence.
    const sentenceDone = SENTENCE_DONE_RE.test(current.at(-1) ?? '')
    if (current.length && ((sentenceDone && count + added > SENTENCES_MAX) || length + 1 + line.length > PARAGRAPH_MAX)) flush()
    length += (current.length ? 1 : 0) + line.length
    current.push(line)
    count += added
  }
  flush()
  return paragraphs.join('\n\n')
}

/**
 * Splits a final answer that is one long block without blank lines into paragraphs: long prose
 * lines at sentence ends, runs of short prose lines into groups of 1-3 sentences, with a blank line
 * around a list and after a bold first line. Any other text is returned unchanged. Deterministic, so
 * a retried delivery sends the same parts.
 */
export function splitLongBlock(text: string): string {
  if (text.length <= SPLIT_ABOVE) return text
  // Trailing line breaks are kept as they are and do not count as a blank line.
  const content = text.replace(/\s+$/u, '')
  const lines = content.split('\n')
  const elements = BLOCK_ELEMENTS.map(({ open, close }) => elementProtectedLines(lines, open, close))
  const table = tableProtectedLines(lines)
  // Fences, multi-line <pre>/<blockquote> elements and tables are kept as written: never a blank line inside.
  const fence = fenceProtectedLines(lines).map((inFence, index) =>
    inFence || table[index] === true || elements.some(element => element[index] === true))
  if (lines.some((line, index) => !fence[index] && line.trim() === '')) return text
  const runs: Array<{ kind: LineKind; lines: string[] }> = []
  for (const [index, line] of lines.entries()) {
    const previous = runs.at(-1)
    const kind = lineKind(line, fence[index] === true, previous?.kind)
    if (previous && previous.kind === kind && kind !== 'heading') previous.lines.push(line)
    else runs.push({ kind, lines: [line] })
  }
  return runs.map((run, index) => {
    const body = run.kind === 'prose' ? groupProse(run.lines) : run.lines.join('\n')
    if (index === 0) return body
    const before = runs[index - 1]!.kind
    // A list and a bold title stand apart; prose next to code, quotes or tables keeps its line break.
    const apart = before === 'list' || before === 'heading' || run.kind === 'list' || run.kind === 'heading'
    return (apart ? '\n\n' : '\n') + body
  }).join('') + text.slice(content.length)
}
