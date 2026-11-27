// Conservative token estimate for budget checks (HOT, priority block, handoff, recent tail).
//
// It must never under-count: hooks enforce their own caps and do not rely on Codex spilling large
// output to a file. Two lower bounds are combined and the larger one wins:
// - UTF-8 bytes / 3. Cyrillic is 2 bytes per character, so Russian text is estimated at about
//   0.67 tokens per character, above the 0.25-0.4 of common BPE vocabularies; English lands at
//   about 0.33 tokens per character against a typical 0.25.
// - one token per word run plus one per symbol, for punctuation- or digit-dense text where every
//   symbol may be its own token.
// The function is pure and deterministic, so the same text always gets the same estimate.

const encoder = new TextEncoder()
const PIECE = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const byBytes = Math.ceil(utf8Bytes(text) / 3)
  const byPieces = text.match(PIECE)?.length ?? 0
  return Math.max(byBytes, byPieces)
}
