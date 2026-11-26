import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function hasMemoriesSetting(path: string): boolean {
  try {
    const { features } = Bun.TOML.parse(readFileSync(path, 'utf8')) as { features?: unknown }
    return features !== undefined && (
      typeof features !== 'object' || features === null || Array.isArray(features) ||
      Object.hasOwn(features, 'memories')
    )
  } catch (error) {
    // A missing layer has no preference. For any other error, let Codex handle it.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function codexAppServerCommand(
  cwd: string, env: NodeJS.ProcessEnv, defaultEnabled: boolean,
): readonly [string, ...string[]] {
  const command = ['codex', 'app-server', '--listen', 'stdio://'] as const
  if (!defaultEnabled) return command

  const codexHome = env.CODEX_HOME ? resolve(cwd, env.CODEX_HOME) : join(env.HOME ?? homedir(), '.codex')
  if (hasMemoriesSetting(join(codexHome, 'config.toml')) || hasMemoriesSetting('/etc/codex/config.toml')) {
    return command
  }

  // Project settings can be more specific than the Codex home configuration.
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (hasMemoriesSetting(join(directory, '.codex', 'config.toml'))) return command
    if (directory === dirname(directory)) break
  }

  return [...command, '-c', 'features.memories=true']
}
