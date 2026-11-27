// The one line the bridge prints when it cannot start. Unknown errors never reach the console
// (they may carry validation payloads or dependency output with secrets); the bridge's own
// startup messages and typed public-home errors (public-home.ts) do, sanitized.

import { isKnownStartupError } from './exit-codes.js'
import { PublicHomeError } from './public-home.js'

const GENERIC = 'Krot Codex pilot could not start'
const KNOWN = /^(Run the Codex pilot|The pilot requires|Set absolute|The Codex workspace|Telegram state must|A bot already|This private pilot|A Codex proxy requires|Configured Telegram token|Multi-user mode cannot start)/
// Token-looking words: known key prefixes and long opaque runs.
const TOKEN_LIKE = /\b(sk-|ghp_|xox[a-z]-)[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}/gu
const MAX_LENGTH = 600

function sanitize(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(TOKEN_LIKE, '[hidden]')
  return line.length > MAX_LENGTH ? line.slice(0, MAX_LENGTH - 1) + '…' : line
}

/** The console line for a startup failure. */
export function startupErrorMessage(error: unknown): string {
  if (error instanceof PublicHomeError) return sanitize('Multi-user mode cannot start: ' + error.message)
  // The exit-code list too (exit-codes.ts): its fatal configuration messages are safe to print.
  if (error instanceof Error && (KNOWN.test(error.message) || isKnownStartupError(error))) return error.message
  return GENERIC
}
