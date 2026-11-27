// `codex-hooks check <sha>` (bun codex-hooks/src/main.ts check <sha>): runs scripts/check.sh in a
// clean worktree at exactly that commit, in the foreground, and posts the result as a GitHub commit
// status on that sha. The ruleset on main requires this status, so GitHub (not a text receipt)
// refuses a merge of an unchecked commit.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Runner } from './types.js'

export const STATUS_CONTEXT = 'codex-hooks/check'
const CHECK_TIMEOUT_MS = 60 * 60_000

export interface CheckDeps {
  run: Runner
  // Where the temporary worktree goes.
  tmp: string
  log: (line: string) => void
}

export interface CheckResult { sha: string; state: 'success' | 'failure'; code: number | null }

function git(deps: CheckDeps, dir: string, args: string[]): string {
  const result = deps.run(['git', '-C', dir, ...args], { timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${dir} (exit ${result.code})`)
  return result.stdout.trim()
}

export function runCheck(repo: string, rev: string, deps: CheckDeps): CheckResult {
  if (!/^[0-9a-f]{7,40}$/i.test(rev)) throw new Error(`not a commit sha: ${rev}`)
  const sha = git(deps, repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  const tree = mkdtempSync(join(deps.tmp, 'codex-hooks-check-'))
  let code: number | null
  try {
    git(deps, repo, ['worktree', 'add', '--detach', tree, sha])
    deps.log(`check: scripts/check.sh at ${sha} in ${tree}`)
    const result = deps.run([join(tree, 'scripts', 'check.sh')], { cwd: tree, timeoutMs: CHECK_TIMEOUT_MS })
    code = result.code
    if (result.stdout) deps.log(result.stdout.trimEnd())
  } finally {
    deps.run(['git', '-C', repo, 'worktree', 'remove', '--force', tree], { timeoutMs: 60_000 })
    rmSync(tree, { recursive: true, force: true })
  }
  const state = code === 0 ? 'success' : 'failure'
  const posted = deps.run(['gh', 'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${STATUS_CONTEXT}`,
    '-f', `description=scripts/check.sh exit ${code ?? 'timeout'}`], { cwd: repo, timeoutMs: 30_000 })
  if (posted.code !== 0) throw new Error(`gh could not post the commit status (exit ${posted.code})`)
  return { sha, state, code }
}
