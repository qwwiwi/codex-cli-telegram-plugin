// Keeps the pinned context HUD card between the owner's message and the agent's
// reply: owner message -> HUD card -> reply. The card is moved to the bottom of
// the chat (ContextHud.bump) only when an owner message is accepted; turn
// progress and turn end only refresh it in place (ContextHud.updateNow). Reply
// senders await `settled()` so a reply never lands above the card of its own
// input.
//
// Best-effort like every HUD operation: nothing here throws or rejects into the
// reply path, and a slow or hung Telegram call delays a reply by at most the cap.

export interface HudCard {
  bump(chatId: string): Promise<void>
  updateNow(chatId: string): Promise<void>
}

// Upper bound a reply waits for the card of its input to land.
const SETTLE_CAP_MS = 3000

export class HudAnchor {
  private pending: Promise<void> | undefined

  constructor(
    private readonly hud: HudCard,
    private readonly chatId: string,
    private readonly capMs = SETTLE_CAP_MS,
  ) {}

  /** An owner message was accepted: move the card to the bottom of the chat now. */
  ownerMessage(): void {
    const bump = attempt(() => this.hud.bump(this.chatId))
    this.pending = bump
    void bump.then(() => {
      if (this.pending === bump) this.pending = undefined
    })
  }

  /** Turn progress or turn end: refresh the numbers in place, never move the card. */
  refresh(): void {
    void attempt(() => this.hud.updateNow(this.chatId))
  }

  /**
   * Resolves once the latest move landed (or after the cap). Never rejects.
   * One cap per move: once a wait for it timed out, later waits (the second
   * wait of the same reply) return at once instead of adding another cap.
   */
  async settled(): Promise<void> {
    const pending = this.pending
    if (pending === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const cap = new Promise<void>(resolve => {
      timer = setTimeout(() => { expired = true; resolve() }, this.capMs)
    })
    try {
      await Promise.race([pending, cap])
    } finally {
      clearTimeout(timer)
      if (expired && this.pending === pending) this.pending = undefined
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
