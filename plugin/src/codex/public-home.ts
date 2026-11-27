// The public (member and guest) Codex homes for KROT_MULTIUSER=1.
//
// Every public role runs on its own `codex app-server` with its own CODEX_HOME,
// a bridge-owned folder under the state directory (mode 700). Its config.toml
// is written from scratch at every start from an explicit allowlist: the
// skills listed for the role (copied read-only from the owner-chosen
// public-skills folder), the MCP servers listed for the role (defined in the
// public allowlist itself under [mcp_servers.<name>], never read from the
// owner's Codex config; URL servers only, a local stdio process would run as
// the bridge user) and one PreToolUse entry the bridge writes itself for the
// permission hook (--thread-role, the second layer; only the validated command
// is taken from the owner's config, with features.hooks forced on). Nothing else
// of the owner's Codex config reaches it, no owner MCP server and no other owner
// hook either; only auth.json (the ChatGPT login) is copied. A listed public
// server that carries credentials (in keys, args or the url) needs
// `public_safe = true`, and the environment variables it reads must be named
// KROT_PUBLIC_MCP_*, so an owner credential (GBRAIN_BEARER and the like) is
// never passed to a public app-server. A rebuild clears the home but for the
// thread history.
//
// Allowlist file: KROT_PUBLIC_CONFIG or <state>/public-access.toml
//   skills_dir = "public-skills"           # default; relative to the state directory
//   [member]
//   skills = "all"                          # or ["faq", "pricing"]
//   mcp = ["docs", { name = "search", public_safe = true }]
//   web_search = false                      # members only
//   [guest]
//   skills = "all"
//   mcp = []
//   [mcp_servers.docs]                      # the public servers, defined here only
//   url = "https://docs.example/mcp"
//   [mcp_servers.search]
//   url = "https://search.example/mcp"
//   bearer_token_env_var = "KROT_PUBLIC_MCP_SEARCH_TOKEN"

import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

import { PUBLIC_FEATURES_OFF } from './public-profile.js'
import { object } from './rpc.js'

/**
 * A public home could not be built or checked. Its message names files, roles, servers and
 * skills only, never a value, so startup prints it as is (server.ts) instead of a generic line.
 */
export class PublicHomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicHomeError'
  }
}

export type PublicRole = 'member' | 'guest'
export const PUBLIC_ROLES: readonly PublicRole[] = ['member', 'guest']

export interface McpAllow { name: string; publicSafe: boolean }
export interface RolePolicy { skills: 'all' | string[]; mcp: McpAllow[]; webSearch: boolean }
export interface PublicPolicy {
  skillsDir: string
  roles: Record<PublicRole, RolePolicy>
  /** The public MCP server definitions ([mcp_servers.<name>] of the allowlist), independent of the owner config. */
  servers: Record<string, Record<string, unknown>>
}

/** What one public home was built with; /doctor and the startup probe compare against it. */
export interface PreparedHome {
  role: PublicRole
  home: string
  skills: string[]
  mcp: string[]
  webSearch: boolean
  /** Environment variable names the copied public_safe MCP servers read. */
  envVars?: string[]
  /** sha256 of the written config.toml and the hook script it runs; the cached hook proof is valid for this hash only. */
  configHash: string
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/u
const name = z.string().regex(NAME, 'names are 1-64 letters, digits, _ or -')
const mcpEntry = z.union([name, z.object({ name, public_safe: z.boolean().default(false) }).strict()])
const roleSchema = z.object({
  skills: z.union([z.literal('all'), z.array(name)]).default('all'),
  mcp: z.array(mcpEntry).default([]),
  web_search: z.boolean().default(false),
}).strict()
const fileSchema = z.object({
  skills_dir: z.string().min(1).optional(),
  member: roleSchema.default({}),
  guest: roleSchema.default({}),
  mcp_servers: z.record(name, z.record(z.string(), z.unknown())).default({}),
}).strict()

// Keys of an MCP entry that carry or point at a credential.
const CREDENTIAL_KEYS = new Set(['env', 'env_vars', 'http_headers', 'env_http_headers', 'bearer_token', 'bearer_token_env_var'])
const CREDENTIAL_LIKE = /token|secret|password|auth|header|cookie|key/iu

// Process environment a public app-server keeps; HOME and CODEX_HOME point at the public home.
const PUBLIC_ENV = /^(PATH|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TEMP|TMP)$/u

// Key names the allowlist schema owns, per level: the only key names an error message prints.
const FILE_KEYS = Object.keys(fileSchema.shape)
const ROLE_KEYS = Object.keys(roleSchema.shape)
const MCP_ENTRY_KEYS = ['name', 'public_safe']
const KNOWN_KEYS = new Set([...FILE_KEYS, ...ROLE_KEYS, ...MCP_ENTRY_KEYS])
// Zod issue codes whose message is the schema's own text (expected type, literal, pattern), never the input.
const SCHEMA_MESSAGES = new Set<string>(['invalid_type', 'invalid_literal', 'invalid_union', 'invalid_string', 'too_small', 'too_big'])

// One line of printable text: control characters and Unicode line and paragraph separators become a space.
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
}

