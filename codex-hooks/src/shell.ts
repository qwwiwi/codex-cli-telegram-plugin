// The strict shell-command reader for the guards. It is not a full shell parser: it accepts only plain
// commands (literal words joined by ; && || | and newlines, literal redirects), keeps track of
// `cd DIR` and strips redirections. Every other shape is reported as unparsed; the guards then apply
// the mention rule (unparsed + a guarded token = deny) instead of guessing what the shell will run.

export interface Word {
  text: string
  // True when the word expands a variable ($X, ${X}) outside single quotes.
  variable: boolean
  // True when an unquoted leading ~ will expand to the home directory.
  tilde: boolean
  // Whether an unquoted wildcard or opening brace occurred in the word.
  glob?: boolean
}

export interface SimpleCommand {
  words: Word[]
  argv: string[]
  // The operator that joined this command to the previous one ('' for the first).
  joinedBy: string
  // The directory the command runs in, after any earlier `cd` in the same line (and env -C).
  cwd: string
  // Every directory the command may run in: a `cd` not joined by && may fail, so the directory
  // before it stays possible. `cwd` comes first.
  cwds: string[]
  // Every directory the shell itself may be in for this command: redirects resolve here, before
  // a wrapper such as `env -C` changes the program's directory.
  shellCwds: string[]
  // An earlier `cd` may have moved the shell to a directory the reader cannot resolve.
  unresolvedCwd?: boolean
  // True when stdout goes to a file (> file, >> file, &> file), not to the terminal.
  stdoutToFile: boolean
  // The program of the previous command when this one reads it through a pipe.
  pipedFrom: string | undefined
  // The argv of the previous command when this one reads it through a pipe.
  pipedFromArgv: string[] | undefined
  // Files the command writes through redirects. Append also marks non-truncating `<>`.
  writes: Array<{ word: Word; append: boolean }>
  // Files the command reads through `<` (and heredoc delimiters, here-strings).
  reads: Word[]
  // True when stdin comes from a `<` redirect, a heredoc or a here-string.
  stdinRedirect: boolean
  // A direct sh/bash -c with a literal script argument, available for the owner-file check.
  literalShellScript?: string
  raw: string
}

interface Token { kind: 'word'; word: Word; raw: string }
interface Operator { kind: 'op'; op: string }

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n']

function lex(line: string): Array<Token | Operator | { kind: 'redirect'; op: string }> {
  const out: Array<Token | Operator | { kind: 'redirect'; op: string }> = []
  let i = 0
  while (i < line.length) {
    const ch = line[i] ?? ''
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    if (ch === '#' ) { while (i < line.length && line[i] !== '\n') i++; continue }
    const op = OPERATORS.find(candidate => line.startsWith(candidate, i))
    if (op && !(op === '&' && line[i + 1] === '>')) { out.push({ kind: 'op', op }); i += op.length; continue }
    const redirect = /^(?:\d*>&\d+-?|\d*>\||\d*<>|\d*>>?|&>>?|\d*<<<|\d*<<-?|\d*<(?!\())/.exec(line.slice(i))
    if (redirect && !line.startsWith('<(', i)) {
      out.push({ kind: 'redirect', op: redirect[0] }); i += redirect[0].length; continue
    }
    let text = ''
    let variable = false
    let glob = false
    const start = i
    const tilde = ch === '~'
    while (i < line.length) {
      const c = line[i] ?? ''
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break
      if (OPERATORS.some(candidate => candidate !== '\n' && line.startsWith(candidate, i))) break
      if ((c === '>' || c === '<') && !line.startsWith('<(', i)) break
      if (c === '\\') { text += line[i + 1] ?? ''; i += 2; continue }
      if (c === "'") {
        const end = line.indexOf("'", i + 1)
        const stop = end < 0 ? line.length : end
        text += line.slice(i + 1, stop); i = stop + 1; continue
      }
      if (c === '"') {
        i++
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) { text += line[i + 1]; i += 2; continue }
          if (line[i] === '$') variable = true
          text += line[i]; i++
        }
        i++; continue
      }
      if (c === '$' && line[i + 1] === '(') {
        const end = matchParen(line, i + 1)
        text += line.slice(i, end + 1); variable = true; i = end + 1; continue
      }
      if (c === '<' && line[i + 1] === '(') {
        const end = matchParen(line, i + 1)
        text += line.slice(i, end + 1); i = end + 1; continue
      }
      if (c === '$') variable = true
      if ('*?[{'.includes(c)) glob = true
      text += c; i++
    }
    out.push({ kind: 'word', word: { text, variable, tilde, glob }, raw: line.slice(start, i) })
  }
  return out
}

