// Keep Telegram credentials and unrelated service environment out of Codex.
// GBRAIN_BEARER is the key Codex MCP servers read through bearer_token_env_var.
export const codexEnvironment = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TEMP|TMP|CODEX_HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GH_CONFIG_DIR|GBRAIN_BEARER)$/i
