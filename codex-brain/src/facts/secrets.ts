// Secret guard for everything Brain stores from the agent (facts, proposals, notes): a text with a
// token-shaped secret is rejected, never stored, not even redacted (spec §5.2 "never store secrets").

import { findSecretKinds } from '../../../plugin/src/safety/redact.js'

/** The kinds of secret found in any of `texts`, joined, or null when there is none. */
export function findSecretText(texts: readonly string[]): string | null {
  const kinds = new Set<string>()
  for (const text of texts) for (const kind of findSecretKinds(text)) kinds.add(kind)
  return kinds.size === 0 ? null : [...kinds].sort().join(', ')
}
