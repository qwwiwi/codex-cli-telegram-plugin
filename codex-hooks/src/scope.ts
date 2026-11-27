// Who a managed hook run is for. The managed pack in /etc/codex is host-wide: every Codex user on
// the host runs it. Only the bridge user gets the full pack.
//
// The bridge user is the uid the installer recorded in <managedDir>/bridge-uid, installed by root
// with the rest of the pack. The launcher names the managed dir in MANAGED_DIR_ENV (its clean
// environment cannot carry a caller's value). bridge-uid is trusted only when it is a small regular
// file (opened without following a symlink and without blocking, checked on the open descriptor),
// owned by root and not writable by group or others, in a root-owned directory (and parent) that
// is no symlink and not writable by group or others, holding one uid in 1..4294967294 (never
// root) as 1-10 digits and at most one trailing newline; the launcher's shell test is the same.
// - full: the real uid of the hook process equals the trusted uid;
// - other: a trusted bridge-uid proves this user is not the bridge: a pure no-op for every event;
// - safety: bridge-uid is missing or untrusted, so who the bridge is cannot be told: the
//   fail-closed PreToolUse safety guard alone.
// The installer, doctor and the full-access gate share readBridgeUid.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MANAGED_DIR_ENV = 'CODEX_HOOKS_MANAGED_DIR'
export const BRIDGE_UID_FILE = 'bridge-uid'

// The contract between the bundle and the managed launcher for a PreToolUse run. The launcher
// starts the bundle with VERDICT_ARG after the event; the bundle then answers
// - a deny: exit DENY_EXIT (a code nothing else in the run uses), the bare reason on stdout;
// - an allow: exit 0 and the line ALLOW_TOKEN first, always (a no-op for another user too): an
//   exit 0 without it is no verdict and the launcher blocks. After it comes nothing, or one more
//   line: exactly `{}`, or the context line CONTEXT_PREFIX + text + CONTEXT_SUFFIX, where the text
//   holds no `"`, no line break and no backslash except as `\uXXXX`, so a shell can see that the
//   line has no other key. Every line ends with one line break.
// The launcher never forwards a deny as JSON: it answers exit 2 with its own stderr line.
export const VERDICT_ARG = 'launcher-verdict'
export const DENY_EXIT = 3
export const ALLOW_TOKEN = 'ALLOW'
export const CONTEXT_PREFIX = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"'
export const CONTEXT_SUFFIX = '"}}'

export type Scope = 'full' | 'safety' | 'other'
// Whether a file owner counts as trusted; production trusts root only (tests inject their own uid).
export type OwnerTrust = (ownerUid: number) => boolean
export const rootOnly: OwnerTrust = uid => uid === 0

// The longest bridge-uid read: a uid line is far shorter.
const MAX_UID_BYTES = 32
const GROUP_OTHER_WRITE = 0o022

export function rootOwned(path: string): boolean {
  try { const stat = statSync(path); return stat.uid === 0 && (stat.mode & GROUP_OTHER_WRITE) === 0 } catch { return false }
}

// A recorded bridge uid: 1..4294967294 (uid_t without the -1 "no uid"); root is never the bridge user.
const MAX_UID = 4_294_967_294
const validUid = (uid: number) => Number.isSafeInteger(uid) && uid > 0 && uid <= MAX_UID
// bridge-uid's exact content: 1-10 digits and at most one trailing newline, nothing else (no
// whitespace, no NUL). The launcher's shell test (install.ts otherScript) applies the same rule.
const UID_CONTENT = /^[0-9]{1,10}\n?$/

// The content of bridge-uid for the installing process.
export function bridgeUidContent(uid: number | undefined = process.getuid?.()): string {
  if (uid === undefined) throw new Error('cannot record the bridge user: this platform has no uid')
  if (uid === 0) throw new Error('refusing to record root as the bridge user: run ./install.sh --hooks as the bridge user')
  if (!validUid(uid)) throw new Error(`cannot record the bridge user: invalid uid ${uid}`)
  return `${uid}\n`
}

export type BridgeUid = { ok: true; uid: number } | { ok: false; why: string }

function untrustedDir(path: string, trust: OwnerTrust): string | undefined {
  let stat
  try { stat = lstatSync(path) } catch { return `нет каталога ${path}` }
  if (!stat.isDirectory()) return `${path} не каталог (или символьная ссылка)`
  if (!trust(stat.uid)) return `${path} принадлежит не root`
  if (stat.mode & GROUP_OTHER_WRITE) return `${path} доступен на запись не только владельцу`
  return undefined
}

// Reads and validates <managedDir>/bridge-uid. Never throws, never blocks on a FIFO or a device.
export function readBridgeUid(managedDir: string, trust: OwnerTrust = rootOnly): BridgeUid {
  const file = join(managedDir, BRIDGE_UID_FILE)
  for (const dir of [dirname(managedDir), managedDir]) {
    const why = untrustedDir(dir, trust)
    if (why) return { ok: false, why }
  }
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return { ok: false, why: `${file} нет, он не читается или это символьная ссылка` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, why: `${file} не обычный файл` }
    if (!trust(stat.uid)) return { ok: false, why: `${file} принадлежит не root` }
    if (stat.mode & GROUP_OTHER_WRITE) return { ok: false, why: `${file} доступен на запись не только владельцу` }
    if (stat.size > MAX_UID_BYTES) return { ok: false, why: `${file} слишком большой` }
    const buffer = Buffer.alloc(MAX_UID_BYTES + 1)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    if (read > MAX_UID_BYTES) return { ok: false, why: `${file} слишком большой` }
    const text = buffer.subarray(0, read).toString('latin1')
    const uid = Number(text.replace(/\n$/, ''))
    if (!UID_CONTENT.test(text) || !validUid(uid)) return { ok: false, why: `${file} не содержит uid пользователя (root не может быть пользователем моста)` }
    return { ok: true, uid }
  } catch {
    return { ok: false, why: `${file} не читается` }
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
  }
}

export function hookScope(env: Record<string, string | undefined>, uid: number | undefined = process.getuid?.(),
  trust: OwnerTrust = rootOnly): Scope {
  const managedDir = env[MANAGED_DIR_ENV]
  // No managed dir: a user-level install in the installing user's own hooks.json.
  if (!managedDir) return 'full'
  if (uid === undefined) return 'safety'
  const recorded = readBridgeUid(managedDir, trust)
  if (!recorded.ok) return 'safety'
  return recorded.uid === uid ? 'full' : 'other'
}
