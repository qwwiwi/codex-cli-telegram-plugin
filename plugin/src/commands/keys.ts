// /keys — deterministic keystrokes from Telegram into the agent's tmux pane.
//
// Problem (owner, 2026-06-12): Claude Code's NATIVE interactive dialogs
// (permission rules like `Bash(rm:*) requires confirmation`, model switch
// prompts, trust dialogs) render in the terminal. The tmux mirror SHOWS them
// in Telegram, but there was no way to ANSWER one remotely — the session sat
// blocked until someone reached the real terminal.
//
// The /keys tap keypad sends an explicit, WHITELISTED keystroke to the pane:
//   tap «2»            → press «2» (select dialog option 2)
//   tap «1» then «⏎»   → press «1», then Enter
//   tap «⎋ esc»        → cancel the dialog
// (The earlier `/key <tokens>` text command was removed in favour of this
// panel; the token parser below is the shared whitelist it taps into.)
//
// Security model:
//   - Reaches this code only via the /keys panel's `kkey:` callback (auth in
//     server.ts + keys-panel-ui.ts): private chat + allowed_user_ids +
//     allowed_chat_ids. Group chats never get here.
//   - Tokens are a closed whitelist (digits, y/n, enter/esc/tab/space,
//     arrows). Arbitrary text is rejected, so the keypad cannot be used to type
//     shell commands into a pane that dropped out of Claude into a shell.
//   - Max 5 tokens per parsed call — a dialog answer, not a macro language.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Literal characters are sent with `send-keys -l` (no name lookup);
// named keys are sent without -l so tmux resolves Enter/Escape/arrows.
// Exported so the /keys inline-button panel (telegram/keys-panel-ui.ts)
// derives its accepted token set from THESE structures — the single whitelist
// the tap keypad injects into the pane.
//
// RUNTIME TAMPER-RESISTANCE (the whole point — this is a pane-injection
// security surface):
//   - `LITERAL_TOKEN_LIST` is a `Object.freeze`d array. Freezing an ARRAY
//     genuinely blocks `push`/index-assignment/`length` mutation at runtime,
//     so its `.includes()` membership cannot be widened — this is the single
//     source of truth literal-token validation checks against.
//   - `NAMED_TOKENS` is a `Object.freeze`d plain object. Freezing an object
//     blocks adding/reassigning own properties at runtime, so its own keys
//     cannot be widened. Membership is checked with `Object.hasOwn` (NOT a
//     bare `t in NAMED_TOKENS`) so a polluted `Object.prototype` cannot smuggle
//     an un-whitelisted token through the prototype chain.
//   - We deliberately do NOT export a `Set` of literal tokens. A `Set`'s
//     contents live in internal slots, so `Object.freeze(new Set(...))` does
//     NOT stop `.add('rm')` — an importer could cast the `ReadonlySet` back to
//     `Set` and widen the injectable keystroke set. The frozen array + the
//     `isLiteralToken` predicate below close that hole.

// Canonical literal-token list (readonly tuple, frozen at runtime). Digits
// 0-9 + y/n. SINGLE SOURCE OF TRUTH — literal-token validation and the panel
// both derive from this exact frozen array.
export const LITERAL_TOKEN_LIST = Object.freeze([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'y', 'n',
] as const)

// Immutable literal-token predicate. Membership is checked against the FROZEN
// `LITERAL_TOKEN_LIST` (whose `.includes` cannot be widened at runtime), so
// there is no mutable `Set` an importer could cast-and-`.add()` to inject a
// new keystroke. The function itself is frozen so it cannot be monkey-patched.
export const isLiteralToken: (t: string) => boolean = Object.freeze(
  (t: string): boolean => (LITERAL_TOKEN_LIST as readonly string[]).includes(t),
)

// Canonical named-token map (frozen at runtime). lower-case token → tmux key
// name. `esc` and `escape` are intentional ALIASES for the same Escape key —
// the /keys panel surfaces `esc` only (both parse identically). Freezing a
// plain object hard-stops adding/reassigning own properties; membership is
// tested with `Object.hasOwn` (not a prototype-walking `in`) so the frozen own
// keys are the genuine, immutable whitelist at runtime.
export const NAMED_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  // Input-field editing for the /keys panel. `backspace` deletes ONE char to
  // the left; `clear` (Ctrl-U) erases the whole input line at once. Both are
  // control keys — they can only DELETE in the input field, never inject text,
  // so they don't widen the pane-injection surface. C-u is the same line-clear
  // already used by sendSlashCommand below.
  backspace: 'BSpace',
  clear: 'C-u',
} as const)

export const MAX_KEY_TOKENS = 5

export interface ParsedKeys {
  // In tmux send-keys argument form, one entry per keystroke.
  steps: Array<{ literal: boolean; key: string }>
}

// Parse keypad token args (e.g. "2 enter") into validated steps. Returns an
// error string (for the Telegram reply) when any token is outside the whitelist.
export function parseKeyTokens(args: string): ParsedKeys | { error: string } {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { error: 'нет клавиши: <1-9|0|y|n|enter|esc|tab|space|up|down|left|right|backspace|clear> …' }
  }
  if (tokens.length > MAX_KEY_TOKENS) {
    return { error: `слишком много нажатий за раз (максимум ${MAX_KEY_TOKENS})` }
  }
  const steps: ParsedKeys['steps'] = []
  for (const t of tokens) {
    // Validate against the FROZEN list (not a mutable Set) so a runtime
    // `(structure as Set).add('rm')` cannot widen the injectable keystrokes.
    if (isLiteralToken(t)) {
      steps.push({ literal: true, key: t })
    } else if (Object.hasOwn(NAMED_TOKENS, t)) {
      // OWN-property check (not `t in NAMED_TOKENS`): a bare `in` walks the
      // prototype chain, so `Object.prototype.rm = 'Enter'` would make
      // `parseKeyTokens('rm')` accept an un-whitelisted token (prototype
      // pollution). `Object.hasOwn` only sees the frozen own keys, closing it.
      steps.push({ literal: false, key: NAMED_TOKENS[t]! })
    } else {
      return { error: `неизвестная клавиша: ${t} — разрешены цифры, y/n, enter, esc, tab, space, стрелки, backspace, clear` }
    }
  }
  return { steps }
}

export interface TmuxKeysTarget {
  paneTarget: string
  // `-L name` (socket under the default tmux dir) — used when the pane comes
  // from explicit plugin config.
  socketName?: string
  // `-S /path/to/socket` (absolute socket path) — used when the pane is
  // resolved from the plugin's own $TMUX env (we live inside the session).
  socketPath?: string
}

export type KeysExec = (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>

async function defaultKeysExec(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync('tmux', args as string[], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return { exitCode: 0, stderr }
  } catch (err) {
    const e = err as { stderr?: string; code?: number; message?: string }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
    }
  }
}

