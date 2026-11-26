# codex-cli-telegram-plugin v0.1.0

First public release. A Telegram bridge for OpenAI Codex (`codex app-server`), forked
from Krotov-plugin by Pavel Krotov (Apache-2.0, see NOTICE).

## What is in it

- **Parallel side threads.** While a task runs, a new message gets its own side thread
  instead of waiting: up to 7 next to the main one (`KROT_CODEX_PARALLEL=1`,
  `KROT_CODEX_MAX_PARALLEL`). A side thread forks the main thread at its last finished
  turn, so it reuses the prompt cache.
- **HUD card over the answer.** The pinned card with context use, model, limits and
  the cached share of the last turn moves under each new message, right above the
  reply.
- **Limits as used percent.** How much of each Codex limit window is spent, weekly
  window first, with the reset time.
- **Codex subagents.** With `multi_agent_v2` on in Codex, approval requests from
  subagents reach you as Telegram cards.
- **Agent webhook.** Other agents can send the bot a message over HTTP (token and/or IP
  allowlist required). Their turns run under a restricted policy: no approvals,
  workspace-write sandbox, no access to your memory, attachments or bot restart.
- **MCP servers.** How to connect any MCP server is in `plugin/docs/install.md`.
- Also: autonomous sandbox mode (`KROT_CODEX_SANDBOX`), `GH_CONFIG_DIR` passed to
  Codex, cleanup of the bot's own pin service messages.

Install: see README.md. Full list: CHANGELOG.md. Next steps: ROADMAP.md.

## Коротко по-русски

Первый публичный релиз: Codex в Telegram с параллельными ветками (до 7), карточкой
контекста над ответом, лимитами в процентах, субагентами Codex и вебхуком для
сообщений от других агентов.
