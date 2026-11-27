import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCheck, STATUS_CONTEXT } from '../../../codex-hooks/src/check.js'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { gitGate } from '../../../codex-hooks/src/git-gate.js'
import { rulesetCheck } from '../../../codex-hooks/src/install.js'
import { sessionSanityHook } from '../../../codex-hooks/src/session.js'
import type { HookContext, Runner } from '../../../codex-hooks/src/types.js'

const view = { cwd: '/work/repo', home: '/home/u' }

describe('S3 canonical push form', () => {
  const denied = [
    'git -c remote.origin.push=HEAD:refs/heads/main push origin',
    'git push',
    'git push origin',
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push origin HEAD',
    'git push origin feature/x:main',
    'git push --tags origin feature/x',
    'git push origin feature/x other',
    'git push "$REMOTE" feature/x',
    'git push origin refs/heads/main',
    'git --git-dir=/x/.git push origin feature/x',
  ]
  for (const command of denied) {
    test(`[R17] denies a push outside git push [-u] <remote> <branch>: ${command}`, () => {
      expect(gitGate(command, view).deny).toBeString()
    })
  }

  test('[R17] the canonical form to a feature branch passes with no receipt', () => {
    for (const command of ['git push origin feature/x', 'git push -u origin feature/x', 'git push --set-upstream origin fix/y',
      'git -C /work/repo push origin feature/x', 'git add -A && git commit -m x && git push origin feature/x']) {
      expect(gitGate(command, view)).toEqual({})
    }
  })
})

const realRun: Runner = (argv, options) => {
  const result = Bun.spawnSync([...argv], { ...(options.cwd ? { cwd: options.cwd } : {}), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  return { code: result.exitCode, stdout: result.stdout.toString() }
}

describe('S3 codex-hooks check <sha>', () => {
  let root = ''
  let repo = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-'))
    repo = join(root, 'repo')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function commitCheck(exit: number): string {
    const out = join(root, 'seen.txt')
    writeFileSync(join(repo, 'scripts', 'check.sh'), `#!/bin/sh\ngit rev-parse HEAD > ${out}\nprintf 'status:%s\\n' "$(git status --porcelain)" >> ${out}\npwd >> ${out}\nexit ${exit}\n`)
    chmodSync(join(repo, 'scripts', 'check.sh'), 0o755)
    for (const argv of [['init', '-q', '-b', 'feature/x'], ['add', '-A'], ['commit', '-q', '-m', 'c']]) {
      if (realRun(['git', '-C', repo, ...argv], { timeoutMs: 10_000 }).code !== 0) throw new Error(`git ${argv[0]} failed`)
    }
    return realRun(['git', '-C', repo, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 }).stdout.trim()
  }

  // gh is stubbed: every call is recorded, nothing leaves the machine.
  function withGh(calls: string[][]): Runner {
    return (argv, options) => {
      if (argv[0] === 'gh') { calls.push([...argv]); return { code: 0, stdout: '{}' } }
      return realRun(argv, options)
    }
  }

  for (const [exit, state] of [[0, 'success'], [1, 'failure']] as const) {
    test(`[R17] check.sh exit ${exit} runs in a clean worktree at the sha and posts ${state}`, () => {
      const sha = commitCheck(exit)
      writeFileSync(join(repo, 'dirty.txt'), 'not committed\n')
      const calls: string[][] = []
      const result = runCheck(repo, sha.slice(0, 10), { run: withGh(calls), tmp: root, log: () => undefined })
      expect(result.state).toBe(state)
      const seen = readFileSync(join(root, 'seen.txt'), 'utf8').split('\n')
      expect(seen[0]).toBe(sha)
      expect(seen[1]).toBe('status:')
      expect(seen[2]).not.toBe(repo)
      expect(existsSync(seen[2] ?? '/nonexistent')).toBe(false)
      expect(calls).toHaveLength(1)
      const call = calls[0] ?? []
      expect(call.slice(0, 5)).toEqual(['gh', 'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`])
      expect(call).toContain(`state=${state}`)
      expect(call).toContain(`context=${STATUS_CONTEXT}`)
    })
  }

  test('[R17] an unknown sha posts nothing', () => {
    commitCheck(0)
    const calls: string[][] = []
    expect(() => runCheck(repo, 'f'.repeat(40), { run: withGh(calls), tmp: root, log: () => undefined })).toThrow()
    expect(calls).toEqual([])
  })
})

describe('S3 ruleset on main', () => {
  const answer = (stdout: string, code = 0): Runner => argv => argv[0] === 'gh' ? { code, stdout }
    : argv.includes('--show-toplevel') ? { code: 0, stdout: '/work/repo\n' } : { code: 1, stdout: '' }

  test('[R17] doctor warns when main has no ruleset and is quiet when a pull-request rule applies', () => {
    expect(rulesetCheck(answer('[]'), '/work/repo')?.status).toBe('warning')
    expect(rulesetCheck(answer('[]'), '/work/repo')?.message).toContain('ruleset')
    expect(rulesetCheck(answer(JSON.stringify([{ type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'codex-hooks/check' }] } }])), '/work/repo')?.status).toBe('ok')
    expect(rulesetCheck(answer('', 1), '/work/repo')?.status).toBe('warning')
  })

  test('[R17] session sanity reports a main branch without a ruleset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sanity-'))
    writeFileSync(join(root, 'config.toml'), 'model = "x"\napproval_policy = "never"\n[features]\nmulti_agent_v2 = true\n')
    writeFileSync(join(root, 'AGENTS.md'), 'x')
    const ctx: HookContext = {
      event: 'SessionStart', input: { cwd: '/work/repo' }, config: DEFAULT_CONFIG, home: root, codexHome: root, stateDir: root,
      now: () => 0, run: answer('[]'), gbrain: undefined, log: () => undefined,
    }
    const result = await sessionSanityHook(ctx)
    rmSync(root, { recursive: true, force: true })
    expect(result.context).toContain('ruleset')
  })
})