// Send the validated steps to the pane, one send-keys call per step (mixing
// -l and named keys in a single call is error-prone). Stops on first failure.
export async function sendKeys(
  target: TmuxKeysTarget,
  parsed: ParsedKeys,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  for (const step of parsed.steps) {
    const args = [
      ...socketArgs,
      'send-keys',
      '-t',
      target.paneTarget,
      ...(step.literal ? ['-l'] : []),
      step.key,
    ]
    const res = await exec(args)
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────
// /cc — passthrough to Claude Code's own slash commands (/compact, /clear,
// /model, /context, custom skills, …) by typing them into the agent pane.
// ─────────────────────────────────────────────────────────────────────

// Slash-command NAME: a leading letter then letters/digits/colon/dash.
// Colon allows plugin-namespaced commands (e.g. superpowers:brainstorm).
export const SLASH_NAME_RE = /^[a-z][a-z0-9:-]{0,40}$/
// ARGS: a deliberately narrow set — alphanumerics, space, and a few path/flag
// punctuation marks. NO shell metacharacters ($ ` ; | & > < ( ) { } " ' \\),
// so even if the pane were at a shell prompt the text can't compose a command.
export const SLASH_ARGS_RE = /^[A-Za-z0-9 ._:/@=-]{0,200}$/

export interface ParsedCc {
  name: string
  rest: string
}

export function parseCcCommand(args: string): ParsedCc | { error: string } {
  const trimmed = args.trim()
  if (trimmed.length === 0) {
    return { error: 'usage: /cc <команда> [аргументы] — напр. /cc compact, /cc model opus' }
  }
  // Explicit newline reject (Codex/Fable review): the charset already excludes
  // \r\n, but a bare-anchored regex CAN match before a trailing newline in JS,
  // so reject up front to make the single-line invariant obvious and robust.
  if (/[\r\n]/.test(trimmed)) {
    return { error: 'аргументы не должны содержать переводов строки' }
  }
  const wsIdx = trimmed.search(/\s/)
  const rawName = wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx)
  const name = rawName.toLowerCase().replace(/^\//, '')
  const rest = wsIdx === -1 ? '' : trimmed.slice(wsIdx + 1).trim()
  if (!SLASH_NAME_RE.test(name)) {
    return { error: `недопустимое имя команды: ${rawName}` }
  }
  if (!SLASH_ARGS_RE.test(rest)) {
    return { error: 'аргументы содержат недопустимые символы (разрешены буквы, цифры, . _ : / @ = -)' }
  }
  return { name, rest }
}

// Type `/<name> [rest]` into the pane and submit with Enter. Clears the input
// line first (C-u) so a leftover draft can't corrupt the command — the same
// hygiene used when driving another agent's pane by hand.
//
// IT2-7: funnelled through the SAME per-pane serialization chain as
// sendControlCommand (via runOnPaneChain, defined below) so an argful /cc, a
// /keys tap, or /stop cannot interleave its keystrokes with an in-flight control
// 3-shot. The raw body lives in `sendSlashCommandInner`; the export is the
// chained wrapper. Return contract is unchanged.
export function sendSlashCommand(
  target: TmuxKeysTarget,
  parsed: ParsedCc,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runOnPaneChain(target, () => sendSlashCommandInner(target, parsed, exec))
}

async function sendSlashCommandInner(
  target: TmuxKeysTarget,
  parsed: ParsedCc,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const text = parsed.rest ? `/${parsed.name} ${parsed.rest}` : `/${parsed.name}`
  // `text` always starts with '/', so it can never be parsed as a tmux flag.
  const steps: Array<readonly string[]> = [
    [...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'],
    [...socketArgs, 'send-keys', '-t', target.paneTarget, '-l', text],
    [...socketArgs, 'send-keys', '-t', target.paneTarget, 'Enter'],
  ]
  for (const args of steps) {
    const res = await exec(args)
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
    }
  }
  return { ok: true }
}

// Send a single named key (Escape, Enter, …) to the pane — used by /stop to
// interrupt Claude, and reusable by other control commands.
//
// IT2-7: the export is serialized through the per-pane chain (runOnPaneChain) so
// a /stop Escape can't land between an in-flight control 3-shot's keystrokes.
// The raw body is `sendNamedKeyInner`; sendControlCommandInner calls the INNER
// form directly (it already holds the pane chain — re-chaining would deadlock).
export function sendNamedKey(
  target: TmuxKeysTarget,
  key: string,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runOnPaneChain(target, () => sendNamedKeyInner(target, key, exec))
}

async function sendNamedKeyInner(
  target: TmuxKeysTarget,
  key: string,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const res = await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, key])
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────
// /clear, /compact & friends — RELIABLE control-command injection.
//
// Problem (owner, 2026-07-01, verified empirically): the 3-shot
// `sendSlashCommand` above (C-u / -l '/cmd' / Enter) is correct ONLY when the
// pane is IDLE. It fails in two states:
//   - BUSY: Claude Code QUEUES text typed while it is working; the command
//     sits in the queue and runs ~25s later (or is silently dropped).
//   - DIALOG: a native permission/confirm dialog is open; the trailing Enter
//     APPROVES THE DIALOG and the typed command is lost.
// Fix: PROBE the pane state before sending, then CONFIRM the command actually
// fired afterwards. Never blind-Enter into a busy pane or an open dialog.
//
// Additive — `sendSlashCommand` stays for argful /cc passthrough (idle only).
// Everything here is driven by `capture-pane`, whose stdout the send-only
// `KeysExec` deliberately drops, so a dedicated capture exec type is needed.

// A capture-capable exec: like `KeysExec` but KEEPS stdout, which `capture-pane`
// needs. Kept SEPARATE from `KeysExec` so the send-only path can never grow a
// stdout dependency, and so tests can script pane snapshots independently of the
// send-keys fake.
export type KeysCaptureExec = (
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

async function defaultKeysCaptureExec(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args as string[], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
    }
  }
}

// Snapshot the pane's visible text (`capture-pane -p`). Returns '' on ANY tmux
// failure — callers classify '' as 'unknown' (never idle), so a failed capture
// can never be mistaken for a safe-to-send idle pane.
export async function capturePane(
  target: TmuxKeysTarget,
  exec: KeysCaptureExec = defaultKeysCaptureExec,
): Promise<string> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const res = await exec([...socketArgs, 'capture-pane', '-p', '-t', target.paneTarget])
  if (res.exitCode !== 0) return ''
  return res.stdout
}

export type PaneState = 'idle' | 'busy' | 'dialog' | 'unknown'

// Number of trailing lines that constitute the LIVE UI chrome (the composer box
// + footer hints + the status/spinner line just above the box). We match the
// pane-state markers ONLY within this bottom region so the agent's OWN
// transcript — which can literally contain strings like "esc to interrupt" or
// "Do you want to proceed?" (this very plugin discusses them) — scrolls ABOVE
// the chrome and can never be misread as live pane state (FIX-5, Fable M3).
//
// Fail-safe bias: a marker that quotes chrome text in the last few transcript
// lines yields a FALSE busy/dialog, which only makes us REFUSE to send (safe),
// never a false idle (which would blind-send). 12 lines comfortably spans a
// tall permission dialog box while excluding scrolled-up history.
const BOTTOM_CHROME_LINES = 12

// The bottom UI chrome region of a capture (geometry anchor for classifyPane,
// the queued-check and the fired-marker count). Exported-internal helper; PURE.
//
// IT2-4: strip trailing whitespace-only lines BEFORE taking the last N. When a
// taller render shrinks (a dialog box closed, a compaction finished) tmux can
// leave blank rows padding the bottom of the capture; without trimming them the
// real chrome markers get pushed OUT of the last-N window and we go blind to the
// live pane state (a false 'unknown'/'idle'). Trimming the blank tail keeps the
// markers inside the window. classifyPane, the queued-check and firedMarkerCount
// all read through this trimmed region.
function bottomChrome(text: string): string {
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim().length === 0) end--
  const trimmed = lines.slice(0, end)
  if (trimmed.length <= BOTTOM_CHROME_LINES) return trimmed.join('\n')
  return trimmed.slice(trimmed.length - BOTTOM_CHROME_LINES).join('\n')
}

// Classify a pane snapshot by string-matching Claude Code TUI v2.1.200 markers,
// anchored to the bottom UI chrome (FIX-5). PURE (no I/O) so it is trivially
// unit-testable against canned captures.
//
// Idle footer is MODE-DEPENDENT (verified on the live pane, v2.1.200): Manual
// mode shows `? for shortcuts`; bypass / accept-edits / plan modes show
// `⏵⏵ … (shift+tab to cycle)` — which PERSISTS on line 1 even while the slash
// autocomplete popup is open. We OR both markers so idle is recognised in every
// mode.
//
// The footer also changes when the session has background shells. It renders
// `⏵⏵ accept edits on · 2 shells · ↓ to manage` and DROPS `(shift+tab to cycle)`
// altogether — not a width clip (verified: widening to 200 columns did not bring
// it back). Matching on individual hint segments therefore made idle detection
// depend on which extras the TUI felt like showing, and every /new + /compact for
// that agent died as `unknown`. So the mode line itself — `⏵⏵` OPENING a line —
// is the idle marker; the segments after it are free to vary. Anchoring to the
// line start keeps transcript prose that merely quotes `⏵⏵` from passing as the
// footer. The interrupt hint still wins (checked first), since a busy pane also
// renders this same mode line.
//
// Ordering is load-bearing: DIALOG is checked BEFORE BUSY, because a native
// permission dialog can ALSO render an "esc to interrupt" hint while a tool runs
// behind it — but a dialog needs an explicit answer, never a blind Enter, so
// dialog must win. Dialog markers (`Do you want to proceed?`, `❯ 1.`,
// `Esc to cancel`) confirmed exact on v2.1.200 — the folder-trust dialog uses
// `❯ 1. Yes…` + `Esc to cancel` (no "Do you want to proceed?"), still caught.
//
// NOT covered here, deliberately: Claude Code's inline session survey ("How is
// Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss") renders ABOVE a
// normal composer with the normal footer, so it reads as idle. It is not a
// blocking dialog and the live captures show both native dialogs (folder-trust,
// permission card) suppress the mode footer entirely, so an open dialog can
// never reach the idle arm. If the survey ever did swallow the composer, the
// pre-Enter draft-ready poll refuses with `not-submitted` rather than blind-Enter.
//
// Callers MUST treat 'unknown' as NOT-idle: if we cannot POSITIVELY identify an
// idle composer, we never blind-Enter (the trailing Enter of a slash command
// could otherwise approve a prompt we failed to recognise). Geometry-detection
// failure (empty capture, no recognisable chrome) → 'unknown' → refuse.
// The permission-mode footer line (`⏵⏵ accept edits on · …`). Matched ONLY
// against the LAST non-blank line, which is where the real footer always sits:
// this plugin's own transcript quotes whole footer lines while discussing panes,
// and such a quote must never pass as live chrome.
const MODE_FOOTER_RE = /^[ \t]*⏵⏵[ \t]/

function lastNonBlankLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().length > 0) return lines[i]!
  }
  return ''
}

export function classifyPane(text: string): PaneState {
  const chrome = bottomChrome(text)
  if (
    chrome.includes('Do you want to proceed?') ||
    chrome.includes('❯ 1.') ||
    chrome.includes('Esc to cancel')
  ) {
    return 'dialog'
  }
  if (chrome.includes('esc to interrupt')) {
    return 'busy'
  }
  if (
    (chrome.includes('shift+tab to cycle') ||
      chrome.includes('? for shortcuts') ||
      MODE_FOOTER_RE.test(lastNonBlankLine(chrome))) &&
    !chrome.includes('esc to interrupt')
  ) {
    return 'idle'
  }
  return 'unknown'
}

