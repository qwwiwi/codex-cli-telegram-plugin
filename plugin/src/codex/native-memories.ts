import { CodexRpc, object } from './rpc.js'

const localAppServer = ['codex', 'app-server', '--listen', 'stdio://'] as const
const probeTimeoutMs = 5000

export async function codexAppServerCommand(
  cwd: string, env: NodeJS.ProcessEnv, defaultEnabled: boolean,
  command: readonly [string, ...string[]] = localAppServer,
): Promise<readonly [string, ...string[]]> {
  if (!defaultEnabled) return command

  // Only Codex knows which project layers are trusted and which managed layers apply.
  const probe = new CodexRpc(cwd, env, () => {}, () => {}, command)
  try {
    await probe.initialize(probeTimeoutMs)
    const { config, origins } = await probe.request('config/read', { cwd }, probeTimeoutMs)
    const features = object(object(config).features)
    if (!origins || typeof origins !== 'object' || Array.isArray(origins)) return command
    if (features.memories === false && !Object.hasOwn(origins, 'features.memories')) {
      return [...command, '-c', 'features.memories=true']
    }
  } catch {
    // An unavailable probe leaves the user's Codex configuration in effect.
  } finally {
    probe.close()
  }

  return command
}
