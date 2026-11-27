// Hook 5 (PreToolUse): the git gate. A push is allowed only in the canonical form
// `git push [-u|--set-upstream] <remote> <branch>` with a literal branch that is not main/master;
// `git -C <dir>` is the only global option. Whether a commit was checked is no longer a text
// receipt: `codex-hooks check <sha>` posts a GitHub commit status and the ruleset on main requires
// it, so merges are gated by GitHub, not by this hook.
import { gitArgs } from './safety.js'
import { basename, program, readCommand } from './shell.js'

export interface GitView {
  cwd: string
  // Expands ~ and $HOME in cd and git -C targets.
  home?: string
}

export interface GateResult { deny?: string; context?: string }

const MAIN = new Set(['main', 'master'])
const PREFIX = 'Заблокировано git-гейтом: '
const CANONICAL = 'Пушь только так: git push origin <ветка> (или git push -u origin <ветка>), ветка не main/master, без других опций и без refspec с двоеточием.'
const deny = (text: string): GateResult => ({ deny: PREFIX + text })

export function gitGate(line: string, view: GitView): GateResult {
  const home = view.home ?? ''
  const reading = readCommand(line, view.cwd, home)
  // An unparsed line naming git push is denied by the safety guard's mention rule.
  if (reading.unparsed) return {}
  for (const command of reading.commands) {
    const args = program(command.argv)
    if (basename(args[0] ?? '') !== 'git') continue
    const { sub, rest, options } = gitArgs(args, command.cwd, home)
    if (sub !== 'push') continue
    // VAR=value (GIT_DIR, GIT_SSH_COMMAND...), env, xargs and other wrappers change what a push does.
    const prefix = command.argv.slice(0, command.argv.length - args.length)
    if (prefix.length) return deny(`${prefix[0]} перед git push меняет, что и куда уйдёт. ${CANONICAL}`)
    if (options.length) return deny(`git ${options.join(' ')} перед push меняет, что и куда уйдёт. ${CANONICAL}`)
    const offset = command.argv.length - rest.length
    if (command.words.slice(offset).some(word => word.variable)) return deny(`push с переменной нельзя проверить. ${CANONICAL}`)
    const positional = rest[0] === '-u' || rest[0] === '--set-upstream' ? rest.slice(1) : rest
    const [remote, branch] = positional
    if (positional.length !== 2 || !remote || !branch || positional.some(arg => arg.startsWith('-'))) return deny(CANONICAL)
    if (!/^[\w.-]+$/.test(remote) || !/^[\w][\w./-]*$/.test(branch) || branch === 'HEAD' || branch.startsWith('refs/')) {
      return deny(`push ${remote} ${branch} не в каноничной форме. ${CANONICAL}`)
    }
    if (MAIN.has(branch)) return deny('push в main/master запрещён. Создай ветку feature/… или fix/…, запушь её и открой PR.')
  }
  return {}
}