// Real timer sleep. Tests inject an instant no-op so the confirm-fire poll does
// not actually wait ~1.5s.
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface ControlCommandOpts {
  // Interrupt a BUSY pane (Escape, wait, re-probe) before sending. When false
  // (default) a busy pane is left untouched and reported as busy.
  interruptIfBusy?: boolean
  // Delay primitive — injected as an instant no-op in tests.
  sleep?: (ms: number) => Promise<void>
  // Send-only exec (send-keys). Defaults to the real tmux exec.
  exec?: KeysExec
  // Capture-capable exec (capture-pane). Defaults to the real tmux exec.
  captureExec?: KeysCaptureExec
  // Wall clock in ms — injected by tests that need a fixed `now` to turn a
  // tmux activity stamp into a deterministic pane idle time.
  now?: () => number
}

// Discriminated union: either it fired, or it did not — with the precise reason
// so the caller can tell the user WHY (dialog open, pane busy, never submitted,
// a raw tmux failure, or an UNKNOWN pane we refused to blind-send into).
//
// `unknown` (FIX-1, both reviews): a failed capture-pane returns '' and an
// unrecognised screen both classify as `unknown`. We NEVER send into an
// unknown pane — a blind Enter could approve a dialog we failed to recognise —
// so the caller sees an explicit `unknown` reason rather than a silent send.
export type ControlCommandResult =
  | { ok: true }
  | { ok: false; reason: 'dialog' | 'busy' | 'not-submitted' | 'tmux' | 'unknown' }

// The composer text region = the lines framed by the LAST two horizontal box
// rules (the input box borders). We check THIS region — not the whole capture —
// for a leftover '/'+name, so a transcript ECHO of the submitted command
// (rendered OUTSIDE the box) is never mistaken for an un-submitted draft.
function composerRegion(text: string): string {
  const lines = text.split('\n')
  const ruleIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    // A box border: 3+ consecutive ─ (U+2500) or a long ASCII dash run.
    if (/─{3,}/.test(lines[i]!) || /-{5,}/.test(lines[i]!)) ruleIdx.push(i)
  }
  if (ruleIdx.length === 0) return text // no box drawn — be conservative
  const last = ruleIdx[ruleIdx.length - 1]!
  const prev = ruleIdx.length >= 2 ? ruleIdx[ruleIdx.length - 2]! : -1
  return lines.slice(prev + 1, last).join('\n')
}

// Count the LINES of `text` that carry `marker`. PURE. Empty marker → 0 (never
// matches, so it can't spuriously certify a fire).
//
// Line-anchored, not a free substring search (2026-10-03 review): the marker
// search region is the whole transcript, which also holds the AGENT'S OWN
// PROSE, and agents routinely quote these strings — every report about this very
// bug contains `❯ /clear` mid-sentence. A substring match turns such a sentence
// into a fresh occurrence and certifies a command that never ran.
//
// Anchored to COLUMN 0, because a line anchor alone is not enough: prose can BE
// the whole line (a quoted capture, a code block, a diff hunk). The column is
// what separates them. In pane captures containing `❯ /clear` in the
// transcript, every transcript occurrence is
// indented (`  ⎿ `, `● `, a diff's line number) and the only column-0 `❯` is the
// composer. The TUI writes agent output through a gutter; what the TUI itself
// emits — the prompt echo, a banner — starts flush left. Trailing whitespace is
// tolerated (capture-pane may pad), leading whitespace is NOT.
//
// `wholeLine` markers must BE the line: a prompt echo is emitted alone on its
// line. Both captures showed only `❯ /clear` on that line.
//
// KNOWN LIMIT, stated rather than papered over: text alone cannot distinguish a
// genuine echo from a BYTE-IDENTICAL forgery — transcript content that is
// exactly `❯ /clear` starting at column 0. Review built that case synthetically
// and it still certifies. The defence is not the string but the renderer: the
// corpus above says the TUI has no way to put agent text in column 0, so the
// forgery is unreachable on a real pane, and reaching it would ALSO require the
// target agent to paint it inside the ~2.8s window after Enter. If a build is
// ever seen rendering agent output flush left, this anchor is void and the
// signal needs a different discriminator (e.g. the echo's position relative to
// the collapse), not a wider string match.
function countMarkerLines(text: string, marker: FiredMarker): number {
  if (marker.text.length === 0) return 0
  let count = 0
  for (const line of text.split('\n')) {
    const flushLeft = line.trimEnd()
    if (marker.wholeLine ? flushLeft === marker.text : flushLeft.startsWith(marker.text)) count++
  }
  return count
}

// Positive "it actually ran" marker strings per command. Scoped to the bottom UI
// chrome (FIX-5) by the caller so a transcript far above that quotes
// "Compacting" is not misread. For `compact` we track BOTH the
// `Compacting conversation…` banner AND the `❯ /compact` echo — a fresh compact
// always prints at least the echo, so summing them makes a genuine fire reliably
// ADD to the count even when a prior run's banner is still on screen.
//
// CRITICAL (coordinator smoke-test, v2.1.200): `Ctrl+Y to paste` does NOT render
// after /clear in this build — using it as the clear marker made /clear and /new
// ALWAYS report not-submitted even on success. /clear success is the fresh
// `❯ /clear` echo (plus the transcript collapse handled in confirmedFired).
// `wholeLine`: the marker is the ENTIRE line (a prompt echo) rather than its
// beginning (a banner with a tail). See countMarkerLines for why it matters.
interface FiredMarker {
  readonly text: string
  readonly wholeLine: boolean
}

function firedMarkers(name: string): readonly FiredMarker[] {
  if (name === 'clear') {
    // /clear echoes an accepted `❯ /clear` into the (now-collapsed) transcript.
    return [{ text: '❯ /clear', wholeLine: true }]
  }
  // /compact used to ALSO track the `Compacting conversation…` banner as a
  // prefix marker. Dropped 2026-10-03 (review): a prefix marker matches any
  // sentence that merely OPENS with the word, and unlike the prompt echo the
  // banner legitimately lives at column 0, so the column anchor cannot separate
  // it from prose — an agent writing «Compacting история диалогов…» certified a
  // compact that never fired. The banner was never measured on a real pane; it
  // was added on the assumption it helps. An unmeasured signal that widens the
  // false-«готово» surface is not worth keeping: a genuine compact always
  // echoes `❯ /compact`, which the generic marker below already catches, and
  // `/compact` is additionally covered by the busy flip (WORK_STARTING_COMMANDS).
  // Generic: Claude Code echoes an accepted slash command into the transcript
  // as `❯ /name`. (Distinct from the dialog option marker `❯ 1.`.)
  return [{ text: `❯ /${name}`, wholeLine: true }]
}

// The occurrence count of a command's fired-markers WITHIN THE TRANSCRIPT.
// Success is judged by an INCREASE of this count vs the pre-send baseline (a
// fresh occurrence), never by mere presence — a stale marker already on screen
// no longer certifies a fire.
//
// 2026-10-03 — region fix, root cause of the owner's «не выполнено
// (not-submitted)» on a /clear that HAD run: this used to search `bottomChrome`
// (the last 12 non-trailing-blank lines). An accepted command is echoed INTO
// THE TRANSCRIPT, i.e. ABOVE the composer, and on a pane where the composer is
// pinned to the bottom the echo falls outside that window entirely — live
// capture, 80×24: echo on line 10, composer rule on line 21,
// so the window spans lines 13..24 and no text signal could see the echo. (The
// polygon missed it because WITHOUT the plugin's three-line channels banner the
// whole post-clear screen is 12 lines, so the window covered it by accident.)
// `bottomChrome` exists to stop `classifyPane` reading scrolled-up history as
// live pane state; it was never the right lens for a command's echo.
//
// The transcript — not the whole capture — is the honest region: the echo of an
// accepted command lands there, while the UNSENT draft of the same command sits
// in the composer and must never be counted as its own confirmation.
function firedMarkerCount(name: string, text: string): number {
  const transcript = transcriptRegion(text)
  let total = 0
  for (const m of firedMarkers(name)) total += countMarkerLines(transcript, m)
  return total
}

// Transcript region = everything ABOVE the composer box (before its top rule).
// Used only to detect that /clear visibly WIPED the conversation.
function transcriptRegion(text: string): string {
  const lines = text.split('\n')
  const ruleIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/─{3,}/.test(lines[i]!) || /-{5,}/.test(lines[i]!)) ruleIdx.push(i)
  }
  if (ruleIdx.length < 2) return ''
  const boxTop = ruleIdx[ruleIdx.length - 2]!
  return lines.slice(0, boxTop).join('\n')
}

function nonEmptyLineCount(text: string): number {
  return text.split('\n').filter((l) => l.trim().length > 0).length
}

