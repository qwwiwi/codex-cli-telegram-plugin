// The restart-loop lines every krotov-telegram.service must carry (docs/design/self-update-spec.md, S2).
// install.sh writes them; doctor reports a unit that lacks any of them.
// 6 starts in 300 s: a hard crash at 10 s spacing trips in about a minute, after safe mode (3 boots) acts.
export const UNIT_RESTART_LINES: readonly string[] = [
  'StartLimitIntervalSec=300',
  'StartLimitBurst=6',
  'OnFailure=krotov-telegram-failed.service',
  'Restart=on-failure',
  'RestartSec=10s',
  'RestartForceExitStatus=75',
  'SuccessExitStatus=75',
  'RestartPreventExitStatus=78',
  'TimeoutStopSec=90',
]

/** The contract lines missing from a unit file's text, in contract order. */
export function unitDrift(text: string): string[] {
  const all = text.split('\n').map(line => line.trim())
  const lines = new Set(all)
  const missing = UNIT_RESTART_LINES.filter(line => !lines.has(line))
  return all.some(line => bootGuard.test(line) && !guardInCheckout.test(line)) ? missing : [...missing, BOOT_GUARD_LINE]
}

// S9: the bash boot guard runs before every start; the "-" keeps a guard error from blocking the start.
// It must be the copy in the state directory: a guard inside the checkout can be deleted or broken by
// the very update it should roll back, so a unit that runs plugin/scripts/boot-guard.sh is drift too.
// Its path depends on the install, so drift is reported with this placeholder line.
export const BOOT_GUARD_LINE = 'ExecStartPre=-/bin/bash "<state>/boot-guard.sh"'
const bootGuard = /^ExecStartPre=-\S*bash\s+"?[^"]*\/boot-guard\.sh"?$/
const guardInCheckout = /\/scripts\/boot-guard\.sh"?$/