function matchParen(line: string, open: number): number {
  let depth = 0
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')') { depth--; if (depth === 0) return i }
  }
  return line.length - 1
}

// Commands hidden inside $(...), `...` and <(...) of a line. Single-quoted text and escaped
// characters are data, so backticks in a quoted commit message are not commands.
function nestedScripts(line: string): string[] {
  const found: string[] = []
  let single = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && !single) { i++; continue }
    if (c === "'") { single = !single; continue }
    if (single) continue
    if ((c === '$' || c === '<') && line[i + 1] === '(') {
      const end = matchParen(line, i + 1)
      found.push(line.slice(i + 2, end))
      i = end
    } else if (c === '`') {
      const end = line.indexOf('`', i + 1)
      if (end < 0) break
      found.push(line.slice(i + 1, end))
      i = end
    }
  }
  return found
}

// A directory argument with ~ and $HOME expanded, made absolute against `base`.
export function resolveDir(target: string, base: string, home: string, codexHome = ''): string {
  let dir = target
  if (codexHome) dir = dir.replace(/^\$(?:CODEX_HOME|\{CODEX_HOME\})(?=\/|$)/, codexHome)
  if (home) dir = dir.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  return dir.startsWith('/') ? dir : `${base.replace(/\/$/, '')}/${dir}`
}

export function resolvePathWord(word: Word, base: string, home: string, codexHome: string): string {
  const literalPrefix = (!word.tilde && word.text.startsWith('~')) || (!word.variable && word.text.startsWith('$'))
  return resolveDir(literalPrefix ? `./${word.text}` : word.text, base, home, codexHome)
}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])

export function basename(program: string): string {
  return program.slice(program.lastIndexOf('/') + 1)
}

// Programs that run the rest of their arguments as a command, and their options that take a value.
// busybox runs its first argument as an applet, so the guards see the applet as the program.
const WRAPPERS = new Set(['env', 'command', 'exec', 'builtin', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'xargs', 'setsid', 'busybox'])
const VALUE_OPTIONS = new Set(['-n', '-s', '-k', '-u', '-c', '-C', '-I', '-P', '-d', '-L', '-a', '-E', '-i', '-o', '-e'])

// The argv with leading VAR=value or VAR+=value assignments and wrapper programs (env, timeout 10, nohup,
// nice -n 5, xargs ...) removed: the program that actually runs comes first.
export function program(argv: readonly string[]): string[] {
  let i = 0
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(argv[i] ?? '')) i++
    const name = basename(argv[i] ?? '')
    if (!WRAPPERS.has(name)) break
    // `command -v sudo` only looks the program up.
    if (name === 'command' && /^-[vV]$/.test(argv[i + 1] ?? '')) break
    i++
    while (i < argv.length && (argv[i] ?? '').startsWith('-') && argv[i] !== '--') {
      const option = argv[i] ?? ''
      const takesValue = name === 'env' ? ['-u', '-C', '--unset', '--chdir'].includes(option)
        : name === 'xargs' ? ['-I', '-P', '-n', '-d', '-L', '-a', '-E', '-s'].includes(option)
          : VALUE_OPTIONS.has(option)
      i += takesValue ? 2 : 1
    }
    if (argv[i] === '--') i++
    if (name === 'timeout' && /^\d/.test(argv[i] ?? '')) i++
  }
  return argv.slice(i)
}

