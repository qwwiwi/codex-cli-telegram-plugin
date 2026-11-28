// A local refusal raised BEFORE any HTTP request (size guard, redaction
// guard). Callers that must tell "provably not delivered" from "outcome
// unknown" key on this type instead of parsing messages.
export class WidgetPreSendError extends Error {
  override readonly name = 'WidgetPreSendError'
}

// The safe wrapper's masking grew a message that fit Telegram's limit past it: nothing was sent, and the caller
// sends the text through its split plain fallback instead of losing it to Telegram's refusal.
export class MaskedOverflowError extends Error {
  override readonly name = 'MaskedOverflowError'
}

// Masking did not settle: a registered value overlaps the mask marker, so every pass changes the text again.
// Nothing was sent; the send fails closed.
export class MaskFixedPointError extends Error {
  override readonly name = 'MaskFixedPointError'
}
