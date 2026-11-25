// Phase 8 / T6 — MemoryWriter facade.
//
// One instance per plugin process (one agent = one workspace).
// onHook(payload) is the single entry point called from the
// /hooks/agent webhook branch. UserPromptSubmit buffers the prompt
// by chatId; Stop reads the buffer + tail-reads the transcript for
// the assistant text + appends one entry each to recent.md and
// verbose-YYYY-MM-DD.jsonl.
//
// All errors are swallowed — the webhook still returns 200 so Claude
// hooks don't back-pressure on a memory outage. The webhook branch
// wraps onHook() in its own try/catch + log.warn so even an unhandled
// throw here cannot block the HTTP response.

import { join } from 'node:path'

import type { Logger } from '../log.js'
import type { ClaudeHookPayload } from '../schemas.js'
import { appendHotEntry, snippet, stripEnvelope } from './hot-writer.js'
import { appendVerbose, type VerboseRecord } from './verbose-writer.js'
import { writeHandoff } from './handoff-writer.js'
import { PromptBuffer } from './prompt-buffer.js'
import { readLastAssistantText } from './transcript-reader.js'

export interface MemoryConfig {
  // <agent-workspace> root. recent.md lands at workspace/core/hot/recent.md.
  workspacePath: string
  // Pre-resolved logs dir (T7 derives <workspace_parent>/logs as the
  // default when config.memory.logs_path is unset).
  logsPath: string
  sourceTag: string
  // Human-friendly capitalised name (e.g. 'Silvana', 'Kaelthas').
  agentLabel: string
  maxHotBytes: number
  trimKeepLines: number
  bufferTtlMs: number
  bufferMaxEntries: number
}

export class MemoryWriter {
  private readonly buffer: PromptBuffer

  constructor(
    private readonly cfg: MemoryConfig,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.buffer = new PromptBuffer(cfg.bufferTtlMs, cfg.bufferMaxEntries, now)
  }

  /** Dispatch on hook_event_name. Other hook kinds are no-ops. */
  async onHook(payload: ClaudeHookPayload): Promise<void> {
    if (payload.hook_event_name === 'UserPromptSubmit') {
      this.buffer.set(
        String(payload.chatId),
        typeof payload.prompt === 'string' ? payload.prompt : '',
        payload.session_id ?? null,
      )
      return
    }
    if (payload.hook_event_name === 'Stop') {
      await this.onStop(payload)
      return
    }
    if (payload.hook_event_name === 'SessionStart') {
      await this.onSessionStart(payload)
    }
  }

  /**
   * Proactive startup snapshot — the SessionStart(startup) hook can't be
   * relied on after a `systemctl restart`: it fires while THIS very plugin's
   * webhook listener is still binding :PORT, so its POST is refused
   * (ECONNREFUSED) and swallowed. server.ts calls this once right after the
   * writer is constructed, so a fresh process still crystallises recent.md
   * into handoff.md regardless of the race. This is the SOLE owner of the
   * `startup` snapshot — onSessionStart deliberately ignores `startup` so a
   * warm restart where the hook DOES reach the listener can't double-write.
   */
  async snapshotStartup(): Promise<void> {
    await this.doHandoff('startup')
  }

  async snapshotBoundary(source: 'clear' | 'compact'): Promise<void> {
    await this.doHandoff(source)
  }

  /**
   * Hook-driven session boundary. recent.md persists on disk independently of
   * the in-context conversation, so when a boundary fires it still holds the
   * pre-reset journal. `source`:
   *   * resume  — prior context restored in-place → NO boundary, skip.
   *   * startup — fresh process; owned by snapshotStartup() (server.ts calls
   *               it directly, bypassing the webhook race), so skip here to
   *               avoid a double snapshot on a warm restart.
   *   * clear   — /new or /clear wiped the context → snapshot.
   *   * compact — auto-compact / /compact replaced it with a summary → snapshot.
   * clear/compact fire INSIDE a live session where the webhook is already up,
   * so they flow through here reliably.
   */
  private async onSessionStart(
    payload: ClaudeHookPayload & { hook_event_name: 'SessionStart' },
  ): Promise<void> {
    const source = payload.source ?? 'startup'
    if (source === 'resume' || source === 'startup') return
    await this.doHandoff(source)
  }