// The non-empty transcript lines of a PRE-SEND screen — the exact set
// 'transcript-replaced' asks its question about.
function baselineTranscriptLines(baseline: string): readonly string[] {
  return transcriptRegion(baseline)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

// How many of those lines are STILL on screen. Zero means the conversation was
// replaced outright; any survivor means it wasn't. Shared by the signal and by
// the journal's poll shape ON PURPOSE: a refusal must be read against the same
// number the decision was made on, not a near-miss recomputed differently.
function survivingBaselineLines(baseline: string, snap: string): number {
  const now = transcriptRegion(snap)
  return baselineTranscriptLines(baseline).filter((l) => now.includes(l)).length
}

// Which signal certified a fire. Named (not just boolean) so the journal can
// record WHY a send was believed: two of the three are a text trace OF the
// command, 'busy-flip' is circumstantial, and a false ok via the weak one must
// be distinguishable from a marker-confirmed one in the audit trail.
export type ConfirmSignal =
  | 'marker'
  | 'transcript-collapse'
  | 'transcript-replaced'
  | 'busy-flip'

// How many non-empty transcript lines the PRE-SEND screen must carry before
// 'transcript-replaced' may certify anything. The signal says «none of these
// lines survived»; on a nearly empty screen that is vacuously true, so a floor
// is what keeps it a measurement instead of a tautology.
const MIN_REPLACED_BASELINE_LINES = 3

// Commands whose OWN effect is to start work, so a pane that flips to working is
// evidence they landed: /clear reboots the session (v2.1.215 shows a boot
// spinner), /compact starts summarising. Deliberately NOT every name that passes
// SLASH_NAME_RE — `sendControlCommand` is a general exported API, and for any
// other command a pane that merely flickers busy proves nothing about whether
// that command ran.
const WORK_STARTING_COMMANDS = new Set(['clear', 'compact'])

// The composer box and everything BELOW it: from the second-to-last horizontal
// rule to the end of the capture. This is where the TUI puts things that await
// the user — the input box itself, a native card that REPLACES it, the footer —
// as opposed to transcript prose, which always renders above that rule.
function composerAndBelow(text: string): string {
  const lines = text.split('\n')
  const ruleIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/─{3,}/.test(lines[i]!) || /-{5,}/.test(lines[i]!)) ruleIdx.push(i)
  }
  if (ruleIdx.length === 0) return text // no box drawn — be conservative
  const from = ruleIdx.length >= 2 ? ruleIdx[ruleIdx.length - 2]! : ruleIdx[0]!
  return lines.slice(from).join('\n')
}

// A numbered choice list / yes-no prompt WHERE THE TUI ASKS. classifyPane
// recognises a dialog by three literal v2.1.215 strings only; a dialog phrased
// any other way ALSO renders `esc to interrupt` and therefore reads as `busy`.
// Pre-2026-10-03 that was harmless (busy → refuse), but once a busy flip can
// certify a send, such a dialog would be reported as «готово» while it sits
// UNANSWERED and nobody is told to look at the pane. So any choice-prompt shape
// vetoes the circumstantial signal — a needless refusal is recoverable, a false
// success is not.
//
// Scoped to composerAndBelow, NOT the whole bottom chrome (round-2 review): the
// agents' own replies routinely END in a numbered list, and those lines stay on
// screen while the cleared session boots. A whole-window scan therefore vetoed
// ordinary prose and re-created the exact bug this patch exists to fix (a real
// /clear answered «не выполнено»). Live geometry — the v2.1.200 dialog captures
// and `classifyPane`'s own note that native cards suppress the mode footer
// entirely — says a card REPLACES the composer, so its options land inside this
// region while transcript prose never does.
function hasChoicePrompt(text: string): boolean {
  const region = composerAndBelow(text)
  return /^[ \t]*(?:❯[ \t]*)?\d+\.[ \t]+\S/m.test(region) || /\(y\/n\)/i.test(region)
}

// FIX-2 / IT2-2 (both reviews): a merely-PRESENT positive marker is not proof of
// success — a marker left over from a PREVIOUS command (a stale "Compacting…",
// "Ctrl+Y to paste", or "❯ /name") would otherwise certify a command that never
// fired (a false NEGATIVE the other way: it made a real fire read as
// not-submitted, and broke back-to-back compacts). Require a FRESH OCCURRENCE:
// the marker count within the bottom chrome must INCREASE vs the PRE-SEND
// baseline. A stale marker leaves the count unchanged (refuse); a genuine
// (even back-to-back) fire adds a new occurrence on top (accept). For /clear we
// ALSO accept a visibly collapsed transcript (the old conversation wiped) as
// proof it ran, covering the case where a stale paste-hint was already on screen
// and the count cannot move.
function confirmedFired(name: string, snap: string, baseline: string): ConfirmSignal | null {
  // A FAILED capture is not a screen. capturePane returns '' on any non-zero
  // tmux exit (pane gone, server busy, timeout) and '' is the absence of
  // information, not an empty pane — a real pane always carries at least a
  // composer. Without this guard an empty snapshot has zero transcript lines,
  // fewer than any real baseline, and 'transcript-collapse' read «the
  // conversation was wiped» out of a capture that never happened (2026-10-03
  // review, reproduced). Nothing may be certified from a screen nobody saw.
  if (snap.trim().length === 0) return null
  // Primary: a FRESH occurrence of the command's marker in the bottom chrome.
  if (firedMarkerCount(name, snap) > firedMarkerCount(name, baseline)) return 'marker'
  // Everything below this line is CIRCUMSTANTIAL — inferred from the screen's
  // shape rather than from a trace of the command itself. None of it may certify
  // a send while the TUI is asking the user something: an unrecognised card (one
  // classifyPane's three literals miss) must surface as a refusal the owner can
  // act on, never as «готово» over an unanswered question. Found by test: a
  // choice card ALSO shrinks the transcript, so vetoing only the busy flip left
  // 'transcript-collapse' as a way around this guard.
  if (hasChoicePrompt(snap)) return null
  if (name === 'clear') {
    // /clear success #2: the conversation visibly COLLAPSED (fewer transcript
    // lines than before) — the wipe landed.
    if (nonEmptyLineCount(transcriptRegion(snap)) < nonEmptyLineCount(transcriptRegion(baseline))) {
      return 'transcript-collapse'
    }
    // /clear success #3: the conversation was REPLACED. Collapse measures line
    // ARITHMETIC, and that arithmetic fails on a pane whose wipe makes the screen
    // LONGER: v2.1.215 reboots into a banner (logo, version, cwd, the channels
    // warning) that can outnumber the conversation it replaced. In one test,
    // a clear that really ran (new session file, same second) polled
    // `t=10` against a `t=6` baseline for the whole window and was reported
    // not-submitted to the owner. What a wipe guarantees is not fewer lines but
    // that NONE of the old ones are left, so measure exactly that.
    //
    // This stays a measurement of CHANGE, not of presence: a dropped Enter leaves
    // the old transcript sitting on screen, every baseline line matching, so the
    // signal cannot fire for the failure it is meant to distinguish (pinned by
    // the 'unchanged transcript is never read as replaced' test). The scroll
    // caveat — a pane that merely scrolled far enough would also lose every
    // baseline line — is covered by the call site, which only consults this after
    // the composer emptied, plus the choice-prompt veto above.
    //
    // ONE survivor vetoes it, not merely "most of them gone": a pane that simply
    // scrolled while the agent kept writing loses most of the old lines too, and
    // a single line still on screen proves the session was never rebooted. The
    // journal records the same count as `sv=` so a near-miss is readable.
    const baselineLines = baselineTranscriptLines(baseline)
    if (
      baselineLines.length >= MIN_REPLACED_BASELINE_LINES &&
      survivingBaselineLines(baseline, snap) === 0
    ) {
      return 'transcript-replaced'
    }
    // REMOVED 2026-10-03 — the presence-based `echo-idle` fallback ("the echo is
    // on screen and the footer is idle, so the clear ran"). It was introduced for
    // the already-clear session, where neither the marker count nor the
    // transcript can move; measuring that case frame-by-frame (polygon, 80×24,
    // v2.1.215) showed the inference
    // is unsound, not merely weak:
    //   +0.93s  the pane goes BUSY and the previous clear's echo is WIPED with
    //           the transcript it lived in — inside the confirm window there is
    //           no echo to see at all
    //   +30s    the settled pane is BYTE-IDENTICAL to the pre-send baseline
    // So "echo present + idle footer" is exactly what a DROPPED Enter leaves
    // behind too, and the signal cannot tell the two apart — it reported «ok» for
    // a command that never fired (review exploit, reproduced). What certifies a
    // genuine back-to-back clear is the busy flip below, which the measurement
    // shows is both present and durable (≥2.9s). Where the echo IS fresh the
    // marker count moves and 'marker' already covers it.
  }
  // Success #4, CIRCUMSTANTIAL — checked LAST, after every text trace, because it
  // is the only signal that is not a trace of the command itself. It exists
  // because the text traces can be absent for the whole window. Two
  // frame-by-frame measurements at 80×24, v2.1.215 (2026-10-03), both timed from
  // the Enter keystroke, NOT from when typing began:
  //   first clear  (capt3): pane busy within 0.18s, `❯ /clear` echo at ~0.5-0.6s
  //                         — meanwhile the transcript GROWS (a boot spinner
  //                         fills the empty space) instead of collapsing
  //   second clear (capt4): pane busy at 0.93s and the PREVIOUS echo wiped with
  //                         the transcript, so NO text trace exists in the window
  // In the second case the busy flip is the only honest signal there is. What it
  // rests on: the sender probed this pane as idle,
  // typed, verified
  // the draft, pressed Enter once, and the caller has already confirmed the draft
  // left the composer. Two narrowings keep that inference honest: the
  // choice-prompt veto above gates every circumstantial signal, and this one
  // fires ONLY for commands that start work themselves (WORK_STARTING_COMMANDS)
  // — for any other name a pane that merely flickers busy proves nothing.
  //
  // Precision about the pane state at Enter: the PRE-SEND probe is a positive
  // idle (runControlCommand refuses anything else), but the draft-poll loop
  // tolerates 'unknown' — the slash autocomplete popup can blank the footer — so
  // at the moment of Enter the pane is idle-OR-unknown. It is never busy or
  // dialog: both abort the send before Enter.
  if (WORK_STARTING_COMMANDS.has(name) && classifyPane(snap) === 'busy') {
    return 'busy-flip'
  }
  return null
}

