#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

setup_token=${TELEGRAM_BOT_TOKEN:-}
export -n setup_token
owner=${TELEGRAM_OWNER_ID:-${TELEGRAM_ALLOWED_USER_IDS:-}}
agent_name=${KROT_CODEX_AGENT_NAME:-}
workspace=${TELEGRAM_WORKSPACE_ROOT:-$HOME/krotov-workspace}
state=${TELEGRAM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/krotov-plugin}
unset TELEGRAM_BOT_TOKEN

setup_repo=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$setup_repo/plugin/scripts/setup-common.sh"
setup_clear_bridge_env

usage() {
  cat <<'HELP'
Использование
  ./install.sh [--start] [--agent-name NAME] [--workspace PATH] [--state-dir PATH]
               [--approval-mode standard|risky]
  ./install.sh --non-interactive --token-file PATH [--owner-id ID | --pair-code CODE] [--start]
  ./install.sh --dry-run

При обычном запуске токен вводится скрыто, а владелец подтверждает личку кодом.
Для автоматизации используйте приватный файл с токеном или TELEGRAM_BOT_TOKEN.
Если ID владельца известен, передайте --owner-id или TELEGRAM_OWNER_ID.
При повторном запуске используется сохранённый plugin/.env.
--approval-mode risky пропускает обычную диагностику и оставляет карточки для действий с риском.
--approval-mode standard возвращает обычную обработку подтверждений Codex.
--start включает пользовательскую службу и автозапуск. Нужен вход в Codex через ChatGPT.
HELP
}

start=0
dry_run=0
non_interactive=0
token_file=''
pair_code=''
approval_mode=''
while (( $# )); do
  case $1 in
    --owner-id|--token-file|--workspace|--state-dir|--agent-name|--pair-code|--approval-mode)
      (( $# >= 2 )) && [[ -n $2 && $2 != --* ]] || setup_fail 'После параметра нужно указать значение.'
      case $1 in
        --owner-id) owner=$2 ;;
        --token-file) token_file=$2 ;;
        --workspace) workspace=$2 ;;
        --state-dir) state=$2 ;;
        --agent-name) agent_name=$2 ;;
        --pair-code) pair_code=$2 ;;
        --approval-mode)
          case $2 in
            standard|risky) approval_mode=$2 ;;
            *) setup_fail 'Для --approval-mode выбери standard или risky.' ;;
          esac ;;
      esac
      shift 2 ;;
    --start) start=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --non-interactive) non_interactive=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) setup_fail 'Неизвестный параметр. Посмотри ./install.sh --help.' ;;
  esac
done

if (( dry_run )); then
  printf '%s\n' 'План: проверить зависимости и вход Codex, связать личку, установить зависимости проекта, запустить doctor и подготовить службу.'
  if [[ -n $approval_mode ]]; then printf 'Режим подтверждений: %s\n' "$approval_mode"; fi
  if (( start )); then printf '%s\n' 'После успешного doctor служба будет включена.'; fi
  exit 0
fi

setup_prerequisites curl jq systemctl
setup_lock
plugin_dir=$setup_repo/plugin
env_file=$plugin_dir/.env
unit_name=krotov-telegram.service
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit_file=$unit_dir/$unit_name

