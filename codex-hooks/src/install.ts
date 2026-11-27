// Installs the pack into Codex, removes it, and checks it for doctor.
//   bun codex-hooks/src/install.ts               register the hooks in $CODEX_HOME/hooks.json
//   bun codex-hooks/src/install.ts --uninstall   remove exactly our handlers, KROT_CODEX_HOOKS and full access from plugin/.env
// Codex runs a new or changed hook only after its trust is persisted (config.toml
// hooks.state."<key>".trusted_hash, written when the user trusts the hook in Codex). The installer
// does not forge that hash: doctor reports untrusted hooks and how to trust them.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { DEFAULT_CONFIG } from './config.js'
import { invokingHome } from './home.js'
import { ALLOW_TOKEN, BRIDGE_UID_FILE, bridgeUidContent, CONTEXT_PREFIX, CONTEXT_SUFFIX, DENY_EXIT, MANAGED_DIR_ENV, readBridgeUid, rootOnly, rootOwned, VERDICT_ARG, type OwnerTrust } from './scope.js'
import { record, type HookEvent, type Json, type Runner } from './types.js'

export const PACK_EVENTS: readonly HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
export const BRAIN_EVENTS: readonly HookEvent[] = ['PreCompact']
const INSTALL_EVENTS = [...PACK_EVENTS, ...BRAIN_EVENTS]
const SESSION_CONTEXT_LIMIT = 6000
const MARK = '/codex-hooks/src/main.ts'
// Every doctor line about the pack starts with this, so /doctor can show the pack's state.
export const HOOKS_CHECK_PREFIX = 'Хуки Codex'
const ENV_FLAG = /^[ \t]*(?:export[ \t]+)?KROT_CODEX_HOOKS[ \t]*=.*(?:\n|$)/gm

export interface PackPaths { codexHome: string; configFile: string; bun: string; main: string }
export interface Check { status: 'ok' | 'info' | 'warning' | 'error'; message: string; blocking?: false }
// One hook as Codex lists it (app-server hooks/list): only the fields the doctor reads. `command`
// is used when the listing carries it; otherwise our handler is found by its position in the event.
// The managed-hook gate (managedListing) also reads handlerType, isManaged and source.
export interface ListedHook {
  eventName?: unknown; sourcePath?: unknown; trustStatus?: unknown; command?: unknown; enabled?: unknown
  handlerType?: unknown; isManaged?: unknown; source?: unknown
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
export const packCommand = (paths: PackPaths, event: HookEvent) => `${quote(paths.bun)} ${quote(paths.main)} ${event}`

function writeAtomic(file: string, content: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, file)
}

function groups(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : []
}

// Our handler is exactly `'<bun>' '<...>/codex-hooks/src/main.ts' <Event>`: a sibling that merely
// mentions the pack path (an audit log line, a wrapper) is not ours.
const OURS = new RegExp(`^'[^']*' '[^']*${MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' (?:${INSTALL_EVENTS.join('|')})$`)
const isOurs = (hook: Json) => typeof hook.command === 'string' && OURS.test(hook.command)

// The event's groups without our handlers; a group left with no handler is dropped, a mixed group
// keeps its other handlers (and its matcher).
function withoutOurs(value: unknown): Json[] {
  return groups(value).flatMap(group => {
    const handlers = groups(group.hooks)
    if (!handlers.some(isOurs)) return [group]
    const kept = handlers.filter(hook => !isOurs(hook))
    return kept.length ? [{ ...group, hooks: kept }] : []
  })
}

const stamp = (now: Date) => now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

// hooks.json.bak.<time>, or .bak.<time>.<n> when that name is taken (two runs in one second).
function backupName(file: string, now: Date): string {
  const base = `${file}.bak.${stamp(now)}`
  let name = base
  for (let n = 1; existsSync(name); n++) name = `${base}.${n}`
  return name
}

// Writes hooks.json only when it changes, after copying the previous file to hooks.json.bak.<time>.
function writeHooks(hooksFile: string, file: Json, hooks: Json, now: Date): void {
  const next = JSON.stringify({ ...file, hooks }, null, 2) + '\n'
  if (existsSync(hooksFile)) {
    if (readFileSync(hooksFile, 'utf8') === next) return
    copyFileSync(hooksFile, backupName(hooksFile, now))
  }
  writeAtomic(hooksFile, next)
}

function readHooksFile(hooksFile: string): Json {
  return existsSync(hooksFile) ? record(JSON.parse(readFileSync(hooksFile, 'utf8'))) : {}
}

export function installHooks(paths: PackPaths, now = new Date()): { hooksFile: string; configWritten: boolean } {
  const hooksFile = join(paths.codexHome, 'hooks.json')
  const file = readHooksFile(hooksFile)
  const hooks = { ...record(file.hooks) }
  for (const event of INSTALL_EVENTS) {
    const handler = { type: 'command', command: packCommand(paths, event),
      ...(event === 'SessionStart' ? { additionalContextLimit: SESSION_CONTEXT_LIMIT } : {}) }
    hooks[event] = [...withoutOurs(hooks[event]), { hooks: [handler] }]
  }
  writeHooks(hooksFile, file, hooks, now)
  const configWritten = !existsSync(paths.configFile)
  if (configWritten) writeAtomic(paths.configFile, JSON.stringify({ enabled: DEFAULT_CONFIG.enabled }, null, 2) + '\n')
  return { hooksFile, configWritten }
}

// Removes our handlers from every event (other handlers stay) and the KROT_CODEX_HOOKS and
// KROT_CODEX_SANDBOX=danger-full-access lines from the bridge env file. The switchboard file stays: it holds the owner's choices.
export function uninstallHooks(paths: PackPaths, envFile: string | undefined, now = new Date()): { hooksFile: string; envChanged: boolean } {
  const hooksFile = join(paths.codexHome, 'hooks.json')
  if (existsSync(hooksFile)) {
    const file = readHooksFile(hooksFile)
    const hooks: Json = {}
    for (const [event, value] of Object.entries(record(file.hooks))) {
      const kept = withoutOurs(value)
      if (kept.length || !INSTALL_EVENTS.includes(event as HookEvent)) hooks[event] = kept
    }
    writeHooks(hooksFile, file, hooks, now)
  }
  let envChanged = false
  if (envFile && existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf8')
    // Full access never outlives the guards: the sandbox setting goes back to the default too.
    const next = content.replace(ENV_FLAG, '').replace(FULL_ACCESS_FLAG, '')
    if (next !== content) { writeAtomic(envFile, next); envChanged = true }
  }
  return { hooksFile, envChanged }
}

