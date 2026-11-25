// Workspace-relative outbound file safety.
//
// Mirrors gateway.py:2987-3007: any file we send out via reply.files must
// resolve to a real path inside TELEGRAM_WORKSPACE_ROOT. This blocks
// `../` traversal, absolute-path escapes, and symlinks that point outside
// the workspace — agents can only ship files from their own sandbox.
//
// The official server.ts uses a 50MB cap (assertSendable, server.ts:128-145)
// — we keep parity with that limit.
//
// Throws clear, user-facing errors that the reply tool surfaces verbatim
// (no stack traces leak through).

import { existsSync, realpathSync, statSync } from 'fs'
import { resolve, sep, extname } from 'path'

import type { AppConfig } from '../config.js'

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Extensions that send as photos (inline preview in Telegram) instead of
// documents. Kept here so tools.ts and any future caller share one truth.
export const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function isPhotoExtension(filePath: string): boolean {
  return PHOTO_EXTENSIONS.has(extname(filePath).toLowerCase())
}

// resolveInsideWorkspace
//
// Canonicalises both `filePath` (resolved against `workspaceRoot` if
// relative) and `workspaceRoot` via realpathSync. Throws if:
//   - workspaceRoot itself does not exist on disk
//   - the file does not exist on disk
//   - the canonical file path is not contained in the canonical workspace
//
// Containment uses `canonicalWorkspace + path.sep` as a prefix so that
// `/ws-evil/foo` cannot masquerade as inside `/ws`.
export function resolveInsideWorkspace(filePath: string, workspaceRoot: string): string {
  let canonicalWorkspace: string
  try {
    canonicalWorkspace = realpathSync(workspaceRoot)
  } catch (err) {
    throw new Error(
      `refusing to send file outside workspace: workspace root unreadable (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  // Resolve relative paths against the canonical workspace, not process CWD.
  // Mirror gateway.py: `(workspace / raw).resolve() if not raw.is_absolute() else raw.resolve()`.
  const joined = resolve(canonicalWorkspace, filePath)

  let canonicalFile: string
  try {
    canonicalFile = realpathSync(joined)
  } catch {
    throw new Error(`refusing to send file outside workspace: ${filePath} (file does not exist)`)
  }

  const prefix = canonicalWorkspace.endsWith(sep) ? canonicalWorkspace : canonicalWorkspace + sep
  if (canonicalFile !== canonicalWorkspace && !canonicalFile.startsWith(prefix)) {
    throw new Error(`refusing to send file outside workspace: ${filePath}`)
  }

  if (!existsSync(canonicalFile)) {
    // Belt-and-braces: realpathSync succeeded but the file was deleted
    // between resolution and the existsSync check.
    throw new Error(`refusing to send file outside workspace: ${filePath} (file does not exist)`)
  }

  return canonicalFile
}

// Directory names that exist to hold credentials. Anything under them is
// secret material regardless of file name. `.claude` is deliberately ABSENT —
// it holds skills, prompts and reports we legitimately send; only the
// `.claude.json` credential file itself is denied, by basename.
const SECRET_DIR_SEGMENTS = new Set([
  'secrets',
  '.secrets',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.codex',
  '.cargo',
])

// Credential stores that live under `.config/<vendor>/` rather than a
// dedicated dotdir — matched as a pair so a plain `gh/` or `gcloud/` folder
// elsewhere stays sendable.
const SECRET_CONFIG_VENDORS = new Set(['gcloud', 'gh'])

// Extensions that are key/cert material by definition.
const SECRET_EXTENSIONS = new Set([
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kdbx',
  '.gpg',
  '.asc',
  '.secret',
])

const SECRET_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.claude.json',
  'auth.json',
  'auth.yaml',
  'auth.yml',
  'secret.json',
  'secrets.json',
  'secret.yaml',
  'secret.yml',
  'service-account.json',
  'serviceaccount.json',
  'secring.gpg',
  'pubring.gpg',
])

// Private-key file names, matched as prefixes so `id_rsa.pub` / `id_rsa.bak`
// are covered too.
const SECRET_BASENAME_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']

// Suffixes a human adds when stashing a copy. Stripped before matching so
// `private.key.bak` is still recognised as key material.
const BACKUP_SUFFIXES = ['.bak', '.old', '.orig', '.save', '.copy']

function stripBackupSuffixes(name: string): string {
  let out = name
  for (let i = 0; i < 4; i += 1) {
    const before = out
    while (out.endsWith('~')) out = out.slice(0, -1)
    for (const suffix of BACKUP_SUFFIXES) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length)
        break
      }
    }
    if (out === before) break
  }
  return out
}

// isSecretAttachmentPath
//
// Second layer of the outbound-file gate (the first is root containment).
// Root containment cannot help once a secret has been COPIED INTO an allowed
// root — an `.env` a session wrote next to its report, a `credentials.json`
// staged in the shared workspace. This answers "is this path secret material"
// from the path alone (no disk read), so both send paths can refuse it.
//
// Deliberately conservative about false positives: a denylist that eats the
// files this channel actually ships (`mama-key.txt`, `report.pdf`) would just
// get switched off. Matching is on the file NAME and on credential-holding
// DIRECTORY names — never on a substring like "key" or "token" anywhere in
// the path.
export function isSecretAttachmentPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]+/).filter((s) => s.length > 0)
  if (segments.length === 0) return false

  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase())
  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i] as string
    if (SECRET_DIR_SEGMENTS.has(dir)) return true
    if (dir === '.config') {
      const vendor = dirs[i + 1]
      if (vendor !== undefined && SECRET_CONFIG_VENDORS.has(vendor)) return true
    }
  }

  const raw = (segments[segments.length - 1] as string).toLowerCase()
  const name = stripBackupSuffixes(raw)

  if (SECRET_BASENAMES.has(name)) return true
  if (SECRET_BASENAME_PREFIXES.some((p) => name.startsWith(p))) return true
  // Any credential store, whatever the vendor calls it:
  // `credentials`, `credentials.json`, `application_default_credentials.json`,
  // `.credentials.json`, `credentials.toml`.
  if (name.includes('credential')) return true
  // Service-account keys ship as `sa-<name>.json` / `firebase-adminsdk-*.json`.
  if (name.startsWith('firebase-adminsdk')) return true
  if (name.startsWith('sa-') && name.endsWith('.json')) return true
  // dotenv in all its spellings: `.env`, `.env.production`, `prod.env`.
  if (name.startsWith('.env.') || name.endsWith('.env')) return true
  if (SECRET_EXTENSIONS.has(extname(name).toLowerCase())) return true

  return false
}

// Shared stat/size/directory gate applied AFTER a path has resolved inside
// an allowed root. Extracted so the single-root (assertSendableFile) and
// multi-root (assertSendableFileInRoots) paths share one truth for "is this
// a regular file we are willing to ship" — including the secret-material
// denylist, so neither send path can be fixed in isolation and miss the other.
function assertRegularFileWithinLimit(canonical: string, filePath: string): string {
  // Check both spellings: the caller-supplied path names what they MEANT to
  // send, the canonical path names what they would ACTUALLY send (a harmless
  // -looking symlink can point at an `.env` inside the same root).
  if (isSecretAttachmentPath(filePath) || isSecretAttachmentPath(canonical)) {
    throw new Error(`files attachment rejected: ${filePath} looks like secret material`)
  }

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(canonical)
  } catch (err) {
    throw new Error(
      `files attachment rejected: ${filePath} not readable (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  if (st.isDirectory()) {
    throw new Error(`files attachment rejected: ${filePath} is a directory`)
  }

  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `files attachment rejected: ${filePath} is ${(st.size / 1024 / 1024).toFixed(1)}MB (max ${
        MAX_ATTACHMENT_BYTES / 1024 / 1024
      }MB)`,
    )
  }

  return canonical
}

// resolveInsideWorkspaces
//
// Multi-root variant of resolveInsideWorkspace: returns the canonical path
// if `filePath` resolves inside ANY of `roots` (each checked with the same
// realpath containment logic), else throws. Empty/blank roots are skipped.
// Used by the multichat router send-path, where a child session may write a
// file under its per-chat state dir OR the shared workspace root.
export function resolveInsideWorkspaces(filePath: string, roots: string[]): string {
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue
    try {
      return resolveInsideWorkspace(filePath, root)
    } catch {
      // Not inside this root — try the next one.
    }
  }
  throw new Error(`refusing to send file outside workspace: ${filePath}`)
}

