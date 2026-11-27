// One admission rule for every owner turn (docs/design/self-update-spec.md, S9): a turn from the
// inbox (startNext) and a /goal start both wait while a turn runs or while /restart or /update holds
// the maintenance reservation. A /goal start awaits Codex several times before its goal counts as
// running, so it claims admission synchronously first: /update sees the bridge busy during that gap.

export type TurnBlocker = 'busy' | 'maintenance'

export interface TurnAdmissionDeps {
  /** A turn, a goal or another owner-visible piece of work is running. */
  running: () => boolean
  /** /restart or /update holds the maintenance reservation. */
  maintenance: () => boolean
}

export class TurnAdmission {
  private claims = 0

  constructor(private readonly deps: TurnAdmissionDeps) {}

  /** Why a new turn must not start now; undefined when it may. Maintenance wins over busy. */
  blocker(): TurnBlocker | undefined {
    if (this.deps.maintenance()) return 'maintenance'
    if (this.claims > 0 || this.deps.running()) return 'busy'
    return undefined
  }

  /** A start that claimed admission and has not released it yet. */
  get claiming(): boolean {
    return this.claims > 0
  }

  /**
   * Claims admission before the first await of a start; undefined when blocked.
   * The returned release is idempotent and must run once the start succeeded or failed.
   */
  claim(): (() => void) | undefined {
    if (this.blocker()) return undefined
    this.claims++
    let released = false
    return () => {
      if (released) return
      released = true
      this.claims--
    }
  }
}
