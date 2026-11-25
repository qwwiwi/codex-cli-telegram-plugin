// Session-boundary handoff snapshot (2026-06-05).
//
// On a session boundary the in-context conversation is discarded, but
// recent.md persists on disk. SessionStart fires with `source`:
//   * clear   — /new or /clear wiped the context
//   * compact — auto-compact or /compact replaced it with a summary
//   * startup — a fresh process (e.g. after `systemctl restart`)
//   * resume  — prior context restored in-place (NOT a boundary)
//
// For the first three the previous turns are gone from context. We
// crystallise the rolling recent.md journal into handoff.md under a
// `[session_end:<source>]` marker so (a) the next session can reload an
// explicit "where we left off" snapshot and (b) the journal survives
// recent.md's own aggressive size-trim. Append-only + emergency trim,
// atomic same-dir rename. Errors propagate to the caller, which swallows
// them — a handoff outage must never back-pressure the hook 200.

import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { lockFor } from './_mutex.js'
import { stripFileHeader, trimEntriesWithRemoved } from './trim.js'

const HANDOFF_HEADER = '# Handoff -- session boundary snapshots\n\n'

// Hard cap on how many `[session_end:*]` snapshots handoff.md retains. Each
// boundary appends a full recent.md dump; without a cap, frequent restarts
// (e.g. a watchdog restart loop) pile up near-duplicate snapshots and bloat
// the context that CLAUDE.md loads via @core/hot/handoff.md. Keeping the last
// few bounds the file to ~N×recent.md regardless of restart frequency.
const MAX_SNAPSHOTS = 2

/**
 * Hard cap on how many recent.md turn entries a single snapshot keeps.
 *
 * A snapshot used to dump recent.md whole, so handoff.md — auto-loaded into
 * every session via `@core/hot/handoff.md` — carried a full copy of the
 * journal (2026-11-16: 15 KB / 34 turns, re-sent on every turn). A handoff is
 * "where we left off", not the archive: recent.md itself still holds the full
 * rolling journal and is read on demand.
 */
export const MAX_SNAPSHOT_TURNS = 8

/**
 * A recent.md turn header: `### YYYY-MM-DD HH:MM [tag]`, as written by
 * hot-writer. Stricter than a bare `### ` prefix on purpose — an agent that
 * quotes a markdown heading back into its own answer would otherwise look
 * like a turn boundary, and the window cut would land INSIDE a turn, leaving
 * a headless fragment at the top of the snapshot.
 */