// An allowlist issue in schema-owned words: known key names and indexes only, never an input key or value.
function issueText(issue: z.ZodIssue): string {
  const where = issue.path.map(part => typeof part === 'number' || KNOWN_KEYS.has(part) ? String(part) : '?').join('.')
  let what = SCHEMA_MESSAGES.has(issue.code) ? issue.message : 'is invalid'
  if (issue.code === 'unrecognized_keys') {
    const allowed = issue.path.length === 0 ? FILE_KEYS : issue.path.length === 1 ? ROLE_KEYS : MCP_ENTRY_KEYS
    what = 'has an unknown key (allowed: ' + allowed.join(', ') + ')'
  }
  return (where ? where + ' ' : '') + what
}

function record(value: unknown): Record<string, unknown> {
  return object(value)
}

/** Reads the public allowlist; a missing default file gives the defaults. Throws on anything it does not understand. */
export function loadPublicPolicy(stateRoot: string, env: Record<string, string | undefined>): PublicPolicy {
  const explicit = env.KROT_PUBLIC_CONFIG?.trim()
  const path = explicit ? resolve(stateRoot, explicit) : join(stateRoot, 'public-access.toml')
  let raw: unknown = {}
  if (explicit || existsSync(path)) {
    try {
      raw = Bun.TOML.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new PublicHomeError(oneLine('The public allowlist ' + path + ' is missing or is not valid TOML'))
    }
  }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PublicHomeError(oneLine('The public allowlist ' + path + ' is invalid: ' + parsed.error.issues.map(issueText).join('; ')))
  }
  if (parsed.data.guest.web_search) throw new PublicHomeError('web_search is for members only; remove it from [guest]')
  const role = (input: z.infer<typeof roleSchema>): RolePolicy => ({
    skills: input.skills,
    mcp: input.mcp.map(entry => typeof entry === 'string' ? { name: entry, publicSafe: false } : { name: entry.name, publicSafe: entry.public_safe }),
    webSearch: input.web_search,
  })
  return {
    skillsDir: resolve(stateRoot, parsed.data.skills_dir ?? 'public-skills'),
    roles: { member: role(parsed.data.member), guest: role(parsed.data.guest) },
    servers: parsed.data.mcp_servers,
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key)
}

// TOML inline values; JSON string escapes are valid TOML basic-string escapes.
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return '[' + value.map(tomlValue).join(', ') + ']'
  if (value !== null && typeof value === 'object') {
    return '{ ' + Object.entries(value).map(([key, item]) => tomlKey(key) + ' = ' + tomlValue(item)).join(', ') + ' }'
  }
  throw new PublicHomeError('An MCP server entry holds a value the bridge cannot copy')
}

// A credential-looking string value: a secret word, a known token prefix or a long opaque token.
const CREDENTIAL_VALUE = /token|secret|passw|auth|bearer|api[-_]?key|access[-_]?key|cookie|\bsk-|ghp_|xox[a-z]-|[A-Za-z0-9_-]{32,}/iu

function valueCarriesCredentials(value: unknown): boolean {
  if (typeof value === 'string') return CREDENTIAL_VALUE.test(value)
  if (Array.isArray(value)) return value.some(valueCarriesCredentials)
  if (value !== null && typeof value === 'object') return Object.values(value).some(valueCarriesCredentials)
  return false
}

// Key names first, then values (args and the like), then the URL: a query string or user:password is a credential too.
function carriesCredentials(entry: Record<string, unknown>, url: URL): boolean {
  if (Object.keys(entry).some(key => CREDENTIAL_KEYS.has(key) || CREDENTIAL_LIKE.test(key))) return true
  if (Object.entries(entry).some(([key, value]) => key !== 'url' && valueCarriesCredentials(value))) return true
  return url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
}

