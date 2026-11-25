# Shared by the Linux installer and updater.

setup_fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

setup_prerequisites() {
  [[ $(uname -s) == Linux ]] || setup_fail 'Установщик рассчитан на Linux с systemd.'
  (( EUID != 0 )) || setup_fail 'Подключись под обычным пользователем, который будет запускать бота.'
  export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  local tool
  for tool in bun codex git flock "$@"; do
    command -v "$tool" >/dev/null || setup_fail "Не найдена команда $tool. Подготовь зависимости по INSTALL-WITH-AGENT.md."
  done
  setup_bun=$(command -v bun)
}

setup_lock() {
  local lock
  lock=$(git -C "$setup_repo" rev-parse --path-format=absolute --git-path krotov-setup.lock) ||
    setup_fail 'Нужна рабочая копия, скачанная через git clone.'
  exec 9>"$lock"
  flock -n 9 || setup_fail 'Другой установщик или обновление уже работает с этой копией.'
}

setup_clear_bridge_env() {
  local name
  for name in ${!TELEGRAM_@} ${!KROT_CODEX_@} GROQ_API_KEY; do
    unset -v "$name"
  done
}

setup_private_file() {
  [[ -f $1 && ! -L $1 && -O $1 && -r $1 ]] ||
    setup_fail 'Нужен обычный читаемый файл текущего пользователя без символической ссылки.'
  local mode
  mode=$(stat -c '%a' -- "$1")
  (( (8#$mode & 077) == 0 )) || setup_fail 'Закрой доступ других пользователей к файлу через chmod 600.'
}

setup_clean_checkout() {
  local changes
  changes=$(git status --porcelain --untracked-files=normal) || return 1
  [[ -z $changes ]]
}

setup_install_deps() {
  "$setup_bun" install --frozen-lockfile --ignore-scripts
}