const TURN_HEAD_RE = /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[/

/**
 * A boundary-snapshot header, as written below: `### <ts> [session_end:<src>]`.
 *
 * Anchored and date-shaped on purpose (2026-11-17). A bare
 * `startsWith('### ') && includes('[session_end:')` test also matched a turn
 * body that merely MENTIONS the marker — e.g. an agent quoting this file's
 * format back into its own answer. On that false positive the structural
 * passes below cut a snapshot in two, so the per-snapshot turn window stopped
 * bounding anything, and the dedupe pass could drop the quoted line together
 * with the real text that followed it.
 */
const SNAPSHOT_HEAD_RE = /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[session_end:/

/**
 * True for a boundary-snapshot header. recent.md turn entries nested inside a
 * snapshot also begin with `### ` but carry no `[session_end:` tag, so they
 * are never mistaken for a boundary.
 *
 * @param line - A single line of handoff.md.
 * @returns Whether the line opens a snapshot.
 */
function isSnapshotStart(line: string): boolean {
  return SNAPSHOT_HEAD_RE.test(line)
}

/**
 * True when line `i` opens a header — turn entry OR snapshot marker — judged in
 * context (2026-11-17).
 *
 * A header line alone is forgeable: an agent quoting this file's format into an
 * answer produces the same text, and on that false positive the structural
 * passes split a snapshot in two (so the turn window bounds nothing), let the
 * forgery push a real snapshot out past MAX_SNAPSHOTS, or — in dedupe — treat
 * the quote as its own block and drop the real text that followed it.
 *
 * Every header this module and hot-writer write is preceded by a blank line
 * (an appended entry starts with `\n`), sits under the `# ` file header, or
 * follows the marker/turn header directly above it. A quote inside a turn body
 * always follows that turn's own text — `**User:** …` / `**Agent:** …`, since
 * hot-writer collapses newlines within a turn. Walking up the run of adjacent
 * headers and judging what sits above it separates the two without changing
 * the on-disk format. Verified against all live handoff.md files on the host.
 */
function isHeadAt(lines: string[], i: number): boolean {
  if (!lines[i]!.startsWith('### ')) return false
  let j = i - 1
  while (j >= 0 && lines[j]!.startsWith('### ')) j--
  if (j < 0) return true
  return lines[j]!.trim().length === 0 || lines[j]!.startsWith('# ')
}

/** True when line `i` opens a real boundary snapshot (a header, plus the tag). */
function isSnapshotStartAt(lines: string[], i: number): boolean {
  return isSnapshotStart(lines[i]!) && isHeadAt(lines, i)
}

/**
 * Trim handoff content to the last MAX_SNAPSHOTS boundary snapshots. A
 * snapshot starts at a `### ... [session_end:` header and runs until the next
 * one. recent.md entries inside a snapshot also begin with `### ` but lack the
 * `[session_end:` tag, so they are never mistaken for boundaries.
 */
function capSnapshots(content: string): { content: string; archived: string } {
  const lines = content.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isSnapshotStartAt(lines, i)) starts.push(i)
  }
  if (starts.length <= MAX_SNAPSHOTS) return { content, archived: '' }
  const from = starts[starts.length - MAX_SNAPSHOTS]!
  // What falls off the end is MOVED, not deleted (2026-11-17). Every other
  // bound in this module archives its cut; this one deleted outright, and
  // because recent.md rotates, a snapshot old enough to be pushed out is
  // routinely the only copy of the turns inside it. Measured on a plain
  // five-boundary cycle: 14 lines gone for good at the fourth boundary.
  // De-header the cut with the shared rule, not `replace(HANDOFF_HEADER, '')`:
  // that constant ends in a blank line, so on a file whose header has none the
  // replace matched nothing and the header rode into the archive as content.
  const cut = stripFileHeader(lines.slice(0, from).join('\n'), HANDOFF_HEADER)
  return {
    content: HANDOFF_HEADER + lines.slice(from).join('\n').trimEnd() + '\n',
    archived: cut,
  }
}

/**
 * Byte offset of the last `### ... [session_end:` marker, or -1 when the file
 * holds no snapshot yet. recent.md entries inside a snapshot also start with
 * `### ` but carry no `[session_end:` tag, so they are never matched.
 */
function lastSnapshotStart(content: string): number {
  // Scan by LINES and accumulate the offset, rather than re-deriving the
  // context rule over byte offsets: two implementations of "is this a real
  // marker" can drift apart, and a drift here desynchronises the byte-for-byte
  // supersede check from the structural passes (2026-11-17).
  const lines = content.split('\n')
  let found = -1
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    if (isSnapshotStartAt(lines, i)) found = offset
    offset += lines[i]!.length + 1 // +1 for the '\n' split consumed
  }
  return found
}

/**
 * Journal body of the last snapshot — everything after its marker line, in the
 * exact shape writeHandoff stores, so it compares directly against a fresh
 * recent.md body.
 */
function lastSnapshotBody(content: string): string | null {
  const idx = lastSnapshotStart(content)
  if (idx === -1) return null
  const nl = content.indexOf('\n', idx)
  return nl === -1 ? '' : content.slice(nl + 1).trimEnd()
}