// Only these survive a rebuild of a public home: Codex's thread history (so saved chats can resume)
// and the bridge's own thread file. Everything else is written fresh.
const KEPT_IN_HOME = new Set(['sessions', 'bridge-thread.json'])

// The real path of a path that may not exist yet (then its absolute form).
function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// True when child lies strictly inside parent, compared by path segments.
function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

// True when a and b are the same folder or one lies inside the other.
function overlaps(a: string, b: string): boolean {
  return a === b || strictlyInside(a, b) || strictlyInside(b, a)
}

/** The owner folders a public-home cleanup must never delete or reach into. */
export interface ProtectedPaths {
  /** The owner Codex workspace (the cwd the owner thread runs in). */
  ownerWorkspace: string
  /** The owner CODEX_HOME. */
  ownerCodexHome: string
  /** The bridge user's HOME; folders under it are fine, HOME itself or a folder holding it is not. */
  userHome: string
}

/**
 * Makes sure the role home is a real folder the bridge owns before anything in it is deleted:
 * exactly <public-homes root>/<role>, neither it nor the root a symlink, not overlapping the
 * owner Codex home or the owner workspace in any direction, and neither HOME nor a folder
 * containing it. Creates the root and the home (mode 700) when missing; throws, and nothing is
 * cleaned, otherwise.
 */
function assertSafeRoleHome(input: { role: PublicRole; home: string; homesRoot: string } & ProtectedPaths): void {
  const { role, home, homesRoot } = input
  if (resolve(home) !== join(resolve(homesRoot), role)) {
    throw new PublicHomeError('The ' + role + ' home ' + home + ' is not <public-homes root>/' + role + ' (' + homesRoot + '); refusing to clean it')
  }
  mkdirSync(homesRoot, { recursive: true, mode: 0o700 })
  if (lstatSync(homesRoot).isSymbolicLink()) {
    throw new PublicHomeError('The public-homes root ' + homesRoot + ' is a symlink; refusing to clean anything in it')
  }
  const existing = lstatSync(home, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) throw new PublicHomeError('The ' + role + ' home ' + home + ' is a symlink; refusing to clean it')
  if (existing && !existing.isDirectory()) throw new PublicHomeError('The ' + role + ' home ' + home + ' is not a folder')
  if (!existing) mkdirSync(home, { mode: 0o700 })
  const real = realpathSync(home)
  if (real !== join(realpathSync(homesRoot), role)) {
    throw new PublicHomeError('The ' + role + ' home ' + home + ' resolves outside the public-homes root ' + homesRoot + '; refusing to clean it')
  }
  const ownerCodex = realOrResolved(input.ownerCodexHome)
  if (real === ownerCodex || strictlyInside(real, ownerCodex) || strictlyInside(ownerCodex, real)) {
    throw new PublicHomeError('The ' + role + ' home ' + home + ' overlaps the owner Codex home ' + input.ownerCodexHome + '; refusing to clean it')
  }
  if (!isAbsolute(input.ownerWorkspace)) {
    throw new PublicHomeError('The owner workspace ' + input.ownerWorkspace + ' is not an absolute path; refusing to clean the ' + role + ' home')
  }
  if (overlaps(real, realOrResolved(input.ownerWorkspace))) {
    throw new PublicHomeError('The ' + role + ' home ' + home + ' overlaps the owner workspace ' + input.ownerWorkspace + '; refusing to clean it')
  }
  // Under HOME is the default state directory; HOME itself or a folder holding it never is a role home.
  if (isAbsolute(input.userHome)) {
    const userHome = realOrResolved(input.userHome)
    if (real === userHome || strictlyInside(real, userHome)) {
      throw new PublicHomeError('The ' + role + ' home ' + home + ' is or contains HOME (' + input.userHome + '); refusing to clean it')
    }
  }
}

/**
 * Every public role home checked before any of them is cleaned (startup): throws on the first
 * role home that fails assertSafeRoleHome, so nothing is deleted when one overlaps an owner folder.
 */
export function assertPublicHomesSafe(input: { homesRoot: string } & ProtectedPaths): void {
  for (const role of PUBLIC_ROLES) assertSafeRoleHome({ ...input, role, home: join(input.homesRoot, role) })
}