const eventKey = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : ''

// For each event, whether Codex trusts OUR handler. Our handler is the listed hook with our exact
// command; without commands in the listing, the one at our handler's position among the event's
// handlers in hooks.json (Codex lists a file's handlers in file order).
function ourTrust(listed: ListedHook[], hooks: Json, paths: PackPaths, events = PACK_EVENTS): boolean {
  return events.every(event => {
    const forEvent = listed.filter(hook => eventKey(hook.eventName) === eventKey(event))
    const command = packCommand(paths, event)
    if (forEvent.some(hook => typeof hook.command === 'string')) {
      return forEvent.some(hook => hook.command === command && hook.trustStatus === 'trusted')
    }
    const handlers = groups(hooks[event]).flatMap(group => groups(group.hooks))
    const position = handlers.findIndex(hook => hook.command === command)
    return position >= 0 && forEvent.length === handlers.length && forEvent[position]?.trustStatus === 'trusted'
  })
}

const brainCheck = (installed: boolean): Check => ({
  status: installed ? 'ok' : 'info',
  message: installed ? `${HOOKS_CHECK_PREFIX}: Brain PreCompact установлен и включён.`
    : `${HOOKS_CHECK_PREFIX}: Brain PreCompact недоступен, передача рабочего контекста после сжатия отключена. ` +
      'Запустите ./install.sh --hooks и выполните напечатанную команду установки или подтвердите доверие к пользовательскому хуку.',
})

export async function checkHooksPack(paths: PackPaths, listHooks: () => Promise<ListedHook[]>): Promise<Check[]> {
  let listed: ListedHook[] | undefined
  try { listed = await listHooks() } catch { /* report unavailable trust below */ }
  if (listed && managedListing(listed).ok) {
    return [{ status: 'ok', message: `${HOOKS_CHECK_PREFIX}: Codex загрузил управляемые хуки для всех ${PACK_EVENTS.length} событий.` },
      brainCheck(managedListingForEvents(listed, ETC_CODEX, BRAIN_EVENTS).ok)]
  }

  const hooksFile = join(paths.codexHome, 'hooks.json')
  let registered: string[] = []
  let hooks: Json = {}
  try {
    hooks = record(record(JSON.parse(readFileSync(hooksFile, 'utf8'))).hooks)
    registered = PACK_EVENTS.filter(event => groups(hooks[event]).some(group => groups(group.hooks)
      .some(hook => typeof hook.command === 'string' && hook.command.includes(MARK) && hook.command.includes(paths.main))))
  } catch { /* missing or broken: reported below */ }
  if (registered.length !== PACK_EVENTS.length || !existsSync(paths.main)) {
    return [{ status: 'error', message: `${HOOKS_CHECK_PREFIX} не установлены или устарели в ${hooksFile}. Запустите ./install.sh --hooks.` }, brainCheck(false)]
  }
  const present: Check = { status: 'ok', message: `${HOOKS_CHECK_PREFIX} зарегистрированы для ${PACK_EVENTS.length} событий.` }
  if (!listed) {
    return [present, { status: 'warning', message: `${HOOKS_CHECK_PREFIX}: не удалось проверить доверие к ним через Codex App Server. Запустите codex и подтвердите хуки, затем повторите /doctor.` }, brainCheck(false)]
  }
  const userHooks = listed.filter(hook => hook.sourcePath === hooksFile)
  const brain = brainCheck(ourTrust(userHooks, hooks, paths, BRAIN_EVENTS))
  if (ourTrust(userHooks, hooks, paths)) {
    return [present, { status: 'ok', message: `${HOOKS_CHECK_PREFIX}: Codex им доверяет, они выполняются.` }, brain]
  }
  return [present, { status: 'warning', message: `${HOOKS_CHECK_PREFIX}: Codex ещё не доверяет им, поэтому они не выполняются. Откройте codex в терминале под пользователем моста, подтвердите доверие к хукам и повторите /doctor.` }, brain]
}

// Collects every object with a sourcePath from an app-server hooks/list response, whatever its nesting.
export function listedHooks(value: unknown): ListedHook[] {
  if (Array.isArray(value)) return value.flatMap(listedHooks)
  const object = record(value)
  const own = typeof object.sourcePath === 'string' ? [object as ListedHook] : []
  return [...own, ...Object.values(object).filter(item => typeof item === 'object' && item !== null).flatMap(listedHooks)]
}

// Whether a ruleset protects main of the GitHub repository at `dir`: GitHub's rules for the branch
// must include a pull-request rule (direct pushes and unchecked merges are then refused by GitHub).
// undefined outside a git repository.
export function rulesetCheck(run: Runner, dir: string): Check | undefined {
  const top = run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 3000 })
  if (top.code !== 0) return
  const repo = top.stdout.trim()
  const answer = run(['gh', 'api', 'repos/{owner}/{repo}/rules/branches/main'], { cwd: repo, timeoutMs: 8000 })
  let rules: unknown
  try { rules = answer.code === 0 ? JSON.parse(answer.stdout) : undefined } catch { rules = undefined }
  if (!Array.isArray(rules)) {
    return { status: 'warning', message: `${HOOKS_CHECK_PREFIX}: не удалось проверить ruleset на main в ${repo} (gh api). Проверьте, что ruleset требует PR и статус codex-hooks/check.` }
  }
  const types = new Set(rules.map(rule => record(rule).type))
  const checked = rules.some(rule => record(rule).type === 'required_status_checks'
    && groups(record(record(rule).parameters).required_status_checks).some(check => check.context === 'codex-hooks/check'))
  if (types.has('pull_request') && types.has('non_fast_forward') && types.has('deletion') && checked) {
    return { status: 'ok', message: `${HOOKS_CHECK_PREFIX}: main в ${repo} защищён ruleset.` }
  }
  return { status: 'warning', message: `${HOOKS_CHECK_PREFIX}: на main в ${repo} нет полного ruleset. Включите в GitHub ruleset: обязательный PR, запрет force push и удаления, обязательный статус codex-hooks/check, пустой список обхода.` }
}

