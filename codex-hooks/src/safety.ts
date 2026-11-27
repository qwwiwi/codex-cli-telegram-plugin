// Hook 4 (PreToolUse): the safety guard. Blocks destructive shell commands and printing secret
// files to the model, and plans the snapshot (snapshot.ts) a recognised deletion or overwrite needs
// before it may run. Fails closed: dispatch.ts turns any exception here into a deny.
import type { CleanModel, Plan } from './snapshot.js'
import { basename, guardedMention, normalizePath, program, readCommand, resolveDir, resolvePathWord, SHELLS, stripHeredocs, viaXargs, type Reading, type SimpleCommand, type Word } from './shell.js'

export interface SafetyView {
  cwd: string
  // Expands ~ and $HOME in cd and git -C targets; the home directory is never deleted.
  home?: string
  codexHome?: string
  // The checked-out branch of the repository at `dir`, or undefined outside a repository.
  branchOf: (dir: string) => string | undefined
  // Probes for the deletion rule. A missing probe or an undefined answer is the unsafe answer.
  exists?: (path: string) => boolean
  isDir?: (path: string) => boolean
  dirty?: (dir: string) => boolean | undefined
  // The path with symlinked ancestors resolved; with `keepLast` the last segment stays as written
  // (rm removes a link, not its target). Missing: the lexical path.
  realpath?: (path: string, keepLast: boolean) => string
  toplevelOf?: (dir: string) => string | undefined
  readFile?: (path: string) => string | undefined
  // Scratch temp directories (default /tmp and /var/tmp): deleting below them needs no snapshot.
  tmpDirs?: string[]
  now?: () => number
}

const PREFIX = 'Заблокировано защитой: '
const MAIN = new Set(['main', 'master'])
const FETCHERS = new Set(['curl', 'wget', 'fetch'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', ''])
const ESCALATION = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0'])
const BUSYBOX_DENY = new Set(['sh', 'ash', 'hush', 'bash', 'su', 'dd', 'mkfs', 'fdisk', 'init', 'reboot', 'poweroff', 'halt'])
const SYSTEM = ['/usr', '/etc', '/var', '/opt', '/boot', '/lib', '/lib64', '/bin', '/sbin', '/root', '/home', '/srv', '/proc', '/sys', '/dev', '/snap']
const SCRATCH_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'target', '__pycache__', '.venv'])
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'sqlcmd', 'clickhouse-client', 'cockroach', 'supabase'])
const ENV_DUMP = 'печать переменных окружения покажет ключи. Проверяй наличие переменной без вывода значения.'
const OWNER_INSTRUCTIONS = 'AGENTS.md меняет только владелец. Предложи правку владельцу.'
const AGENTS_FILES = ['AGENTS.md', 'AGENTS.override.md']

export function isSecretPath(path: string): boolean {
  const name = basename(path)
  if (/^\.env(?:\.[\w.-]+)?$/.test(name) && !/\.(?:example|sample|template|dist)$/.test(name)) return true
  if (/\.(?:key|pem)$/.test(name) || /^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(name) || name === 'gbrain.env') return true
  return /(?:^|\/)\.?secrets\//.test(path) || path.startsWith('~/.secrets')
}

// True when a glob such as `.env*` or `.e?v` can match a .env file (a glob that does not start
// with a dot never matches a dotfile in the shell).
function globHitsEnv(arg: string): boolean {
  if (!/[*?[]/.test(arg)) return false
  const name = basename(arg)
  if (!name.startsWith('.')) return false
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  return ['.env', '.env.local', '.env.production'].some(candidate => pattern.test(candidate))
}

function flags(args: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const arg of args) {
    if (arg === '--') break
    if (arg.startsWith('--')) set.add(arg)
    else if (/^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) set.add(letter)
  }
  return set
}

function stamp(view: SafetyView): string {
  return new Date(view.now?.() ?? Date.now()).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
}