/**
 * Deletes everything in a role home but the kept thread history. Each target is checked again
 * right before it is removed: it must not be, contain or lie inside the owner workspace or the
 * owner Codex home, and must not be or contain HOME; otherwise it throws and the target stays.
 */
export function clearRoleHome(home: string, protectedPaths: ProtectedPaths): void {
  const parent = realpathSync(home)
  const ownerWorkspace = realOrResolved(protectedPaths.ownerWorkspace)
  const ownerCodexHome = realOrResolved(protectedPaths.ownerCodexHome)
  const userHome = isAbsolute(protectedPaths.userHome) ? realOrResolved(protectedPaths.userHome) : undefined
  for (const entry of readdirSync(home)) {
    const path = join(home, entry)
    if (KEPT_IN_HOME.has(entry) && !lstatSync(path).isSymbolicLink()) continue
    // The entry itself is never followed: rmSync removes a symlink, not what it points at.
    const target = join(parent, entry)
    if (overlaps(target, ownerWorkspace) || overlaps(target, ownerCodexHome) ||
        (userHome !== undefined && (target === userHome || strictlyInside(target, userHome)))) {
      throw new PublicHomeError('Refusing to delete ' + path + ': it is, holds or lies inside the owner workspace, ' +
        'the owner Codex home or HOME')
    }
    rmSync(target, { recursive: true, force: true })
  }
}

const HOOK_MARK = 'codex-permission-hook'
const HOOK_ROLE_FLAG = '--thread-role'
// The hook's own timeout (docs/claude-compatibility.md): longer than its 125 s approval wait.
const HOOK_TIMEOUT_SEC = 135
// One plain argument: no quotes, spaces, `;`, `$`, pipes or anything else a shell would act on.
const PLAIN_ARG = /^[A-Za-z0-9_./@+=:-]+$/u
const HOOK_SCRIPT = /^codex-permission-hook\.(js|ts)$/u

/**
 * The permission hook command, when it has exactly the shape the bridge runs:
 * `<abs bun> <abs .../codex-permission-hook.js|ts> <abs policy> <port> <abs token file> [scope] --thread-role`.
 */
function validHookCommand(command: string): boolean {
  const args = command.split(' ')
  if (args.length !== 6 && args.length !== 7) return false
  if (!args.every(arg => PLAIN_ARG.test(arg))) return false
  const [bin, script, policy, port, token] = args as [string, string, string, string, string]
  const absolute = (path: string) => path.startsWith('/') && !path.split('/').includes('..')
  if (![bin, script, policy, token].every(absolute)) return false
  if (!HOOK_SCRIPT.test(script.slice(script.lastIndexOf('/') + 1))) return false
  const portNumber = Number(port)
  if (!/^\d{1,5}$/u.test(port) || portNumber < 1 || portNumber > 65535) return false
  if (args.length === 7 && !NAME.test(args[5]!)) return false
  return args[args.length - 1] === HOOK_ROLE_FLAG
}

// Command strings of every PreToolUse handler of one hooks table; other events are ignored.
function preToolUseCommands(hooks: unknown): string[] {
  const groups = record(hooks).PreToolUse
  if (!Array.isArray(groups)) return []
  return groups.flatMap(group => {
    const handlers = record(group).hooks
    return Array.isArray(handlers) ? handlers.map(record)
      .filter(handler => handler.type === 'command' && typeof handler.command === 'string')
      .map(handler => handler.command as string) : []
  })
}

/**
 * The PreToolUse entry of every public home (the second layer: it denies every tool call of a member
 * or guest thread). Written by the bridge, never copied: only the validated command of the owner's
 * codex-permission-hook PreToolUse handler (hooks.json or config.toml) is taken; the matcher, timeout and
 * every other owner hook are fixed or left out, and no hooks.json is written. Throws when there is
 * not exactly one such command, or one of them has another shape.
 */
