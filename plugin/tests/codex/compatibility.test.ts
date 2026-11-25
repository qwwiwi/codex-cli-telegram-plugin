import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sideQuestion, sideReply } from '../../src/codex/side-reply.js'
import { legacyCommand } from '../../src/codex/legacy-command.js'
import { assessPolicy, policyHookOutput } from '../../src/codex/legacy-policy.js'

test('preserves YAML denies, confirm overrides and restrictions on patch paths', () => {
  const policy = `version: 1
default_tier: allow
deny:
  bash_patterns: ["git push --force"]
  write_paths: ["**/secrets/**"]
confirm:
  bash_patterns: ["custom-deploy"]
confirm_overrides:
  builtin_rules: ["git push"]
`
  const call = (command: string) => assessPolicy(policy, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
  expect(call('git push --force').tier).toBe('deny')
  expect(call('git push origin main').tier).toBe('allow')
  expect(call('custom-deploy').tier).toBe('confirm')
  expect(assessPolicy(policy, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: /work/secrets/test\n*** End Patch' } }).tier).toBe('deny')
  expect(policyHookOutput(false)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny')
})

test('uses the operator-selected policy scope and declines invalid YAML safely', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf audit' } }
  const policy = 'version: 1\ndefault_tier: allow\nscopes:\n  strict:\n    deny:\n      bash_patterns: ["printf audit"]\n'
  expect(assessPolicy(policy, input).tier).toBe('allow')
  expect(assessPolicy(policy, input, 'strict').tier).toBe('deny')
  expect(assessPolicy('scopes: [', input).tier).toBe('deny')
})

test('protects the installer service from direct stop or restart commands', () => {
  const policy = 'version: 1\ndefault_tier: allow'
  const verdict = (command: string) => assessPolicy(policy, {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
  })
  expect(verdict('systemctl --user restart krotov-telegram.service')).toMatchObject({
    tier: 'deny', matchedRule: 'builtin:deny:own-channel',
  })
  expect(verdict('systemctl --user stop unrelated.service').tier).toBe('allow')
})

test('only eligible standalone questions can get a tool-free side reply', async () => {
  expect(sideQuestion('Отдельный вопрос: что такое JSON?')).toBe('что такое JSON?')
  expect(sideQuestion('Что такое JSON?')).toBe('Что такое JSON?')
  expect(sideQuestion('Поправь код. Что такое JSON?')).toBeUndefined()
  expect(await sideReply('что такое JSON?', [], async () => '{"answer":"Формат обмена данными."}')).toBe('Формат обмена данными.')
  expect(await sideReply('что мы остановили?', [], async () => '{"answer":""}')).toBeUndefined()
})

test('a configured legacy command expands arguments as text and rejects paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-command-'))
  try {
    mkdirSync(join(root, 'team'))
    writeFileSync(join(root, 'team', 'report.md'), '---\ndescription: Report\n---\nСделай отчёт для $ARGUMENTS.')
    expect(legacyCommand(root, 'team:report', 'команды поддержки')).toBe('Сделай отчёт для команды поддержки.')
    expect(legacyCommand(root, '../report', '')).toBeUndefined()
  } finally { rmSync(root, { force: true, recursive: true }) }
})
