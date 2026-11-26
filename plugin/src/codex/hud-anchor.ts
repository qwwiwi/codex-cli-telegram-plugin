// Keeps the pinned context HUD card between the owner's message and the agent's
// reply: owner message -> HUD card -> reply. The card is moved to the bottom of
// the chat (ContextHud.bump) only when an owner message is accepted; turn
// progress and turn end only refresh it in place (ContextHud.updateNow). Reply
// senders await `settled()`, which resolves once the card of the latest owner
// message landed (or Telegram refused it), so a reply never goes out above the
// card of its own turn and never under a card of an older turn.
//
// Bursts: an owner message that arrives while a move is in flight does not
// start a second concurrent move and is not dropped either; the in-flight move
// is followed by exactly one more move, so the card always ends up under the
// newest owner message.
//
// Hangs: Telegram normally answers in well under a second, and a failed call
// resolves the move at once (the answer still goes out; ContextHud logs the
// failure). Only a call that hangs past the guard lets the answer go first;
// the card is then retired (ContextHud.retire, serialized behind the late
// move) so it never stays below the answer.
//
// Best-effort like every HUD operation: nothing here throws or rejects into the
// reply path.

export interface HudCard {
  bump(chatId: string): Promise<void>
  updateNow(chatId: string): Promise<void>
  retire(chatId: string): Promise<void>
}

export interface HudAnchorLog {
  warn(msg: string, ctx?: Record<string, unknown>): void
}

// Upper bound a reply waits for a hung card. Not a race against normal
// Telegram latency: a late card is retired, never left below the answer.
const HANG_GUARD_MS = 30_000

// One move of the card: one bump, plus one more per burst behind it.
interface Move {
  done: Promise<void>
  // An owner message arrived while this move was in flight.
  again: boolean
}

export class HudAnchor {
  private current: Move | undefined

  constructor(
    private readonly hud: HudCard,
    private readonly chatId: string,
    private readonly guardMs = HANG_GUARD_MS,
    private readonly log?: HudAnchorLog,
  ) {}

  /** An owner message was accepted: move the card under it. */
  ownerMessage(): void {
    if (this.current !== undefined) {
      this.current.again = true
      return
    }
    const move: Move = { done: Promise.resolve(), again: false }
    this.current = move
    move.done = this.run(move)
  }

  /** Turn progress or turn end: refresh the numbers in place, never move the card. */
  refresh(): void {
    void attempt(() => this.hud.updateNow(this.chatId))
  }

  /**
   * Resolves once the card of the latest owner message landed or failed. Never
   * rejects. One guard per move: once a wait for it expired, later waits (the
   * second wait of the same reply) return at once instead of adding another.
   */
  async settled(): Promise<void> {
    const move = this.current
    if (move === undefined) return
    // Concurrent waiters of the same move share one guarded wait.
    let wait = this.waits.get(move)
    if (!wait) {
      wait = this.guarded(move)
      this.waits.set(move, wait)
    }
    await wait
  }

  private readonly waits = new WeakMap<Move, Promise<void>>()

  private async run(move: Move): Promise<void> {
    try {
      do {
        move.again = false
        await attempt(() => this.hud.bump(this.chatId))
      } while (move.again)
    } finally {
      // Cleared in the same step that saw no burst, so no owner message is lost.
      if (this.current === move) this.current = undefined
    }
  }

  private async guarded(move: Move): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const guard = new Promise<void>(resolve => {
      timer = setTimeout(() => { expired = true; resolve() }, this.guardMs)
    })
    try {
      await Promise.race([move.done, guard])
    } finally {
      clearTimeout(timer)
      if (expired) {
        // The next owner message starts a fresh move with its own guard.
        if (this.current === move) this.current = undefined
        this.log?.warn('context hud card did not land in time; the reply goes out without it', {
          chat_id: this.chatId,
          guard_ms: this.guardMs,
        })
        void attempt(() => this.hud.retire(this.chatId))
      }
    }
  }
}

// Run a HUD call so that neither a synchronous throw nor a rejection escapes.
function attempt(call: () => Promise<void>): Promise<void> {
  try {
    return call().then(() => undefined, () => undefined)
  } catch {
    return Promise.resolve()
  }
}
