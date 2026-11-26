// Delivery-side paragraph safety net for final answers (TOV rule 6, see format-check.ts P450).
//
// When an answer arrives as one block longer than SPLIT_ABOVE characters with no blank line, every
// prose line longer than PARAGRAPH_MAX is split into paragraphs of 1-3 sentences at sentence ends.
// Only the whitespace between two sentences changes (to a blank line); no word is added, removed or
// moved. Code fences, <pre> blocks, list items, headings, quotes and tables stay as written, and no
// split lands inside inline code, a link, a URL, an HTML element or tag or a bold/italic/strike/spoiler span.

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

// A multi-line <pre> block: its lines stay as written, like a code fence.
const PRE_OPEN_RE = /<pre\b[^>]*>/giu
const PRE_CLOSE_RE = /<\/pre\s*>/giu

function preProtectedLines(lines: readonly string[]): boolean[] {
  let open = false
  return lines.map(line => {
    const wasOpen = open
    const opens = line.match(PRE_OPEN_RE)?.length ?? 0
    const closes = line.match(PRE_CLOSE_RE)?.length ?? 0
    open = opens > closes || (open && closes === 0)
    return wasOpen || open
  })
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

/**
 * Splits a final answer that is one long block without blank lines into paragraphs at sentence
 * ends. Any other text is returned unchanged. Deterministic, so a retried delivery sends the same
 * parts.
 */
export function splitLongBlock(text: string): string {
  if (text.length <= SPLIT_ABOVE) return text
  const lines = text.split('\n')
  const pre = preProtectedLines(lines)
  const fence = fenceProtectedLines(lines).map((inFence, index) => inFence || pre[index] === true)
  if (lines.some((line, index) => !fence[index] && line.trim() === '')) return text
  return lines.map((line, index) =>
    fence[index] || BLOCK_START_RE.test(line) || line.length <= PARAGRAPH_MAX ? line : splitLine(line),
  ).join('\n')
}