/**
 * Drop journal turns that a newer snapshot already carries (2026-09-15).
 *
 * Supersede above covers the common case — an unchanged or merely grown
 * journal. It does NOT fire when recent.md *slid*: the oldest turn rotated out
 * while a new one arrived, so the fresh dump is no longer a prefix of the
 * stored one even though the turns in the middle are identical. Those shared
 * turns would then sit in handoff.md twice, and handoff.md is auto-loaded into
 * context via `@core/hot/handoff.md` — the duplicate is re-sent every turn.
 * Keep the newest copy of each turn (closest to "where we left off"), drop the
 * older ones, and drop any snapshot marker left with no turns of its own. Also
 * cleans duplicates already accumulated on disk by earlier builds.
 */
function dedupeSnapshots(content: string): string {
  const lines = content.split('\n')
  // Real headers only. A `### ` line quoted inside a turn body used to become a
  // block of its own, and when its text matched another turn's tail the dedupe
  // dropped it — silently taking that turn's real text with it (2026-11-17).
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isHeadAt(lines, i)) heads.push(i)
  }
  if (heads.length === 0) return content

  interface Block {
    boundary: boolean
    // Comparison key — trailing blank lines are separators, not content.
    key: string
    // Verbatim lines, so keeping a block preserves it byte for byte.
    raw: string[]
    drop: boolean
  }
  const blocks: Block[] = heads.map((from, b) => {
    const to = b + 1 < heads.length ? heads[b + 1]! : lines.length
    const raw = lines.slice(from, to)
    return {
      boundary: isSnapshotStartAt(lines, from),
      key: raw.join('\n').trimEnd(),
      raw,
      drop: false,
    }
  })

  // Newest → oldest, so the copy that survives is the most recent one.
  const seen = new Set<string>()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blk = blocks[i]!
    if (blk.boundary || blk.key.length === 0) continue
    if (seen.has(blk.key)) blk.drop = true
    else seen.add(blk.key)
  }

  // A marker whose turns all vanished carries nothing — drop the marker too.
  // "Carries nothing" has to include the marker block's OWN lines (2026-11-17):
  // a marker line followed by text that never got a `### ` header of its own
  // sits inside that block, and dropping the block silently took the text with
  // it — e.g. everything an agent wrote after quoting this file's format.
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i]!.boundary) continue
    if (blocks[i]!.raw.slice(1).some((l) => l.trim().length > 0)) continue
    let empty = true
    for (let j = i + 1; j < blocks.length && !blocks[j]!.boundary; j++) {
      if (!blocks[j]!.drop) {
        empty = false
        break
      }
    }
    if (empty) blocks[i]!.drop = true
  }

  // Nothing to drop → hand back the ORIGINAL bytes. Re-serialising would
  // normalise blank-line separators, and the supersede check above compares the
  // stored snapshot byte for byte against a fresh recent.md dump.
  if (!blocks.some((b) => b.drop)) return content

  const kept = blocks.filter((b) => !b.drop).flatMap((b) => b.raw)
  // Everything above the FIRST header is not a block, so the rebuild has to
  // carry it explicitly. Returning a bare header when every block was dropped
  // destroyed it (2026-11-17): a turn-less marker over a headless prologue —
  // turn text a hand-edit or an older build left with no `### ` of its own — is
  // dropped as empty, and the prologue went with it. That text exists nowhere
  // else once recent.md has rotated.
  const head = lines.slice(0, heads[0]!)
  const out = [...head, ...kept].join('\n').trimEnd()
  if (!out.split('\n').some((l) => l.trim().length > 0 && !l.startsWith('# '))) {
    return HANDOFF_HEADER
  }
  return out + '\n'
}

/**
 * Split off turns stored BEFORE the first boundary marker (2026-11-17).
 *
 * An older build dumped recent.md into handoff.md without a `[session_end:]`
 * marker of its own, so those turns sit in a prologue that neither bound can
 * reach: capSnapshots counts markers (a prologue has none) and dedupeSnapshots
 * only drops turns a NEWER snapshot repeats. Unique stale turns therefore rode
 * along in every turn's context forever — 9.5 KB of the live 13 KB file.
 *
 * They are MOVED, not deleted. recent.md is itself byte-trimmed
 * (`max_hot_bytes`, 20 KB by default), so a prologue turn old enough to have
 * rotated out of the journal exists nowhere else — the caller appends the
 * returned text to handoff-archive.md, which no CLAUDE.md auto-loads.
 *
 * No-op while the file holds no snapshot at all: there is no boundary to anchor
 * on yet, and the prologue is then the only record of where we left off.
 */