// A target word as an absolute path. A glob stands for the directory its literal prefix names
// (`glob: true`); a variable cannot be resolved (undefined).
function targetOf(word: Word, cwd: string, home: string): { path: string; glob: boolean } | undefined {
  if (word.variable) return
  const expanded = resolveDir(word.text, cwd, home)
  // Brace expansion ({a,b}, {1..3}) names several paths: treated like a glob.
  const wild = expanded.search(/[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/)
  if (wild < 0) return { path: normalizePath(expanded), glob: false }
  const prefix = expanded.slice(0, wild)
  return { path: normalizePath(prefix.slice(0, prefix.lastIndexOf('/') + 1) || '/'), glob: true }
}

const under = (path: string, root: string) => path.startsWith(`${root.replace(/\/$/, '')}/`)

function tmpRoots(view: SafetyView): string[] {
  const home = view.home ? normalizePath(view.home) : undefined
  return [...(view.tmpDirs ?? ['/tmp', '/var/tmp']), ...(home ? [`${home}/.cache`] : [])].filter(Boolean).map(normalizePath)
}

// ~/.trash holds the snapshots: the agent never deletes, overwrites or moves anything out of it.
function inTrash(path: string, view: SafetyView): boolean {
  const trash = `${normalizePath(view.home ?? '/nonexistent')}/.trash`
  return path === trash || under(path, trash)
}

const TRASH = 'корзина ~/.trash хранит снимки удалённого, её не удаляют и не перезаписывают. Её чистит таймер.'

const real = (view: SafetyView, path: string, keepLast: boolean) => view.realpath ? normalizePath(view.realpath(path, keepLast)) : path

// The root, the home directory or one of its parents, the working directory or one of its
// parents, a top-level or system directory: never deleted, backup or not.
// `contents`: only what is inside `path` goes (a glob, find), so the working directory itself stays.
function catastrophic(path: string, view: SafetyView, cwd: string, contents: boolean): boolean {
  if (path === '/' || /^\/[^/]+$/.test(path) || /^\/home\/[^/]+$/.test(path)) return true
  const home = view.home ? normalizePath(view.home) : undefined
  if (home && (path === home || under(home, path))) return true
  const dir = normalizePath(cwd)
  if (!contents && (dir === path || under(dir, path))) return true
  if (tmpRoots(view).some(root => under(path, root))) return false
  return SYSTEM.some(prefix => prefix !== '/home' && (path === prefix || under(path, prefix)))
}

function scratch(path: string, view: SafetyView): boolean {
  if (tmpRoots(view).some(root => under(path, root))) return true
  return path.split('/').some(segment => SCRATCH_DIRS.has(segment))
}

// The deny reason for destroying `words` (relative to `cwd`), or undefined with a snapshot plan of
// `kind` pushed for every target that is not scratch.
function deletionReason(words: Word[], cwd: string, view: SafetyView, plans: Plan[], kind: 'link' | 'copy'): string | undefined {
  const home = view.home ?? ''
  for (const word of words) {
    const unbounded = unboundedReason(word)
    if (unbounded) return unbounded
    const target = targetOf(word, cwd, home)
    if (!target) return `путь удаления из переменной (${word.text}) не проверить. Укажи конкретный путь.`
    // rm removes a link itself, but `link/` and `link/.` (and in-place writers) reach its target.
    const keepLast = kind === 'link' && !target.glob && !/\/\.?$/.test(word.text)
    const path = real(view, target.path, keepLast)
    if (catastrophic(target.path, view, cwd, target.glob) || catastrophic(path, view, cwd, target.glob)) {
      return `удаление корня, домашней папки, рабочей папки или системного каталога (${target.path}). Укажи конкретный вложенный путь.`
    }
    if (inTrash(path, view)) return TRASH
    if (scratch(target.glob ? `${path}/x` : path, view)) continue
    plans.push({ kind, path })
  }
  return
}

// Why a target word cannot be bounded to the snapshot of its literal prefix, or undefined: a glob
// followed by `..` climbs out of that prefix, `~user` names another home.
function unboundedReason(word: Word): string | undefined {
  const text = word.text
  const wild = text.search(/[*?[{]/)
  if (wild >= 0 && /(?:^|\/)\.\.(?:\/|$)/.test(text.slice(wild))) return `шаблон с .. после * (${text}) выходит за пределы снимка. Укажи конкретный путь.`
  if (word.tilde && /^~[^/]/.test(text)) return `путь ${text} указывает на чужую домашнюю папку. Укажи конкретный путь.`
  return
}

// Positional arguments after `skip` value-taking options; everything after `--` is positional.
function operands(words: Word[], valueOptions: ReadonlySet<string> = new Set()): Word[] {
  const out: Word[] = []
  let literal = false
  for (let i = 0; i < words.length; i++) {
    const text = words[i]?.text ?? ''
    if (!literal && text === '--') { literal = true; continue }
    if (!literal && text.startsWith('-') && text !== '-') { if (valueOptions.has(text)) i++; continue }
    const word = words[i]
    if (word) out.push(word)
  }
  return out
}

function codexHomeOf(view: SafetyView): string {
  const home = view.home ?? ''
  const dir = view.codexHome || (home ? `${home}/.codex` : '')
  return dir ? resolveDir(dir, view.cwd, home) : ''
}

// Compare both directory entries and referents. Keep `..` until after resolving symlinks.
function ownerTargets(view: SafetyView) {
  const codexHome = codexHomeOf(view)
  const variants = (path: string) => view.realpath ? [real(view, path, true), real(view, path, false)] : [normalizePath(path)]
  const files = codexHome ? AGENTS_FILES.flatMap(name => variants(`${codexHome}/${name}`)) : []
  return (word: Word, cwd: string, mode: 'file' | 'literal' | 'tree' | 'delete' = 'file'): boolean => {
    if (!files.length) return false
    if (word.variable && !/^\$(?:HOME|CODEX_HOME|\{(?:HOME|CODEX_HOME)\})(?=\/|$)/.test(word.text)) return false
    const path = resolvePathWord(word, cwd, view.home ?? '', codexHome)
    const recursive = mode === 'tree' || mode === 'delete'
    const wild = mode === 'literal' || word.glob === false ? -1 : path.search(/[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/)
    if (wild >= 0) {
      const slash = path.lastIndexOf('/', wild)
      const parent = path.slice(0, slash) || '/'
      return variants(parent).some(dir => {
        const glob = new Bun.Glob(`${dir.replace(/\/$/, '')}/${path.slice(slash + 1)}`)
        return files.some(file => glob.match(file) || (recursive && glob.match(file.slice(0, file.lastIndexOf('/')))))
      })
    }
    return variants(path).some(candidate => files.includes(candidate) || (recursive
      // The deletion guard supplies its own reason for catastrophic targets.
      && (mode !== 'delete' || !catastrophic(candidate, view, cwd, true))
      && files.some(file => under(file, candidate))))
  }
}

const literalWord = (text: string): Word => ({ text, variable: false, tilde: text.startsWith('~') })
type OwnerTarget = ReturnType<typeof ownerTargets>

function mentionedPaths(text: string): string[] {
  return [...Array.from(text.matchAll(/(['"`])([^'"`\n]+)\1/g), match => match[2] ?? ''),
    ...(text.match(/(?:\$\{(?:CODEX_HOME|HOME)\}|[\w./~$*?{}[\]-])+/g) ?? [])]
}

function mentionsOwnerPath(text: string, cwd: string, hits: OwnerTarget): boolean {
  const paths = mentionedPaths(text)
  const matches = (path: string) => hits({ ...literalWord(path), variable: path.startsWith('$') }, cwd)
  if (paths.some(matches)) return true
  // Inline code can join a literal directory or an environment lookup to a separate filename.
  const homeLookup = /\b(?:HOME|home|homedir|expanduser)\b/.test(text)
  return AGENTS_FILES.some(name => paths.includes(name) && paths.some(path => {
    if (path === 'CODEX_HOME') return matches(`$CODEX_HOME/${name}`)
    const file = `${path.replace(/\/$/, '')}/${name}`
    return matches(file) || (homeLookup && matches(`$HOME/${file.replace(/^\/+/, '')}`))
  }))
}

const TRANSFER_OPTIONS = new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group'])

function ownerTransfer(name: string, words: Word[], cwd: string, view: SafetyView, hits: OwnerTarget): boolean {
  const end = words.findIndex(word => word.text === '--')
  const options = words.slice(0, end < 0 ? undefined : end)
  const option = options.findIndex(word => /^(?:-t|--target-directory=|--target-directory$)/.test(word.text))
  const targetOption = options[option]
  const explicitDir = targetOption && (/^(?:-t|--target-directory)$/.test(targetOption.text)
    ? options[option + 1]
    : { ...targetOption, text: targetOption.text.replace(/^(?:-t|--target-directory=)/, '') })
  const ops = operands(words, TRANSFER_OPTIONS)
  const implicitDir = name === 'ln' && ops.length === 1
  const dest = explicitDir ?? (implicitDir ? literalWord('.') : ops.at(-1))
  const sources = explicitDir || implicitDir ? ops : ops.slice(0, -1)
  if (!dest || !sources.length) return false
  const set = flags(options.map(word => word.text))
  if ((name === 'mv' || (name === 'ln' && !set.has('s') && !set.has('--symbolic')))
    && sources.some(source => hits(source, cwd, name === 'mv' ? 'tree' : 'file'))) return true
  if (hits(dest, cwd)) return true
  if (set.has('T') || set.has('--no-target-directory')) return false
  const codexHome = codexHomeOf(view)
  const directory = real(view, resolveDir(dest.text, cwd, view.home ?? '', codexHome), false)
  if (!explicitDir && !implicitDir && !dest.text.endsWith('/') && !view.isDir?.(directory)
    && (!codexHome || directory !== real(view, codexHome, false))) return false
  const { glob: destGlob, ...destination } = dest
  return sources.some(source => {
    const glob = destGlob || source.glob
    return hits({ ...destination, ...(glob === undefined ? {} : { glob }),
      text: `${dest.text.replace(/\/$/, '')}/${basename(source.text.replace(/\/+$/, ''))}` }, cwd)
  })
}

const OWNER_OPERANDS = new Set(['tee', 'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'chmod', 'chown', 'chgrp', 'touch'])
const OWNER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  truncate: new Set(['-s', '-r', '--size', '--reference']),
  shred: new Set(['-n', '-s', '--iterations', '--size']),
  chmod: new Set(['--reference']), chown: new Set(['--reference', '--from']), chgrp: new Set(['--reference']),
  touch: new Set(['-r', '--reference', '-d', '--date', '-t']),
}

function ownerCommandReason(command: SimpleCommand, line: string, view: SafetyView, hits: OwnerTarget): string | undefined {
  if (command.writes.some(write => command.shellCwds.some(cwd => hits(write.word, cwd)))) return OWNER_INSTRUCTIONS
  const args = program(command.argv)
  const name = basename(args[0] ?? '')
  const words = command.words.slice(command.argv.length - args.length + 1)
  const end = words.findIndex(word => word.text === '--')
  const options = words.slice(0, end < 0 ? undefined : end).map(word => word.text)
  const inline = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|bun)$/.test(name)
    && options.some(arg => /^-(?:c|e|p)|^--(?:eval|print)(?:=|$)/.test(arg))
  const inPlace = (name === 'sed' && options.some(arg => /^-[nEruszi]*i|^--in-place(?:=|$)/.test(arg)))
    || (name === 'perl' && options.some(arg => /^-[nplawWXtTU]*i/.test(arg)))
  const recursivePermissions = ['chmod', 'chown', 'chgrp'].includes(name)
    && options.some(arg => /^-[A-Za-z]*R[A-Za-z]*$/.test(arg) || arg === '--recursive')
  const targetMode = name === 'rm' || name === 'rmdir' ? 'delete' : recursivePermissions ? 'tree' : 'file'
  for (const cwd of command.cwds) {
    if (inline && words.some(word => mentionsOwnerPath(word.text, cwd, hits))) {
      return `${OWNER_INSTRUCTIONS} ${unparsedHint(`${name}: код интерпретатора`, 'путь к AGENTS.md')}`
    }
    if (['cp', 'mv', 'ln', 'install'].includes(name) && ownerTransfer(name, words, cwd, view, hits)) return OWNER_INSTRUCTIONS
    if ((inPlace || OWNER_OPERANDS.has(name))
      && operands(words, OWNER_VALUE_OPTIONS[name]).some(word => hits(word, cwd, targetMode))) return OWNER_INSTRUCTIONS
    if (name === 'dd' && words.some(word => word.text.startsWith('of=') && hits({ ...word, text: word.text.slice(3) }, cwd))) return OWNER_INSTRUCTIONS
    if (name === 'apply_patch' && (words.some(word => patchHitsOwner(word.text, cwd, hits))
      || (command.stdinRedirect && patchHitsOwner(line, cwd, hits)))) return OWNER_INSTRUCTIONS
  }
  return
}

const OWNER_READERS = new Set(['cat', 'grep', 'ls'])
const hasPipe = (reading: Reading) => reading.commands.some(command => command.joinedBy === '|' || command.joinedBy === '|&')

function ownerEvidence(command: SimpleCommand, words = command.raw): string {
  return [words, ...command.reads.map(word => word.text), ...command.writes.map(write => write.word.text)].join(' ')
}

// A literal shell script can contribute the paths it actually uses, without combining a reader's
// arguments with a later command. Preserve the mention fallback for pipelines and opaque scripts.
function mentionsOwnerOutsideShellReads(line: string, reading: Reading, view: SafetyView, hits: OwnerTarget): boolean {
  const mentionsOwner = mentionsOwnerPath(line, view.cwd, hits)
  if (!reading.literalShellScriptsOnly || hasPipe(reading)) return mentionsOwner
  const mentionsHome = mentionsOwner || mentionedPaths(line).some(path => {
    const file = `${path.replace(/\/$/, '')}/AGENTS.md`
    return hits({ ...literalWord(file), variable: path.startsWith('$') }, view.cwd, 'literal')
  })
  if (!mentionsHome) return false
  const home = view.home ?? ''
  const codexHome = codexHomeOf(view)
  const evidence: string[] = []
  let hasReader = false
  for (const command of reading.commands) {
    const script = command.literalShellScript
    if (script === undefined) { evidence.push(ownerEvidence(command)); continue }
    for (const cwd of command.cwds) {
      const nested = readCommand(script, cwd, home, codexHome, command.unresolvedCwd)
      const opaque = nested.unparsed || hasPipe(nested)
      if (opaque && mentionsOwner) return true
      // A directory mention still matters when a write's path cannot be resolved.
      if (nested.commands.some(inner => ownerCommandReason(inner, script, view, (word, dir, mode) => {
        if (hits(word, dir, mode)) return true
        const path = resolvePathWord(word, '.', home, codexHome)
        return (word.variable && path.includes('$')) || (inner.unresolvedCwd === true && !path.startsWith('/'))
      }))) return true
      if (opaque) continue
      const paths = nested.commands.map(inner => {
        if (!OWNER_READERS.has(inner.argv[0] ?? '')) return ownerEvidence(inner)
        hasReader = true
        return inner.writes.map(write => write.word.text).join(' ')
      }).join('\n')
      if (mentionsOwnerPath(paths, cwd, hits)) return true
      evidence.push(ownerEvidence(command, paths))
    }
  }
  return mentionsOwner && (!hasReader || mentionsOwnerPath(evidence.join('\n'), view.cwd, hits))
}

function findReason(words: Word[], cwd: string, view: SafetyView, plans: Plan[]): string | undefined {
  const args = words.map(word => word.text)
  const exec = args.findIndex(arg => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))
  const tool = basename(args[exec + 1] ?? '')
  const viaExec = exec >= 0 && ['rm', 'rmdir', 'unlink', 'shred', 'truncate'].includes(tool)
  if (!args.includes('-delete') && !viaExec) return
  // shred and truncate destroy in place: a hardlink would be destroyed too.
  const kind = viaExec && (tool === 'shred' || tool === 'truncate') ? 'copy' : 'link'
  const end = args.findIndex((arg, index) => index > 0 && /^[-(!]/.test(arg))
  // find deletes what is inside its start directories: read each as `<dir>/*`.
  const starts = words.slice(1, end < 0 ? undefined : end)
  const contents = (starts.length ? starts : [{ text: '.', variable: false, tilde: false }])
    .map(word => ({ ...word, text: `${word.text.replace(/\/+$/, '')}/*` }))
  const reason = deletionReason(contents, cwd, view, plans, kind)
  if (reason || !viaExec) return reason
  // Literal operands of the -exec program (not {}) are destroyed too, relative to find's directory;
  // under -execdir they are relative to every match, which the guard cannot bound.
  const close = args.findIndex((arg, index) => index > exec + 1 && (arg === ';' || arg === '+'))
  const values = tool === 'shred' ? new Set(['-n', '-s', '--iterations', '--size']) : tool === 'truncate' ? new Set(['-s', '-r', '--size', '--reference']) : undefined
  const explicit = operands(words.slice(exec + 2, close < 0 ? undefined : close), values).filter(word => !word.text.includes('{}'))
  if (!explicit.length) return
  if (args[exec] === '-execdir' || args[exec] === '-okdir') return `find ${args[exec]} ${tool} с явным путём (${explicit[0]?.text}) удаляет его в папке каждой находки, это не проверить. Укажи путь через -exec или удали его отдельно.`
  return deletionReason(explicit, cwd, view, plans, kind)
}

// Global git options that take a separate value.
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'])
const GIT_ENV_ASSIGNMENT = /^GIT_\w*\+?=/
const GIT_ENV_EXPORT = /^GIT_\w*(?:\+?=|$)/

export function gitArgs(args: string[], cwd: string, home: string): { sub: string | undefined; rest: string[]; dir: string; options: string[] } {
  let i = 1
  let dir = cwd
  const options: string[] = []
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const option = args[i] ?? ''
    if (option === '-C') { dir = resolveDir(args[i + 1] ?? '.', dir, home); i += 2; continue }
    if (GIT_VALUE_OPTIONS.has(option)) { options.push(option, args[i + 1] ?? ''); i += 2; continue }
    options.push(option)
    i++
  }
  return { sub: args[i], rest: args.slice(i + 1), dir, options }
}

function gitReason(args: string[], cwd: string, view: SafetyView, plans: Plan[], gitEnvChanged: boolean): string | undefined {
  const { sub, rest, dir, options } = gitArgs(args, cwd, view.home ?? '')
  if (options.some((option, index) => /^(?:alias\.|--config-env=alias\.)/i.test(option) && (options[index - 1] === '-c' || option.startsWith('--config-env')))
    || options.some((option, index) => option === '--config-env' && /^alias\./i.test(options[index + 1] ?? ''))) {
    return 'git -c alias.* подменяет команду git. Вызови нужную команду git напрямую.'
  }
  if (sub === 'push') {
    const set = flags(rest)
    if (set.has('f') || set.has('--force') || [...set].some(flag => flag.startsWith('--force-with-lease') || flag === '--force-if-includes')
      || rest.some(arg => /^\+/.test(arg))) {
      return 'принудительный push (--force / -f / +refspec) переписывает историю на сервере. Сделай обычный push или новую ветку.'
    }
    if (set.has('d') || set.has('--delete') || set.has('--mirror') || set.has('--prune') || rest.some(arg => /^:[^:]/.test(arg))) {
      return 'удаление ветки на удалённом репозитории. Это делает только владелец.'
    }
  }
  if (sub === 'filter-branch' || sub === 'filter-repo' || (sub === 'reflog' && rest[0] === 'expire')) {
    return 'переписывание истории git. Это делает только владелец.'
  }
  const branch = sub === 'reset' || sub === 'rebase' ? view.branchOf(dir) : undefined
  if (sub === 'reset' && rest.includes('--hard') && branch && MAIN.has(branch)) {
    return `git reset --hard на ветке ${branch} стирает работу. Создай ветку или спроси владельца.`
  }
  if (sub === 'rebase' && branch && MAIN.has(branch)) {
    return `rebase на ветке ${branch} переписывает историю. Работай в отдельной ветке.`
  }
  // Commands that throw away uncommitted work: the hook keeps that work as refs/backup/<stamp>.
  const discards = (sub === 'reset' && rest.includes('--hard'))
    || (sub === 'checkout' && (rest.includes('--') || rest.includes('.')) && !rest.some(arg => /^-[bB]$/.test(arg)))
    || (sub === 'restore' && !(rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')))
  if (sub === 'reset' && rest.includes('--hard')) {
    // A hard reset also replaces untracked files at the paths its target tracks: they are
    // snapshotted too, so the target must be one plain revision.
    const end = rest.indexOf('--')
    const revisions = (end >= 0 ? rest.slice(0, end) : rest).filter(arg => !arg.startsWith('-'))
    if (revisions.length > 1 || (end >= 0 && end < rest.length - 1)) {
      return 'git reset --hard с несколькими целями или путями нельзя проверить. Укажи одну ревизию.'
    }
    plans.push({ kind: 'stash', dir, target: revisions[0] ?? 'HEAD' })
  } else if (discards) plans.push({ kind: 'stash', dir })
  if (sub === 'clean') {
    // The snapshot comes from a dry run built only from this parsed model (cleanPreviewArgs), so
    // a word the parser does not know is a deny, never forwarded.
    const clean = parseClean(rest)
    if (typeof clean === 'string') return clean
    // Repository config can allow deletion without -f (clean.requireForce=false).
    if (!clean.dryRun) {
      if (options.length) return 'git clean: перед clean разрешён только -C <папка>.'
      if (gitEnvChanged) return 'git clean: переменные GIT_* меняют окружение. Запусти без них.'
      const { dryRun: _dryRun, ...model } = clean
      plans.push({ kind: 'clean', dir, model })
    }
  }
  if (sub === 'branch') {
    const set = flags(rest)
    if (set.has('D') || ((set.has('d') || set.has('--delete')) && (set.has('f') || set.has('--force')))) {
      const names = operands(rest.map(text => ({ text, variable: false, tilde: false }))).map(item => item.text)
      if (!names.length) return 'удаление ветки без имени ветки. Укажи ветку явно.'
      for (const name of names) plans.push({ kind: 'branch', dir, name })
    }
  }
  return
}

const CLEAN_DENY = 'git clean: параметр «%» не проверить. Пиши параметры полностью и только эти: -f/--force, -d, -x, -X, -q/--quiet, -n/--dry-run, -e/--exclude <шаблон>; пути после --.'

// git clean's arguments read with a strict allowlist, the way git's parse-options reads them:
// options and paths may mix, the first `--` that is not an option's value ends the options, and
// -e/--exclude without an attached value takes the next word whatever it is (`--` too). Anything
// else that looks like an option is a deny reason: an abbreviation (`--qui`), a negation
// (`--no-dry-run`), -i, an unknown or a valueless option.
function parseClean(rest: string[]): (CleanModel & { dryRun: boolean }) | string {
  const model = { force: 0, dirs: false, ignored: false, onlyIgnored: false, excludes: [] as string[], paths: [] as string[], dryRun: false }
  const deny = (word: string) => CLEAN_DENY.replace('%', word)
  let index = 0
  // The value of -e/--exclude: the attached text, else the next word.
  const value = (attached: string): string | undefined => {
    if (attached !== '') return attached
    index++
    return rest[index]
  }
  for (; index < rest.length; index++) {
    const word = rest[index] ?? ''
    if (word === '--') { model.paths.push(...rest.slice(index + 1)); break }
    if (!word.startsWith('-')) { model.paths.push(word); continue }
    if (word.startsWith('--')) {
      if (word === '--force') model.force++
      else if (word === '--quiet') continue
      else if (word === '--dry-run') model.dryRun = true
      else if (word === '--exclude' || word.startsWith('--exclude=')) {
        const pattern = word === '--exclude' ? value('') : word.slice('--exclude='.length)
        if (pattern === undefined) return deny(word)
        model.excludes.push(pattern)
      } else return deny(word)
      continue
    }
    if (word === '-') return deny(word)
    for (let at = 1; at < word.length; at++) {
      const letter = word[at]
      if (letter === 'f') model.force++
      else if (letter === 'd') model.dirs = true
      else if (letter === 'x') model.ignored = true
      else if (letter === 'X') model.onlyIgnored = true
      else if (letter === 'n') model.dryRun = true
      else if (letter === 'q') continue
      else if (letter === 'e') {
        const pattern = value(word.slice(at + 1))
        if (pattern === undefined) return deny(word)
        model.excludes.push(pattern)
        break
      } else return deny(word)
    }
  }
  return model
}

function ghReason(args: string[]): string | undefined {
  if (args[1] !== 'api') return
  const method = args.findIndex(arg => arg === '-X' || arg === '--method')
  const verb = method >= 0 ? args[method + 1] : args.find(arg => /^(?:-X|--method=)/.test(arg))?.replace(/^(?:-X|--method=)/, '')
  if (verb?.toUpperCase() === 'DELETE' && args.some(arg => /git\/refs\//.test(arg))) {
    return 'удаление ветки на GitHub через API. Это делает только владелец.'
  }
  return
}

// DROP/TRUNCATE anywhere, or a DELETE whose statement has no WHERE.
function destructiveSql(sql: string): boolean {
  if (/\b(?:drop\s+(?:table|database|schema)|truncate)\b/i.test(sql)) return true
  for (const match of sql.matchAll(/\bdelete\s+from\b/gi)) {
    const statement = sql.slice(match.index ?? 0).split(';')[0] ?? ''
    if (!/\bwhere\b/i.test(statement)) return true
  }
  return false
}

const dropSql = (sql: string) => /\b(?:drop\s+(?:table|database|schema)|truncate)\b/i.test(sql)

interface DbCall { hosts: string[]; viaVariable: boolean; database: string | undefined; sql: string; files: Word[] }

function dbCall(command: SimpleCommand, args: string[], words: Word[], line: string): DbCall {
  const hosts: string[] = []
  let database: string | undefined
  const files: Word[] = [...command.reads]
  const sql: string[] = []
  const name = basename(args[0] ?? '')
  for (const assignment of command.argv.slice(0, command.argv.length - args.length)) {
    const match = /^(?:PGHOST|MYSQL_HOST)=(.*)$/.exec(assignment)
    if (match) hosts.push(match[1] ?? '')
    const db = /^PGDATABASE=(.*)$/.exec(assignment)
    if (db) database = db[1]
  }
  const positional: string[] = []
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? ''
    const next = args[i + 1] ?? ''
    if (arg === '-h' || arg === '--host') { hosts.push(next); i++; continue }
    if (/^-h./.test(arg)) { hosts.push(arg.slice(2)); continue }
    if (arg.startsWith('--host=')) { hosts.push(arg.slice(7)); continue }
    if (arg === '-d' || arg === '--dbname' || (arg === '-D' && name !== 'psql') || arg === '--database') { database = next; i++; continue }
    if (/^--(?:dbname|database)=/.test(arg)) { database = arg.slice(arg.indexOf('=') + 1); continue }
    if (arg === '-c' || arg === '--command' || arg === '-e' || arg === '--execute' || arg === '--eval') { sql.push(next); i++; continue }
    // The attached forms: -cSQL, -eSQL, --command=SQL, --execute=SQL, --eval=SQL.
    if (/^-[ce]./.test(arg)) { sql.push(arg.slice(2)); continue }
    if (/^--(?:command|execute|eval)=/.test(arg)) { sql.push(arg.slice(arg.indexOf('=') + 1)); continue }
    if (arg === '-f' || arg === '--file') { const word = words[i + 1]; if (word) files.push(word); i++; continue }
    if (/^--file=/.test(arg)) { files.push({ text: arg.slice(7), variable: words[i]?.variable ?? false, tilde: false }); continue }
    if (/^-[UpPW]$|^--(?:user|port|username)$/.test(arg)) { i++; continue }
    if (arg.startsWith('-')) continue
    positional.push(arg)
    for (const match of arg.matchAll(/\bhost\s*=\s*([^\s'"]+)/g)) hosts.push(match[1] ?? '')
    const conninfoDb = /\bdbname\s*=\s*([^\s'"]+)/.exec(arg)
    if (conninfoDb) database = conninfoDb[1]
    const url = /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/(?:[^\s'"@/]*@)?([^\s'"/:?]*)(?::\d+)?(?:\/([^\s'"?]+))?/i.exec(arg)
    if (url) { hosts.push(url[1] ?? ''); if (url[2]) database = url[2] }
  }
  // sqlite3 DB SQL: the database is a file; psql/mysql: the first plain word names the database.
  if (name === 'sqlite3') { database = positional[0] ? `file:${positional[0]}` : undefined; sql.push(...positional.slice(1)) }
  else if (!database && positional[0] && !/[=:]/.test(positional[0])) database = positional[0]
  // A heredoc body is the client's stdin: its SQL is part of the call.
  if (/<<-?\s*['"]?\w/.test(line)) sql.push(line)
  const viaVariable = words.slice(1).some(word => word.variable) || name === 'supabase'
  return { hosts, viaVariable, database, sql: sql.join('\n'), files }
}

function sqlReason(command: SimpleCommand, args: string[], words: Word[], line: string, view: SafetyView, plans: Plan[]): string | undefined {
  const name = basename(args[0] ?? '')
  if (!DB_CLIENTS.has(name) || (name === 'supabase' && args[1] !== 'db')) return
  const call = dbCall(command, args, words, line)
  const remote = call.viaVariable || call.hosts.some(host => !LOCAL_HOSTS.has(host.toLowerCase()) && !host.startsWith('/'))
  let sql = call.sql
  for (const file of call.files) {
    const path = file.variable ? undefined : normalizePath(resolveDir(file.text, command.cwd, view.home ?? ''))
    const content = path ? view.readFile?.(path) : undefined
    if (content === undefined) {
      if (remote) return `SQL из файла или stdin (${file.text}) для нелокальной базы нельзя проверить. Покажи SQL владельцу или выполни его по частям через -c.`
      continue
    }
    sql += `\n${content}`
  }
  if (remote && destructiveSql(sql)) {
    return 'DROP/TRUNCATE или DELETE без WHERE против нелокальной базы данных. Такие операции делает только владелец.'
  }
  if (remote || !dropSql(sql)) return
  if (name === 'sqlite3' && call.database) {
    const file = call.database.slice(5)
    return deletionReason([{ text: file, variable: false, tilde: file.startsWith('~') }], command.cwd, view, plans, 'copy')
  }
  return `DROP/TRUNCATE в базе${call.database ? ` ${call.database}` : ''}: в v0.4 хук ещё не умеет сам снять дамп Postgres/MySQL, поэтому это делает владелец. `
    + `Подготовь дамп (pg_dump -f ~/backups/<база>-${stamp(view)}.sql <база>) и попроси владельца.`
}

// Programs that may name a secret path because they do not print it: existence and mode checks,
// loading it into the shell, deleting it (snapshotted). Everything else naming one is denied.
const SECRET_OK = new Set(['test', '[', '[[', 'ls', 'stat', 'chmod', 'chown', 'touch', 'source', '.', 'rm', 'unlink', 'rmdir', 'shred'])
// Programs whose last operand is only written: copying a template onto .env reads no secret.
const WRITERS = new Set(['cp', 'mv', 'install'])

// True when a word names a secret path anywhere in it (`open('.env')`, `--env-file=.env`).
function namesSecret(arg: string): boolean {
  return arg.split(/[\s'"()=,;:`]+/).some(piece => piece !== '' && (isSecretPath(piece) || globHitsEnv(piece)))
}

// grep/rg flags read like getopt does: a value-taking letter (-e PATTERN, -f FILE, -m N, -A N...)
// takes the rest of its word or the next word, so `grep -e -q` has the pattern -q, not the flag.
function grepFlags(args: readonly string[]): Set<string> {
  const set = new Set<string>()
  const values = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D', 'g', 't', 'j', 'M', 'r', 'T'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') break
    if (arg.startsWith('--')) {
      if (/^--(?:regexp|file|max-count|context|before-context|after-context|glob|type|replace)$/.test(arg)) i++
      else set.add(arg)
      continue
    }
    if (!/^-./.test(arg)) continue
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j] ?? ''
      if (values.has(letter)) { if (j === arg.length - 1) i++; break }
      set.add(letter)
    }
  }
  return set
}

function secretReadReason(args: string[], command: SimpleCommand): string | undefined {
  const name = basename(args[0] ?? '')
  if (name === 'printenv' && (args.length === 1 || args.slice(1).some(arg => /TOKEN|KEY|SECRET|PASS|BEARER/i.test(arg)))) return ENV_DUMP
  if ((name === 'export' && (args.length === 1 || args.includes('-p'))) || (name === 'declare' && args.length <= 2 && args.slice(1).every(arg => /^-[px]+$/.test(arg)))
    || (name === 'set' && args.length === 1)) return ENV_DUMP
  const fromStdin = command.reads.find(word => namesSecret(word.text))
  if (fromStdin) return `вывод секретного файла (${basename(fromStdin.text)}) в ответ. Не печатай .env, *.key, *.pem и ~/.secrets.`
  const operandsOnly = args.slice(1).filter(arg => !arg.startsWith('-'))
  const named = args.slice(1).filter(namesSecret)
  if (!named.length || SECRET_OK.has(name)) return
  if (/grep$/.test(name) || name === 'rg') {
    const set = grepFlags(args.slice(1))
    if (set.has('q') || set.has('l') || set.has('L') || set.has('c') || set.has('--quiet')) return
  }
  // With -t / --target-directory every operand is a source: none is only written.
  const targetDir = args.some(arg => arg === '-t' || arg.startsWith('--target-directory') || /^-[a-zA-Z]*t/.test(arg))
  if (WRITERS.has(name) && !targetDir && named.length === 1 && named[0] === operandsOnly.at(-1)) return
  return `секретный файл (${named[0]}) упомянут в команде ${name}: её вывод или копия покажет ключ. С секретами можно только test, [, ls, stat, chmod, grep -q/-c/-l, source и rm; ключ проверяй без вывода значения.`
}

function decodes(argv: readonly string[] | undefined): boolean {
  if (!argv?.length) return false
  const name = basename(argv[0] ?? '')
  const rest = argv.slice(1)
  if (['base64', 'base32', 'basenc'].includes(name)) return rest.some(arg => /^-[a-zA-Z]*[dD]|^--decode$/.test(arg))
  if (name === 'xxd') return rest.some(arg => /^-[a-z]*r/.test(arg))
  if (name === 'openssl') return rest.some(arg => arg === 'base64' || arg === 'enc') && rest.includes('-d')
  return name === 'uudecode'
}

// The program behind sudo/doas, or the program itself.
const shellName = (args: string[]) => basename((ESCALATION.has(basename(args[0] ?? '')) ? program(args.slice(1))[0] : args[0]) ?? '')

function deletionCommandReason(command: SimpleCommand, args: string[], words: Word[], view: SafetyView, plans: Plan[]): string | undefined {
  const name = basename(args[0] ?? '')
  const cwd = command.cwd
  if (name === 'rm' || name === 'rmdir' || name === 'unlink' || name === 'shred' || name === 'truncate') {
    // Under xargs the targets come from stdin and the guard cannot see them.
    if (viaXargs(command.argv)) return 'удаление файлов из списка через xargs не проверить. Удаляй конкретные пути.'
    const values = name === 'shred' ? new Set(['-n', '-s', '--iterations', '--size']) : name === 'truncate' ? new Set(['-s', '-r', '--size', '--reference']) : undefined
    const targets = operands(words.slice(1), values)
    // shred and truncate destroy the file in place, so a hardlink would be destroyed too.
    return targets.length ? deletionReason(targets, cwd, view, plans, name === 'shred' || name === 'truncate' ? 'copy' : 'link') : undefined
  }
  if (name === 'find') return findReason(words, cwd, view, plans)
  if (name === 'mv' || name === 'cp') return moveReason(args, words, cwd, view, plans)
  // tee and dd of= truncate their output files like `>` does.
  if (name === 'tee' && !flags(args.slice(1)).has('a') && !flags(args.slice(1)).has('--append')) {
    for (const word of operands(words.slice(1))) {
      const reason = overwriteReason(word, cwd, view, plans)
      if (reason) return reason
    }
  }
  if (name === 'dd') {
    for (const word of words.slice(1)) {
      if (!word.text.startsWith('of=')) continue
      const reason = overwriteReason({ ...word, text: word.text.slice(3) }, cwd, view, plans)
      if (reason) return reason
    }
  }
  return
}

// mv/cp onto an existing file destroys the destination: snapshot it. Moving out of ~/.trash is denied.
function moveReason(args: string[], words: Word[], cwd: string, view: SafetyView, plans: Plan[]): string | undefined {
  const set = flags(args.slice(1))
  const home = view.home ?? ''
  const ops = operands(words.slice(1), new Set(['-t', '--target-directory', '-S', '--suffix']))
  const option = args.findIndex(arg => arg === '-t' || arg === '--target-directory')
  const dest = option >= 0 ? words[option + 1] : ops.at(-1)
  const sources = option >= 0 ? ops : ops.slice(0, -1)
  if (!dest || !sources.length) return
  if (basename(args[0] ?? '') === 'mv') {
    for (const source of sources) {
      const from = targetOf(source, cwd, home)
      if (from && inTrash(real(view, from.path, true), view)) return TRASH
    }
  }
  if (set.has('n') || set.has('--no-clobber')) return
  const to = targetOf(dest, cwd, home)
  if (!to) return `назначение ${basename(args[0] ?? '')} из переменной (${dest.text}) может затереть файл. Укажи конкретный путь.`
  if (to.glob) return
  const destination = real(view, to.path, false)
  const targets = view.isDir?.(destination) ? sources.map(source => `${destination}/${basename(source.text.replace(/\/+$/, ''))}`) : [destination]
  for (const target of targets) {
    if (inTrash(target, view) && view.exists?.(target)) return TRASH
    if (inTrash(target, view) || scratch(target, view) || !view.exists?.(target)) continue
    plans.push({ kind: view.isDir?.(target) ? 'link' : 'copy', path: target })
  }
  return
}

// Writing `word` from the start destroys the file it names (through links): plan a copy of it.
function overwriteReason(word: Word, cwd: string, view: SafetyView, plans: Plan[]): string | undefined {
  if (/^\/dev\//.test(word.text)) return
  const target = targetOf(word, cwd, view.home ?? '')
  if (!target) return `запись в файл из переменной (${word.text}) может стереть его. Укажи конкретный путь.`
  if (target.glob) return
  const path = real(view, target.path, false)
  if (inTrash(path, view)) return TRASH
  if (scratch(path, view) || (view.exists && !view.exists(path))) return
  plans.push({ kind: 'copy', path })
  return
}

// A `>` redirect is opened by the shell, so it resolves against the shell's directories, not a
// wrapper's (`env -C out printf x > notes.md` writes the caller's notes.md).
function truncationReason(command: SimpleCommand, view: SafetyView, plans: Plan[]): string | undefined {
  for (const write of command.writes) {
    if (write.append) continue
    for (const cwd of command.shellCwds) {
      const reason = overwriteReason(write.word, cwd, view, plans)
      if (reason) return reason
    }
  }
  return
}

// In a line the reader cannot parse, a `>` onto an existing file cannot be tied to a snapshot
// with certainty: denied unless the file is new, scratch or a device.
function unparsedWriteReason(commands: SimpleCommand[], view: SafetyView): string | undefined {
  for (const command of commands) {
    for (const write of command.writes) {
      if (write.append || /^\/dev\//.test(write.word.text)) continue
      const harmless = command.shellCwds.every(cwd => {
        const target = targetOf(write.word, cwd, view.home ?? '')
        const path = target && !target.glob ? real(view, target.path, false) : undefined
        return path !== undefined && !inTrash(path, view) && (scratch(path, view) || (view.exists !== undefined && !view.exists(path)))
      })
      if (harmless) continue
      return `команду нельзя разобрать, а она перезаписывает ${write.word.text}. Напиши её простыми командами, по одной в строке (${PLAIN_HINT}), тогда хук сохранит снимок файла.`
    }
  }
  return
}

export const PLAIN_HINT = 'write it as plain commands, one per line'

export function unparsedHint(why: string, mention: string): string {
  return `команду нельзя разобрать (${why}), а в ней есть ${mention}. Напиши её простыми командами, по одной в строке `
    + `(${PLAIN_HINT}): без if/for/(...)/{...}/$(...)/bash -c/&.`
}

// What the guard decides about a line: a Russian deny reason, or the snapshots to make first.
export interface Assessment { deny?: string; plans: Plan[] }

// The Russian reason to block `line`, or undefined when the command is allowed (snapshots aside).
export function dangerReason(line: string, view: SafetyView): string | undefined {
  return assess(line, view).deny
}

const patchTargets = (patch: string) => patch.matchAll(/^\*\*\* (Delete File|Update File|Add File|Move to): (.+)$/gm)

function patchHitsOwner(patch: string, cwd: string, hits: OwnerTarget): boolean {
  for (const match of patchTargets(patch)) {
    if (hits(literalWord(match[2]?.trim() ?? ''), cwd, 'literal')) return true
  }
  return false
}

// The files a patch (apply_patch format) deletes or overwrites, as snapshot plans.
export function assessPatch(patch: string, view: SafetyView): Assessment {
  const plans: Plan[] = []
  const hits = ownerTargets(view)
  if (patchHitsOwner(patch, view.cwd, hits)) return { deny: PREFIX + OWNER_INSTRUCTIONS, plans }
  for (const match of patchTargets(patch)) {
    const target = resolveDir((match[2] ?? '').trim(), view.cwd, view.home ?? '')
    const path = view.realpath ? real(view, target, match[1] === 'Delete File') : normalizePath(target)
    if (inTrash(path, view)) return { deny: PREFIX + TRASH, plans: [] }
    if (scratch(path, view) || (match[1] !== 'Delete File' && view.exists && !view.exists(path))) continue
    plans.push({ kind: match[1] === 'Delete File' ? 'link' : 'copy', path })
  }
  return { plans }
}

const DECODED_SCRIPT = 'запуск раскодированного скрипта (base64/xxd | sh) нельзя проверить. Раскодируй в файл, прочитай его и только потом запускай.'
const FETCHED_SCRIPT = 'запуск скачанного скрипта (curl | sh). Скачай файл, прочитай его и только потом запускай.'

// A shell fed through a pipe by a decoder or a fetcher earlier in the same pipeline.
function pipedScriptReason(commands: SimpleCommand[]): string | undefined {
  let decoded = false
  let fetched = false
  for (const command of commands) {
    const args = program(command.argv)
    const piped = command.joinedBy === '|' || command.joinedBy === '|&'
    if (!piped) { decoded = false; fetched = false }
    if (SHELLS.has(shellName(args)) && piped && (decoded || fetched || FETCHERS.has(command.pipedFrom ?? ''))) {
      return decoded || !fetched && !FETCHERS.has(command.pipedFrom ?? '') ? DECODED_SCRIPT : FETCHED_SCRIPT
    }
    if (decodes(args)) decoded = true
    if (FETCHERS.has(basename(args[0] ?? ''))) fetched = true
  }
  return
}

export function assess(line: string, view: SafetyView): Assessment {
  const plans: Plan[] = []
  const denied = (reason: string): Assessment => ({ deny: reason, plans: [] })
  let decoded = false
  let fetched = false
  let sourcedSecret = false
  let gitEnvChanged = false
  const reading = readCommand(line, view.cwd, view.home ?? '', codexHomeOf(view))
  const hits = ownerTargets(view)
  for (const command of reading.commands) {
    const reason = ownerCommandReason(command, line, view, hits)
    if (reason) return denied(PREFIX + reason)
  }
  if (reading.unparsed) {
    // The owner check can inspect literal shell scripts. The other guards use the mention fallback.
    if (mentionsOwnerOutsideShellReads(reading.stdinShell ? line : stripHeredocs(line), reading, view, hits)) {
      return denied(PREFIX + OWNER_INSTRUCTIONS + ' ' + unparsedHint(reading.unparsed, 'путь к AGENTS.md'))
    }
    const piped = reading.stdinShell ? pipedScriptReason(reading.commands) : undefined
    if (piped) return denied(PREFIX + piped)
    const mention = guardedMention(line, reading.stdinShell)
    if (mention) return denied(PREFIX + unparsedHint(reading.unparsed, mention))
    const write = unparsedWriteReason(reading.commands, view)
    return write ? denied(PREFIX + write) : { plans }
  }
  for (const command of reading.commands) {
    const args = program(command.argv)
    const prefixLength = command.argv.length - args.length
    const words = command.words.slice(prefixLength)
    const prefix = command.argv.slice(0, prefixLength)
    const wrappers = prefix.map(basename)
    const name = basename(args[0] ?? '')
    const hasGitEnvAssignment = prefix.some(arg => GIT_ENV_ASSIGNMENT.test(arg))
    // Standalone assignments and export can change the shell environment for later commands.
    if ((!args.length && hasGitEnvAssignment) || (name === 'export' && args.slice(1).some(arg => GIT_ENV_EXPORT.test(arg)))) gitEnvChanged = true
    const piped = command.joinedBy === '|' || command.joinedBy === '|&'
    if (!piped) { decoded = false; fetched = false }
    let reason: string | undefined
    if (args.length === 0 && wrappers.includes('env')) reason = ENV_DUMP
    else if (wrappers.includes('env') && command.argv.some(arg => /^-[a-zA-Z]*S|^--split-string/.test(arg))) {
      reason = 'env -S собирает команду из строки, её нельзя проверить. Запусти команду напрямую.'
    } else if (wrappers.includes('busybox') && BUSYBOX_DENY.has(name)) reason = `busybox ${name} обходит защиту. Запусти нужную программу напрямую.`
    else if (ESCALATION.has(name)) reason = `${name}: повышение прав. Агент работает без прав администратора; попроси владельца.`
    else if (name === 'eval') reason = 'eval выполняет собранную строку, её нельзя проверить. Запусти команду напрямую.'
    else if (name === 'git') for (const cwd of command.cwds) reason ??= gitReason(args, cwd, view, plans, gitEnvChanged || hasGitEnvAssignment)
    else if (name === 'git-filter-repo') reason = 'переписывание истории git. Это делает только владелец.'
    else if (name === 'gh') reason = ghReason(args)
    else if ((name === 'source' || name === '.') && args.slice(1).some(arg => isSecretPath(arg))) sourcedSecret = true
    else if (sourcedSecret && ['echo', 'printf', 'printenv', 'env', 'set', 'export', 'declare', 'cat'].includes(name)) {
      reason = 'вывод переменных после source .env покажет ключи. Используй переменные, не печатая их.'
    }
    if (!reason && SHELLS.has(shellName(args)) && piped && (decoded || fetched || FETCHERS.has(command.pipedFrom ?? ''))) {
      reason = decoded || !fetched && !FETCHERS.has(command.pipedFrom ?? '') ? DECODED_SCRIPT : FETCHED_SCRIPT
    }
    if (!reason && SHELLS.has(shellName(args))) {
      const shellArgs = ESCALATION.has(name) ? program(args.slice(1)) : args
      const shellWords = words.slice(words.length - shellArgs.length)
      const flag = shellArgs.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg))
      if (flag >= 0 && shellWords[flag + 1]?.variable) reason = 'bash -c со скриптом из переменной нельзя проверить. Запусти команду напрямую.'
      else if (shellWords.some(word => /^(?:<\(|\$\()\s*(?:curl|wget)\b/.test(word.text))) {
        reason = 'запуск скачанного скрипта без проверки. Скачай файл, прочитай его и только потом запускай.'
      }
    }
    // Every directory the command may run in gets its targets checked and snapshotted.
    for (const cwd of command.cwds) {
      const at = { ...command, cwd }
      reason ??= sqlReason(at, args, words, line, view, plans) ?? deletionCommandReason(at, args, words, view, plans)
    }
    reason ??= truncationReason(command, view, plans)
    reason ??= secretReadReason(args, command)
    if (reason) return denied(PREFIX + reason)
    if (decodes(command.argv.slice(command.argv.length - args.length))) decoded = true
    if (FETCHERS.has(name)) fetched = true
  }
  const unique = new Map(plans.map(plan => [JSON.stringify(plan), plan]))
  return { plans: [...unique.values()] }
}