function ownerHookCommand(ownerCodexHome: string, ownerConfig: Record<string, unknown>): string {
  const commands = preToolUseCommands(ownerConfig.hooks)
  const hooksJsonPath = join(ownerCodexHome, 'hooks.json')
  if (existsSync(hooksJsonPath)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf8'))
    } catch {
      throw new PublicHomeError('Cannot read the owner Codex hooks file ' + hooksJsonPath)
    }
    commands.push(...preToolUseCommands(record(parsed).hooks))
  }
  const ours = [...new Set(commands.filter(command => command.includes(HOOK_MARK)))]
  const invalid = ours.filter(command => !validHookCommand(command))
  if (invalid.length) {
    throw new PublicHomeError('The ' + HOOK_MARK + ' PreToolUse command of the owner Codex config is not of the form ' +
      '"/abs/bun /abs/codex-permission-hook.js /abs/policy.yaml <port> /abs/token-file [scope] --thread-role" ' +
      '(plain arguments, nothing else); public homes run only that permission hook')
  }
  if (ours.length > 1) {
    throw new PublicHomeError('The owner Codex config has ' + ours.length + ' different ' + HOOK_MARK +
      ' PreToolUse commands; keep one so the public homes get the permission hook the owner runs')
  }
  if (!ours.length) {
    throw new PublicHomeError('The owner Codex config (config.toml or hooks.json) has no PreToolUse ' + HOOK_MARK +
      ' permission hook with ' + HOOK_ROLE_FLAG + '; public homes carry it as the second layer, so multi-user mode cannot start')
  }
  return ours[0]!
}

/** What the permission hook of a public home runs on; `bun` and `codexBuild` are part of the home hash. */
export interface HookRuntime {
  /** Absolute path of the bun running the bridge (process.execPath): the only executable a public hook runs. */
  bun: string
  /** Absolute real path of the one Codex executable: probed for its build and launched for every public app-server. */
  codex: string
  /** `codex --version` of exactly that executable. */
  codexBuild: string
}

// The first executable `codex` on an absolute PATH entry, symlinks followed. Relative or empty entries
// are skipped: they resolve against the cwd of whoever spawns them, so the probe and the launch could differ.
function resolveCodexExecutable(env: Record<string, string | undefined>): string {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, 'codex')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      continue
    }
  }
  throw new PublicHomeError('No executable codex on an absolute PATH entry; the public app-servers need one pinned Codex executable')
}

/**
 * Startup: resolves ONE absolute Codex executable and reads its `codex --version`; the public app-servers
 * launch that same file (publicAppServerCommand). Throws when either fails: the home hash, and so the
 * cached hook proof, must name the Codex build that actually runs.
 */
export function publicCodexRuntime(env: Record<string, string | undefined>, bun: string): HookRuntime {
  const codex = resolveCodexExecutable(env)
  let output = ''
  try {
    const run = Bun.spawnSync([codex, '--version'], { env: { PATH: env.PATH ?? '' }, stdout: 'pipe', stderr: 'ignore' })
    if (run.exitCode === 0) output = run.stdout.toString().trim()
  } catch {
    output = ''
  }
  if (!output) throw new PublicHomeError('Cannot read `codex --version`; the hook proof of the public homes must name the Codex build')
  return { bun, codex, codexBuild: output }
}

/** The command a public app-server starts with: the pinned Codex executable, never a PATH lookup. */
export function publicAppServerCommand(runtime: HookRuntime): [string, ...string[]] {
  return [runtime.codex, 'app-server', '--listen', 'stdio://']
}

/**
 * The hook command a public home runs: the hook script and its arguments from the validated owner
 * command, the executable always the bridge's own bun, never the one named in the owner config.
 */
function trustedHookCommand(ownerCommand: string, runtime: HookRuntime): string {
  const bun = runtime.bun
  if (!bun.startsWith('/') || !PLAIN_ARG.test(bun) || bun.split('/').includes('..')) {
    throw new PublicHomeError('The bridge\'s bun path is not a plain absolute path, so the public permission hook cannot run on it')
  }
  return [bun, ...ownerCommand.split(' ').slice(1)].join(' ')
}

/** The only hooks table a public home may have: one PreToolUse entry running `command`. */
function publicHooks(command: string): Record<string, unknown> {
  return { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] }] }
}

// The only environment variables a public MCP server may read: credentials the owner set up for public roles.
const PUBLIC_MCP_VAR = /^KROT_PUBLIC_MCP_[A-Z0-9_]+$/u

// Variable names a copied server reads from the environment (public_safe entries only).
function envVarNames(entry: Record<string, unknown>): string[] {
  const names: string[] = []
  if (Array.isArray(entry.env_vars)) names.push(...entry.env_vars.filter((item): item is string => typeof item === 'string'))
  if (typeof entry.bearer_token_env_var === 'string') names.push(entry.bearer_token_env_var)
  names.push(...Object.values(record(entry.env_http_headers)).filter((item): item is string => typeof item === 'string'))
  return names
}

