# Krotov Plugin

Telegram-мост для OpenAI Codex. Поддерживает личный чат одного владельца, сохранённый диалог,
долгие задачи, вложения, статус работы и подтверждения действий.

## Запуск

1. Установите Bun и Codex CLI. Войдите в Codex под учётной записью, от которой будет работать мост.
2. Создайте Telegram-бота. В каталоге `plugin/` скопируйте `.env.example` в `.env` и заполните настройки.
   Для `TELEGRAM_STATE_DIR` и `TELEGRAM_WORKSPACE_ROOT` укажите разные абсолютные каталоги.
3. В каталоге `plugin/` выполните `bun install --frozen-lockfile` и `bun run start` от непривилегированного пользователя.
4. Напишите своему боту в личку. Команда `/help` покажет управление.

Проверки запускаются командой `bun test` в каталоге `plugin/`.
Подробнее о настройке в [руководстве по установке](plugin/docs/install.md).

Код развивается на основе [Krot-tg-plugin](https://github.com/example-owner/claude-reference)
и [Dashi Channel](https://github.com/qwwiwi/dashi-plugin-claude-code). Лицензия [Apache 2.0](LICENSE).