export interface SendableFileMultiRootChecks {
  filePath: string
  roots: string[]
}

// assertSendableFileInRoots
//
// Full outbound-file gate for the multichat router: the path must resolve
// inside one of `roots` (no `../` / symlink escape), be a regular file, and
// be within the size cap. Returns the canonical resolved path. Throws a
// clear, user-facing error otherwise. The router NEVER ships the raw
// child-supplied path — always this canonical result.
export function assertSendableFileInRoots({
  filePath,
  roots,
}: SendableFileMultiRootChecks): string {
  const usable = roots.filter((r) => typeof r === 'string' && r.length > 0)
  if (usable.length === 0) {
    throw new Error('files attachment rejected: no workspace root configured')
  }
  const canonical = resolveInsideWorkspaces(filePath, usable)
  return assertRegularFileWithinLimit(canonical, filePath)
}

export interface SendableFileChecks {
  filePath: string
  config: AppConfig
}

// assertSendableFile
//
// Full gate for reply.files entries:
//   1. workspace_root configured (else clear error)
//   2. path resolves inside workspace (no escapes)
//   3. target is a regular file (not a directory)
//   4. size <= MAX_ATTACHMENT_BYTES
// Returns the canonical resolved path; callers should use this when
// invoking Telegram sendDocument/sendPhoto so we ship the canonical file,
// not the user-supplied path.
export function assertSendableFile({ filePath, config }: SendableFileChecks): string {
  if (config.workspace_root === undefined) {
    throw new Error('files attachment rejected: TELEGRAM_WORKSPACE_ROOT not configured')
  }

  const canonical = resolveInsideWorkspace(filePath, config.workspace_root)
  return assertRegularFileWithinLimit(canonical, filePath)
}
