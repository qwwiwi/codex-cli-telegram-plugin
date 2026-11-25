# Krotov Plugin deployment guide

The Telegram bridge runs as a dedicated non-root service user and serves one owner in a private chat. A test bot can run alongside the original Claude service. When switching to Codex with the same Telegram bot token, stop the old poller before starting the new one.

## Configure

- Install Bun and the official Codex CLI. Run the normal ChatGPT sign-in as the pilot service user before starting Telegram polling. The pilot checks the account type at startup.
- Set `TELEGRAM_BOT_TOKEN` to the test bot token and `TELEGRAM_EXPECTED_BOT_ID` to that bot's numeric ID. Keep the token in a private environment file.
- Set both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` to the owner’s numeric Telegram ID.
- Set `TELEGRAM_STATE_DIR` to an absolute, private directory dedicated to the pilot and outside the workspace. Set `TELEGRAM_WORKSPACE_ROOT` to an absolute path to the sandbox workspace. Put test agent instructions in `AGENTS.md` there.
- Set `KROT_CODEX_MODEL` if you want to override the default model in Codex.
- Set `KROT_CODEX_APPROVALS=1` for one-time Telegram approvals. Codex uses
  `on-request` with its workspace sandbox. The owner sees the exact command or
  file diff. Set `permission_gate.timeout_ms` in the Telegram config to change
  the two-minute timeout.
- To connect to a separately managed local Codex service, configure
  `KROT_CODEX_PROXY` as the absolute path to a root-owned, no-argument
  executable that relays stdin/stdout to the private Codex Unix socket. The
  supplied `scripts/codex-root-relay.py` requires Python 3 and `websockets`
  and limits the forwarded methods. Grant sudo only for that exact executable
  without arguments. Keep the server socket private
  and start the Telegram process as a dedicated non-root user.
- Set `GROQ_API_KEY` to enable voice transcription. Photos are sent to Codex as image input. Documents up to 20 MB are stored in the private Telegram inbox. Codex receives the local path and up to 64 KiB of content for UTF-8 text documents.
- Telegram albums are collected into one turn using `album.flush_ms`.
  While an owner turn is active, an assembled album can be delivered to that
  turn as a single follow-up. If the original turn ends before the album is
  ready, the entire album is queued for the next turn.
  Audio, video, video notes, GIFs and stickers carry Telegram metadata
  and a local file when the download succeeds. Static stickers may also
  be passed as images. Telegram replies carry quoted context, and forwarded
  text and authorship are marked as third-party data. The bridge accepts rich
  text forwards as well as plain Telegram messages.
- Results can be sent back as Telegram attachments. Codex stages the copy in
  `telegram-outbox/` inside the workspace and adds an `@@SEND_FILE:` line to
  its final reply. The bridge sends the file and removes the directive from the
  displayed text. The existing workspace and credential-file checks apply.
  On split Linux deployments, create the outbox before running the bridge.
  Give it the Codex backend owner and Telegram bridge group, with mode
  `2750`. The bridge also needs traverse permission on workspace parents.
  Codex prepares each outgoing copy with mode `0640`.
- Edit `TELEGRAM_STATE_DIR/config.json` or set `TELEGRAM_CONFIG_FILE` to
  use another file. The `commands` block enables or disables `help`,
  `status`, `stop`, `new`, and `reset`. Set `hud.enabled` to `true` for
  the pinned context meter and its **Сжать** button. Restart the Telegram
  bridge to apply configuration changes. Telegram command registration is
  scoped to the owner's private chat.
- The `richMessages` block controls Telegram rich Markdown and per-chat
  opt-outs. The bridge falls back to Telegram HTML when rich text is unavailable.
- Enable `memory.enabled` and set `memory.workspace_path` to append completed
  turns to `core/hot/recent.md` and a private verbose journal. Configure
  `memory.logs_path` separately. Startup, reset and context compaction write a
  handoff snapshot. The Telegram bridge needs write access to the hot-memory
  directory and journal directory. Credentials recognized by the plugin
  are redacted before new entries are written. With systemd
  `ProtectSystem=strict`, allow writes to the hot-memory directory explicitly.
- Set `outbox.enabled` to retry undelivered text after a Telegram flood ban.
  The bridge logs ambiguous delivery failures and avoids replaying them.
- Install the example `krot-codex-health` systemd service and timer for the
  supervised Linux backend. It restarts only the dedicated example-agent App Server
  after two failed local probes. The bridge separately attempts to interrupt a
  silent turn after `status.ttl_ms`, while allowing managed worker processes
  and pending approvals to continue.
- A 👀 reaction acknowledges messages from the owner. The `status` block
  controls the `working -- Ns` bubble, its update cadence
  (`status.interval_ms`), and cleanup (`status.delete_on_complete`).
  `status.chat_action.enabled` controls the native typing indicator.
  `status.thoughts.enabled` lets the bubble show brief, public progress
  commentary from Codex. Tool arguments are summarized and secrets are masked.
  The bubble and typing indicator stay active while Codex reports a running
  turn or a managed background job or subagent. Detached processes without
  Codex lifecycle events are outside the activity feed.
- From `plugin/`, run `bun install` and `bun run start:codex`. In a deployment, use the same environment variables with the bundled entry point.

## Telegram controls

- `/help` lists the enabled commands. `/status` shows session activity,
  permissions and the model and context usage once received from Codex.
- `/stop` interrupts the current turn. `/new` and `/reset force` start a
  new conversation on the next message and leave previous history on disk.
  Incoming requests and album fragments wait on disk (up to 16 batches).
  Restart restores batches that have not started. A started request is not
  replayed because it may already have executed commands.
  `/stop` cancels the current turn and its pending continuation. Queued
  requests and albums keep their place. `/new` can interrupt the current turn
  to open a fresh conversation.
  When an already-returned turn has managed background jobs still running in
  the dedicated Linux backend, `/stop` restarts that backend to terminate them.
- `/compact` and `/cc compact` compact the current context through Codex.
  The pinned **Сжать** button performs the same operation.
- `/cc context` and `/cc status` show the same information as `/status`.
  `/cc clear` explains how to confirm a reset.
- `/keys` opens buttons for status, stop, compaction and help.
- `/mirror on|off|status` controls the live progress card. It shows the
  current Codex stage and a limited tail of reported terminal output.
  Recognized secrets are redacted before display. The initial setting
  comes from `tmux_mirror.enabled`; subsequent Telegram changes persist.
- `/lease <scope>[; ttl=48h]` grants a time-limited instruction to act within
  the given scope. `/lease` lists active mandates, and
  `/lease revoke <ID>` revokes one. A mandate guides the agent on future
  turns and does not change sandbox rules or approval requirements. Codex
  can mark a mandate offered to its turn as used after finishing its task.
  The owner can also mark it manually with `/lease consume <ID>`.
- `/cc model [name]` lists and selects models available to the account.
  Use `/cc model default` for `KROT_CODEX_MODEL` or the catalog default.
  The selected model applies to subsequent turns without losing the conversation.
- `/cc resume [number or ID]` lists or switches between up to ten
  conversations previously used by this Telegram bridge.
- `/cc export` sends the current conversation as Markdown, up to 100 turns.
  It exports user and final assistant messages, strips channel directives,
  redacts recognized secrets, and leaves out tool logs and reasoning.
- `/cc archive YYYY-MM-DD resume` opens a new Codex conversation with
  the available text from that day of the Claude archive as background.
  It does not import Claude's runtime, tools, or session ID.
- `/cc cost` shows account usage as percentage of the limits reported by
  Codex. The managed ChatGPT account may not report a cost per conversation.
- `/goal <outcome and completion criteria>` starts a native Codex Goal.
  Codex can continue it across turns with a 60,000-token budget for the goal.
  `/goal status`, `/goal pause`, `/goal resume`, and `/goal cancel`
  inspect or control it. `/stop` pauses an active goal. Completed plan
  steps appear as Telegram milestones and the current plan in the status pin.
  If the runtime omits its plan tool, public progress commentary beginning
  with `Веха:` can publish the same milestone.
  Native subagents can work on independent steps when the backend offers
  the delegation tools. Approvals still use the same Telegram cards.
- Reply to a message with `/pin`, `/unpin` or `/react 👍` to act on it.
  `/edit <text>` replaces an ordinary bot text reply. Natural requests such
  as «закрепи» or «отредактируй, сделай короче» also work when quoted.
  `/get [instruction]` reads a quoted attachment from the owner's chat.

## Verify

- Send text in the owner’s private chat and check the reply and the typing indicator.
- Send a voice note, a photo with a caption and a text document. Ask for the
  document result as a new attachment and verify the returned file contents.
- Ask Codex to remember a unique test phrase, restart the pilot and ask for the phrase. Send `/new` and confirm the next request uses a new conversation.
- Start a test task and send `/stop` to interrupt it. Try a new message afterward.
- Check that a message from another account or a group receives no reply.
- Confirm that only the intended service is polling the production bot.

## Local task submission

Set both `TELEGRAM_WEBHOOK_PORT` and `TELEGRAM_WEBHOOK_TOKEN` to enable the
loopback listener on `127.0.0.1`. POST the legacy envelope
`{"message":"task text","chatId":123,"agentId":"dashi-channel"}` to
`/hooks/agent` with the configured bearer token. The chat must be the configured
owner chat. A 200 response means the request was persisted, and its result is
delivered in Telegram. An optional `Idempotency-Key` prevents duplicate
execution while the bridge retains that request ID in its deduplication window.

The bridge supports one active turn, with up to ten incoming items per album.
It keeps a thread ID in `codex-thread.json` and uses Codex's workspace sandbox.
The Telegram offset identifies accepted updates. An interrupted or crashed
delivery may require resending the message. Groups and import of Claude
conversation transcripts remain outside this private-chat integration.
