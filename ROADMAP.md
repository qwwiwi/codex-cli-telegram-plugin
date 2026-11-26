# Roadmap

## Done in v0.1.0

- **Parallel side threads.** With `KROT_CODEX_PARALLEL=1`, a new message that arrives
  while a task runs gets its own side thread instead of waiting. Up to 7 side threads
  next to the main one (`KROT_CODEX_MAX_PARALLEL`, 1 to 8 threads in total, default 2).
- **Prompt-cache friendly thread fork.** Side threads fork from the main thread at its
  last finished turn so they can reuse its prompt cache (hit rate not measured yet). If
  Codex refuses a fork, the bridge starts a fresh thread.
- **HUD context card over the answer.** The pinned card with context use, model and
  limits moves under each new owner message, so it sits right above the reply. The
  card also shows the cached share of the last turn's input.
- **Limits as used percent.** The HUD shows how much of each Codex limit window is
  spent, weekly window first, with the weekly reset time.
- **Agent webhook.** Other agents can send a message over HTTP
  (`KROT_AGENT_WEBHOOK_LISTEN`, token and/or IP allowlist required). Their turns run
  under a restricted policy: workspace-write sandbox, no approvals, no access to owner
  state, memory, attachments or bridge restart.
- **MCP wiring documented.** How to connect any MCP server through Codex's own
  config and pass its token: [plugin/docs/install.md](plugin/docs/install.md#mcp-servers).
- Smaller: autonomous sandbox mode (`KROT_CODEX_SANDBOX`), `GH_CONFIG_DIR` passed to
  Codex, the bot deletes its own "pinned a message" service lines.

## Inherited from upstream, documented

- **Codex subagents.** With Codex's `multi_agent_v2` feature on, approval requests from
  subagent (child) threads reach the owner as Telegram cards. This comes from the
  upstream fork point; v0.1.0 keeps it and documents it.

Full list: [CHANGELOG.md](CHANGELOG.md).

## Next (v0.2.0)

- **Telegram widget components.** Render answers with the components from
  [qwwiwi/html-components](https://github.com/qwwiwi/html-components).
  Done when: answers can include a widget; plain-text fallback when Telegram rejects it.
  Status: done, not released yet: `send_component`, `update_component` and `component_schema`
  ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#widget-components)).
- **Measured cache hit rate.** Measure how often side threads and new turns hit the
  prompt cache over time, not only the share of the last turn.
  Done when: the bridge logs the cache hit rate per turn and shows it in the HUD.
