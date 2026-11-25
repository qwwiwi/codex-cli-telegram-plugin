#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
unset TELEGRAM_BOT_TOKEN

setup_repo=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$setup_repo/plugin/scripts/setup-common.sh"
setup_clear_bridge_env

restart=0
dry_run=0
while (( $# )); do
  case $1 in
    --restart) restart=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
      printf '%s\n' 'Использование: ./update.sh [--dry-run] [--restart]' \
        'Проверяет новую версию в отдельном каталоге и обновляет чистую рабочую копию. Состояние и plugin/.env сохраняются.' \
        'Укажи --restart только когда бот свободен. Перезапуск выполняется для службы этой копии.'
      exit 0 ;;
    *) setup_fail 'Неизвестный параметр. Посмотри ./update.sh --help.' ;;
  esac
  shift
done

if (( dry_run )); then
  printf '%s\n' 'План: получить upstream, проверить чистую копию, протестировать обновление в отдельном каталоге и обновить только fast-forward.'
  if (( restart )); then printf '%s\n' 'После проверки будет перезапущена служба этой копии.'; fi
  exit 0
fi

setup_prerequisites tar
setup_lock
cd "$setup_repo"
setup_clean_checkout || setup_fail 'Есть локальные изменения или новые файлы. Сохрани их перед обновлением.'
env_file=$setup_repo/plugin/.env
[[ -f $env_file ]] || setup_fail 'Сначала установи эту копию с помощью ./install.sh.'
setup_private_file "$env_file"
unit=krotov-telegram.service

restart_target() {
  local directory
  command -v systemctl >/dev/null || return 1
  directory=$(systemctl --user show --property=WorkingDirectory --value "$unit") || return 1
  [[ $directory == "$setup_repo/plugin" ]]
}

if (( restart )); then
  restart_target || setup_fail 'Пользовательская служба krotov-telegram.service не привязана к этой копии.'
fi

branch=$(git symbolic-ref --quiet --short HEAD) || setup_fail 'Переключись на ветку, которая отслеживает upstream.'
upstream_remote=$(git config --get "branch.$branch.remote") || setup_fail 'У текущей ветки не настроен upstream.'
[[ $upstream_remote != . && $upstream_remote != -* ]] || setup_fail 'Для обновления нужен удалённый upstream.'
old=$(git rev-parse --verify HEAD)
git fetch -- "$upstream_remote"
target=$(git rev-parse --verify '@{upstream}^{commit}') || setup_fail 'Не удалось определить версию upstream.'
if [[ $target == "$old" ]]; then
  printf '%s\n' 'Копия уже актуальна.'
  exit 0
fi
git merge-base --is-ancestor "$old" "$target" || setup_fail 'Ветка расходится с upstream. Разреши расхождение вручную.'

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
git archive "$target" | tar -xf - -C "$stage"
printf 'Проверяю версию %s в отдельном каталоге.\n' "${target:0:12}"
if ! (
  cd "$stage/plugin"
  setup_install_deps &&
    "$setup_bun" --no-env-file test &&
    "$setup_bun" --no-env-file build src/codex/server.ts --target=bun >/dev/null
); then setup_fail 'Проверка обновления не прошла. Рабочая копия и служба остались на прежней версии.'; fi

# Doctor derives paths from the saved copy, including the production token,
# only after tests have finished in the separate directory.
if ! (cd "$stage/plugin" && "$setup_bun" --env-file="$env_file" run doctor); then
  setup_fail 'Doctor обнаружил проблему. Обновление рабочей копии не применено.'
fi

[[ $(git rev-parse HEAD) == "$old" && $(git symbolic-ref --quiet --short HEAD) == "$branch" ]] &&
  setup_clean_checkout || setup_fail 'Рабочая копия изменилась во время проверки. Запусти обновление снова.'
if (( restart )); then
  restart_target || setup_fail 'Привязка пользовательской службы изменилась во время проверки.'
fi
git merge --ff-only "$target"

restore_previous() {
  printf '%s\n' 'Возвращаю предыдущую версию.' >&2
  if [[ $(git rev-parse HEAD) != "$target" ]] || ! setup_clean_checkout ||
      ! git reset --keep "$old" ||
      ! (cd "$setup_repo/plugin" && setup_install_deps); then
    setup_fail 'Автоматический откат не завершился. Проверь git status и зависимости перед запуском службы.'
  fi
}

if ! (cd "$setup_repo/plugin" && setup_install_deps); then
  restore_previous
  setup_fail 'Не удалось установить зависимости обновления.'
fi
if (( restart )); then
  if ! systemctl --user restart "$unit" || ! systemctl --user is-active --quiet "$unit"; then
    restore_previous
    systemctl --user restart "$unit" ||
      setup_fail 'Не удалось запустить и предыдущую версию. Проверь журнал службы.'
    setup_fail 'Новая версия не запустилась. Возвращена предыдущая версия.'
  fi
  printf '%s\n' 'Служба перезапущена. Проверь обычный ответ бота в Telegram.'
else
  printf '%s\n' 'Обновление готово. Когда бот свободен, перезапусти его командой systemctl --user restart krotov-telegram.service.'
fi
