// A local refusal raised BEFORE any HTTP request (size guard, redaction
// guard). Callers that must tell "provably not delivered" from "outcome
// unknown" key on this type instead of parsing messages.
export class WidgetPreSendError extends Error {
  override readonly name = 'WidgetPreSendError'
}
