# Changelog

Fork of Krotov-plugin by Pavel Krotov (Apache-2.0, see [NOTICE](NOTICE)); fork point
upstream `bb1d1ce`. Per-commit details for the first changes: [CHANGES.md](CHANGES.md).

## v0.5.0 – 2026-11-27

[Release notes in English and Russian](docs/releases/v0.5.0.md).

### Added

- Multi-user roles and chats behind `KROT_MULTIUSER=1`, off by default. The owner
  stays the only person with full access; members and guests are added with
  `/users` (list, add, remove, role, one-time invite code) or `KROT_MEMBER_USER_IDS`,
  and groups are approved with `/chats`. Member and guest messages run in their
  own Codex app-server per role, with a clean settings folder, an allowlist of
  skills and URL-only MCP servers (`public-access.toml`), and a permission hook
  (`--thread-role`) that denies every tool call from their threads. The bridge
  refuses to start in this mode until the hook, the policy token and
  `KROT_PUBLIC_WORKSPACE_ROOT` are set and each role passes a live hook check.
  Their exchanges are journalled in Brain as foreign and never enter owner memory.
  [Setup](plugin/docs/claude-compatibility.md)
- Render "eyes": after every reply the bridge compares what Telegram shows with
  the model's text (raw markup, broken HTML, a reply sent as a file, a block split
  across messages). The next turn gets one short note, the `render_preview` tool
  shows a Telegram-like picture of a reply or a draft, and `/doctor` lists the last
  render diffs. The history file keeps metadata only, never reply text.
- `/doctor tests`: a short smoke set (settings parse, Telegram `getMe` for the
  expected bot, Codex App Server handshake, hooks pack, writable state directory)
  with pass or fail per check; secrets are masked.
- Install by link: [AGENT_INSTALL.md](AGENT_INSTALL.md) walks a Codex agent from the
  repository link to a tested install and a report to the owner. Both READMEs link it.
- Automatic self-update, off by default (`KROT_AUTO_UPDATE=1`, every
  `KROT_AUTO_UPDATE_HOURS`, default 6), and the owner command `/cc update`. A new
  fast-forward commit is checked in a staged copy (tests and doctor) and applied
  only while the bridge is idle. After its health mark it stays on probation for
  10 minutes; a third crash rolls it back, and a rolled-back commit is never
  installed automatically again. `/doctor` shows the setting, the last attempt and
  the bad commits. [Automatic update](plugin/docs/install.md#automatic-update)
- `/status` and `/doctor` show the prompt-cache share of Codex input.

### Fixed

- Brain: foreign text (forwards, replies to another person's message) stays out of
  owner side threads, and a side reply target is judged by the same provenance rule
  as an incoming message. Member and guest exchanges stay out of the owner's recent
  window and of the handoff scan.
- Compaction and side turns wait while a restart or an update is in progress.
- Multi-user configuration errors stop the bridge with the fatal exit code (78) and
  are printed.

## v0.4.0 – 2026-11-27

[Release notes in English and Russian](docs/releases/v0.4.0.md).

### Added

- Full access in approval mode `never` requires verified system-wide managed hooks.
  Run `./install.sh --hooks` as the dedicated bridge user, run the printed
  `sudo install …` line as an administrator, then rerun the installer and check
  `/doctor`. The hooks protect `AGENTS.md` and `AGENTS.override.md` in Codex home.
- Codex Brain stores owner facts and open tasks in the private memory directory.
  Forwarded and foreign input is isolated from owner memory. PreCompact saves a
  handoff before compaction, and the SessionStart hook sets its additional context limit
  to 6,000. Open `/memory` to inspect or manage the store.
- `/usage` shows local token trends for 1, 7 or 30 days, and the analytics
  script exports JSON. [Usage analytics](docs/usage-analytics.md) · [#9](https://github.com/qwwiwi/codex-cli-telegram-plugin/pull/9)
- Fresh installations with Brain off default to native Codex memories for the
  local backend when Codex has no explicit setting. `--no-memories` skips the
  default. [Native memory settings](plugin/docs/install.md#native-codex-memories) · [#10](https://github.com/qwwiwi/codex-cli-telegram-plugin/pull/10)

### Fixed

- Telegram retries recheck the bot-wide cooldown before sending, including when
  another request extends the pause during a retry. [#4](https://github.com/qwwiwi/codex-cli-telegram-plugin/issues/4)
- Telegram reply splitting preserves tag, entity and text boundaries. The
  bridge migrates saved legacy queue entries before replay, redacting across
  old chunk cuts and preserving delivery receipts. [#7](https://github.com/qwwiwi/codex-cli-telegram-plugin/issues/7)

## v0.3.1.1

Fix release on top of v0.3.1. Release notes: [docs/releases/v0.3.1.1.md](docs/releases/v0.3.1.1.md).

### Fixed

- Paragraphs are preserved in long replies. Plain prose goes as Telegram HTML with the
  empty line between paragraphs kept; a Rich Message is used only for Markdown that only
  Telegram renders (a table, math, a task list, `<details>`, a footnote). Long HTML
  replies are split on tag and entity boundaries within Telegram's parsed length, and
  owner-requested edits are rendered as HTML too.
- Inter-agent messages show their real sender, marked verified or unverified. The sender
  comes from `fromAgent` or the `X-From-Agent` header (verified), else from a leading
  `[Inter-agent от <sender> → <recipient>]` line (shown as «не подтверждён»,
  unverified), else `unknown`; `agentId` is no longer used for display. The
  verification survives restarts and is carried into the Codex turn, the side prompt,
  the recovery notice and the final reply.
- Parallel replies without false "parallel stream" errors: replies no longer stall behind
  status edits and the HUD card. Owner replies get their own send queue and reserved
  slots of the per-chat minute budget, status edits leave room for sends, the HUD card
  move skips stale refreshes, and a queue notice is sent only to a message that still
  waits and is cancelled on pickup.
- Secrets are redacted in the source text before HTML rendering on the reply and edit
  paths, and in queued and replayed messages: saved reply parts from an older outbox are
  joined, redacted and re-split on load, so a secret cut across two parts is masked
  before replay.
- Link-preserving fallback: when Telegram refuses a part's HTML, the plain-text fallback
  keeps link destinations after their text («text (url)») while the part fits Telegram's
  limit, instead of escaping the whole HTML.
- A refused diagram is sent as a numbered flow instead of raw node kinds and index pairs.

### Known limitations

- See [issue #7](https://github.com/qwwiwi/codex-cli-telegram-plugin/issues/7).

## v0.1.0 – 2026-11-26

First public release.

### Added

- Parallel side threads (`KROT_CODEX_PARALLEL=1`): a message that arrives while a task
  runs is answered in a side thread. `KROT_CODEX_MAX_PARALLEL` sets the total, 1 to 8
  threads with the main one, so up to 7 side threads; default 2. Side threads fork
  from the main thread at its last finished turn so they can reuse its prompt cache
  (hit rate not measured yet); when Codex refuses a fork, the bridge starts a fresh
  thread. (`3d3c50a`, `027d394`,
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

### Inherited from upstream, documented

- Codex subagents (`multi_agent_v2`): approval requests from child threads go to the
  owner as Telegram cards. Comes from the upstream fork point; kept and documented in
  this release.