  /**
   * Crystallise recent.md into handoff.md under a `[session_end:<source>]`
   * marker. Best-effort — errors are swallowed so a handoff outage never
   * back-pressures the hook 200 nor delays boot.
   */
  private async doHandoff(source: string): Promise<void> {
    try {
      const ts = formatLocalTs(new Date(this.now()))
      const wrote = await writeHandoff({
        recentPath: join(this.cfg.workspacePath, 'core', 'hot', 'recent.md'),
        handoffPath: join(this.cfg.workspacePath, 'core', 'hot', 'handoff.md'),
        ts,
        source,
        maxBytes: this.cfg.maxHotBytes,
        trimKeepLines: this.cfg.trimKeepLines,
        onWarn: (msg, meta) => this.log.warn(`[memory] ${msg}`, meta),
      })
      if (wrote) this.log.info('[memory] handoff snapshot written', { source })
    } catch (err) {
      this.log.warn('[memory] handoff write failed (ignored)', {
        source,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async onStop(
    payload: ClaudeHookPayload & { hook_event_name: 'Stop' },
  ): Promise<void> {
    const chatId = String(payload.chatId)
    const buffered = this.buffer.take(chatId)
    const userText = buffered?.prompt ?? '(no prompt)'
    if (!buffered) {
      // Stop without a prior UserPromptSubmit can happen on resume/clear
      // hooks, restart races, or when the buffer expired. We never drop
      // the entry — '(no prompt)' is the gateway.py parity behaviour.
      this.log.warn('[memory] Stop without buffered prompt', {
        chatId,
        session_id: payload.session_id,
      })
    }

    let agentText = ''
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      const t = await readLastAssistantText(payload.transcript_path)
      if (t) agentText = t
    }

    await this.recordTurn({
      sessionId: payload.session_id ?? null,
      userText, agentText,
      durationMs: buffered ? this.now() - buffered.ts : 0,
    })
  }

  /** Shared input for runtimes that already have both sides of the completed turn. */
  async recordTurn({ sessionId, userText, agentText, durationMs }: {
    sessionId: string | null; userText: string; agentText: string; durationMs: number
  }): Promise<void> {
    const ts = formatLocalTs(new Date(this.now()))
    const hotPath = join(this.cfg.workspacePath, 'core', 'hot', 'recent.md')
    await appendHotEntry({
      path: hotPath,
      ts,
      agentLabel: this.cfg.agentLabel,
      sourceTag: this.cfg.sourceTag,
      // Strip the <channel>/<media file_id=...> envelope so recent.md keeps the
      // real message, not metadata — prevents per-turn context bloat.
      userSnippet: snippet(stripEnvelope(userText)),
      // gateway.py:1950 uses '(inline)' as the agent fallback when no
      // response text was captured. We mirror that to keep recent.md
      // diff-able between the two implementations.
      agentSnippet: snippet(agentText || '(inline)'),
      maxBytes: this.cfg.maxHotBytes,
      trimKeepLines: this.cfg.trimKeepLines,
    })

    const record: VerboseRecord = {
      ts: new Date(this.now()).toISOString(),
      sid: sessionId,
      ch: this.cfg.sourceTag,
      user: userText,
      agent: agentText,
      dur_ms: durationMs,
      status: 'completed',
    }
    await appendVerbose({ logsDir: this.cfg.logsPath, record })
  }
}

/**
 * Format a Date as 'YYYY-MM-DD HH:MM' in local time. Matches Python's
 * `time.strftime("%Y-%m-%d %H:%M")` in gateway.py:1948.
 */
function formatLocalTs(d: Date): string {
  const p = (n: number): string => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  )
}