private_dir() {
  local path=$1
  [[ $path == /* && $path != *$'\n'* && $path != *$'\r'* &&
     $path != *'"'* && $path != *'\'* && $path != *'$'* ]] ||
    setup_fail 'Для рабочей папки и состояния нужны абсолютные пути без кавычек, обратной косой черты и знака доллара.'
  realpath -m -- "$path"
}

telegram_api() {
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$setup_token" "$1" |
    curl --silent --fail --max-time 15 --config -
}

tmp_env=''
tmp_unit=''
cleanup() {
  if [[ -n $tmp_env ]]; then rm -f -- "$tmp_env"; fi
  if [[ -n $tmp_unit ]]; then rm -f -- "$tmp_unit"; fi
}
trap cleanup EXIT

if [[ -e $env_file || -L $env_file ]]; then
  unset setup_token
  setup_private_file "$env_file"
  printf '%s\n' 'Использую существующий plugin/.env.'
  if [[ -n $approval_mode ]]; then
    tmp_env=$(mktemp "$plugin_dir/.env.XXXXXXXX")
    awk '!/^[[:space:]]*(export[[:space:]]+)?KROT_CODEX_(APPROVAL_MODE|APPROVALS)[[:space:]]*=/' \
      "$env_file" > "$tmp_env"
    printf 'KROT_CODEX_APPROVALS=1\nKROT_CODEX_APPROVAL_MODE=%s\n' "$approval_mode" >> "$tmp_env"
    mv -fT -- "$tmp_env" "$env_file"
    tmp_env=''
  fi
else
  workspace=$(private_dir "$workspace")
  state=$(private_dir "$state")
  [[ $workspace != / && $state != / && $state != "$workspace" && $state != "$workspace/"* ]] ||
    setup_fail 'Папка состояния должна находиться за пределами рабочей папки.'
  if [[ -n $token_file ]]; then
    setup_private_file "$token_file"
    setup_token=$(< "$token_file")
  elif [[ -z $setup_token && $non_interactive == 0 && -t 0 ]]; then
    read -r -s -p 'Вставь токен бота из BotFather. Ввод скрыт. ' setup_token
    printf '\n'
  fi
  [[ $setup_token =~ ^([1-9][0-9]{0,15}):[A-Za-z0-9_-]+$ ]] ||
    setup_fail 'Нужен действующий токен. Используй скрытый ввод, --token-file или TELEGRAM_BOT_TOKEN.'
  expected_bot=${BASH_REMATCH[1]}
  bot=$(telegram_api getMe) || setup_fail 'Telegram не подтвердил токен. Проверь токен и доступ VPS к Telegram.'
  bot_id=$(jq -er 'select(.ok == true) | .result.id | tostring' <<< "$bot") ||
    setup_fail 'Telegram не вернул ID бота.'
  [[ $bot_id == "$expected_bot" ]] || setup_fail 'ID бота не совпал с токеном.'
  bot_name=$(jq -er 'select(.ok == true) | .result.username' <<< "$bot") ||
    setup_fail 'Telegram не вернул имя бота.'
  if [[ -z $agent_name ]]; then
    agent_name=$(jq -er '.result.first_name // .result.username' <<< "$bot")
  fi
  [[ -n ${agent_name//[[:space:]]/} && ${#agent_name} -le 64 &&
     ! $agent_name =~ [[:cntrl:]] &&
     $agent_name != *'"'* && $agent_name != *'\'* && $agent_name != *'$'* ]] ||
    setup_fail 'Имя агента должно содержать от 1 до 64 символов без кавычек, обратной косой черты и знака доллара.'
  webhook=$(telegram_api getWebhookInfo) || setup_fail 'Не удалось проверить webhook бота.'
  jq -e '.ok == true and .result.url == ""' <<< "$webhook" >/dev/null ||
    setup_fail 'У этого бота активен webhook. Для установки используй нового бота или освободи токен у текущей интеграции.'
  printf 'Telegram подтвердил бота @%s.\n' "$bot_name"

  if [[ -z $owner ]]; then
    if [[ -n $pair_code ]]; then
      [[ $pair_code =~ ^krotov-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
        setup_fail 'Сгенерируй код как krotov-$(cat /proc/sys/kernel/random/uuid).'
      probe=$pair_code
    else
      [[ $non_interactive == 0 && -t 0 ]] || setup_fail 'Укажи --owner-id или предложи владельцу отправить --pair-code.'
      probe=krotov-$(< /proc/sys/kernel/random/uuid)
      printf 'Открой личку @%s, нажми Start и отправь боту эту строку.\n%s\n' "$bot_name" "$probe"
      read -r -p 'После отправки нажми Enter. ' _
    fi
    updates=$(telegram_api getUpdates) ||
      setup_fail 'Не удалось получить контрольное сообщение. Убедись, что токен свободен.'
    owner=$(jq -er --arg probe "$probe" '
      select(.ok == true)
      | first(.result[] | .message | select(.chat.type == "private" and .from.is_bot == false
          and .chat.id == .from.id and .text == $probe) | .from.id | tostring)
    ' <<< "$updates") || setup_fail 'Контрольное сообщение не найдено. Повтори установку и отправь новый код боту в личку.'
  fi
  [[ $owner =~ ^[1-9][0-9]{0,15}$ && $owner -lt 9007199254740992 ]] ||
    setup_fail 'ID владельца должен быть положительным числом из Telegram.'

  if [[ ! -d $workspace ]]; then install -d -m 700 -- "$workspace"; fi
  if [[ ! -d $state ]]; then install -d -m 700 -- "$state"; fi
  tmp_env=$(mktemp "$plugin_dir/.env.XXXXXXXX")
  {
    printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_EXPECTED_BOT_ID=%s\n' "$setup_token" "$bot_id"
    printf 'TELEGRAM_ALLOWED_USER_IDS=%s\nTELEGRAM_ALLOWED_CHAT_IDS=%s\n' "$owner" "$owner"
    printf 'TELEGRAM_STATE_DIR="%s"\nTELEGRAM_WORKSPACE_ROOT="%s"\n' "$state" "$workspace"
    printf 'KROT_CODEX_AGENT_NAME="%s"\n' "$agent_name"
    printf '%s\n' 'KROT_CODEX_APPROVALS=1'
    if [[ -n $approval_mode ]]; then printf 'KROT_CODEX_APPROVAL_MODE=%s\n' "$approval_mode"; fi
  } > "$tmp_env"
  unset setup_token
  ln -- "$tmp_env" "$env_file" || setup_fail 'Не удалось сохранить plugin/.env. Проверь, не появился ли файл параллельно.'
  if [[ ! -e $workspace/AGENTS.md && ! -L $workspace/AGENTS.md ]]; then
    (set -o noclobber; printf '%s\n' '# Профиль агента' '' \
      "Твоё имя — $agent_name. Ты работаешь с владельцем в личке Telegram." '' \
      'Владелец может дополнить этот профиль своими задачами, правилами работы и стилем ответов.' '' \
      '## Ответы в Telegram' '' \
      'Начинай рабочий отчёт с результата и выделяй его жирным. Отделяй смысловые блоки пустой строкой.' \
      'Для сравнения нескольких однотипных результатов используй короткую Markdown-таблицу. Для отдельных находок используй список.' \
      'Под сравнением коротко укажи, что проверил и где ещё нужен результат.' > "$workspace/AGENTS.md")
  fi
fi

cd "$plugin_dir"
setup_install_deps
"$setup_bun" --no-env-file build src/codex/server.ts --target=bun >/dev/null ||
  setup_fail 'Не удалось собрать мост. Проверь полноту клона и зависимости.'
"$setup_bun" run doctor || setup_fail 'Исправь замечания doctor и повтори установку. Настройки уже сохранены.'

unit_escape() {
  local text=$1
  [[ $text != *$'\r'* && $text != *$'\n'* ]] || setup_fail 'В пути службы есть перенос строки.'
  text=${text//%/%%}
  text=${text//\\/\\\\}
  printf '%s' "${text//\"/\\\"}"
}

# Keep the user service on the exact checkout, including paths with spaces.
install -d -- "$unit_dir"
tmp_unit=$(mktemp "$unit_dir/.krotov-telegram.XXXXXXXX")
{
  printf '%s\n' '[Unit]' 'Description=Krotov Plugin Telegram bridge for Codex' '[Service]' 'Type=simple'
  printf 'WorkingDirectory=%s\n' "${plugin_dir//%/%%}"
  printf 'Environment="PATH=%s"\n' "$(unit_escape "$(dirname -- "$setup_bun"):$(dirname -- "$(command -v codex)"):/usr/local/bin:/usr/bin:/bin")"
  printf 'ExecStart="%s" run start\n' "$(unit_escape "$setup_bun")"
  printf '%s\n' 'Restart=on-failure' 'RestartSec=10s' 'UMask=0077' '[Install]' 'WantedBy=default.target'
} > "$tmp_unit"
chmod 644 -- "$tmp_unit"
if [[ ! -e $unit_file && ! -L $unit_file ]]; then
  ln -- "$tmp_unit" "$unit_file" || setup_fail 'Не удалось создать файл службы.'
elif [[ -L $unit_file ]] || ! cmp -s -- "$tmp_unit" "$unit_file"; then
  printf 'Сохранил существующий файл службы %s.\n' "$unit_file"
  (( ! start )) || setup_fail 'Для автозапуска сначала проверь существующий файл службы и путь к этой копии.'
fi

if (( start )); then
  systemctl --user daemon-reload ||
    setup_fail 'Открой обычное SSH-подключение под пользователем моста: нужен пользовательский systemd.'
  loginctl enable-linger "$(id -un)" ||
    setup_fail 'Для автозапуска попроси администратора выполнить sudo loginctl enable-linger ИМЯ и повтори ./install.sh --start.'
  systemctl --user enable --now "$unit_name"
  systemctl --user is-active --quiet "$unit_name" ||
    setup_fail 'Служба не запустилась. Посмотри journalctl --user -u krotov-telegram.service -n 50.'
  printf '%s\n' 'Служба запущена. Отправь боту /help и обычный вопрос, чтобы проверить связь с Codex.'
else
  printf '%s\n' 'Проверка пройдена. Для запуска и автозапуска выполни ./install.sh --start.'
fi
