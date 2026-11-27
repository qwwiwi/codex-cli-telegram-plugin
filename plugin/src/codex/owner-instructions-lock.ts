import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const OWNER_INSTRUCTIONS_CHECK_PREFIX = 'Защита инструкций Codex: '
const instructionFiles = ['AGENTS.md', 'AGENTS.override.md']

export function ownerInstructionsHome(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return resolve(cwd, env.CODEX_HOME || join(env.HOME ?? homedir(), '.codex'))
}

function readAttributes(path: string): string {
  return execFileSync('lsattr', ['-d', '--', path], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
  })
}

function fileProtection(path: string, read: typeof readAttributes): 'protected' | 'mutable' | 'missing' | 'invalid' | 'unverified' {
  try {
    if (!lstatSync(path).isFile()) return 'invalid'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverified'
  }
  try {
    // lsattr prints the flags first. The path itself can contain the letter i.
    const flags = /^([-A-Za-z]{10,})[ \t]/.exec(read(path))?.[1]
    if (flags) return flags.includes('i') ? 'protected' : 'mutable'
  } catch {
    // lsattr may be missing, or the filesystem may not support the probe.
  }
  return 'unverified'
}

function ownerCommand(path: string): string {
  const arg = /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
  return `sudo chattr +i ${arg}`
}

const reasons = {
  mutable: '',
  missing: ' (файл отсутствует)',
  invalid: ' (путь должен указывать на обычный файл)',
  unverified: ' (не удалось проверить атрибут через lsattr)',
}

function checkFiles(codexHome: string, read: typeof readAttributes, startup: boolean) {
  const checks: { status: 'ok' | 'warning' | 'error'; message: string }[] = []
  for (const name of instructionFiles) {
    const path = join(codexHome, name)
    const protection = fileProtection(path, read)
    if (protection === 'missing' && (startup || name === 'AGENTS.override.md')) continue
    if (name === 'AGENTS.override.md' && protection === 'mutable') {
      checks.push({
        status: 'error',
        message: `${OWNER_INSTRUCTIONS_CHECK_PREFIX}AGENTS.override.md exists and is not owner-locked – Codex reads it instead of AGENTS.md. ` +
          `Команда для владельца: ${ownerCommand(path)}`,
      })
      continue
    }
    const label = OWNER_INSTRUCTIONS_CHECK_PREFIX + path
    checks.push(protection === 'protected'
      ? { status: 'ok', message: `${label}: protected` }
      : { status: 'warning', message: `${label}: NOT protected${reasons[protection]}. Команда для владельца: ${ownerCommand(path)}` })
  }
  return checks
}

export function ownerInstructionChecks(codexHome: string, read = readAttributes) {
  return checkFiles(codexHome, read, false)
}

export async function reportOwnerInstructionsAtStartup(codexHome: string, warn: (text: string) => void,
  sendOwner: (text: string) => Promise<unknown>, read = readAttributes): Promise<void> {
  const messages = checkFiles(codexHome, read, true).filter(check => check.status !== 'ok').map(check => check.message)
  if (messages.length === 0) return
  warn(messages.join(' | '))
  await sendOwner(messages.join('\n'))
}
