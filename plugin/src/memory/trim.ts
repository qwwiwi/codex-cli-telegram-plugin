// Byte-bounded entry trim, shared by the hot journal (recent.md) and the
// session-boundary snapshot (handoff.md). Added 2026-09-13.
//
// The original trim mirrored gateway.py: keep the last N *lines*. Line count
// is a poor proxy for size — 600 lines of ~200-char Russian snippets is ~76 KB
// against a 20 KB cap, so the file parked permanently ABOVE the threshold and
// re-trimmed on every single append. As a result, recent.md and
// handoff.md sat at 52k chars each, blowing the 40k context budget they are
// @-included into.
//
// keepLines stays as the first, cheap cut (bounds how much we ever re-scan);
// the byte cap is then enforced by dropping whole entries off the top. A
// single entry larger than maxBytes is kept as-is — an empty journal is worse
// than an oversized one.

export interface TrimEntriesInput {
  /** Full current file content, header included. */
  content: string
  /** File header re-emitted verbatim at the top of the trimmed result. */
  header: string
  /** Upper bound on retained lines — the cheap first cut. 0 disables it. */
  keepLines: number
  /** Hard upper bound on the result size in bytes. */
  maxBytes: number
  /**
   * Entry-boundary predicate, given all lines and the index to judge. Defaults
   * to the bare `### ` prefix, which suits flat journals (recent.md). handoff.md
   * NESTS recent.md entries inside a snapshot, so both levels start with `### `
   * and the default would cut on an inner line — decapitating the
   * `[session_end:]` marker and leaving the body orphaned. Such callers pass
   * their own marker predicate.
   *
   * It takes the surrounding lines, not just one line, because a marker is
   * forgeable by text alone: a turn body that quotes one must not become a cut
   * point, or the trim promotes the forgery to "where we left off"
   * (2026-11-17).
   */
  isEntryStart?: (lines: string[], index: number) => boolean
}

const ENTRY_PREFIX = '### '
const defaultIsEntryStart = (lines: string[], index: number): boolean =>
  lines[index]!.startsWith(ENTRY_PREFIX)

type EntryPredicate = (lines: string[], index: number) => boolean

/** Index of the first entry header at or after `from`, or -1. */
function findEntry(lines: string[], from: number, isEntryStart: EntryPredicate): number {
  for (let i = from; i < lines.length; i++) {
    if (isEntryStart(lines, i)) return i
  }
  return -1
}

/** Index of the last entry header, or -1 when the content holds no entry. */
function findLastEntry(lines: string[], isEntryStart: EntryPredicate): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isEntryStart(lines, i)) return i
  }
  return -1
}

/** Result of a trim: what stays, and what the cut dropped. */
export interface TrimEntriesResult {
  /** Header plus the retained entries — what the file should now hold. */
  content: string
  /**
   * The dropped prefix, verbatim and without the header, so a caller that must
   * not lose data can move it elsewhere. `''` when nothing was dropped.
   */
  removed: string
}

/**
 * Trim `content` to at most `maxBytes`, cutting on entry boundaries so the
 * result always starts at an entry header directly under `header`.
 *
 * @param input - Content, header, line pre-cut, byte cap, boundary predicate.
 * @returns Header plus the retained entries. Header alone when `content` holds
 *          no entry at all — returning the raw tail would break the cap and
 *          leave a headless fragment that reads like a current entry.
 */
export function trimEntriesToBytes(input: TrimEntriesInput): string {
  return trimEntriesWithRemoved(input).content
}

/**
 * Same cut as {@link trimEntriesToBytes}, but it also hands back what it
 * dropped (2026-11-17).
 *
 * handoff.md is append-only with bounded size, and its emergency byte trim
 * drops whole boundary snapshots. Those snapshots are not redundant: recent.md
 * rotates, so a snapshot old enough to be cut here is routinely the only copy
 * of the turns inside it. Measured on production defaults before this existed:
 * nine turns gone from handoff.md, handoff-archive.md and recent.md at once in
 * a single boundary. The caller archives `removed` and, when the archive
 * refuses, keeps the oversized file rather than cutting it.
 *
 * @param input - Content, header, line pre-cut, byte cap, boundary predicate.
 * @returns The trimmed content and the dropped prefix (header excluded).
 */
export function trimEntriesWithRemoved(input: TrimEntriesInput): TrimEntriesResult {
  const isEntryStart = input.isEntryStart ?? defaultIsEntryStart
  const allLines = input.content.split('\n')

  // Work in indices of the FULL line array throughout, never on a slice of it
  // (2026-11-17). The predicate judges a line by what sits above it, and a
  // slice has nothing above its first line — so every context rule reads that
  // line as a valid header. Passing the pre-cut slice therefore let the cut
  // boundary MANUFACTURE a header out of whatever happened to land there,
  // including a marker an agent merely quoted inside a turn body. With the
  // production default (trim_keep_lines: 600) that forgery became the top of
  // the file, i.e. "where we left off", and the real entry was dropped.
  //
  // `slice(-0)` is `slice(0)` in JS — "keep the last 0 lines" would silently
  // keep everything. Treat any non-positive keepLines as "no pre-cut".
  const preCutFrom = input.keepLines > 0 ? Math.max(0, allLines.length - input.keepLines) : 0

  // Start at an entry boundary. When the pre-cut landed INSIDE the newest
  // entry (its header is above the cut), fall back to the full content from
  // that header — losing the header would orphan the body.
  let from = findEntry(allLines, preCutFrom, isEntryStart)
  if (from === -1) {
    from = findLastEntry(allLines, isEntryStart)
    // No entries at all: the whole body goes, so report the whole body as
    // removed — a caller that archives it keeps text it would otherwise lose.
    if (from === -1) {
      return { content: input.header, removed: stripFileHeader(input.content, input.header) }
    }
  }

  while (
    Buffer.byteLength(input.header + allLines.slice(from).join('\n'), 'utf8') > input.maxBytes
  ) {
    const next = findEntry(allLines, from + 1, isEntryStart)
    if (next === -1) break // one entry left — keep it oversized
    from = next
  }

  // Exact complements by LINE INDEX: kept + removed reassembles the input, so
  // no line can fall between the two.
  const removed = stripFileHeader(allLines.slice(0, from).join('\n'), input.header)
  return {
    content: input.header + allLines.slice(from).join('\n'),
    removed,
  }
}

/**
 * Drop the file header from a cut prefix, so the archive records turns rather
 * than a stray copy of the header. Exported because every bound that archives
 * its cut needs the SAME rule — two spellings of "de-header this" drifted
 * apart once already.
 *
 * Matched line-wise, not with `replace(header, '')`: a header constant ends in
 * a blank line, and a hand-edited file may not have one — the string replace
 * then silently matched nothing and leaked the header into the archive.
 *
 * @param text - A cut prefix of the file, header possibly included.
 * @param header - The file header constant.
 * @returns `text` without its leading header lines; `''` when nothing is left.
 */
export function stripFileHeader(text: string, header: string): string {
  // Compare with the line ending stripped: a CRLF file's header line ends in
  // `\r`, so a raw comparison missed it and the header rode into the archive as
  // if it were a turn (2026-11-17).
  const headLines = header.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  const lines = text.split('\n')
  while (
    lines.length > 0 &&
    (lines[0]!.trim().length === 0 || headLines.includes(lines[0]!.trimEnd()))
  ) {
    lines.shift()
  }
  const out = lines.join('\n').trimEnd()
  return out.length > 0 ? out + '\n' : ''
}