// The directory a wrapper prefix (`env -C DIR`, `env --chdir=DIR`) makes the program run in.
export function wrapperDir(argv: readonly string[], dir: string, home: string, codexHome = ''): string {
  const prefix = argv.slice(0, argv.length - program(argv).length)
  let current = dir
  let inEnv = false
  for (let i = 0; i < prefix.length; i++) {
    const word = prefix[i] ?? ''
    if (!word.startsWith('-')) { inEnv = basename(word) === 'env'; continue }
    if (!inEnv) continue
    if (word === '-C' || word === '--chdir') { current = resolveDir(prefix[i + 1] ?? '.', current, home, codexHome); i++ }
    else if (word.startsWith('--chdir=')) current = resolveDir(word.slice(8), current, home, codexHome)
    else if (/^-C./.test(word)) current = resolveDir(word.slice(2), current, home, codexHome)
  }
  return current
}

// True when a shell started with `args` reads its script from stdin: no script operand, `-s` or `-`.
export function shellReadsStdin(args: readonly string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-') return true
    if (arg === '--') return i + 1 >= args.length
    if (/^[-+]/.test(arg)) {
      if (/^-[a-zA-Z]*s/.test(arg)) return true
      if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(arg)) i++
      continue
    }
    return false
  }
  return true
}

const dequote = (text: string) => text.replace(/['"\\]/g, '')

// True when a wrapper such as xargs feeds the program arguments that the command line does not show.
export function viaXargs(argv: readonly string[]): boolean {
  const rest = program(argv)
  return argv.slice(0, argv.length - rest.length).some(word => basename(word) === 'xargs')
}

// Drops heredoc bodies (`cmd <<'EOF' ... EOF`): they are data for the command, not commands, unless
// the command is itself a shell (`bash <<EOF`), whose body runs and stays visible to the guards.
export function stripHeredocs(line: string): string {
  const lines = line.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? ''
    out.push(current)
    const match = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(current)
    if (!match || match[0].startsWith('<<<')) continue
    const before = current.slice(0, match.index).trim().split(/\s+/)
    if (before.some(word => SHELLS.has(basename(dequote(word))))) continue
    const end = lines.findIndex((candidate, index) => index > i && candidate.replace(/^\t+/, '') === match[2])
    if (end < 0) break
    i = end
  }
  return out.join('\n')
}

// Words that make a line shell code rather than plain commands when they stand in program position.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'select', 'coproc', '!', '{', '}', '[[', ']]'])

// Text outside quotes and escapes, for spotting shell syntax a word carries.
const unquoted = (raw: string) => raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./gs, '')

export interface Reading {
  commands: SimpleCommand[]
  // True when a shell reads its script from a pipe, heredoc, here-string or `<` file: heredoc
  // bodies then are code, so the mention rule must see them.
  stdinShell?: boolean
  // Set when the line is not plain commands (literal words joined by && || ; | and literal
  // redirects): why the strict reader gave up. The commands are then a best-effort split only.
  unparsed?: string
  // All unsupported syntax was direct sh/bash -c with a literal argument.
  literalShellScriptsOnly?: boolean
}