function splitPrologue(content: string): { content: string; archived: string } {
  const lines = content.split('\n')
  let first = -1
  for (let i = 0; i < lines.length; i++) {
    if (isSnapshotStartAt(lines, i)) {
      first = i
      break
    }
  }
  if (first === -1) return { content, archived: '' }
  const head = lines.slice(0, first)
  // Nothing but the file header above the marker → already clean, and handing
  // back the ORIGINAL bytes keeps the byte-for-byte supersede check valid.
  // "Content" is any non-blank line that isn't the `# ` file header — not just
  // a `### ` entry: a headless prologue is still stale text re-sent on every
  // turn, and requiring a header left it in handoff.md forever (2026-11-17).
  if (!head.some((l) => l.trim().length > 0 && !l.startsWith('# '))) {
    return { content, archived: '' }
  }
  return {
    content: HANDOFF_HEADER + lines.slice(first).join('\n').trimEnd() + '\n',
    archived: stripFileHeader(head.join('\n'), HANDOFF_HEADER),
  }
}

/**
 * Re-apply the per-snapshot turn window to snapshots already on disk
 * (2026-11-17).
 *
 * MAX_SNAPSHOT_TURNS is applied when a snapshot is written, so a block stored
 * by a build that predates the window keeps its full journal dump forever —
 * later boundaries only ever append. Normalising stored blocks shrinks them in
 * place on the next boundary.
 *
 * What falls outside the window is RETURNED, not dropped. The first build of
 * this pass deleted it, and on the live files that was real loss: a legacy
 * snapshot held 63 turns, 12 of which had already rotated out of recent.md, so
 * the next boundary would have destroyed the only copy. The caller appends
 * `archived` to handoff-archive.md, which no CLAUDE.md auto-loads.
 */
function capTurnsPerSnapshot(content: string): { content: string; archived: string } {
  const lines = content.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isSnapshotStartAt(lines, i)) starts.push(i)
  }
  if (starts.length === 0) return { content, archived: '' }

  const out: string[] = lines.slice(0, starts[0]!)
  const archived: string[] = []
  let changed = false
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!
    const to = s + 1 < starts.length ? starts[s + 1]! : lines.length
    // Cut by LINE INDEX, so what is kept and what is archived are exact
    // complements — deriving the cut from string lengths is off by whatever
    // trailing blanks the window trimmed.
    const bodyLines = lines.slice(from + 1, to)
    const turns: number[] = []
    for (let i = 0; i < bodyLines.length; i++) {
      if (TURN_HEAD_RE.test(bodyLines[i]!) && isHeadAt(bodyLines, i)) turns.push(i)
    }
    const cutAt = turns.length > MAX_SNAPSHOT_TURNS ? turns[turns.length - MAX_SNAPSHOT_TURNS]! : 0
    const kept = bodyLines.slice(cutAt).join('\n').trimEnd()
    if (cutAt > 0) {
      changed = true
      const cut = bodyLines.slice(0, cutAt).join('\n').trimEnd()
      // Keep the marker with the turns so the archive says which session they
      // came from.
      if (cut.length > 0) archived.push(`${lines[from]!}\n${cut}`)
    }
    out.push(lines[from]!)
    if (kept.length > 0) out.push(...kept.split('\n'))
    out.push('')
  }
  // Unchanged → original bytes, so supersede still compares byte for byte.
  if (!changed) return { content, archived: '' }
  return {
    content: out.join('\n').trimEnd() + '\n',
    archived: archived.length > 0 ? archived.join('\n\n') + '\n' : '',
  }
}

