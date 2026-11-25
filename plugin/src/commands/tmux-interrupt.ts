// tmux-interrupt.ts — real, pre-emptive interrupt of the agent's CURRENT turn.
//
// /stop used to be cooperative only: it cancelled the status indicator and
// enqueued a "/stop" channel message that Claude saw at its NEXT channel read,
// so a mid-tool turn kept running until it voluntarily yielded. But the plugin
// (the bun poller) is a SEPARATE process from the Claude turn, so it can act
// instantly. The one primitive the headless TUI honours mid-tool is a single
// Escape keystroke (the same key the prompt-watchdog sends to unstick a frozen
// turn). The channel runs INSIDE its own tmux session, so $TMUX already points
// the `tmux` binary at the correct server/socket — no `-L` needed. Best-effort:
// any failure is swallowed so the cooperative /stop path still completes.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Logger } from '../log.js'
import type { TmuxKeysTarget } from './keys.js'

const execFileAsync = promisify(execFile)
const TMUX_EXEC_TIMEOUT_MS = 5000

/**
 * Resolve the tmux pane target for /keys and /cc keystroke injection, using the
 * SAME precedence as {@link interruptCurrentTurn}: an explicit config
 * `pane_target`, else the session named after `$AGENT_ID` (`channel-<agent>`).
 * Returns undefined when neither is available — callers then report the pane as
 * unavailable instead of sending an empty `-t ''`. No `-L`/`-S` is set: the
 * plugin runs INSIDE the agent's own tmux session, so the socket is inherited
 * from `$TMUX` (mirrors interruptCurrentTurn).
 *
 * @param paneTargetConfig - `tmux_mirror.pane_target` from config ('' = derive).
 */
export function resolveTmuxKeysTarget(paneTargetConfig: string): TmuxKeysTarget | undefined {
  const agentId = (process.env.AGENT_ID ?? '').trim()
  const paneTarget = paneTargetConfig.trim() || (agentId ? `channel-${agentId}` : '')
  return paneTarget ? { paneTarget } : undefined
}

/**
 * Send a single Escape keystroke to the agent's own tmux pane, interrupting the
 * turn that is currently running.
 *
 * Target precedence: an explicit `pane_target` from config, else the session
 * named after `$AGENT_ID` (`channel-<agent>`), else the current `$TMUX` session
 * (no `-t`, relying on the inherited socket).
 *
 * @param paneTarget - `tmux_mirror.pane_target` from config ('' = use $TMUX session).
 * @param log - structured logger; the result is logged, never thrown.
 */
export async function interruptCurrentTurn(paneTarget: string, log: Logger): Promise<void> {
  const agentId = (process.env.AGENT_ID ?? '').trim()
  const target = paneTarget.trim() || (agentId ? `channel-${agentId}` : '')
  const args = target ? ['send-keys', '-t', target, 'Escape'] : ['send-keys', 'Escape']
  try {
    await execFileAsync('tmux', args, { timeout: TMUX_EXEC_TIMEOUT_MS })
    log.info('oob /stop: sent real interrupt (Escape) to pane', { target: target || '$TMUX' })
  } catch (err) {
    log.warn('oob /stop: interrupt failed (cooperative /stop still delivered)', {
      target: target || '$TMUX',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
