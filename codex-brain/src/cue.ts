// Explicit "remember / correction" wording of the owner (spec §7.3). One pattern for the bridge
// (the permit cue, plugin/src/codex/brain-origin.ts) and the hook pack (the save reminder,
// codex-hooks/src/prompt.ts), so both flag exactly the same messages.

export const MEMORY_CUE =
  /(?<!\p{L})(?:запомни(?:те)?|поправка|не\s+надо|так\s+не\s+работает|неправильно|я\s+же\s+просил[аи]?|remember|correction)(?!\p{L})/iu

export function hasMemoryCue(text: string): boolean {
  return MEMORY_CUE.test(text)
}