/**
 * Bring a stored handoff.md to the shape the current build writes: no
 * duplicate turns, no pre-marker prologue, every snapshot within the turn
 * window, and at most MAX_SNAPSHOTS snapshots.
 *
 * @param content - Current handoff.md bytes.
 * @returns `content` — the normalised file, byte-identical to the input when it
 * was already normal — and `archived`, prologue turns the caller must append to
 * handoff-archive.md before overwriting the file. Nothing is deleted outright.
 */
export function normalizeStored(content: string): { content: string; archived: string } {
  const split = splitPrologue(dedupeSnapshots(content))
  const capped = capTurnsPerSnapshot(split.content)
  const bounded = capSnapshots(capped.content)
  return {
    content: bounded.content,
    archived: split.archived + capped.archived + bounded.archived,
  }
}

/**
 * Keep only the last `max` `### ` turn entries of a journal body.
 *
 * @param body - recent.md content with its own header already stripped.
 * @param max - How many trailing turn entries to keep.
 * @returns The trailing slice, or `body` unchanged when it holds no more.
 */
function lastTurns(body: string, max: number): string {
  const lines = body.split('\n')
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    // Context-aware like every other pass (2026-11-17): this was the last path
    // judging a header by its text alone, so a turn body quoting one could put
    // the window cut inside a turn — the fresh snapshot then opened on the
    // forgery with the real turn's text orphaned above it, and normalizeStored
    // does not undo a bad window.
    if (TURN_HEAD_RE.test(lines[i]!) && isHeadAt(lines, i)) heads.push(i)
  }
  if (heads.length <= max) return body
  return lines.slice(heads[heads.length - max]!).join('\n').trimEnd()
}

/**
 * Split a snapshot body into its turn blocks, cutting only on REAL turn
 * headers. Text above the first header (or a body with no header at all) comes
 * back as its own block, so nothing is silently skipped.
 *
 * @param body - Snapshot body: everything below a `[session_end:]` marker.
 * @returns Non-empty blocks, in file order.
 */
function turnBlocks(body: string): string[] {
  const lines = body.split('\n')
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (TURN_HEAD_RE.test(lines[i]!) && isHeadAt(lines, i)) heads.push(i)
  }
  if (heads.length === 0) {
    const whole = body.trimEnd()
    return whole.trim().length > 0 ? [whole] : []
  }
  const out: string[] = [lines.slice(0, heads[0]!).join('\n').trimEnd()]
  for (let h = 0; h < heads.length; h++) {
    const to = h + 1 < heads.length ? heads[h + 1]! : lines.length
    out.push(lines.slice(heads[h]!, to).join('\n').trimEnd())
  }
  return out.filter((b) => b.trim().length > 0)
}

/**
 * Append text to handoff-archive.md — the sink for everything the bounds cut.
 * No CLAUDE.md auto-loads it, so an archived turn costs no per-turn context
 * while still existing.
 *
 * Never lets the archive take the snapshot down with it: the file may belong to
 * another agent's UID, or the directory may be read-only, and this is
 * housekeeping on a path whose real job is recording the boundary.
 *
 * @returns Whether the text is now safely on disk. `false` means the caller
 * must KEEP the bytes it was about to drop.
 */
async function appendArchive(input: WriteHandoffInput, text: string): Promise<boolean> {
  const archivePath = join(dirname(input.handoffPath), 'handoff-archive.md')
  try {
    await appendFile(
      archivePath,
      `\n## archived ${input.ts} (trimmed from handoff.md)\n\n${text}`,
      'utf8',
    )
    return true
  } catch (err) {
    input.onWarn?.('handoff archive append failed — keeping untrimmed bytes', {
      path: archivePath,
      err: String(err),
    })
    return false
  }
}

export interface WriteHandoffInput {
  // Source journal — <workspace>/core/hot/recent.md.
  recentPath: string
  // Destination — <workspace>/core/hot/handoff.md.
  handoffPath: string
  // Local-tz timestamp 'YYYY-MM-DD HH:MM' (caller owns formatting so a
  // fake clock in tests stays deterministic).
  ts: string
  // Boundary reason: clear | compact | startup | ... — recorded in the marker.
  source: string
  maxBytes: number
  trimKeepLines: number
  // Optional sink for housekeeping that failed but must not fail the snapshot
  // (an unwritable handoff-archive.md). Omitted in tests that don't assert it.
  onWarn?: (msg: string, meta: Record<string, unknown>) => void
}