// Managed hooks: a root-owned copy of the pack registered in /etc/codex/requirements.toml. Codex
// runs system-layer hooks without a trust step and the agent cannot edit or switch them off.
// Codex 0.172 command handlers have no failure policy: a PreToolUse hook that crashes, exits
// with another code, is killed or times out lets the tool run. So the launcher owns the verdict
// of a PreToolUse run: the bundle only reports it (scope.ts: exit 3 = deny, exit 0 with the ALLOW
// line first = allow) and the launcher answers Codex itself. Every block is exit 2
// with a stderr line that starts with BLOCK_PREFIX, so the reason Codex reads is never blank.
export const BLOCK_PREFIX = 'Заблокировано защитой Codex: '
// The reason when the bundle's deny carries no visible character.
const NO_REASON = 'причина не указана'
export const MANAGED_MARK = '# krotov-plugin codex-hooks: managed hooks'
export const ETC_CODEX = '/etc/codex'
const BUNDLE = 'codex-hooks.js'
const HOOK_TIMEOUT_S = 30
// The launcher's bridge-uid lookup (find, cat, wc, id) runs under one timeout: stopped after
// LOOKUP_TIMEOUT_S, killed LOOKUP_KILL_S later; a lookup that does not finish is not 'other'.
const LOOKUP_TIMEOUT_S = 2
const LOOKUP_KILL_S = 1
// A PreToolUse run of the bridge user has one absolute deadline. The launcher Codex waits for (the
// outer one) does no file work at all: after the lookup it runs itself again as the judge under one
// watchdog (stopped after JUDGE_TIMEOUT_S, killed JUDGE_KILL_S later), and everything that touches
// /tmp happens inside that judge. So a stalled /tmp ends as a block from the outer launcher, never
// as a Codex timeout (Codex 0.172 lets the tool run when a hook times out).
const JUDGE_ARG = 'judge'
// The judge's exit code after it printed the block line itself.
const JUDGE_BLOCKED = 10
// The judge's files (the drained envelope, the bundle's answer) live in one owner-only directory
// TMP_PREFIX<pid of the outer launcher>.<random>. The judge never removes it: the outer launcher
// does, by that name, in a detached process with closed stdio once the verdict is written, so no
// cleanup can hold the result (and a judge its watchdog killed leaves nothing behind either).
const TMP_PREFIX = '/tmp/codex-hooks.'
// The judge first drains Codex's stdin into its directory: at most CALL_CAP bytes are kept (a
// longer envelope is read to its end and blocked), within DRAIN_TIMEOUT_S (killed DRAIN_KILL_S
// later; not done = block). Then it closes its stdin, so no process started later (bun, a bun that
// outlives its timeout) ever holds Codex's pipe: Codex waits for its write of the envelope as well
// as for the hook result, and a write still pending at its timeout lets the tool run.
const CALL_CAP = 4 * 1024 * 1024
const DRAIN_TIMEOUT_S = 2
const DRAIN_KILL_S = 1
// The judge stops bun after this many seconds (and kills it LAUNCHER_KILL_S later). The entry's
// own PreToolUse deadline (entry.ts HOOK_DEADLINE_MS, 18 s) ends first.
const LAUNCHER_TIMEOUT_S = 20
const LAUNCHER_KILL_S = 1
// One second more than the drain and bun can take together (2 + 1 + 20 + 1), for the judge's own
// reads of its two files.
const JUDGE_TIMEOUT_S = DRAIN_TIMEOUT_S + DRAIN_KILL_S + LAUNCHER_TIMEOUT_S + LAUNCHER_KILL_S + 1
const JUDGE_KILL_S = 1
// The most the judge reads of the bundle's stdout: an allow answer, a deny reason (bytes).
const ANSWER_CAP = 65_536
const REASON_CAP = 8192
// The longest a launcher run can take: lookup 2 + 1 and the judge 25 + 1 = 29 s, below
// HOOK_TIMEOUT_S. Nothing else of the outer launcher can wait: it only writes its answer.
export const LAUNCHER_BUDGET_S = LOOKUP_TIMEOUT_S + LOOKUP_KILL_S + JUDGE_TIMEOUT_S + JUDGE_KILL_S

const tomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// The root-owned launcher every managed hook runs: `<managedDir>/run <Event>`.
const LAUNCHER = 'run'
// The root-owned copy of the interpreter and its (empty) config, next to the bundle.
const MANAGED_BUN = 'bun'
const MANAGED_BUNFIG = 'bunfig.toml'
const SELF_TEST_TIMEOUT_MS = 15_000

const managedCommand = (managedDir: string, event: HookEvent) => `${quote(`${managedDir}/${LAUNCHER}`)} ${event}`

export function managedToml(managedDir: string): string {
  return formatManagedToml(managedDir, INSTALL_EVENTS, true)
}