// FIX-4 (both reviews): per-pane serialization. This code drives the user's
// ONLY communication channel by injecting keystrokes; two concurrent control
// sends into the SAME pane (e.g. a HUD «Сжать» tap racing a typed /compact)
// could interleave C-u / text / Enter and corrupt the command — or worse,
// let one call's Enter land on another's half-typed draft. IT2-7: EVERY pane
// write — sendControlCommand, sendSlashCommand, sendNamedKey — chains through
// this per-target promise (runOnPaneChain) so they run strictly one-at-a-time.
// Keyed by socket+pane so distinct panes stay independent. The stored chain is
// the SETTLED (never-rejecting) tail, so a failed/throwing call never poisons the
// next one.
const paneChains = new Map<string, Promise<void>>()

// IT2-7: run `fn` strictly after any in-flight pane operation for the SAME
// target, and make the next caller wait for `fn`. The single per-pane
// serialization primitive shared by sendControlCommand, sendSlashCommand and
// sendNamedKey so their keystrokes can never interleave. The stored chain tail
// is the SETTLED (never-rejecting) promise, so a throwing/failing op never
// poisons the next one. NOT re-entrant: an op already running inside the chain
// must call the *Inner form directly, never re-enter through here (it would
// deadlock waiting on its own tail).
function runOnPaneChain<T>(target: TmuxKeysTarget, fn: () => Promise<T>): Promise<T> {
  const key = paneKey(target)
  const prior = paneChains.get(key) ?? Promise.resolve()
  // Chain on the prior tail (which never rejects) so an earlier failure can't
  // skip this call's body.
  const result = prior.then(fn)
  const settled: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  )
  paneChains.set(key, settled)
  // Opportunistic cleanup: drop the entry once WE are the tail and have settled.
  void settled.then(() => {
    if (paneChains.get(key) === settled) paneChains.delete(key)
  })
  return result
}

function paneKey(target: TmuxKeysTarget): string {
  return `${target.socketPath ?? ''} ${target.socketName ?? ''} ${target.paneTarget}`
}

// Pre-Enter settle window: how long we give the TUI to actually PAINT the
// draft we just typed before pressing Enter.
//
// 2026-10-03: the owner's /new came back «не выполнено (not-submitted)» on an
// idle pane whose context then turned out untouched — Enter was never pressed,
// so the poll had given up before the draft appeared. The old window was
// 120ms + 2×250ms ≈ 0.6s, which a pane that repaints late (long transcript, an
// hour of idling) can miss; the command is then wiped and the owner is told it
// failed even though nothing was wrong with the pane. Widened to ~1.5s.
//
// This does NOT weaken the TOCTOU guard: a dialog or busy screen surfacing in
// the window still aborts immediately, and a draft that never paints is still
// refused rather than blind-Entered — a wider window only buys a slow repaint
// more time to prove the draft is really there.
const DRAFT_PAINT_DELAY_MS = 120
const DRAFT_POLL_INTERVAL_MS = 250
const DRAFT_POLL_ATTEMPTS = 6
// How many times the draft may be TYPED before the sender gives up. A pane that
// has been idle for hours swallows the first `send-keys -l` whole (measured
// 2026-10-06 on a live channel pane: first two types painted nothing, a later
// one painted in 234ms), so one shot at typing is not enough.
const DRAFT_TYPE_ATTEMPTS = 3
// Each retype's settle window is this many times the previous one (6 → 12 → 24
// polls ≈ 1.5s → 3s → 6s, ~11s of patience in total on the failure path).
//
// A fixed 6-poll window per attempt once refused /new after eighteen
// identical polls of a plain idle screen. A replica of
// draftPollShape over a fresh capture of that pane's EMPTY composer prints the
// same `d=0 s=1 r=1 n=17`, so all 18 polls saw nothing typed. The pane was
// healthy, mode-less, single-paned, and keys typed by hand landed at once, so
// the draft was late rather than lost. What made 1.5s too short is not proven
// for that one send: the process did hold 187MB of swap against a 181MB RSS
// after 13h of idling (page-in on first touch), but that is a correlation, and
// plain repaint jitter explains it just as well — the SUCCESSES in the same
// journal needed up to 5 of the 6 polls, i.e. the ceiling was already being
// brushed without any swap story. Both readings have the same cure.
//
// Retyping is the right cure for DROPPED keystrokes (2026-10-06) but it cannot
// help a draft that is merely late, so each attempt now buys more time than the
// last: dropped keys still get three shots, a slow pane gets patience, and the
// refusal still happens rather than a blind Enter. Price, paid only when the
// send fails: the caller's Telegram update loop is sequential, so the channel
// now stands still for ~10s instead of ~5s before the owner is told it failed.
// That is the trade — a doubled stall on the rare refusal against a /clear that
// was never actually broken being reported as «не выполнено».
const DRAFT_POLL_WINDOW_GROWTH = 2

// How long a pane must have been silent before its draft budget is widened, and
// by how much.
//
// A long-idle Claude Code process may be paged out. In that case tmux accepts
// the keystrokes, but the TUI cannot paint until the process pages back in.
//
// So `d=0 s=0` has TWO root causes that look identical in the trace: dropped
// keystrokes (cured by retyping, 2026-10-06) and a process paging back in
// (cured only by waiting). The discriminator is the pane's idle time, which
// tmux already knows — `#{window_activity}`, queried in the same display-message
// that asks about the pane mode, so the cold path costs no extra tmux call.
//
// The widening is deliberately one-sided: it lengthens ONLY the failure path
// (a draft that paints exits the loop immediately), so a pane wrongly judged
// cold pays nothing when things work. What it does cost is a 4x longer stall
// before a genuine breakage is reported — ~41.6s instead of ~10.1s — which is
// why the threshold is half an hour rather than a couple of minutes: a pane
// that was alive a minute ago is not paging in, and its refusal is real news.
//
// The stall is not local to this call: the update loop is a straight chain of
// inline awaits (poller -> bot.handleUpdate -> handleInboundText -> oob -> here)
// with no timeout anywhere, so while a cold refusal runs, THIS bot fetches no
// new updates. Worst case grows ~10.1s -> ~41.6s. Accepted deliberately: it is
// paid only on the failure path of a pane that has already been silent for half
// an hour, nothing is lost (Telegram holds the updates), and the alternative is
// the false «не выполнено» this branch exists to stop.
//
// Both numbers are a HEURISTIC, not a measurement: the incident proved 12.7s is
// too short, never that 41.6s is enough. Two known limits worth revisiting once
// more cold cases are journalled (`paneIdleSec` is recorded for exactly that):
// a host whose channel memory caps are oversubscribed can push a pane into swap
// well before half an hour, so the 3-29 minute band still gets the warm budget;
// and when the real cause is cgroup reclaim throttling rather than plain paging
// (see the memory.high wedge), no amount of patience is the right answer — that
// one needs intervention, and a refusal is the correct, honest outcome.
const COLD_PANE_IDLE_SEC = 30 * 60
const COLD_PANE_WINDOW_FACTOR = 4

// Post-Enter confirm window, widened 4→8 attempts (≈1.2s → ≈2.8s) on 2026-10-03.
//
// MARGIN, not the fix for the owner's incident: that one was a REGION bug (see
// firedMarkerCount — the echo rendered outside the searched window) and no width
// would have cured it. Correcting my own first justification for this widening
// (round-3 review caught it): I had timed the frames from the moment TYPING
// began, which inflated every latency by ~2×. Re-measured from the ENTER
// keystroke, frames 145ms apart, 80×24, v2.1.215:
//   capt3, first clear in a session: busy ≤0.18s, `❯ /clear` echo ~0.5-0.6s
//   capt4, second clear in a row:    busy  0.93s, held ≥2.9s, no echo at all
// The slowest confirmable signal measured is therefore 0.93s, and the OLD 1.2s
// window did cover it — by 0.27s. That thin margin, on a polygon that is much
// quicker than a channel pane carrying a multi-day session, is the whole reason
// the window stays widened; the upper bound of repaint lag on a loaded host is
// NOT measured, so 2.8s is a chosen ~3× margin over the 0.93s that is. The cost
// of waiting is bounded (a genuinely failed send is reported ~1.6s later); the
// cost of giving up early is telling the owner his command failed when it did
// not. Widening does not widen the false-success surface: 'busy-flip' can only
// be reached once the caller has seen the draft LEAVE the composer, which a
// dropped Enter never achieves.
const CONFIRM_POLL_INTERVAL_MS = 400
const CONFIRM_POLL_ATTEMPTS = 8

