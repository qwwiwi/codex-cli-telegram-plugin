# Changelog

Fork of Krotov-plugin by Pavel Krotov (Apache-2.0, see [NOTICE](NOTICE)); fork point
upstream `bb1d1ce`. Per-commit details for the first changes: [CHANGES.md](CHANGES.md).

## v0.1.0 – 2026-11-26

First public release.

### Added

- Parallel side threads (`KROT_CODEX_PARALLEL=1`): a message that arrives while a task
  runs is answered in a side thread. `KROT_CODEX_MAX_PARALLEL` sets the total, 1 to 8
  threads with the main one, so up to 7 side threads; default 2. A side thread is a
  fork of the main thread at its last finished turn and reuses its prompt cache; when
  Codex refuses a fork, the bridge starts a fresh thread. (`3d3c50a`, `027d394`,
  `34aa9a5`, `2cc9e05`)
- Agent webhook (`KROT_AGENT_WEBHOOK_LISTEN`, `KROT_AGENT_WEBHOOK_TOKEN`,
  `KROT_AGENT_WEBHOOK_ALLOW_IPS`): other agents send messages over HTTP; a token, an IP
  allowlist or both are required. Agent turns run under a restricted policy:
  workspace-write sandbox, no approvals, no owner state, memory, attachments or bridge
  restart. Each queued input keeps its origin (owner or agent) across restarts; a lost
  agent message is kept as a dead letter. (`49c29de`, `730f8fd`, `9c05134`, `e746bae`,
  `d6deb45`, `2cc9e05`)
- Codex limits line in the HUD, shown as the used percent, weekly window first, with
  the weekly reset time. (`23d1804`, `92e2d25`)
- Cached share of the last turn's input in the HUD («кеш N%»). (`027d394`)
- Autonomous sandbox mode `KROT_CODEX_SANDBOX=danger-full-access`. (`9ead1f9`)
- `GH_CONFIG_DIR` and `GBRAIN_BEARER` (bearer token for HTTP MCP servers) passed to
  Codex. (`26462e1`, `49c29de`)
- Docs: English and Russian README, `docs/ARCHITECTURE.md`, `NOTICE`, MCP server setup
  in `plugin/docs/install.md`, this changelog and `ROADMAP.md`.

### Changed

- The HUD card moves under each accepted owner message, so it sits above the reply;
  turn end and side-thread end only refresh it in place. Concurrent replies share one
  wait for the card move. (`de24369`, `064ba09`, `7acff76`)
- The bot deletes its own "pinned a message" service lines after HUD re-pins.
  (`88d5a1c`)
- Codex subagents (`multi_agent_v2`): approval requests from child threads go to the
  owner as Telegram cards (inherited from upstream, kept in this release).