function formatManagedToml(managedDir: string, events: readonly HookEvent[], sessionLimit: boolean): string {
  const lines = [MANAGED_MARK, '', '[hooks]', `managed_dir = ${tomlString(managedDir)}`]
  for (const event of events) {
    lines.push('', `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"',
      `command = ${tomlString(managedCommand(managedDir, event))}`, `timeout = ${HOOK_TIMEOUT_S}`)
    if (event === 'SessionStart' && sessionLimit) lines.push(`additionalContextLimit = ${SESSION_CONTEXT_LIMIT}`)
  }
  return lines.join('\n') + '\n'
}

export interface LauncherOptions {
  // The owner bridge-uid and its directories must have for the launcher to trust them (root).
  trustedOwnerUid?: number
  // Seconds before the launcher stops bun and blocks.
  timeoutS?: number
  // Seconds before the launcher stops the whole judge (drain, bun, verdict) of a PreToolUse run and blocks.
  judgeTimeoutS?: number
}

// The `other` test as one script for `sh -c` (it holds no single quote). The same rule as
// readBridgeUid: the parent dir, the managed dir and bridge-uid owned by the trusted uid and not
// group/other-writable (directories, and a regular file under 33 bytes, no symlinks), the file
// holding 1-10 digits and at most one trailing newline (no other byte, no NUL), a value in
// 1..4294967294 that differs from the real uid of this process.
const otherScript = (trustedOwnerUid: number) => [
  `trusted=$(find "$1" "$2" "$3" -prune \\( -type d -o -type f -size -33c \\) -user ${trustedOwnerUid} ! -perm /022 2>/dev/null | wc -l) || exit 1`,
  '[ "$trusted" -eq 3 ] || exit 1',
  'bridge=$(cat "$3") && size=$(wc -c < "$3") && lines=$(wc -l < "$3") && me=$(id -ru) || exit 1',
  'case $bridge in ""|*[!0-9]*) exit 1;; esac',
  'case $me in ""|*[!0-9]*) exit 1;; esac',
  '[ ${#bridge} -le 10 ] && [ "$lines" -le 1 ] && [ $((size - ${#bridge})) -eq "$lines" ] || exit 1',
  '[ "$bridge" -gt 0 ] && [ "$bridge" -le 4294967294 ] && [ "$bridge" -ne "$me" ]',
].join('\n')

// Keep the invoking user's paths across the cwd change. Use the managed bun and bunfig, and
// drop the rest of the caller environment before starting bun. A user a trusted bridge-uid proves
// is not the bridge gets exit 0 and no output without starting bun at all; that lookup has its own
// timeout. Other events keep bun's exit code and streams (they fail open).
// For everyone else the launcher owns the verdict of a PreToolUse run. The outer launcher (the
// process Codex waits for) only starts timed children and writes its answer: it runs itself again
// as the judge under one timeout, hands it Codex's stdin and its own pid, and when the judge is
// done or stopped it starts the detached removal of the judge's directory and exits.
// The judge makes that directory, drains stdin into it (CALL_CAP, DRAIN_TIMEOUT_S; a longer or
// unfinished envelope blocks) and closes stdin, then starts bun in verdict mode with the envelope
// file as stdin and stdout in a second file (stderr is dropped):
// - bun exit DENY_EXIT: block, the reason is the first REASON_CAP bytes of the file as one line
//   without control characters, or NO_REASON when it has no ASCII-visible or Cyrillic character;
// - bun exit 0: an allow only when the answer file is, byte for byte, the line ALLOW_TOKEN and at
//   most one more line, each ended by one line break. The raw bytes are checked first (size up to
//   ANSWER_CAP, no NUL and no other control byte besides those line breaks, by comparing byte
//   counts), before the shell reads the file: a command substitution drops NUL bytes and trailing
//   line breaks. The second line is exactly `{}` or exactly the context line (scope.ts; its text
//   has no quote and no raw control character, and a backslash only as `\uXXXX` with four
//   lowercase hex digits) and is the output; without it there is none;
// - everything else (exit 0 without ALLOW_TOKEN, another exit code, a signal, a timeout, a missing
//   bun, any other output, a judge that does not end in time): block with the cause.
// A block is always exit 2, nothing on stdout, and one stderr line that starts with BLOCK_PREFIX.
// No JSON of the bundle that could be a deny is ever forwarded.
// Needs GNU coreutils (timeout, mktemp, head, tr, wc, cat, id, printf, rm), sed and findutils (find -perm /022).
export function launcherScript(managedDir: string,
  { trustedOwnerUid = 0, timeoutS = LAUNCHER_TIMEOUT_S, judgeTimeoutS = JUDGE_TIMEOUT_S }: LauncherOptions = {}): string {
  const uidFile = `${managedDir}/${BRIDGE_UID_FILE}`
  const failed = (cause: string) => `хук защиты Codex не сработал (${cause}), поэтому вызов инструмента запрещён.`
  const malformed = 'fail "ответ не в формате хука" 1'
  const unread = 'fail "ответ не прочитан" 1'
  const noDir = 'fail "нет временного каталога" 1'
  const number = (name: string, otherwise: string) => `case $${name} in ""|*[!0-9]*) ${otherwise};; esac`
  return ['#!/bin/sh', '# krotov-plugin codex-hooks: root-owned launcher of the managed hooks.',
    'PATH=/usr/bin:/bin',
    // Byte-wise patterns and lengths, whatever the caller's locale.
    'LC_ALL=C',
    'export PATH LC_ALL',
    'event=${1-}',
    'stage=',
    `[ "$event" = PreToolUse ] && [ "\${2-}" = ${JUDGE_ARG} ] && stage=${JUDGE_ARG}`,
    'T=timeout',
    '[ -x /usr/bin/timeout ] && T=/usr/bin/timeout',
    // Set by the outer launcher once it has started a judge: only then is there a directory.
    'judged=',
    // Detached, stdio closed: the launcher never waits for it and it holds none of Codex's pipes.
    'reap() {',
    '  [ -n "$judged" ] || return 0',
    `  rm -rf ${TMP_PREFIX}"$$".* </dev/null >/dev/null 2>&1 &`,
    '}',
    'block() {',
    `  printf '%s%s\\n' ${quote(BLOCK_PREFIX)} "$1" >&2`,
    `  [ "$stage" = ${JUDGE_ARG} ] && exit ${JUDGE_BLOCKED}`,
    '  reap',
    '  exit 2',
    '}',
    'fail() {',
    `  [ "$event" = PreToolUse ] && block "${failed('$1')}"`,
    '  exit "$2"',
    '}',
    `if [ "$stage" != ${JUDGE_ARG} ]; then`,
    '  other() {',
    `    "$T" -k ${LOOKUP_KILL_S} ${LOOKUP_TIMEOUT_S} /bin/sh -c '${otherScript(trustedOwnerUid)}' sh ${quote(dirname(managedDir))} ${quote(managedDir)} ${quote(uidFile)} </dev/null >/dev/null 2>&1`,
    '  }',
    '  other && exit 0',
    '  if [ "$event" = PreToolUse ]; then',
    '    judged=1',
    `    "$T" -k ${JUDGE_KILL_S} ${judgeTimeoutS} ${quote(`${managedDir}/${LAUNCHER}`)} PreToolUse ${JUDGE_ARG} "$$"`,
    '    status=$?',
    '    case $status in',
    '      0) reap',
    '         exit 0;;',
    `      ${JUDGE_BLOCKED}) reap`,
    '         exit 2;;',
    `      124|137) fail "не ответил за ${judgeTimeoutS} с" 1;;`,
    '      *) fail "код выхода $status" 1;;',
    '    esac',
    '  fi',
    'fi',
    'case ${HOME-} in ""|/*) ;; *) HOME="$PWD/$HOME";; esac',
    'case ${CODEX_HOME-} in ""|/*) ;; *) CODEX_HOME="$PWD/$CODEX_HOME";; esac',
    `cd ${quote(managedDir)} || fail "нет каталога хуков" 1`,
    'hook() {',
    '  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="${HOME-}" CODEX_HOME="${CODEX_HOME-}" TMPDIR=/tmp LANG=C.UTF-8 '
      + `${MANAGED_DIR_ENV}=${quote(managedDir)} "$T" -k ${LAUNCHER_KILL_S} ${timeoutS} ./${MANAGED_BUN} --no-env-file --config=./${MANAGED_BUNFIG} ./${BUNDLE} "$event" "$@"`,
    '}',
    `if [ "$stage" != ${JUDGE_ARG} ]; then`,
    '  hook',
    '  exit "$?"',
    'fi',
    // The judge. Its directory carries the pid of the outer launcher, which removes it.
    'owner=${3-}',
    number('owner', noDir),
    `tmp=$(mktemp -d "${TMP_PREFIX}$owner.XXXXXXXXXX") || ${noDir}`,
    'call=$tmp/call',
    'out=$tmp/answer',
    // One byte above the cap shows an envelope that is too long; the rest is read and dropped,
    // so the writer is never left with a full pipe.
    `"$T" -k ${DRAIN_KILL_S} ${DRAIN_TIMEOUT_S} /bin/sh -c 'head -c ${CALL_CAP + 1} && cat >/dev/null' >"$call" 2>/dev/null`,
    'status=$?',
    'exec 0</dev/null',
    'case $status in',
    '  0) ;;',
    `  124|137) fail "вызов инструмента не прочитан за ${DRAIN_TIMEOUT_S} с" 1;;`,
    '  *) fail "вызов инструмента не прочитан, код $status" 1;;',
    'esac',
    'size=$(wc -c <"$call") || fail "вызов инструмента не прочитан" 1',
    number('size', 'fail "вызов инструмента не прочитан" 1'),
    `[ "$size" -le ${CALL_CAP} ] || fail "вызов инструмента длиннее ${CALL_CAP} байт" 1`,
    `hook ${VERDICT_ARG} <"$call" >"$out" 2>/dev/null`,
    'status=$?',
    'case $status in',
    '  0) ;;',
    `  ${DENY_EXIT}) reason=$(head -c ${REASON_CAP} "$out" | tr '\\n\\t\\r' '   ' | tr -d '\\000-\\037\\177' | sed 's/^ *//;s/ *$//')`,
    // Visible: an ASCII graphic character or a Cyrillic letter (UTF-8 lead byte D0 or D1).
    "     d0=$(printf '\\320')",
    "     d1=$(printf '\\321')",
    '     case $reason in *[[:graph:]]*|*"$d0"*|*"$d1"*) block "$reason";; esac',
    `     block ${quote(NO_REASON)};;`,
    `  124) fail "не ответил за ${timeoutS} с" 1;;`,
    `  137) fail "убит или не ответил за ${timeoutS} с" 1;;`,
    '  *) fail "код выхода $status" 1;;',
    'esac',
    // The raw bytes of the answer, counted before the shell reads any of them.
    `size=$(wc -c <"$out") || ${unread}`,
    number('size', unread),
    `[ "$size" -le ${ANSWER_CAP} ] || fail "ответ длиннее ${ANSWER_CAP} байт" 1`,
    // Every byte left once the control bytes (NUL included, the line break excepted) are deleted.
    `plain=$(tr -d '\\000-\\011\\013-\\037\\177' <"$out" | wc -c) || ${unread}`,
    number('plain', unread),
    `lines=$(wc -l <"$out") || ${unread}`,
    number('lines', unread),
    `[ "$plain" -eq "$size" ] || ${malformed}`,
    `[ "$lines" -ge 1 ] && [ "$lines" -le 2 ] || ${malformed}`,
    `answer=$(head -c ${ANSWER_CAP} "$out")`,
    // The substitution dropped exactly the one line break that ends the answer.
    `[ "$((size - \${#answer}))" -eq 1 ] || ${malformed}`,
    "newline='",
    "'",
    `[ "$answer" = ${ALLOW_TOKEN} ] && exit 0`,
    'case $answer in',
    `  ${ALLOW_TOKEN}"$newline"*) answer=\${answer#${ALLOW_TOKEN}"$newline"};;`,
    `  *) ${malformed};;`,
    'esac',
    'if [ "$answer" = "{}" ]; then',
    "  printf '{}\\n'",
    '  exit 0',
    'fi',
    `pre=${quote(CONTEXT_PREFIX)}`,
    `post=${quote(CONTEXT_SUFFIX)}`,
    'case $answer in',
    '  "$pre"*"$post")',
    '    text=${answer#"$pre"}',
    '    text=${text%"$post"}',
    // The text cannot end its JSON string early and is valid JSON string text: no quote, no raw
    // control character, and no backslash left once every \uXXXX is taken out.
    `    case $text in *'"'*|*[[:cntrl:]]*) ${malformed};; esac`,
    `    rest=$(printf '%s' "$text" | sed 's/\\\\u[0-9a-f]\\{4\\}//g') || ${malformed}`,
    `    case $rest in *'\\'*) ${malformed};; esac`,
    "    printf '%s\\n' \"$answer\"",
    '    exit 0;;',
    'esac',
    malformed,
    ''].join('\n')
}

