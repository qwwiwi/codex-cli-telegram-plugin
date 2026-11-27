// Keep Telegram credentials and unrelated service environment out of Codex.
// GBRAIN_BEARER is the key Codex MCP servers read through bearer_token_env_var.
export const codexEnvironment = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TEMP|TMP|CODEX_HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GH_CONFIG_DIR|GBRAIN_BEARER)$/i

// The children /update and /update codex run (git, bun install, tsc, npm, systemctl): no credential at all.
// XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS stay for `systemctl --user`.
export const updateEnvironment = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TEMP|TMP|CODEX_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i

// Credentials the bridge reads from its environment; logs and replies redact
// each exact value (generic patterns miss opaque tokens).
const secretNames = ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'TELEGRAM_WEBHOOK_TOKEN', 'KROT_CODEX_POLICY_TOKEN',
  'KROT_AGENT_WEBHOOK_TOKEN', 'GBRAIN_BEARER'] as const

/** Exact secret values for redaction, read from the bridge environment. */
export function exactSecrets(env: Record<string, string | undefined>): string[] {
  return [...new Set(secretNames.map(name => env[name] ?? '').filter(Boolean))]
}