// Interrupt window (2026-10-05). The owner's /new on a rendering agent reported
// «агент занят, не удалось прервать» while that pane in fact showed `Interrupted
// · What should Claude do instead?`: Escape HAD landed, we just looked once,
// 350ms later, and quit. Worst outcome available — his work was killed and the
// session was NOT cleared.
//
// Measured on a live Claude Code pane (v2.1.215, foreground tool burning CPU):
// 9 runs out of 9 left 'busy' 200-300ms after a single Escape — one run took
// 300ms, i.e. the old fixed 350ms wait had ~50ms of margin on an UNLOADED
// polygon. A channel pane under a render has less. So stop timing the pane and
// start waiting on the condition, re-sending Escape while it refuses to yield.
//
// Two costs, both accepted deliberately (round-2 review raised them):
//   * A re-sent Escape can race a dialog that surfaces between the capture that
//     said 'busy' and the keystroke. MEASURED: an Escape into an idle pane left
//     the screen byte-identical, so the common race is inert. The dialog race is
//     NOT measured and stays an open risk — bounded by the fact that Escape can
//     only ever CANCEL a card, never answer one (answering needs Enter or a
//     digit, which this branch never sends), and that the loop stops the instant
//     classifyPane reports 'dialog'. The same race existed before this change
//     with one Escape; the ceiling is now four.
//   * sendControlCommand holds the pane chain for the whole run, so a worst case
//     grows from ~4.5s to ~9s and a second control command for the same pane
//     queues behind it. A queued /new is recoverable; a /new that lies is not.
const INTERRUPT_POLL_INTERVAL_MS = 300
const INTERRUPT_POLL_ATTEMPTS = 16 // ≈4.8s of observation
const INTERRUPT_ESCAPE_EVERY = 4 // re-send Escape every ~1.2s while still busy

// Where a control send ended, i.e. how far into the pane we got:
//   probe     — nothing was ever sent (dialog, busy, unclassifiable pane).
//   interrupt — Escape was sent (or failed to send); the pane WAS touched,
//               but the re-probe refused to go on.
//   send      — the 3-shot keystrokes failed in tmux.
//   draft     — the typed command never painted, so Enter was withheld.
//   confirm   — Enter was pressed (ok, or the fire was never confirmed).
// `reason` is orthogonal: 'tmux' can surface at the interrupt or send stage,
// 'unknown' at probe or interrupt.
export type ControlCommandStage = 'probe' | 'interrupt' | 'send' | 'draft' | 'confirm'

// One journal line per control send. Deliberately flat and primitive-only so a
// sink can `JSON.stringify` it straight into a JSONL file.
export interface ControlCommandLogEntry {
  /** ISO-8601 timestamp of when the send STARTED. */
  ts: string
  /** tmux pane target the command was typed into. */
  pane: string
  /** Slash name without the leading '/'. */
  command: string
  ok: boolean
  /** Present only on failure — same reason the caller is told. */
  reason?: 'dialog' | 'busy' | 'not-submitted' | 'tmux' | 'unknown'
  stage: ControlCommandStage
  /** Pane state at the probe (after an interrupt, if one was performed). */
  paneState: PaneState
  /** Capture-pane polls spent waiting for a busy pane to yield to Escape. */
  interruptPolls?: number
  /** Capture-pane polls spent waiting for the draft to paint. */
  draftPolls?: number
  /** Capture-pane polls spent waiting for the fired signal. */
  confirmPolls?: number
  /**
   * Present only on success: WHICH signal certified the fire. 'busy-flip' is the
   * circumstantial one (no text trace of the command itself), so a line carrying
   * it is the one to audit first if a send is ever disputed.
   */
  confirmedVia?: ConfirmSignal
  /**
   * Present only on a confirm-stage REFUSAL: one compact line per poll saying
   * what that poll actually saw — `<paneState> c=<composerEmptied> q=<queued>
   * p=<choicePrompt> t=<transcript non-empty lines> m=<fired-marker count>`.
   *
   * Added 2026-10-03 because the owner's «не выполнено» was undiagnosable from
   * the journal: the verdict was recorded, the SCREEN SHAPE behind it was not,
   * and which of the four signals had been blind (and why) could only be
   * reconstructed from live panes days later. Shapes, never raw captures — a
   * pane dump would put the agent's conversation into the log file.
   */
  confirmTrace?: readonly string[]
  /**
   * Present only on a draft-stage REFUSAL: one compact line per poll —
   * `<paneState> d=<draft in composer> s=<text anywhere on screen>
   * r=<composer lines> n=<screen non-empty lines>`.
   *
   * Added 2026-10-03 after a SECOND live «не выполнено», this one from the draft
   * stage, which the journal recorded (`draftPolls: 6`, `paneState: idle`) but
   * could not explain: the two candidate causes — keystrokes that never reached
   * the pane, and keystrokes that painted outside the slice we read as the
   * composer — are indistinguishable from the verdict alone, and replaying the
   * same shots on that same live pane succeeded 5/5 minutes later. `s` is the
   * discriminator (`s=1 d=0` = the reader is wrong, not the pane), `n=0` marks a
   * capture that FAILED. Shapes, never raw captures.
   */
  draftTrace?: readonly string[]
  /**
   * Present only when the pane WAS in a tmux mode and we took it out of one:
   * `'left'` (cancelled) or `'failed'` (tmux refused — the send then fails on
   * its own further down). Absent on a mode-less pane, which is the normal case.
   *
   * This is the one side effect of a control send that the OWNER can see
   * directly: cancelling copy-mode drops them back to the live screen and loses
   * their scroll position. It is recorded so «why did my scrollback jump?» has
   * an answer in the journal instead of looking like a tmux glitch.
   */
  leftPaneMode?: 'left' | 'failed'
  /**
   * Seconds since tmux last saw this window produce output, i.e. how long the
   * pane had been asleep when the command arrived. Absent when the stamp was
   * unreadable. A refusal carrying a large value is the paged-out-process case,
   * not a broken pane — see COLD_PANE_IDLE_SEC.
   */
  paneIdleSec?: number
  /** `t=<lines> m=<markers>` of the PRE-SEND baseline the text signals diff against. */
  baselineShape?: string
  durationMs: number
}

export type ControlCommandLogSink = (entry: ControlCommandLogEntry) => void

// Module-level so the three callers (oob, newq-confirm-ui, context-hud) need no
// wiring — boot installs one sink and every send is covered.
let controlCommandLogSink: ControlCommandLogSink | null = null

/** Install (or, with `null`, remove) the control-command journal sink. */
export function setControlCommandLogSink(sink: ControlCommandLogSink | null): void {
  controlCommandLogSink = sink
}

// A journal must never be able to break the thing it journals: a sink that
// throws (full disk, bad path) is swallowed. Losing a log line is acceptable;
// losing the owner's /new is not.
function emitControlCommandLog(entry: ControlCommandLogEntry): void {
  const sink = controlCommandLogSink
  if (!sink) return
  try {
    sink(entry)
  } catch {
    /* journal failures are never fatal */
  }
}

// Internal result of one control send, carrying the diagnostics the journal
// needs on top of what the caller sees.
interface ControlCommandRun {
  result: ControlCommandResult
  stage: ControlCommandStage
  paneState: PaneState
  interruptPolls?: number
  draftPolls?: number
  confirmPolls?: number
  confirmedVia?: ConfirmSignal
  confirmTrace?: readonly string[]
  draftTrace?: readonly string[]
  leftPaneMode?: 'left' | 'failed'
  paneIdleSec?: number
  baselineShape?: string
}

// One poll's view of the pane, as a short SHAPE string for the journal. Never
// the capture itself: a raw dump would copy the agent's conversation into the
// log. `c`/`q`/`p` are the three call-site gates, `t`/`m` the two numbers the
// text signals compare against the baseline. `sv` is how many of the PRE-SEND
// transcript lines are still on screen — the number 'transcript-replaced' decides
// on, so a refusal says whether that signal was one stray survivor short
// (`sv=1`) or looking at an untouched conversation (`sv` = the baseline's `t`).
function pollShape(name: string, snap: string, text: string, baseline: string): string {
  const c = composerRegion(snap).includes(text) ? 0 : 1
  const q = bottomChrome(snap).includes('Press up to edit queued messages') ? 1 : 0
  const p = hasChoicePrompt(snap) ? 1 : 0
  const t = nonEmptyLineCount(transcriptRegion(snap))
  const m = firedMarkerCount(name, snap)
  const sv = survivingBaselineLines(baseline, snap)
  return `${classifyPane(snap)} c=${c} q=${q} p=${p} t=${t} m=${m} sv=${sv}`
}

// One draft poll's view, as a SHAPE string. `d` is the gate itself (draft found
// in the composer), `s` the same text ANYWHERE on the capture: together they say
// whether a refusal means "the keystrokes never landed" (s=0) or "they landed
// and the composer slice is wrong" (s=1, d=0). `r`/`n` size the composer and the
// whole screen. `n=0` means the capture held no text at all, which in practice
// means it FAILED — a live Claude Code pane always paints some chrome — but it
// is a count, not a status flag, so read it as "empty screen" and check the
// pane before concluding tmux broke.
function draftPollShape(snap: string, text: string): string {
  const d = composerRegion(snap).includes(text) ? 1 : 0
  const s = snap.includes(text) ? 1 : 0
  const r = nonEmptyLineCount(composerRegion(snap))
  const n = nonEmptyLineCount(snap)
  return `${classifyPane(snap)} d=${d} s=${s} r=${r} n=${n}`
}

// Reliable control-command injection: probe → (optionally interrupt) → send →
// CONFIRM, serialized per pane. `name` must pass `SLASH_NAME_RE` — the SAME
// closed slash-name whitelist `sendSlashCommand` uses. Control commands here
// take NO args (/clear, /compact, …).
export function sendControlCommand(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts = {},
): Promise<ControlCommandResult> {
  return runOnPaneChain(target, () => sendControlCommandInner(target, name, opts))
}