// The strict reader. Only plain commands parse; subshells, groups, keywords, substitutions,
// heredocs into a shell, `&`, `bash -c`, eval and a variable in program position are unparsed.
export function readCommand(input: string, cwd: string, home = '', codexHome = '', unresolvedCwd = false): Reading {
  const line = stripHeredocs(input)
  const commands: SimpleCommand[] = []
  let unparsed: string | undefined
  let opaque = false
  const give = (why: string, literalShell = false) => { unparsed ??= why; opaque ||= !literalShell }
  for (const match of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) {
    if (match[0].startsWith('<<<')) continue
    const before = line.slice(0, match.index).split('\n').at(-1)?.trim().split(/\s+/) ?? []
    if (before.some(word => SHELLS.has(basename(dequote(word))))) give('heredoc into a shell')
  }
  if (nestedScripts(line).length) give('command substitution')
  let words: Word[] = []
  let raws: string[] = []
  let joinedBy = ''
  let stdoutToFile = false
  let pendingRedirect = ''
  let dirs = [cwd]
  let stdinRedirect = false
  let stdinShell = false
  let previousArgv: string[] | undefined
  let writes: SimpleCommand['writes'] = []
  let reads: Word[] = []
  const flush = (next: string) => {
    if (words.length || writes.length || reads.length) {
      const argv = words.map(word => word.text)
      const piped = joinedBy === '|' || joinedBy === '|&'
      const cwds = [...new Set(dirs.map(candidate => wrapperDir(argv, candidate, home, codexHome)))]
      const script = argv.length === 3 && (argv[0] === 'sh' || argv[0] === 'bash') && argv[1] === '-c' ? words[2] : undefined
      const command: SimpleCommand = {
        words, argv, joinedBy, cwd: cwds[0] ?? cwd, cwds, shellCwds: [...new Set(dirs)], stdoutToFile, raw: raws.join(' '), writes, reads, stdinRedirect,
        ...(unresolvedCwd ? { unresolvedCwd } : {}),
        ...(script && !script.variable && !script.glob ? { literalShellScript: script.text } : {}),
        pipedFrom: piped && previousArgv?.[0] ? basename(previousArgv[0]) : undefined,
        pipedFromArgv: piped ? previousArgv : undefined,
      }
      commands.push(command)
      const args = program(argv)
      const head = words[argv.length - args.length]
      if (head && (KEYWORDS.has(head.text) || head.variable)) give(head.variable ? 'variable in program position' : `shell keyword ${head.text}`)
      if (basename(args[0] ?? '') === 'eval') give('eval')
      // A shell running a script string anywhere in the argv (bash -c, find -exec sh -c, xargs sh -c).
      argv.forEach((arg, index) => {
        if (SHELLS.has(basename(arg)) && argv.slice(index + 1).some(flag => /^-[a-z]*c[a-z]*$/.test(flag))) {
          give('shell -c script', index === 0 && command.literalShellScript !== undefined)
        }
      })
      if (SHELLS.has(basename(args[0] ?? '')) && (piped || stdinRedirect) && shellReadsStdin(args)) {
        stdinShell = true
        give('script on stdin of a shell')
      }
      if (args[0] === 'cd') {
        const word = words[argv.length - args.length + (args[1] === '--' ? 2 : 1)]
        const path = word ? resolvePathWord(word, '.', home, codexHome) : home
        const unknown = !path || word?.text === '-' || (word?.tilde && /^~[^/]/.test(word.text))
          || (word?.glob && /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/.test(path)) || (word?.variable && path.includes('$'))
        unresolvedCwd = Boolean(unknown) || (unresolvedCwd && (next !== '&&' || !path.startsWith('/')))
        // Only && proves the cd succeeded; after ; || | or a newline the old directory stays possible.
        if (path) {
          const moved = word ? dirs.map(candidate => resolvePathWord(word, candidate, home, codexHome)) : [home]
          dirs = [...new Set(next === '&&' ? moved : [...moved, ...dirs])]
        }
      }
      previousArgv = args
    }
    words = []; raws = []; joinedBy = next; stdoutToFile = false; pendingRedirect = ''; writes = []; reads = []; stdinRedirect = false
  }
  for (const token of lex(line)) {
    if (token.kind === 'op') {
      if (token.op === '&' || token.op === ';;') give(token.op === '&' ? 'background &' : 'case')
      flush(token.op); continue
    }
    if (token.kind === 'redirect') { pendingRedirect = /&\d*-?$/.test(token.op) && /\d|-$/.test(token.op.slice(token.op.indexOf('&'))) ? '' : token.op; continue }
    if (/[()]/.test(unquoted(token.raw))) give('subshell or group')
    if (/['"]/.test(unquoted(token.raw))) give('unclosed quote')
    if (pendingRedirect) {
      const target = token.word.text
      const toStdout = /^(?:1?(?:>>?|>\|)|&>>?)$/.test(pendingRedirect)
      if (toStdout && !['/dev/stdout', '/dev/stderr', '/dev/tty'].includes(target)) stdoutToFile = true
      if (pendingRedirect.includes('<')) { reads.push(token.word); if (/^0?</.test(pendingRedirect)) stdinRedirect = true }
      if (!pendingRedirect.includes('<') || pendingRedirect.endsWith('<>')) {
        writes.push({ word: token.word, append: pendingRedirect.endsWith('>>') || pendingRedirect.endsWith('<>') })
      }
      pendingRedirect = ''
      continue
    }
    words.push(token.word); raws.push(token.raw)
  }
  flush('')
  if (!unparsed) return { commands }
  return { commands, unparsed, ...(stdinShell ? { stdinShell } : {}), ...(!opaque ? { literalShellScriptsOnly: true } : {}) }
}

// The best-effort split of a line, for hooks that only need directories (never for a guard).
export function parseCommand(input: string, cwd: string, home = ''): SimpleCommand[] {
  return readCommand(input, cwd, home).commands
}

// Tokens whose mere mention in an unparsed line denies it: deletion, git history and pushes, GitHub,
// database clients, privilege escalation and secret paths.
const GUARDED: Array<[RegExp, string]> = [
  [/(?<![\w.-])(?:rm|rmdir|unlink|shred|truncate|dd|mkfs(?:\.\w+)?)(?![\w-])/, 'удаление'],
  [/(?<![\w-])-delete(?![\w-])/, 'find -delete'],
  [/(?<![\w.-])git(?![\w-])[\s\S]*(?<![\w-])(?:push|clean|reset|checkout|restore|branch|filter-branch|filter-repo|reflog|update-ref)(?![\w-])/, 'git'],
  [/(?<![\w.-])gh(?![\w-])/, 'gh'],
  [/(?<![\w.-])(?:psql|mysql|mariadb|sqlite3|mongosh|sqlcmd|clickhouse-client|cockroach|supabase|redis-cli)(?![\w-])/, 'клиент базы данных'],
  [/(?<![\w.-])(?:sudo|su|doas|pkexec|run0)(?![\w-])/, 'повышение прав'],
  [/(?<![\w.-])(?:curl|wget)(?![\w-])[\s\S]*(?<![\w.-])(?:sh|bash|zsh|dash|ksh)(?![\w-])|(?<![\w.-])(?:sh|bash|zsh|dash|ksh)(?![\w-])[\s\S]*(?<![\w.-])(?:curl|wget)(?![\w-])/, 'скачанный скрипт'],
  [/(?<![\w.-])\.env(?:\.(?!example|sample|template|dist)[\w.-]+)?(?![\w-])|\.(?:pem|key)(?![\w-])|(?<![\w-])id_(?:rsa|ed25519|ecdsa|dsa)(?![\w-])|gbrain\.env|secrets\//, 'секретный файл'],
]

// The first guarded token named anywhere in `line`, or undefined. Heredoc bodies are data and
// excluded unless `keepHeredocs` (a shell reads them as code). Quotes and escapes inside words
// (r'm', "g"it) do not hide a token: the text is also checked with them removed.
export function guardedMention(line: string, keepHeredocs = false): string | undefined {
  const text = keepHeredocs ? line : stripHeredocs(line)
  const bare = dequote(text)
  return GUARDED.find(([pattern]) => pattern.test(text) || pattern.test(bare))?.[1]
}

// An absolute path with `.` and `..` segments resolved and no trailing slash ('/' stays '/').
export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The shell text of a tool call, or undefined for a tool that runs no shell command.
export function commandOf(toolName: unknown, toolInput: unknown): string | undefined {
  if (typeof toolName !== 'string' || toolInput === null || typeof toolInput !== 'object') return
  const input = toolInput as Record<string, unknown>
  const value = input.command ?? input.cmd ?? (toolName === 'write_stdin' ? input.chars : undefined)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    const parts = value as string[]
    const flag = parts.findIndex(part => /^-[a-z]*c[a-z]*$/.test(part))
    if (SHELLS.has(basename(parts[0] ?? '')) && flag >= 0 && parts[flag + 1]) return parts[flag + 1]
    return parts.map(part => /[\s'"]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part).join(' ')
  }
  return
}

export const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'shell_command', 'exec_command', 'unified_exec', 'write_stdin'])
