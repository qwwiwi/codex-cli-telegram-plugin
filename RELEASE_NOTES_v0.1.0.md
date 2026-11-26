# codex-cli-telegram-plugin v0.1.0

First public release. A Telegram bridge for OpenAI Codex (`codex app-server`), fork
of Krotov-plugin by Pavel Krotov (Apache-2.0, see NOTICE); fork point upstream
`bb1d1ce`. Per-commit details for the first changes: CHANGES.md.

## What is in it

- **Parallel side threads (opt-in).** Off by default; turn on with
  `KROT_CODEX_PARALLEL=1`. Then a new message that arrives while a task runs gets its
  own side thread instead of waiting. `KROT_CODEX_MAX_PARALLEL` sets the total number
  of threads with the main one: default 2, at most 8, so up to 7 side threads. Side
  threads fork from the main thread so they can reuse its prompt cache (hit rate not
  measured yet).
- **HUD card over the answer.** The pinned card with context use, model, limits and
  the cached share of the last turn moves under each new message, right above the
  reply.
- **Limits as used percent.** How much of each Codex limit window is spent, weekly
  window first, with the reset time.
- **Agent webhook.** Other agents can send the bot a message over HTTP (token and/or IP
  allowlist required). Their turns run under a restricted policy: no approvals,
  workspace-write sandbox, no access to your memory, attachments or bot restart.
- **MCP servers.** How to connect any MCP server is in `plugin/docs/install.md`.
- Also: autonomous sandbox mode (`KROT_CODEX_SANDBOX`), `GH_CONFIG_DIR` passed to
  Codex, cleanup of the bot's own pin service messages.

Inherited from upstream, documented:

- **Codex subagents.** With `multi_agent_v2` on in Codex, approval requests from
  subagents reach you as Telegram cards. This comes from the upstream fork point;
  v0.1.0 keeps it and documents it.

Install: see README.md. Full list: CHANGELOG.md. Next steps: ROADMAP.md.

## Коротко по-русски

Первый публичный релиз: Codex в Telegram с карточкой контекста над ответом, лимитами
в процентах и вебхуком для сообщений от других агентов.

Параллельные ветки включаются отдельно: `KROT_CODEX_PARALLEL=1`. По умолчанию всего
2 ветки (основная и одна боковая); `KROT_CODEX_MAX_PARALLEL` поднимает предел до 8,
то есть максимум 7 боковых веток. Боковая ветка ответвляется от основной, чтобы
переиспользовать её кеш промпта (доля попаданий в кеш пока не измерена).

Субагенты Codex (`multi_agent_v2`) унаследованы от исходного проекта: в этом релизе
они сохранены и описаны.
