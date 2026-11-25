import { basename, isAbsolute, resolve } from 'node:path'

const program = /^(?:(?:\/usr)?\/bin\/)?[a-z][a-z0-9_-]*$/u
const secretPath = /(?:^|\/)(?:\.(?:env(?:\.[^/]*)?|ssh|aws|gnupg)|auth\.json|credentials?|secrets?|shadow|sudoers|environ)(?:\/|$)/iu
const service = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*(?:\.service|\.timer|\.socket)$/u
const properties = new Set([
  'ActiveState', 'SubState', 'LoadState', 'UnitFileState', 'MainPID', 'NRestarts', 'Result',
  'ExecMainStartTimestamp', 'ActiveEnterTimestamp', 'User', 'Group', 'Description', 'FragmentPath',
])

// Only parse literal shell words and simple composition. Anything with substitutions,
// redirects, assignments or unresolved syntax keeps the native approval.
function shellCommands(source: string): string[][] | undefined {
  if (source.length > 12_000 || /[\x00-\x08\x0b-\x1f\x7f]/u.test(source)) return
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let quote = ''
  let started = false
  let needsCommand = false
  const flush = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === quote) quote = ''
      else if (quote === '"' && (ch === '$' || ch === '`')) return
      else if (quote === '"' && ch === '\\') {
        const next = source[++i]
        if (next !== '"' && next !== '\\') return
        word += next
      } else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      started = true
      quote = ch
    } else if (ch === '\\') {
      const next = source[++i]
      if (!next || next === '\n') return
      started = true
      word += next
    } else if ('`$(){}<>*?[]#~!'.includes(ch)) {
      return
    } else if (/[;&|\n]/u.test(ch)) {
      const double = source[i + 1] === ch
      if (ch === '&' && !double) return
      if (double && (ch === '&' || ch === '|')) i++
      flush()
      if (!words.length) return
      commands.push(words)
      words = []
      needsCommand = ch === '&' || ch === '|'
    } else if (/\s/u.test(ch)) flush()
    else {
      started = true
      word += ch
    }
  }
  if (quote) return
  flush()
  if (words.length) commands.push(words)
  else if (needsCommand) return
  return commands.length ? commands : undefined
}

function commandParts(source: string): string[][] | undefined {
  const commands = shellCommands(source.trim())
  if (commands?.length !== 1) return commands
  const [bin, option, script, ...rest] = commands[0]!
  if (bin && program.test(bin) && ['bash', 'sh', 'dash'].includes(basename(bin))
      && (option === '-c' || option === '-lc') && script !== undefined && !rest.length) {
    return shellCommands(script.trim())
  }
  return commands
}

function inspectSystemd(args: string[]): boolean {
  const words = args.filter(word => !['--user', '--system', '--no-pager', '--no-legend', '--quiet', '--'].includes(word))
  const [verb, ...targets] = words
  if (verb === 'is-active' || verb === 'is-enabled' || verb === 'is-failed') {
    return targets.length > 0 && targets.every(target => service.test(target))
  }
  if (verb === 'list-timers' || verb === 'list-units' || verb === 'list-unit-files') {
    return targets.every(target => service.test(target) || /^--type=(?:service|timer|socket)$/u.test(target))
  }
  if (verb !== 'show') return false
  let hasFilter = false
  const units: string[] = []
  for (let i = 0; i < targets.length; i++) {
    const value = targets[i]!
    const filter = value.startsWith('--property=') ? value.slice(11)
      : value === '-p' || value === '--property' ? targets[++i] : undefined
    if (filter !== undefined) {
      if (!filter.split(',').every(property => properties.has(property))) return false
      hasFilter = true
    } else units.push(value)
  }
  return hasFilter && units.length > 0 && units.every(unit => service.test(unit))
}

