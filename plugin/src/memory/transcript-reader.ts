// Phase 8 / T5 — tail-read the last assistant text from a Claude
// transcript JSONL file.
//
// Claude Code persists each session as `~/.claude/projects/<slug>/<sid>.jsonl`
// with one JSON object per line. We're interested in the last line whose
// `message.role === 'assistant'` and whose `message.content` array has
// at least one `{type: 'text', text: ...}` block — that's the text the
// user would have seen at the end of the turn.
//
// Telegram reply-tool capture: the agent
// answers via the MCP `reply` tool, so the user-visible text lives in a
// `{type:'tool_use', name:'…__reply', input:{text:…}}` block, NOT a text
// block. Without handling this, every reply-tool turn produced no text
// and recent.md / the verbose log logged `(inline)` instead of the
// actual answer — losing the agent's side of the conversation on restart.
// We therefore treat the reply tool's `input.text` as a fallback for an
// assistant message that has no plain text block. Plain text still wins
// (it's the agent's own reasoning the user saw); other tool_use blocks
// (Read/Bash/…) are ignored and we walk further back to the reply.
//
// Strategy: open the file, read at most the trailing TAIL_BYTES bytes
// to keep memory bounded on multi-megabyte transcripts, drop the first
// (possibly-truncated) line when we didn't start at byte 0, then walk
// the lines backward and return the first parseable assistant text.
//
// All errors are swallowed and surface as `null` — the caller treats
// "no agent text" as "(inline)". Missing files, permission denied,
// malformed JSON, schema drift — none of them should block the hot/
// verbose writes for the user side.

import { open, type FileHandle } from 'node:fs/promises'

import { redactSecrets } from '../safety/redact.js'

const TAIL_BYTES = 256 * 1024

// Tail-read the transcript and return its lines (oldest→newest), dropping a
// possibly-truncated leading line when we didn't start at byte 0. Shared by
// readLastAssistantText and readLatestThought. All errors surface as null —
// missing file / permission / empty file are normal "no data yet" states.
async function readTailLines(transcriptPath: string): Promise<string[] | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(transcriptPath, 'r')
    const st = await handle.stat()
    if (st.size === 0) return null
    const len = Math.min(st.size, TAIL_BYTES)
    const start = st.size - len
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, start)
    const text = buf.toString('utf8')
    const split = text.split('\n')
    return (start > 0 ? split.slice(1) : split).filter((l) => l.length > 0)
  } catch {
    return null
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // close() race on an already-closed handle is harmless
      }
    }
  }
}

export async function readLastAssistantText(
  transcriptPath: string,
): Promise<string | null> {
  try {
    const lines = await readTailLines(transcriptPath)
    if (lines === null) return null

    for (let i = lines.length - 1; i >= 0; i--) {
      // Permissive parse: valid JSON with the wrong shape (null, a bare
      // array, a string, …) used to bypass the per-line try/catch and
      // throw at the next `obj.message?.role` access, escaping to the
      // OUTER catch and short-circuiting earlier valid assistant text.
      // Each line is now its own boundary — shape mismatch = skip, not
      // abort.
      let obj: unknown
      try {
        obj = JSON.parse(lines[i]!)
      } catch {
        continue
      }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
      const msg = (obj as { message?: unknown }).message
      if (typeof msg !== 'object' || msg === null) continue
      const role = (msg as { role?: unknown }).role
      if (role !== 'assistant') continue
      const content = (msg as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      const parts: string[] = []
      const replyParts: string[] = []
      for (const c of content) {
        if (typeof c !== 'object' || c === null) continue
        const block = c as {
          type?: unknown
          text?: unknown
          name?: unknown
          input?: unknown
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
          continue
        }
        // Telegram reply-tool fallback: a `*__reply` tool call carries the
        // user-visible answer in `input.text`. Matched by name suffix so
        // it's robust to the MCP server prefix (mcp__telegram__reply).
        if (
          block.type === 'tool_use' &&
          typeof block.name === 'string' &&
          /(?:^|__)reply$/.test(block.name) &&
          typeof block.input === 'object' &&
          block.input !== null
        ) {
          const replyText = (block.input as { text?: unknown }).text
          if (typeof replyText === 'string' && replyText.length > 0) {
            replyParts.push(replyText)
          }
        }
      }
      // Plain assistant text wins; reply-tool text is the fallback for a
      // tool-only answer turn. A message with neither falls through to the
      // older messages (e.g. a trailing Read/Bash-only assistant message).
      if (parts.length > 0) return parts.join('\n')
      if (replyParts.length > 0) return replyParts.join('\n')
    }
    return null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// Streaming thoughts (#1) — surface the agent's in-flight narration in the
// working bubble. We read the LATEST assistant `text` block (what the user
// sees in the CLI between tool calls), NOT the `*__reply` answer — the final
// reply ships through reply() and the bubble is torn down on Stop.
// ─────────────────────────────────────────────────────────────────────

export interface ThoughtShapeOpts {
  readonly maxChars: number
  readonly maxLines: number
}

/**
 * Shape a raw narration block for the small rolling bubble line: drop fenced
 * code, unwrap inline backticks, redact secrets, collapse blank lines, then
 * keep the TAIL — last `maxChars` chars (prefixed with … when truncated) and
 * last `maxLines` lines. Showing the tail makes the text feel like it scrolls
 * as the narration grows across reads. Returns null when nothing renderable
 * remains (whitespace / code-only block).
 */
export function shapeThought(raw: string, opts: ThoughtShapeOpts): string | null {
  let t = raw
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
  t = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
  t = redactSecrets(t).trim()
  if (t.length === 0) return null

  if (t.length > opts.maxChars) {
    t = '…' + t.slice(t.length - opts.maxChars)
  }
  const lines = t.split('\n')
  if (lines.length > opts.maxLines) {
    return lines.slice(lines.length - opts.maxLines).join('\n')
  }
  return lines.join('\n')
}

export async function readLatestThought(
  transcriptPath: string,
  opts: ThoughtShapeOpts,
): Promise<string | null> {
  const lines = await readTailLines(transcriptPath)
  if (lines === null) return null

  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown
    try {
      obj = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    const msg = (obj as { message?: unknown }).message
    if (typeof msg !== 'object' || msg === null) continue
    if ((msg as { role?: unknown }).role !== 'assistant') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const c of content) {
      if (typeof c !== 'object' || c === null) continue
      const block = c as { type?: unknown; text?: unknown }
      // ONLY plain text blocks — the reply-tool answer is deliberately
      // ignored here (final answer ≠ in-flight thought).
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    if (parts.length > 0) {
      return shapeThought(parts.join('\n'), opts)
    }
    // Tool-only assistant message — keep walking back to the prior narration.
  }
  return null
}