async function buildManagedBundle(paths: PackPaths): Promise<Buffer> {
  const built = await Bun.build({ entrypoints: [paths.main], root: dirname(paths.main), target: 'bun', naming: BUNDLE })
  const bundle = built.outputs[0]
  if (!built.success || !bundle) throw new Error(`could not bundle the hooks pack: ${built.logs.map(log => String(log)).join('; ')}`)
  return Buffer.from(await bundle.arrayBuffer())
}

function managedFileMatches(file: string, expected: Buffer): boolean {
  try { return readFileSync(file).equals(expected) } catch { return false }
}

const installManagedFile = (mode: string, source: string, target: string) =>
  `sudo install -D -o root -g root -m ${mode} ${quote(source)} ${quote(target)}`

// Writes the managed files to staging and returns the command the owner can run to install them.
export async function stageManaged(paths: PackPaths, staging: string, etc = ETC_CODEX): Promise<{ command: string; existing: boolean }> {
  const bundle = await buildManagedBundle(paths)
  const managedDir = `${etc}/hooks`
  writeAtomic(join(staging, BUNDLE), bundle)
  writeAtomic(join(staging, 'requirements.toml'), managedToml(managedDir))
  copyFileSync(paths.bun, join(staging, MANAGED_BUN))
  writeAtomic(join(staging, MANAGED_BUNFIG), '')
  writeAtomic(join(staging, LAUNCHER), launcherScript(managedDir))
  writeAtomic(join(staging, BRIDGE_UID_FILE), bridgeUidContent())
  const put = (mode: string, name: string, target: string) => installManagedFile(mode, join(staging, name), target)
  const command = [
    put('0644', 'requirements.toml', `${etc}/requirements.toml`),
    put('0644', BUNDLE, `${managedDir}/${BUNDLE}`),
    put('0755', MANAGED_BUN, `${managedDir}/${MANAGED_BUN}`),
    put('0644', MANAGED_BUNFIG, `${managedDir}/${MANAGED_BUNFIG}`),
    put('0755', LAUNCHER, `${managedDir}/${LAUNCHER}`),
    put('0644', BRIDGE_UID_FILE, `${managedDir}/${BRIDGE_UID_FILE}`),
  ].join(' && ')
  return { command, existing: existsSync(`${etc}/requirements.toml`) }
}


