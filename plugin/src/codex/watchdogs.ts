// Shutdown and startup watchdogs (docs/design/self-update-spec.md, S7).
// Shutdown: once shutdown() starts, the process exits within 45 s even if a close hangs, keeping
// the exit code already chosen (75 for a planned restart). 45 s stays under TimeoutStopSec=90.
// Startup: a bridge that is not ready (first getUpdates and the Codex handshake) within 180 s
// exits 75; that boot counts in the boot-ledger chain, and a failed /update trial is rolled back
// by the boot guard on the next start.

export const SHUTDOWN_LEASH_MS = 45_000
export const STARTUP_LIMIT_MS = 180_000

type SetTimer = (run: () => void, ms: number) => () => void

const unrefTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function armShutdownWatchdog(options: {
  exit: (code: number) => void
  exitCode: () => number | undefined
  setTimer?: SetTimer
}): () => void {
  return (options.setTimer ?? unrefTimer)(() => options.exit(options.exitCode() ?? 1), SHUTDOWN_LEASH_MS)
}

export function armStartupWatchdog(options: { onTimeout: () => void; setTimer?: SetTimer; ms?: number }): { ready: () => void } {
  let done = false
  const cancel = (options.setTimer ?? unrefTimer)(() => {
    if (done) return
    done = true
    options.onTimeout()
  }, options.ms ?? STARTUP_LIMIT_MS)
  return { ready: () => { done = true; cancel() } }
}