async function sendControlCommandInner(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts,
): Promise<ControlCommandResult> {
  const startedAt = Date.now()
  // An invalid name is a programming error raised before anything is typed —
  // it throws past the journal rather than being recorded as a pane outcome.
  const run = await runControlCommand(target, name, opts)
  emitControlCommandLog({
    ts: new Date(startedAt).toISOString(),
    pane: target.paneTarget,
    command: name,
    ok: run.result.ok,
    ...(run.result.ok ? {} : { reason: run.result.reason }),
    stage: run.stage,
    paneState: run.paneState,
    ...(run.interruptPolls === undefined ? {} : { interruptPolls: run.interruptPolls }),
    ...(run.draftPolls === undefined ? {} : { draftPolls: run.draftPolls }),
    ...(run.confirmPolls === undefined ? {} : { confirmPolls: run.confirmPolls }),
    ...(run.confirmedVia === undefined ? {} : { confirmedVia: run.confirmedVia }),
    ...(run.confirmTrace === undefined ? {} : { confirmTrace: run.confirmTrace }),
    ...(run.draftTrace === undefined ? {} : { draftTrace: run.draftTrace }),
    ...(run.leftPaneMode === undefined ? {} : { leftPaneMode: run.leftPaneMode }),
    ...(run.paneIdleSec === undefined ? {} : { paneIdleSec: run.paneIdleSec }),
    ...(run.baselineShape === undefined ? {} : { baselineShape: run.baselineShape }),
    durationMs: Date.now() - startedAt,
  })
  return run.result
}

// Step a0 + the body, split so the ONE visible side effect of a0 (a cancelled
// pane mode) reaches the journal from every exit of the body — the body refuses
// in a dozen places and threading the field through each return would mean
// twelve chances to forget it in the one record that had to explain the jump.
async function runControlCommand(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts,
): Promise<ControlCommandRun> {
  // Reuse the frozen slash-name whitelist. A name outside it is a programming
  // error (callers validate via `parseCcCommand` first), so fail loudly rather
  // than smuggle an unvalidated token toward the pane. Checked BEFORE a0 so an
  // invalid name never so much as queries the pane.
  if (!SLASH_NAME_RE.test(name)) {
    throw new RangeError(`sendControlCommand: invalid command name «${name}»`)
  }
  const { leftPaneMode, paneIdleSec } = await leaveAnyPaneMode(target, opts)
  // Same reason as leftPaneMode above (round-2 review caught the first version
  // doing exactly what the comment warns against): the interrupt poll count was
  // threaded through ONE return — the refusal — so the case the counter exists
  // for, an interrupt that WORKED, journalled nothing. Collected by reference
  // and merged here instead, once, for every exit.
  const diag: InterruptDiag = { polls: 0 }
  const body = await runControlCommandBody(target, name, opts, diag, paneIdleSec)
  const run = diag.polls === 0 ? body : { ...body, interruptPolls: diag.polls }
  return {
    ...run,
    ...(leftPaneMode === undefined ? {} : { leftPaneMode }),
    ...(paneIdleSec === undefined ? {} : { paneIdleSec }),
  }
}

/** Interrupt-phase counters, filled in by the body for the journal. */
interface InterruptDiag {
  polls: number
}

// a0. Leave a tmux pane MODE before anything is typed (2026-10-03 root cause).
// A pane sitting in copy-mode swallows every `send-keys`: tmux still exits 0,
// `capture-pane` still returns a healthy-looking screen, and classifyPane still
// says 'idle' — so the draft never paints and the send is refused with the
// opaque `not-submitted`. Reproduced on a probe pane: in copy-mode the run is
// byte-for-byte the owner's live journal line (stage draft, idle, 6/6 polls);
// leave the mode and the same keys land. Runs BEFORE the probe so the baseline
// is the LIVE screen rather than a scrolled-back view of history.
//
// Cancelling is NOT free, which the first version of this fix got wrong:
// `copy-mode -q` cancels copy mode *and any other mode* (man tmux) and the
// pane's scroll position goes with it — measured on a probe pane,
// `scroll_position` 71 → empty. The owner reads these panes BY HAND, so an
// unconditional cancel would yank them out of their own scrollback on every
// single /new. Hence query first: `display-message '#{pane_in_mode}'` disturbs
// neither mode nor scroll (measured — 1/71 before and after) and the cancel
// fires only when there is a mode to leave.
//
// When a mode IS found we cancel rather than refuse: the command exists because
// the owner pressed /new and is waiting for it, and refusing is the exact «не
// выполнено» this branch is paid to eliminate. The visible side effect is
// journalled (`leftPaneMode`) so a jumped scrollback has an explanation.
// Returns undefined when there was no mode — an unreadable query counts as
// UNKNOWN, never as "in a mode": a dead pane must not be chased with a doomed
// cancel, and the capture right after refuses on its own anyway.
//
// The same query also reads `#{window_activity}` — the last time tmux saw this
// window produce output — which the draft loop turns into "how long has this
// pane been asleep" (see COLD_PANE_IDLE_SEC). Two questions, one round trip:
// asking separately would double the probe cost for every control send.
// An unreadable or missing stamp yields `paneIdleSec: undefined`, which the
// caller MUST read as "unknown", never as "asleep forever" — granting the cold
// budget on no evidence would quadruple every refusal stall.
//
// `#{window_activity}` is WINDOW-scoped and tmux 3.4 offers no per-pane
// equivalent (`#{pane_activity}` does not exist), so the stamp describes the
// target pane only while the window holds exactly ONE pane — true of every
// channel today, and of multichat children too, which get their own tmux
// SESSION rather than a split. `#{window_panes}` is read in the same breath to
// make that an enforced precondition instead of a silent assumption: split the
// window and a chatty neighbour keeps the stamp fresh while the target sleeps,
// turning the cold branch into a no-op nobody would notice.
async function leaveAnyPaneMode(
  target: TmuxKeysTarget,
  opts: ControlCommandOpts,
): Promise<{ leftPaneMode?: 'left' | 'failed'; paneIdleSec?: number }> {
  const exec = opts.exec ?? defaultKeysExec
  const captureExec = opts.captureExec ?? defaultKeysCaptureExec
  const now = opts.now ?? Date.now
  const socketArgs = socketArgsFor(target)
  const modeProbe = await captureExec([
    ...socketArgs,
    'display-message',
    '-p',
    '-t',
    target.paneTarget,
    '#{pane_in_mode} #{window_activity} #{window_panes}',
  ])
  if (modeProbe.exitCode !== 0) return {}
  const [mode, activity, panes] = modeProbe.stdout.trim().split(/\s+/)
  const paneIdleSec = panes === '1' ? paneIdleSecondsFrom(activity, now()) : undefined
  const idle = paneIdleSec === undefined ? {} : { paneIdleSec }
  if (mode !== '1') return idle
  const cancel = await exec([...socketArgs, 'copy-mode', '-q', '-t', target.paneTarget])
  return { ...idle, leftPaneMode: cancel.exitCode === 0 ? 'left' : 'failed' }
}

// tmux prints `#{window_activity}` as whole seconds since the epoch, and an
// unsupported format prints nothing at all. Two separate rejections live here:
// a stamp that is not a positive integer is UNKNOWN (absent field, or tmux
// saying `0` — "no activity recorded", which must not read as "idle since
// 1970"), while a stamp in the FUTURE is real but skewed, and clamps to 0 so a
// clock jump cannot masquerade as hours of sleep.
function paneIdleSecondsFrom(activity: string | undefined, nowMs: number): number | undefined {
  if (activity === undefined || !/^\d+$/.test(activity)) return undefined
  const stamp = Number(activity)
  if (stamp <= 0) return undefined
  return Math.max(0, Math.floor(nowMs / 1000) - stamp)
}

function socketArgsFor(target: TmuxKeysTarget): string[] {
  return target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
}

