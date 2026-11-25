# Krotov Plugin

Telegram-мост для OpenAI Codex. Поддерживает личный чат одного владельца, сохранённый диалог,
долгие задачи, вложения, статус работы и подтверждения действий.

## Установка

[Установка с нуля на Ubuntu или Debian VPS](plugin/docs/quickstart.md) ведёт от скачивания репозитория и создания бота до первого ответа в Telegram и автозапуска после перезагрузки. Понадобятся доступ к репозиторию, аккаунт ChatGPT с доступом к Codex и аккаунт Telegram.

Если плагин уже настроен, в каталоге `plugin/` выполните `bun run doctor`, чтобы проверить окружение перед запуском. Для ручного запуска выполните `bun run start`. Команда `/help` в личке бота покажет доступные действия.

[Подробная настройка и команды Telegram](plugin/docs/install.md). Тесты разработчика запускаются командой `bun test` в каталоге `plugin/`.

[Память предпочтений, уроков и навыков](plugin/docs/learning.md) можно включить отдельно после первого запуска.

Код развивается на основе [Krot-tg-plugin](https://github.com/example-owner/claude-reference)
и [Dashi Channel](https://github.com/qwwiwi/dashi-plugin-claude-code). Лицензия [Apache 2.0](LICENSE).