export interface SelfTest { ok: boolean; why: string }

interface ProbeRun { code: number | null; stdout: string; stderr: string }

function runProbe(argv: string[], cwd: string, envelope: Json, timeoutMs: number): ProbeRun {
  try {
    const result = Bun.spawnSync(argv, {
      cwd, stdin: Buffer.from(JSON.stringify(envelope)), stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs,
      // These startup overrides must not reach the guard.
      env: { ...process.env, TMPDIR: cwd, BUN_OPTIONS: `--preload=${cwd}/evil.ts`, NODE_OPTIONS: `--require=${cwd}/evil.ts` },
    })
    return { code: result.signalCode ? null : result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch {
    return { code: null, stdout: '', stderr: '' }
  }
}

// Proves the installed PreToolUse hook runs and guards: its exact command (through sh, as a shell
// line, and as argv) is started from a hostile cwd (a bunfig.toml preload, a .env) and must block
// `rm -rf /` the launcher's way (exit 2, a stderr reason after BLOCK_PREFIX, nothing on stdout),
// allow `ls` with exit 0, and load nothing from that cwd. A timeout, a missing executable, another
// exit code or a deny left to JSON on stdout fails. It does not prove that Codex loads
// requirements.toml: only a Codex run shows that.
export function selfTest(etc = ETC_CODEX, timeoutMs = SELF_TEST_TIMEOUT_MS): SelfTest {
  const command = managedCommand(`${etc}/hooks`, 'PreToolUse')
  const hostile = mkdtempSync(join(tmpdir(), 'codex-hooks-selftest-'))
  const marker = join(hostile, 'loaded')
  try {
    writeFileSync(join(hostile, 'evil.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
    writeFileSync(join(hostile, 'bunfig.toml'), 'preload = ["./evil.ts"]\n')
    writeFileSync(join(hostile, '.env'), `TMPDIR=/\nCODEX_HOOKS_CONFIG=${hostile}/off.json\n`)
    const envelope = (shell: string, id: string): Json => ({
      hook_event_name: 'PreToolUse', session_id: 'codex-hooks-self-test', turn_id: id, cwd: hostile,
      tool_name: 'shell', tool_input: { command: shell }, tool_use_id: id,
    })
    for (const argv of [['/bin/sh', '-c', command], [`${etc}/hooks/${LAUNCHER}`, 'PreToolUse']]) {
      const deny = runProbe(argv, hostile, envelope('rm -rf /', 'self-test-deny'), timeoutMs)
      if (deny.code === null) return { ok: false, why: `самопроверка: хук не ответил за ${timeoutMs} мс или не запустился` }
      if (deny.code === 0) return { ok: false, why: 'самопроверка: хук не запретил rm -rf /' }
      if (deny.code !== 2) return { ok: false, why: `самопроверка: хук завершился с кодом ${deny.code}` }
      if (!deny.stderr.startsWith(BLOCK_PREFIX) || !deny.stderr.slice(BLOCK_PREFIX.length).trim() || deny.stdout !== '') {
        return { ok: false, why: 'самопроверка: запрет rm -rf / пришёл не от launcher (нужен код 2 и причина в stderr)' }
      }
      const allow = runProbe(argv, hostile, envelope('ls', 'self-test-allow'), timeoutMs)
      if (allow.code === 2) return { ok: false, why: 'самопроверка: хук запрещает всё, даже ls' }
      if (allow.code !== 0) return { ok: false, why: `самопроверка: хук не пропустил ls (код ${allow.code ?? 'таймаут'})` }
      if (existsSync(marker)) return { ok: false, why: 'самопроверка: хук загрузил код из рабочей папки (bunfig.toml/BUN_OPTIONS)' }
    }
    return { ok: true, why: 'ok' }
  } finally {
    rmSync(hostile, { recursive: true, force: true })
  }
}

const BRIDGE_FIX = 'запустите ./install.sh --hooks под пользователем моста, затем выполните строку sudo install, которую он напечатает'

// Whether <managedDir>/bridge-uid is trusted and names `uid`: the managed pack then runs in full
// scope (hookScope === 'full') for this process. The same check (readBridgeUid) decides the scope
// of every hook run, so the gate, doctor and the installer agree with the hooks.
export function bridgeScope(managedDir: string, trust: OwnerTrust = rootOnly,
  uid: number | undefined = process.getuid?.()): SelfTest {
  const recorded = readBridgeUid(managedDir, trust)
  if (!recorded.ok) return { ok: false, why: `${recorded.why}; ${BRIDGE_FIX}` }
  if (recorded.uid !== uid) {
    return { ok: false, why: `${join(managedDir, BRIDGE_UID_FILE)} называет пользователем моста uid ${recorded.uid}, а не uid ${uid ?? '(нет)'}, поэтому хуки для этого пользователя не работают; ${BRIDGE_FIX}` }
  }
  return { ok: true, why: 'ok' }
}

// The managed guards are active when requirements.toml matches an exact pack template, including
// the pre-Brain template for existing installs. It, the launcher, the bun copy, its bunfig, the bundle and their directories
// are owned by root and not writable by anyone else; bridge-uid is trusted and names the calling
// uid (otherwise the managed pack is safety-only or a no-op for this user); and the live self-test passes.
export function guardsActive(etc = ETC_CODEX, owned: (path: string) => boolean = rootOwned,
  probe: (etc: string) => SelfTest = selfTest, trust: OwnerTrust = rootOnly): { active: boolean; why: string } {
  const toml = `${etc}/requirements.toml`
  const managedDir = `${etc}/hooks`
  let content: string
  try { content = readFileSync(toml, 'utf8') } catch { return { active: false, why: `нет ${toml}` } }
  // Not a substring test: a file can carry our handler text as data and another real handler.
  // The launcher's deadlines are sized for the handler timeout in it (LAUNCHER_BUDGET_S < it).
  if (content !== managedToml(managedDir) && content !== formatManagedToml(managedDir, PACK_EVENTS, false)
    && content !== formatManagedToml(managedDir, PACK_EVENTS, true)) {
    return { active: false, why: `${toml} отличается от файла управляемых хуков пакета (нужны только обработчики пакета с timeout = ${HOOK_TIMEOUT_S}) – перезапусти установщик и строку sudo` }
  }
  for (const file of [toml, ...[BUNDLE, MANAGED_BUN, MANAGED_BUNFIG, LAUNCHER].map(name => `${managedDir}/${name}`), managedDir, etc]) {
    if (!existsSync(file)) return { active: false, why: `нет ${file}` }
    if (!owned(file)) return { active: false, why: `${file} принадлежит не root или доступен на запись не только root` }
  }
  // An older launcher may lack the fail-closed handling this release relies on.
  const launcher = `${managedDir}/${LAUNCHER}`
  if (!managedFileMatches(launcher, Buffer.from(launcherScript(managedDir)))) {
    return { active: false, why: `${launcher}: launcher отличается от текущей версии – перезапусти установщик и строку sudo` }
  }
  const bridge = bridgeScope(managedDir, trust)
  if (!bridge.ok) return { active: false, why: bridge.why }
  const test = probe(etc)
  return test.ok ? { active: true, why: 'ok' } : { active: false, why: test.why }
}

// HookMetadata.source values of Codex 0.172 that come from managed (admin) configuration.
const MANAGED_SOURCES: ReadonlySet<string> = new Set(['system', 'mdm', 'cloudRequirements', 'cloudManagedConfig',
  'legacyManagedConfigFile', 'legacyManagedConfigMdm'])

// The sourcePath values Codex gives a hook loaded from the managed pack: `<etc>/requirements.toml`
// or, as Codex 0.172 reports it, the [hooks].managed_dir `<etc>/hooks`. Exact match after
// normalisation (duplicate and trailing slashes, dot segments); anything else is not ours.
const normalPath = (path: string) => { const out = posix.normalize(path); return out.length > 1 ? out.replace(/\/+$/, '') : out }
export function managedSourcePath(sourcePath: unknown, etc = ETC_CODEX): boolean {
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/')) return false
  const actual = normalPath(sourcePath)
  return actual === normalPath(`${etc}/requirements.toml`) || actual === normalPath(`${etc}/hooks`)
}

// Whether Codex's own listing (app-server hooks/list) shows that it loaded the managed handler for
// every pack event from the managed pack (managedSourcePath) and runs it. Our handler is the one hook
// of the event from there with handlerType "command" and exactly our launcher command; it counts only
// with isManaged === true, enabled === true, trustStatus "managed" and a managed source. Any field
// missing or different fails closed.
export function managedListing(listed: ListedHook[], etc = ETC_CODEX): SelfTest {
  return managedListingForEvents(listed, etc, PACK_EVENTS)
}

function managedListingForEvents(listed: ListedHook[], etc: string, events: readonly HookEvent[]): SelfTest {
  const toml = `${etc}/requirements.toml`
  for (const event of events) {
    const command = managedCommand(`${etc}/hooks`, event)
    const ours = listed.filter(hook => eventKey(hook.eventName) === eventKey(event) && managedSourcePath(hook.sourcePath, etc)
      && hook.handlerType === 'command' && hook.command === command)
    if (ours.length !== 1) return { ok: false, why: `Codex (hooks/list) не показывает управляемый хук ${event} из ${toml} или ${etc}/hooks` }
    const hook = ours[0]!
    if (hook.isManaged !== true || hook.enabled !== true || hook.trustStatus !== 'managed'
      || typeof hook.source !== 'string' || !MANAGED_SOURCES.has(hook.source)) {
      return { ok: false, why: `Codex (hooks/list) показывает хук ${event} не как включённый управляемый` }
    }
  }
  return { ok: true, why: 'ok' }
}

// The gate for full access: the live managed guards (guardsActive: root-owned files and the
// self-test) and Codex's own listing of the managed handlers. A Codex whose app-server does not
// answer hooks/list cannot prove it loaded them: no full access.
export async function fullAccessGuards(etc: string, listHooks: () => Promise<ListedHook[]>,
  guards: (etc: string) => { active: boolean; why: string } = guardsActive): Promise<{ active: boolean; why: string }> {
  const live = guards(etc)
  if (!live.active) return live
  let listed: ListedHook[]
  try {
    listed = await listHooks()
  } catch {
    return { active: false, why: 'Codex App Server не ответил на hooks/list, загрузку управляемых хуков нельзя проверить' }
  }
  const shown = managedListing(listed, etc)
  return shown.ok ? { active: true, why: 'ok' } : { active: false, why: shown.why }
}

const SANDBOX_FLAG =/^[ \t]*(?:export[ \t]+)?KROT_CODEX_SANDBOX[ \t]*=.*(?:\n|$)/gm
const FULL_ACCESS_FLAG = /^[ \t]*(?:export[ \t]+)?KROT_CODEX_SANDBOX[ \t]*=[ \t]*['"]?danger-full-access['"]?[ \t]*(?:\n|$)/gm

// Full access only behind active guards: writes KROT_CODEX_SANDBOX=danger-full-access to the bridge
// env file when `guards` is active. Otherwise a danger-full-access line left by an earlier install
// is removed. True when written.
export function activateFullAccess(envFile: string, guards: { active: boolean }): boolean {
  const content = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  if (!guards.active) {
    const kept = content.replace(FULL_ACCESS_FLAG, '')
    if (kept !== content) writeAtomic(envFile, kept)
    return false
  }
  const kept = content.replace(SANDBOX_FLAG, '')
  writeAtomic(envFile, `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}KROT_CODEX_SANDBOX=danger-full-access\n`)
  return true
}

const lexists = (path: string) => { try { lstatSync(path); return true } catch { return false } }

export function managedCheck(etc = ETC_CODEX, trust: OwnerTrust = rootOnly,
  owned: (path: string) => boolean = rootOwned, probe: (etc: string) => SelfTest = selfTest): Check {
  const managedDir = join(etc, 'hooks')
  const launcher = join(managedDir, LAUNCHER)
  if (existsSync(launcher) && !managedFileMatches(launcher, Buffer.from(launcherScript(managedDir)))) {
    return { status: 'error', blocking: false, message: `${HOOKS_CHECK_PREFIX}: launcher отличается от текущей версии (${launcher}). Запустите ./install.sh --hooks, затем выполните строку sudo install, если установщик её напечатает.` }
  }
  // An installed managed pack whose bridge-uid does not name this user: the bridge gets the
  // safety guard only (or nothing), whatever else is in place.
  let toml = ''
  try { toml = readFileSync(join(etc, 'requirements.toml'), 'utf8') } catch { /* no managed pack */ }
  if (toml.includes(MANAGED_MARK) || lexists(join(managedDir, BRIDGE_UID_FILE))) {
    const bridge = bridgeScope(managedDir, trust)
    if (!bridge.ok) return { status: 'error', blocking: false, message: `${HOOKS_CHECK_PREFIX}: управляемые хуки не узнают пользователя моста: ${bridge.why}.` }
  }
  const guards = guardsActive(etc, owned, probe, trust)
  return guards.active
    ? { status: 'ok', message: `${HOOKS_CHECK_PREFIX}: защита установлена как управляемые хуки в ${etc} (сбой, таймаут или отсутствие bun в PreToolUse блокируют вызов: launcher отвечает кодом 2).` }
    : { status: 'warning', message: `${HOOKS_CHECK_PREFIX}: управляемые хуки не активны (${guards.why}). Запустите ./install.sh --hooks и выполните строку sudo install, которую он напечатает.` }
}

export function defaultPaths(env: Record<string, string | undefined>): PackPaths {
  const home = invokingHome(env)
  return {
    codexHome: env.CODEX_HOME || join(home, '.codex'),
    configFile: env.CODEX_HOOKS_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'krotov-plugin', 'codex-hooks.json'),
    bun: process.execPath,
    main: join(import.meta.dir, 'main.ts'),
  }
}

export async function installHookPack(paths: PackPaths, listHooks: () => Promise<ListedHook[]>,
  { etc = ETC_CODEX, trustedOwner = rootOnly,
    inspectGuards = (dir: string): { active: boolean; why: string } => guardsActive(dir, rootOwned, selfTest, trustedOwner),
    report = console.log } = {}): Promise<{ active: boolean; why: string }> {
  const live = inspectGuards(etc)
  const guards = live.active ? await fullAccessGuards(etc, listHooks, () => live) : live
  if (guards.active) {
    // The managed copy runs: a user-level copy would run every hook twice.
    uninstallHooks(paths, undefined)
    report(`Защита работает как управляемые хуки в ${etc}; пользовательские хуки пакета убраны из hooks.json.`)
  } else if (live.active) {
    // Installed root-owned, but Codex does not show it: the user-level hooks keep guarding.
    const result = installHooks(paths)
    report(`Управляемые хуки в ${etc} установлены, но ${guards.why}. Хуки Codex остаются в ${result.hooksFile}. Проверьте версию Codex и повторите ./install.sh --hooks.`)
  } else {
    const result = installHooks(paths)
    report(`Хуки Codex записаны в ${result.hooksFile}.`)
    if (result.configWritten) report(`Создан файл переключателей хуков ${paths.configFile} (все включены). Удалённые MCP-хуки заработают, когда вы впишете туда agent и адреса серверов gbrain.`)
  }
  const staging = join(paths.codexHome, 'managed-hooks')
  let pending = guards
  if (live.active) {
    const managedDir = join(etc, 'hooks')
    const current = [
      { name: BUNDLE, mode: '0644', content: await buildManagedBundle(paths) },
      { name: LAUNCHER, mode: '0755', content: Buffer.from(launcherScript(managedDir)) },
      { name: BRIDGE_UID_FILE, mode: '0644', content: Buffer.from(bridgeUidContent()) },
    ]
    const commands = current.flatMap(({ name, mode, content }) => {
      const target = join(managedDir, name)
      // bridge-uid with the right bytes but a wrong owner, mode or file type is not trusted by
      // the hooks: restage it so the sudo line reinstalls it root-owned.
      const valid = name !== BRIDGE_UID_FILE || bridgeScope(managedDir, trustedOwner).ok
      if (valid && managedFileMatches(target, content)) return []
      const source = join(staging, name)
      writeAtomic(source, content)
      return [installManagedFile(mode, source, target)]
    })
    const requirements = join(etc, 'requirements.toml')
    const content = Buffer.from(managedToml(managedDir))
    if (!managedFileMatches(requirements, content)) {
      const source = join(staging, 'requirements.toml')
      writeAtomic(source, content)
      const command = installManagedFile('0644', source, requirements)
      if (!commands.length) {
        report('Чтобы включить Brain PreCompact, выполните одну команду от root:')
        report(command)
        return guards
      }
      commands.push(command)
    }
    if (!commands.length) return guards
    const stale = `управляемый пакет в ${etc} отличается от текущей версии`
    report(`Обновите защиту от root одной командой: ${stale}.`)
    report(commands.join(' && '))
    pending = { active: false, why: stale }
  } else {
    const staged = await stageManaged(paths, staging, etc)
    report('Чтобы агент не мог отключить защиту, установите её от root одной командой:')
    report(staged.command)
    if (staged.existing) report(`Внимание: ${etc}/requirements.toml уже есть, команда его заменит. Если там ваши настройки, перенесите их в новый файл.`)
  }
  report('Потом снова запустите ./install.sh --hooks: полный доступ агенту включится только после этого.')
  return pending
}

if (import.meta.main) {
  const paths = defaultPaths(process.env)
  const flag = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
  const envFile = flag('--env-file') ?? join(import.meta.dir, '..', '..', 'plugin', '.env')
  if (process.argv.includes('--uninstall')) {
    const result = uninstallHooks(paths, envFile)
    console.log(`Хуки Codex удалены из ${result.hooksFile}; остальные хуки на месте.`)
    if (result.envChanged) console.log(`KROT_CODEX_HOOKS и полный доступ убраны из ${envFile}. Перезапустите мост: он перестанет проверять хуки и будет работать в песочнице workspace-write.`)
    if (existsSync(`${ETC_CODEX}/requirements.toml`)) console.log(`Управляемые хуки в ${ETC_CODEX} удаляет владелец: sudo rm ${[BUNDLE, MANAGED_BUN, MANAGED_BUNFIG, LAUNCHER, BRIDGE_UID_FILE].map(name => `${ETC_CODEX}/hooks/${name}`).join(' ')} и наш блок в ${ETC_CODEX}/requirements.toml.`)
  } else {
    // Codex's own listing proves it loaded the managed handlers; the bridge's app-server client
    // asks it (loaded lazily: plugin/scripts/doctor.ts imports this module too).
    const codexHooks = async () => (await import('../../plugin/scripts/doctor.js')).listHooksViaAppServer(process.env, invokingHome(process.env))
    const guards = await installHookPack(paths, codexHooks)
    if (process.argv.includes('--full-access')) {
      console.log(activateFullAccess(envFile, guards)
        ? `Полный доступ (KROT_CODEX_SANDBOX=danger-full-access) записан в ${envFile}: защита активна.`
        : `Полный доступ не включён: ${guards.why}. Агент работает в песочнице, пока защита не установлена.`)
    }
  }
}