// Copies a skill folder read-only (files 0444; folders stay 0700 so a plain rm still works); a symlink could point anywhere, so it refuses to start.
function copySkill(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new PublicHomeError('Public skill file ' + source + ' is a symlink; copy the real file instead')
  if (stat.isDirectory()) {
    mkdirSync(target, { mode: 0o700 })
    for (const entry of readdirSync(source)) copySkill(join(source, entry), join(target, entry))
  } else if (stat.isFile()) {
    copyFileSync(source, target)
    chmodSync(target, 0o444)
  } else {
    throw new PublicHomeError('Public skill file ' + source + ' is not a regular file')
  }
}

function availableSkills(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && NAME.test(entry.name) && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()
}

/**
 * Builds (or rebuilds) the CODEX_HOME of one public role from the allowlist.
 * Throws, and multi-user mode does not start, on any entry it cannot copy safely.
 */
export function preparePublicHome(input: {
  role: PublicRole; policy: PublicPolicy; home: string; ownerCodexHome: string; runtime: HookRuntime
  /** The bridge's public-homes root (<state>/codex-public); `home` must be exactly <homesRoot>/<role>. */
  homesRoot: string
  /** The bridge user's HOME; a role home is never HOME or a folder containing it. */
  userHome: string
  /** The owner Codex workspace (canonical path); a role home never overlaps it in any direction. */
  ownerWorkspace: string
}): PreparedHome {
  const { role, policy, home, ownerCodexHome } = input
  const rolePolicy = policy.roles[role]
  // Skills: every name must exist in the public skills folder.
  const available = availableSkills(policy.skillsDir)
  const skills = rolePolicy.skills === 'all' ? available : [...new Set(rolePolicy.skills)]
  for (const skill of skills) {
    if (!available.includes(skill)) throw new PublicHomeError('Public skill "' + skill + '" for ' + role + ' is not in ' + policy.skillsDir)
  }
  // The owner's config.toml is read for the permission hook command only, never for MCP servers.
  const ownerConfigPath = join(ownerCodexHome, 'config.toml')
  let ownerConfig: Record<string, unknown> = {}
  if (existsSync(ownerConfigPath)) {
    try {
      ownerConfig = record(Bun.TOML.parse(readFileSync(ownerConfigPath, 'utf8')))
    } catch {
      throw new PublicHomeError('Cannot read the owner Codex config ' + ownerConfigPath)
    }
  }
  const hookCommand = trustedHookCommand(ownerHookCommand(ownerCodexHome, ownerConfig), input.runtime)
  // MCP: only listed servers defined in the public allowlist, credentials only when marked public_safe.
  const mcpLines: string[] = []
  const envVars: string[] = []
  for (const allow of rolePolicy.mcp) {
    const server = Object.hasOwn(policy.servers, allow.name) ? policy.servers[allow.name] : undefined
    if (server === undefined || Object.keys(server).length === 0) {
      throw new PublicHomeError('MCP server "' + allow.name + '" for ' + role + ' is not defined in the public allowlist; ' +
        'define it as [mcp_servers.' + allow.name + '] there (the owner Codex config is never copied)')
    }
    // A local (stdio) server runs as the bridge user and could read every owner file; public roles get URL servers only.
    let url: URL | undefined
    try {
      url = 'command' in server || typeof server.url !== 'string' ? undefined : new URL(server.url)
    } catch {
      url = undefined
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new PublicHomeError('MCP server "' + allow.name + '" for ' + role + ' is a local process (stdio) server or has no http(s) url; ' +
        'it would run as the bridge user with access to the owner files, so public roles get only URL servers')
    }
    if (carriesCredentials(server, url) && !allow.publicSafe) {
      throw new PublicHomeError('MCP server "' + allow.name + '" carries credentials (env, headers, a bearer token, a key in args or the url); ' +
        'mark it { name = "' + allow.name + '", public_safe = true } in the public allowlist to give it to ' + role)
    }
    const foreignVar = envVarNames(server).find(variable => !PUBLIC_MCP_VAR.test(variable))
    if (foreignVar !== undefined) {
      throw new PublicHomeError('MCP server "' + allow.name + '" for ' + role + ' reads an environment variable that is not named ' +
        'KROT_PUBLIC_MCP_<NAME>; give public servers their own credentials, never an owner one')
    }
    envVars.push(...envVarNames(server))
    mcpLines.push('', '[mcp_servers.' + tomlKey(allow.name) + ']',
      ...Object.entries(server).map(([key, value]) => tomlKey(key) + ' = ' + tomlValue(value)))
  }
  const auth = join(ownerCodexHome, 'auth.json')
  if (!existsSync(auth)) throw new PublicHomeError('The owner CODEX_HOME has no auth.json (the ChatGPT login file); the public Codex cannot log in')

  const protectedPaths: ProtectedPaths = { ownerWorkspace: input.ownerWorkspace, ownerCodexHome, userHome: input.userHome }
  assertSafeRoleHome({ role, home, homesRoot: input.homesRoot, ...protectedPaths })
  chmodSync(home, 0o700)
  clearRoleHome(home, protectedPaths)
  const skillsRoot = join(home, 'skills')
  mkdirSync(skillsRoot, { mode: 0o700 })
  for (const skill of skills) copySkill(join(policy.skillsDir, skill), join(skillsRoot, skill))

  const config = [
    '# Written by the Telegram bridge at every start: the Codex home of ' + role + ' threads. Do not edit;',
    '# change public-access.toml instead.',
    'web_search = ' + JSON.stringify(rolePolicy.webSearch && role === 'member' ? 'live' : 'disabled'),
    '',
    '[features]',
    ...PUBLIC_FEATURES_OFF.map(feature => feature + ' = false'),
    // Forced on whatever the owner set: the permission hook below must run (the startup probe checks it).
    'hooks = true',
    '',
    '# Account (ChatGPT) connectors off for every app, on top of features.apps = false.',
    '[apps._default]',
    'enabled = false',
    '',
    '# The permission hook (--thread-role), written by the bridge: denies every tool call of these threads.',
    '[[hooks.PreToolUse]]',
    'matcher = "*"',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = ' + JSON.stringify(hookCommand),
    'timeout = ' + HOOK_TIMEOUT_SEC,
    ...mcpLines,
    '',
  ].join('\n')
  const written = record(Bun.TOML.parse(config))
  if (!Bun.deepEquals(written.hooks, publicHooks(hookCommand)) || record(written.features).hooks !== true) {
    throw new PublicHomeError('The bridge could not write the permission hook of the ' + role + ' home exactly')
  }
  writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 })
  chmodSync(join(home, 'config.toml'), 0o600)
  copyFileSync(auth, join(home, 'auth.json'))
  chmodSync(join(home, 'auth.json'), 0o600)
  // The hook script, the Codex build and the bun it runs on are part of what the proof proved:
  // a replaced hook build, a Codex upgrade or another bun needs a new proof.
  const hash = createHash('sha256').update(config).update('\0')
  try {
    hash.update(readFileSync(hookCommand.split(' ')[1]!))
  } catch {
    hash.update('missing hook script')
  }
  hash.update('\0codex ' + input.runtime.codexBuild + '\0bun ' + input.runtime.bun)
  return {
    role, home, skills, mcp: rolePolicy.mcp.map(allow => allow.name),
    webSearch: rolePolicy.webSearch && role === 'member', envVars: [...new Set(envVars)], configHash: hash.digest('hex'),
  }
}

/** Environment of a public app-server: no owner credentials, HOME and CODEX_HOME at the public home. */
export function publicCodexEnv(env: Record<string, string | undefined>, home: string, passVars: readonly string[] = []):
  Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (PUBLIC_ENV.test(key) || passVars.includes(key))) result[key] = value
  }
  result.HOME = home
  result.CODEX_HOME = home
  return result
}

const ROLE_LABEL: Record<PublicRole, string> = { member: 'Участник', guest: 'Гость' }

/** /doctor lines: what each public role may use. */
export function publicRolesSummary(prepared: readonly PreparedHome[]): string[] {
  const list = (items: readonly string[]) => items.length ? items.join(', ') : 'нет'
  return prepared.map(home => ROLE_LABEL[home.role] + ': навыки: ' + list(home.skills) + '; MCP: ' + list(home.mcp) +
    '; веб-поиск: ' + (home.webSearch ? 'да' : 'нет') + '; команды и запись файлов: нет')
}
