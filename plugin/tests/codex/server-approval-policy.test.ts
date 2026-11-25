import { expect, test } from 'bun:test'
import { assessPolicy } from '../../src/codex/legacy-policy.js'
import { isRoutineServerCommand } from '../../src/codex/server-approval-policy.js'

const cwd = '/home/agent/workspace'
const routine = [
  'df -h',
  "/bin/bash -lc 'df -h && free -m'",
  'ps -eo pid,user,comm | head -15',
  'systemctl --no-pager show -p ActiveState,MainPID -- krotov-telegram.service',
  'journalctl --user -u krotov-telegram.service -n 50 --no-pager',
  "stat -c '%U %a' /etc/hostname",
]
const interactive = [
  'df -h && rm -r -- ./directory',
  'ls "$(touch ./side-effect)"',
  'ls > /etc/ssh/sshd_config',
  'ps e',
  'journalctl --vacuum-time=1d',
  'journalctl --user -u worker.service -n 2 --no-pager --rotate',
  'systemctl show -p Environment worker.service',
  'systemctl --host=other show -p ActiveState worker.service',
  'systemctl restart worker.service',
  'systemctl reboot',
  'stat /etc/shadow',
  'stat /home/agent/.codex/auth.json',
  'cat /etc/hostname',
  'runuser -u root -- stat /etc/hostname',
  '/tmp/df -h',
  'df -h &',
  'bash -lc "df -h" unexpected-argument',
]
for (const command of routine) test('auto-approves ' + command, () => {
  expect(isRoutineServerCommand(command, cwd)).toBe(true)
})
for (const command of interactive) test('keeps approval for ' + command, () => {
  expect(isRoutineServerCommand(command, cwd)).toBe(false)
})

test('the optional YAML hook detects a mixed dangerous command only in risky mode', () => {
  const yaml = 'version: 1\ndefault_tier: allow\n'
  const value = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'df -h && rm -r -- ./directory' } }
  expect(assessPolicy(yaml, value).tier).toBe('allow')
  expect(assessPolicy(yaml, value, 'main', true)).toMatchObject({ tier: 'confirm', matchedRule: 'server:risk' })
  value.tool_input.command = 'cat /home/agent/.ssh/id_ed25519'
  expect(assessPolicy(yaml, value, 'main', true).tier).toBe('deny')
})