async function runControlCommandBody(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts,
  diag: InterruptDiag,
  paneIdleSec?: number,
): Promise<ControlCommandRun> {
  const exec = opts.exec ?? defaultKeysExec
  const captureExec = opts.captureExec ?? defaultKeysCaptureExec
  const sleep = opts.sleep ?? realSleep
  const interruptIfBusy = opts.interruptIfBusy ?? false

  const socketArgs = socketArgsFor(target)


  // a. Probe pane state. This snapshot is ALSO the PRE-SEND baseline (FIX-2) —
  //    the fired-marker check below requires a FRESH transition against it.
  let baseline = await capturePane(target, captureExec)
  let state = classifyPane(baseline)

  // b. Dialog open → send NOTHING (the trailing Enter would approve it).
  if (state === 'dialog') {
    return { result: { ok: false, reason: 'dialog' }, stage: 'probe', paneState: state }
  }

  // c. Busy → either interrupt (Escape, wait, re-probe) or refuse.
  //    `interrupted` records that Escape REALLY went into the pane, so a later
  //    refusal is journalled as 'interrupt' and never as 'probe' (which claims
  //    we never touched the pane — misleading when a tool was just aborted).
  let interrupted = false
  if (state === 'busy') {
    if (!interruptIfBusy) {
      return { result: { ok: false, reason: 'busy' }, stage: 'probe', paneState: state }
    }
    // IT2-7: call the INNER (unchained) form — we already hold the pane chain,
    // so re-entering runOnPaneChain here would deadlock on our own tail.
    const esc = await sendNamedKeyInner(target, 'Escape', exec)
    if (!esc.ok) {
      return { result: { ok: false, reason: 'tmux' }, stage: 'interrupt', paneState: state }
    }
    interrupted = true
    for (let attempt = 0; attempt < INTERRUPT_POLL_ATTEMPTS; attempt++) {
      await sleep(INTERRUPT_POLL_INTERVAL_MS)
      baseline = await capturePane(target, captureExec)
      state = classifyPane(baseline)
      diag.polls++
      if (state !== 'busy') break
      // Not on the final attempt: after it we never look at the pane again, so
      // that Escape could only land unobserved.
      const isLastAttempt = attempt === INTERRUPT_POLL_ATTEMPTS - 1
      if (!isLastAttempt && (attempt + 1) % INTERRUPT_ESCAPE_EVERY === 0) {
        const again = await sendNamedKeyInner(target, 'Escape', exec)
        if (!again.ok) {
          return { result: { ok: false, reason: 'tmux' }, stage: 'interrupt', paneState: state }
        }
      }
    }
    if (state === 'busy') {
      return { result: { ok: false, reason: 'busy' }, stage: 'interrupt', paneState: state }
    }
    if (state === 'dialog') {
      // Interrupting surfaced a confirm dialog — never type a command into it.
      return { result: { ok: false, reason: 'dialog' }, stage: 'interrupt', paneState: state }
    }
  }

  // FIX-1 (both reviews): require a POSITIVE idle before sending. A failed
  // capture ('' → unknown) or any unrecognised screen must NEVER fall through
  // to the 3-shot — a blind Enter could approve a dialog we failed to classify.
  if (state !== 'idle') {
    return {
      result: { ok: false, reason: 'unknown' },
      stage: interrupted ? 'interrupt' : 'probe',
      paneState: state,
    }
  }

  // d. 3-shot: clear the line, type '/'+name, (settle) then submit with Enter.
  const text = `/${name}`
  // `text` always starts with '/', so it can never be parsed as a tmux flag.
  const typeDraft = async (): Promise<boolean> => {
    const preEnter: Array<readonly string[]> = [
      [...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'],
      [...socketArgs, 'send-keys', '-t', target.paneTarget, '-l', text],
    ]
    for (const args of preEnter) {
      const res = await exec(args)
      if (res.exitCode !== 0) return false
    }
    await sleep(DRAFT_PAINT_DELAY_MS) // let the TUI render the typed text before Enter
    return true
  }
  if (!(await typeDraft())) {
    return { result: { ok: false, reason: 'tmux' }, stage: 'send', paneState: state }
  }

  // FIX-3 + IT2-3 (both reviews): TOCTOU guard, refined. Between typing the draft
  // and pressing Enter a native dialog / busy state can surface — those are the
  // DANGEROUS states (a trailing Enter would approve a dialog or queue behind a
  // running tool), so we ABORT on them (wipe the draft, refuse). But typing a
  // slash command ALSO opens Claude Code's autocomplete popup, which can REPLACE
  // the idle footer hints → classifyPane === 'unknown'; a slow paint can also
  // hide the draft transiently. Refusing on unknown/absent here would kill every
  // control send. So we poll a short window (~600ms) for the composer to actually
  // show our '/name' draft, and as long as the pane is NOT busy/dialog we press
  // Enter once the draft is visible. Only if the draft never appears do we refuse
  // (not-submitted).
  //
  // 2026-10-06: a pane idle for hours can DROP the first typed draft outright —
  // every poll then shows the typed text nowhere on screen (`d=0 s=0`), and no
  // amount of extra waiting helps because nothing is in flight. So the window is
  // a RETYPE loop: poll for the draft, and if it never painted, type it again
  // (up to DRAFT_TYPE_ATTEMPTS). C-u leads every retype, so a late paint of the
  // first draft can never leave a doubled command behind.
  //
  // The retype is NOT blind, and the shape of this loop is what makes it so: the
  // LAST poll of a window classifies the pane and is not followed by a sleep, so
  // a pane that turned busy/dialog while we waited is refused right there —
  // before another draft is typed into it. Keep the danger check INSIDE the poll
  // loop; hoisting it out (or typing first and classifying after) would open a
  // blind window three keystrokes wide. Pinned by the 'turns busy on the last
  // poll' test. Cost of the loop, paid only on the failure path: a draft refusal
  // now takes ~3x as long (≈4.1s vs 1.4s), which is the price of not reporting a
  // false 'not-submitted' to the owner.
  let draftReady = false
  let draftPolls = 0
  const draftTrace: string[] = []
  // A pane that has been silent for half an hour may be paging back in rather
  // than dropping keys — same `d=0 s=0` trace, different cure (COLD_PANE_IDLE_SEC).
  const coldPaneFactor =
    paneIdleSec !== undefined && paneIdleSec >= COLD_PANE_IDLE_SEC ? COLD_PANE_WINDOW_FACTOR : 1
  for (let typeAttempt = 0; typeAttempt < DRAFT_TYPE_ATTEMPTS && !draftReady; typeAttempt++) {
    if (typeAttempt > 0 && !(await typeDraft())) {
      return { result: { ok: false, reason: 'tmux' }, stage: 'send', paneState: state }
    }
    const pollWindow =
      DRAFT_POLL_ATTEMPTS * DRAFT_POLL_WINDOW_GROWTH ** typeAttempt * coldPaneFactor
    for (let attempt = 0; attempt < pollWindow; attempt++) {
      const snap = await capturePane(target, captureExec)
      draftPolls++
      const st = classifyPane(snap)
      draftTrace.push(draftPollShape(snap, text))
      if (st === 'dialog' || st === 'busy') {
        // A dangerous state surfaced in the settle window — never Enter. Wipe the
        // draft so it can't be submitted by a later keystroke.
        await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'])
        return {
          result: { ok: false, reason: st },
          stage: 'draft',
          paneState: state,
          draftPolls,
          draftTrace,
        }
      }
      if (composerRegion(snap).includes(text)) {
        draftReady = true
        break
      }
      if (attempt < pollWindow - 1) await sleep(DRAFT_POLL_INTERVAL_MS)
    }
  }
  if (!draftReady) {
    await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'])
    return {
      result: { ok: false, reason: 'not-submitted' },
      stage: 'draft',
      paneState: state,
      draftPolls,
      draftTrace,
    }
  }

  const enter = await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'Enter'])
  if (enter.exitCode !== 0) {
    return { result: { ok: false, reason: 'tmux' }, stage: 'send', paneState: state, draftPolls }
  }

  // e. Confirm-fire: poll for the fired signal. IT2-2: capture IMMEDIATELY after
  //    Enter (a fresh marker often lands right away), then a few short intervals
  //    to cover a slow render — waiting a full 500ms first needlessly delayed the
  //    ok. Success requires ALL of: composer emptied (the region above the last
  //    rule no longer holds '/'+name) AND not queued ('Press up to edit queued
  //    messages' absent WITHIN the bottom chrome, so a stale/scrolled quote of it
  //    can't false-fail) AND a FRESH command-specific fired OCCURRENCE vs the
  //    pre-send baseline (a stale marker never certifies success).
  let confirmPolls = 0
  // Shape of every poll, kept for the journal so a refusal says WHAT was on
  // screen, not just that we gave up. Only emitted on failure.
  const confirmTrace: string[] = []
  // The cold budget spans BOTH halves of the send. 2026-10-20, this pane: the
  // draft got the widened window and landed, the confirm kept the warm 2.8s,
  // expired, and reported «не выполнено» — the clear had in fact run 2.8s later.
  // Every confirm poll in that journal reads `c=0`, the composer still holding
  // the draft, so no signal was even consulted: the pane was simply still
  // repainting. A pane slow enough to need 4× to echo a draft needs 4× to show
  // what the draft did; granting one without the other just moves the false
  // refusal from the first stage to the second. Cost is bounded and paid only
  // on the failure path of a pane asleep for half an hour: ≈2.8s → ≈12.4s,
  // which puts the WHOLE cold worst case (draft ≈41.6s + confirm ≈12.4s) at
  // ≈54s of a bot that fetches no updates while a control send is in flight,
  // up from ≈44.4s. Both halves must fail on the same already-rare cold pane
  // to reach it, and Telegram holds the updates — but that 54s is the number
  // to weigh before widening either window again.
  const confirmWindow = CONFIRM_POLL_ATTEMPTS * coldPaneFactor
  for (let attempt = 0; attempt < confirmWindow; attempt++) {
    if (attempt > 0) await sleep(CONFIRM_POLL_INTERVAL_MS)
    const snap = await capturePane(target, captureExec)
    confirmPolls++
    confirmTrace.push(pollShape(name, snap, text, baseline))
    const composerEmptied = !composerRegion(snap).includes(text)
    const queued = bottomChrome(snap).includes('Press up to edit queued messages')
    const confirmedVia = composerEmptied && !queued ? confirmedFired(name, snap, baseline) : null
    if (confirmedVia) {
      return {
        result: { ok: true },
        stage: 'confirm',
        paneState: state,
        draftPolls,
        confirmPolls,
        confirmedVia,
      }
    }
  }
  return {
    result: { ok: false, reason: 'not-submitted' },
    stage: 'confirm',
    paneState: state,
    draftPolls,
    confirmPolls,
    confirmTrace,
    baselineShape: `t=${nonEmptyLineCount(transcriptRegion(baseline))} m=${firedMarkerCount(name, baseline)}`,
  }
}