/**
 * Snapshot the current recent.md journal into handoff.md under a
 * `### <ts> [session_end:<source>]` marker. No-op (returns false) when
 * recent.md is missing or holds no turn entries — nothing to hand off.
 * Returns true when a snapshot was appended.
 */
export async function writeHandoff(input: WriteHandoffInput): Promise<boolean> {
  let recent: string
  try {
    recent = await readFile(input.recentPath, 'utf8')
  } catch {
    return false // no journal yet → nothing to snapshot
  }
  // Keep only the entry body (drop recent.md's own top header line). Turn
  // entries begin at the first `### ` header; no header → no turns.
  const idx = recent.indexOf('### ')
  if (idx === -1) return false
  // `full` is the whole journal — the supersede check below compares against
  // it, not against the stored window. `body` is what actually gets written.
  const full = recent.slice(idx).trimEnd()
  const body = lastTurns(full, MAX_SNAPSHOT_TURNS)
  if (body.length === 0) return false

  const entry = `\n### ${input.ts} [session_end:${input.source}]\n${body}\n`

  let wrote = false
  await lockFor(input.handoffPath).run(async () => {
    await mkdir(dirname(input.handoffPath), { recursive: true })
    // Seed the header on first write so the file is self-describing.
    let existing: string
    try {
      existing = await readFile(input.handoffPath, 'utf8')
    } catch {
      existing = HANDOFF_HEADER
      await writeFile(input.handoffPath, HANDOFF_HEADER, 'utf8')
    }

    // Normalise what an older build left behind, archiving any prologue, and
    // persist the result. Runs BEFORE `prev` is read out of the file: a legacy
    // prologue or an over-wide snapshot would otherwise set the supersede
    // comparison against bytes this build would never write.
    const normalize = async (raw: string): Promise<string> => {
      const { content, archived } = normalizeStored(raw)
      // Unchanged bytes AND nothing to archive → nothing to do. The two are
      // tested together on purpose: today a non-empty `archived` always comes
      // with changed content, and testing only the bytes would silently throw
      // the archive away the day that stops holding.
      if (archived.length === 0 && content === raw) return content
      // Archive FIRST — losing the only copy of a turn is worse than a
      // duplicate archive entry. Keep the original bytes when the archive
      // refuses, so nothing is dropped and the next boundary retries.
      if (archived.length > 0 && !(await appendArchive(input, archived))) return raw
      await writeFile(input.handoffPath, content, 'utf8')
      return content
    }
    existing = await normalize(existing)

    // Supersede instead of accumulate (2026-09-15). handoff.md is auto-loaded
    // into every session, so every stored byte is re-sent on every turn. Two
    // boundaries in a row normally snapshot the SAME journal (a restart with no
    // turns in between) or a journal that merely GREW by a turn — in both cases
    // the older snapshot carries nothing the journal no longer has, and only
    // costs context. Identical → skip the write entirely; grown → drop the
    // stored snapshot and store the current window. A diverged journal (recent.md rotated or
    // trimmed between boundaries) is NOT a superset and is appended as before,
    // because the old snapshot is then the only record of those turns.
    // Compare the stored snapshot against the FULL journal, not against the
    // capped window (2026-11-16). With a window the two successive snapshots
    // are almost never in a prefix relation — the window slides — so a
    // `body.startsWith(prev)` test would fail on every grown journal and
    // append a second near-duplicate snapshot instead of superseding the
    // first. Containment in the full journal still means "the stored snapshot
    // holds nothing this one doesn't", which is what supersede needs.
    const prev = lastSnapshotBody(existing)
    if (prev !== null && (prev === body || full.includes(prev))) {
      if (prev === body) {
        // Nothing new since the last boundary — but an earlier build may have
        // left duplicates on disk, so still normalise before bowing out.
        // capSnapshots too, not just dedupe: an older build may have left MORE
        // than MAX_SNAPSHOTS on disk, and a run of turn-less boundaries would
        // otherwise never compress the file back down to the limit.
        await normalize(existing)
        return
      }
      // Dropping the stored snapshot loses nothing RIGHT NOW — the journal
      // still contains it. But what replaces it is the capped window, so turns
      // outside that window would live only in recent.md, which rotates: on a
      // plain boundary cycle the oldest turn was gone from handoff.md, the
      // archive and recent.md alike one boundary later (2026-11-17). Archive
      // exactly the turns the new window no longer covers, and when the archive
      // refuses, keep the stored snapshot instead of dropping it.
      const uncovered = turnBlocks(prev).filter((t) => !body.includes(t))
      if (uncovered.length === 0 || (await appendArchive(input, uncovered.join('\n\n') + '\n'))) {
        existing = existing.slice(0, lastSnapshotStart(existing)).trimEnd() + '\n'
        await writeFile(input.handoffPath, existing, 'utf8')
      }
    }

    // A file left without a trailing newline (hand-edited, or truncated by an
    // older build) would glue `entry`'s leading blank line onto the last turn,
    // so the new marker lands mid-line and no pass recognises it as a boundary
    // (2026-11-17). Terminate the line first.
    if (existing.length > 0 && !existing.endsWith('\n')) {
      await appendFile(input.handoffPath, '\n', 'utf8')
    }
    await appendFile(input.handoffPath, entry, 'utf8')
    wrote = true

    // Primary bound: drop turns an older snapshot duplicates, then keep only
    // the last MAX_SNAPSHOTS boundary snapshots. Runs every boundary so the
    // file self-compresses on each restart.
    await normalize(await readFile(input.handoffPath, 'utf8'))

    const s = await stat(input.handoffPath)
    if (s.size <= input.maxBytes) return

    // Emergency trim — keep last trimKeepLines, advance to the first
    // `### ` header so a partial entry isn't left at the top, then drop
    // whole entries until maxBytes holds. Mirrors hot-writer.ts.
    const buf = await readFile(input.handoffPath, 'utf8')
    const { content: trimmed, removed } = trimEntriesWithRemoved({
      content: buf,
      header: HANDOFF_HEADER,
      keepLines: input.trimKeepLines,
      maxBytes: input.maxBytes,
      // Cut on SNAPSHOT boundaries, not on every `### `: the recent.md turns
      // inside a snapshot start with `### ` too, so the default predicate would
      // strip the `[session_end:]` marker and leave the body orphaned — an
      // unmarked fragment of an old session that the next agent loads via
      // @core/hot/handoff.md as if it were the current one.
      // Context-aware, like every other pass: a marker quoted inside a turn
      // body must not become the cut point, or the trim leaves the FORGERY at
      // the top of the file as "where we left off" (2026-11-17).
      isEntryStart: isSnapshotStartAt,
    })
    // MOVE, don't delete (2026-11-17). This was the last bound in the module
    // that cut bytes with no sink: it drops whole snapshots, and a snapshot old
    // enough to be cut here is routinely the only copy of its turns, because
    // recent.md rotates. Measured on production defaults: nine turns gone from
    // handoff.md, the archive and recent.md at once in one boundary.
    //
    // When the archive refuses, keep the oversized file. The normalise pass
    // above already does that ("keeping untrimmed bytes"), and cutting here
    // anyway would undo its fail-safe within the same pass — the file would end
    // up small AND short of turns that exist nowhere else.
    if (removed.trim().length > 0 && !(await appendArchive(input, removed))) return
    const tmp = join(
      dirname(input.handoffPath),
      `.handoff.md.tmp.${process.pid}.${Date.now()}`,
    )
    try {
      await writeFile(tmp, trimmed, 'utf8')
      await rename(tmp, input.handoffPath)
    } catch (err) {
      await unlink(tmp).catch(() => {
        // tmp may not exist if writeFile threw first — fine.
      })
      throw err
    }
  })
  return wrote
}
