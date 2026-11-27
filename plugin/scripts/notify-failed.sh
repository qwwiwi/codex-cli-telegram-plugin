#!/usr/bin/env bash
# OnFailure notifier for krotov-telegram.service: systemd runs it once when the start limit stops the
# bridge. Plain bash and curl, outside the bun code path, so a broken bridge cannot break the notice.
# Usage: notify-failed.sh [path to plugin/.env]
set -euo pipefail

env_file=${1:-"$(dirname -- "$0")/../.env"}

# Exit 78 is a fatal setup error the bridge already reported itself (fatal.json and one message).
# systemd 251+ passes the failed unit's exit status as MONITOR_EXIT_STATUS.
if [[ ${MONITOR_EXIT_STATUS:-} == 78 ]]; then
  echo 'notify-failed: exit 78 was already reported by the bridge; nothing to send'
  exit 0
fi
if [[ ! -r $env_file ]]; then
  echo "notify-failed: cannot read $env_file" >&2
  exit 1
fi

# Last assignment wins, as in the bridge; surrounding double quotes are dropped. The file is never sourced.
value() {
  local line
  line=$(grep -E "^$1=" -- "$env_file" | tail -n 1 || true)
  line=${line#*=}
  line=${line#\"}
  printf '%s' "${line%\"}"
}

token=$(value TELEGRAM_BOT_TOKEN)
chat=$(value TELEGRAM_ALLOWED_CHAT_IDS)
chat=${chat%%,*}
if [[ ! $token =~ ^[0-9]+:[A-Za-z0-9_-]+$ || ! $chat =~ ^-?[0-9]+$ ]]; then
  echo 'notify-failed: TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_CHAT_IDS is missing in plugin/.env' >&2
  exit 1
fi

text='Мост остановлен: systemd прекратил перезапуски после нескольких падений подряд.

Что сделать на сервере:
1. journalctl --user -u krotov-telegram.service -n 50 — посмотреть причину.
2. Исправить причину.
3. systemctl --user reset-failed krotov-telegram.service && systemctl --user start krotov-telegram.service'

echo 'notify-failed: sending the failure notice to the owner'
# The token goes through the curl config on stdin, never through argv.
printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
  curl --silent --fail --max-time 15 --config - --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" >/dev/null
echo 'notify-failed: done'
