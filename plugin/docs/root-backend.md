# Локальное реле Codex App Server

Стандартная установка запускает Codex от пользователя Telegram-моста. Реле подключает мост к отдельному Codex App Server, запущенному администратором под `root` на том же Linux-сервере. Используйте приватный Unix-сокет для одного моста и доверенного пользователя службы. App Server должен видеть тот же `/run`, что и реле.

## Установка

1. Выполните команды из корня репозитория. Храните установленные скрипты в каталоге, который может изменять только `root`.

   ```bash
   sudo apt install -y python3 python3-websockets
   sudo install -d -o root -g root -m 0755 /usr/libexec/krotov-plugin
   sudo install -o root -g root -m 0755 plugin/scripts/codex-root-relay.py plugin/scripts/codex-root-health.py /usr/libexec/krotov-plugin/
   sudo install -o root -g root -m 0644 plugin/scripts/root_backend.py /usr/libexec/krotov-plugin/
   sudo install -d -o root -g root -m 0755 /etc/krotov-plugin
   sudo test -e /etc/krotov-plugin/root-backend.json || sudo install -o root -g root -m 0600 examples/root-backend.json.example /etc/krotov-plugin/root-backend.json
   sudoedit /etc/krotov-plugin/root-backend.json
   ```

2. Укажите абсолютные пути своей установки. `socket` указывает на Unix-сокет вашего Codex App Server. `workspace` совпадает с `TELEGRAM_WORKSPACE_ROOT`. `telegram_inbox` совпадает с `inbox` внутри `TELEGRAM_STATE_DIR`. Для путей используйте результат `realpath`. Каталог сокета должен быть закрыт от записи пользователя моста. В `restart_unit` оставьте `null` или укажите точное имя одной службы systemd, если реле должно иметь право её перезапустить.

3. Через `visudo` разрешите пользователю моста запуск только установленного реле без аргументов. Замените `BRIDGE_USER` на имя этого пользователя.

   ```sudoers
   BRIDGE_USER ALL=(root) NOPASSWD: /usr/libexec/krotov-plugin/codex-root-relay.py ""
   ```

4. Добавьте строки в свои локальные `plugin/.env`, затем выполните `bun run doctor` из `plugin/` от пользователя моста. После успешной проверки перезапустите Telegram-мост и отправьте ему обычное сообщение.

   ```dotenv
   KROT_CODEX_APPROVALS=1
   KROT_CODEX_PROXY=/usr/libexec/krotov-plugin/codex-root-relay.py
   ```

Фото проходят через временные копии в закрытом каталоге реле. Допускается до 20 МиБ на файл, до 128 файлов и до 128 МиБ на одно соединение с App Server. Копии удаляются при закрытии соединения.

## Проверка и мониторинг

Проверка сокета из административной сессии выполняется командой `sudo /usr/libexec/krotov-plugin/codex-root-health.py --probe`.

Для регулярной проверки установите шаблоны таймера. Если в конфиге указано имя службы, монитор перезапустит её после двух неудачных проверок подряд. При `restart_unit: null` монитор только проверяет доступность сокета.

```bash
sudo install -o root -g root -m 0644 examples/krot-codex-health.service examples/krot-codex-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krot-codex-health.timer
```

Профиль агента, токен Telegram и рабочие данные хранятся на сервере пользователя. В каталоге `examples/` лежит конфиг с вымышленными путями.
