import { CodexRpc, LOCAL_CODEX_COMMAND, object } from './rpc.js'

const probeTimeoutMs = 5000

export async function codexAppServerCommand(
  cwd: string, env: NodeJS.ProcessEnv, defaults: { nativeEnabled: boolean; brainEnabled: boolean },
  command: readonly [string, ...string[]] = LOCAL_CODEX_COMMAND,
): Promise<readonly [string, ...string[]]> {
  // Brain manages the bridge's owner memory by default. Explicit Codex configuration
  // still applies because the command is returned without a feature override.
  if (!defaults.nativeEnabled || defaults.brainEnabled) return command

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
