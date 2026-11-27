import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../../codex-hooks/src/config.js'
import { runHook } from '../../../codex-hooks/src/entry.js'
import { gitGate } from '../../../codex-hooks/src/git-gate.js'
import { rulesetCheck } from '../../../codex-hooks/src/install.js'
import { appendActivity } from '../../../codex-hooks/src/post.js'
import { dangerReason, type SafetyView } from '../../../codex-hooks/src/safety.js'
import type { HookContext, Runner } from '../../../codex-hooks/src/types.js'

const view: SafetyView = { cwd: '/work/repo', home: '/home/u', branchOf: () => 'feature/x', exists: () => true, dirty: () => false, tmpDirs: ['/tmp'] }
const remote: SafetyView = { ...view, readFile: () => undefined }

describe('R3 sol: git gate takes only the canonical push', () => {
  for (const line of ['echo origin main | xargs git push', 'GIT_DIR=../other/.git git push origin feature/x', 'env GIT_SSH_COMMAND=x git push origin feature/x']) {
    test(`[R17] denied: ${line}`, () => {
      expect(gitGate(line, { cwd: '/work/repo', home: '/home/u' }).deny).toBeString()
    })
  }
  test('[R17] the plain canonical push still passes', () => {
    expect(gitGate('git push -u origin feature/x', { cwd: '/work/repo', home: '/home/u' }).deny).toBeUndefined()
  })
})

describe('R3 sol: the ruleset check wants every rule the design names', () => {
  const answer = (stdout: string): Runner => argv => argv[0] === 'gh' ? { code: 0, stdout }
    : argv.includes('--show-toplevel') ? { code: 0, stdout: '/work/repo\n' } : { code: 1, stdout: '' }
  const status = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'codex-hooks/check' }] } }
  test('[R17] a pull-request-only ruleset is not protection', () => {
    expect(rulesetCheck(answer('[{"type":"pull_request"}]'), '/work/repo')?.status).toBe('warning')
  })
  test('[R17] PR, no force push, no deletion and the codex-hooks/check status together are', () => {
    const full = JSON.stringify([{ type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' }, status])
    expect(rulesetCheck(answer(full), '/work/repo')?.status).toBe('ok')
    const other = JSON.stringify([{ type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/other' }] } }])
    expect(rulesetCheck(answer(other), '/work/repo')?.status).toBe('warning')
  })
})

describe('R3 sol: SQL and secret operands', () => {
  test('[R17] an attached -c/-e with DROP against a remote database is denied', () => {
    expect(dangerReason("psql -h db.example.com '-cDROP TABLE users'", remote)).toContain('DROP')
    expect(dangerReason("psql -h db.example.com --command='DROP TABLE users'", remote)).toContain('DROP')
    expect(dangerReason("mysql -h db.example.com '-eDROP TABLE users'", remote)).toContain('DROP')
  })
  test('[R17] cp -t names its sources last, so a .env source is denied', () => {
    expect(dangerReason('cp -t out .env', view)).toContain('.env')
    expect(dangerReason('cp .env.example .env', view)).toBeUndefined()
  })
  test('[R17] grep -e -q takes -q as the pattern, so it prints .env', () => {
    expect(dangerReason('grep -e -q .env', view)).toContain('.env')
    expect(dangerReason('grep -q KEY .env', view)).toBeUndefined()
    expect(dangerReason('grep -qe KEY .env', view)).toBeUndefined()
  })
})

describe('R3 sol: logs and malformed input', () => {
  test('[R17] the activity line masks a known secret in program names and cwd', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'activity-'))
    const secret = 'synthetic-secret-value-42'
    const ctx: HookContext = {
      event: 'PostToolUse', config: DEFAULT_CONFIG, home: stateDir, codexHome: stateDir, stateDir,
      input: { tool_name: 'shell', tool_input: { command: `/opt/${secret}/tool --x` }, cwd: `/work/${secret}`, session_id: 's', turn_id: 't' },
      now: () => 0, run: () => ({ code: 0, stdout: '' }), gbrain: undefined, log: () => undefined, secrets: [secret],
    }
    appendActivity(ctx, 'ran')
    const line = readFileSync(join(stateDir, 'activity.jsonl'), 'utf8')
    expect(line).not.toContain(secret)
    expect(line).toContain('[REDACTED]')
  })
  test('[R17] a PreToolUse envelope that is not an object with a tool name is denied', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'envelope-'))
    const env = { CODEX_HOOKS_STATE_DIR: stateDir, CODEX_HOOKS_CONFIG: join(stateDir, 'none.json') }
    const run: Runner = () => ({ code: 1, stdout: '' })
    for (const stdin of ['null', '[]', '"x"', '{}', '{"tool_name":"shell","tool_input":{}}']) {
      const out = JSON.parse(await runHook('PreToolUse', stdin, env, stateDir, run)) as { hookSpecificOutput?: { permissionDecision?: string } }
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    }
  })
})