function inspectJournal(args: string[]): boolean {
  // Scope journal auto-approvals to a named unit of the service account and a
  // bounded tail. Global/system journals and mutations still go to the owner.
  if (!args.includes('--user') || !args.includes('--no-pager')) return false
  let unit = false, lines = false
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!
    if (value === '--user' || value === '--no-pager') continue
    if (value === '-u' || value === '--unit') {
      if (unit || !service.test(args[++i] ?? '')) return false
      unit = true
    } else if (value === '-n' || value === '--lines') {
      if (lines || !/^[1-9]\d{0,2}$/u.test(args[++i] ?? '')) return false
      lines = true
    } else return false
  }
  return unit && lines
}

function routinePart(args: string[], cwd: string): boolean {
  const [bin, ...rest] = args
  if (!bin || !program.test(bin) || rest.some(arg => secretPath.test(arg) || arg.includes('\n'))) return false
  switch (basename(bin)) {
    case 'df': return rest.every(arg => /^-[hHikmPT]+$/u.test(arg) || !arg.startsWith('-'))
    case 'free': return rest.every(arg => /^-[bhkmgwt]+$/u.test(arg))
    case 'uptime': return rest.every(arg => ['-p', '-s', '--pretty', '--since'].includes(arg))
    case 'uname': return rest.every(arg => /^-[asnrvmpio]+$/u.test(arg))
    case 'id': return rest.length === 0 || rest.length === 1 && /^-[ugGn]+$/u.test(rest[0]!)
    case 'whoami': case 'pwd': return rest.length === 0
    case 'ps':
      return rest.length === 0 || rest.join(' ') === '-ef' || rest.join(' ') === 'aux'
        || rest.length === 2 && rest[0] === '-eo' && /^(?:pid|ppid|user|uid|comm|stat|etime|pcpu|pmem|rss|args)(?:,(?:pid|ppid|user|uid|comm|stat|etime|pcpu|pmem|rss|args))*$/u.test(rest[1]!)
    case 'lsblk': return rest.every(arg => /^-[ablmnpPrsSt]+$/u.test(arg) || ['--json', '--fs', '--bytes'].includes(arg))
    case 'ls': return rest.every(arg => /^-[aAdFhilLnoprStUX1]+$/u.test(arg) || !arg.startsWith('-'))
    case 'stat': return rest.length > 0 && rest.every(arg => !arg.startsWith('-') || ['-c', '--format', '--', '--terse'].includes(arg) || arg.startsWith('--format='))
    case 'head': case 'tail': return rest.length === 0 || rest.length === 1 && /^-[1-9]\d{0,2}$/u.test(rest[0]!)
      || rest.length === 2 && rest[0] === '-n' && /^[1-9]\d{0,2}$/u.test(rest[1]!)
    case 'wc': return rest.every(arg => /^-[clLmw]+$/u.test(arg))
    case 'systemctl': return inspectSystemd(rest)
    case 'journalctl': return inspectJournal(rest)
    case 'test': return rest.length === 2 && ['-d', '-e', '-f'].includes(rest[0]!) && resolve(cwd, rest[1]!).startsWith(cwd + '/')
    default: return false
  }
}

export function isRoutineServerCommand(source: string, cwd: unknown): boolean {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || secretPath.test(cwd)) return false
  const parts = commandParts(source)
  return parts?.every(words => routinePart(words, cwd)) ?? false
}

export function needsServerRiskCard(source: string): boolean {
  return commandParts(source)?.some(([bin, ...args]) => {
    switch (basename(bin ?? '')) {
      case 'rm': return args.some(arg => /^(?:--recursive|--force|-[rfR]+)$/u.test(arg))
      case 'find': return args.includes('-delete')
      case 'reboot': case 'shutdown': case 'poweroff': case 'halt':
      case 'ufw': case 'nft': case 'iptables': case 'ip6tables': case 'firewall-cmd':
      case 'wipefs': case 'fdisk': case 'parted': case 'mkfs': return true
      case 'systemctl': return args.some(arg => /^(?:reboot|poweroff|halt|kexec)$/u.test(arg))
        || args.some(arg => /^(?:ssh(?:d)?|systemd-logind|systemd-networkd|NetworkManager)(?:\.service)?$/iu.test(arg))
        && args.some(arg => /^(?:stop|restart|disable|mask|edit|reload)$/u.test(arg))
      default: return false
    }
  }) ?? false
}
