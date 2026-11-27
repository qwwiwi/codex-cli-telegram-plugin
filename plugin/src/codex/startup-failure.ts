// The exit code of a bridge whose startup failed (server.ts main() rejected), kept out of server.ts so
// the S9 rule is tested where it is wired: a fatal configuration error (78) on the trial boot of an
// /update exits 1 and records outcome=crash, so systemd starts again and the boot guard rolls back.
import { EXIT, exitCodeDuringTrial, exitCodeFor, fatalReason, recordFatal } from './exit-codes.js'
import { trialOutcomeFor, type PendingUpdate, type TrialOutcome } from './self-update.js'

export interface StartupFailure {
  error: unknown
  /** Writes the outcome into the /update trial record; returns the record when this boot is a trial. */
  recordTrial: (outcome: TrialOutcome) => PendingUpdate | undefined
  /** The startup watchdog asked for the exit. */
  watchdog: boolean
  /** <state>, where recordFatal writes fatal.json. */
  stateDir: string | undefined
  /** One owner message about a fatal configuration error; may throw. */
  send: (text: string) => Promise<unknown>
}

/** Records the trial outcome and, for exit 78, fatal.json and the owner notice; returns the exit code. */
export async function startupFailureExit({ error, recordTrial, watchdog, stateDir, send }: StartupFailure): Promise<number> {
  const classified = exitCodeFor(error)
  const trial = recordTrial(trialOutcomeFor(exitCodeDuringTrial(classified, true), watchdog))
  const code = exitCodeDuringTrial(classified, trial !== undefined)
  if (classified === EXIT.fatalConfig) {
    await recordFatal({
      stateDir, reason: fatalReason(error), send,
      ...(trial ? { update: { from: trial.from, to: trial.to } } : {}),
    })
  }
  return code
}
