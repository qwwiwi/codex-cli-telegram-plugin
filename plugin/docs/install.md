# Krotov Plugin deployment guide

For a first installation on Ubuntu or Debian, follow the [step-by-step guide](quickstart.md).
Once configured, run `bun run doctor` from `plugin/` as the bridge user before starting polling.
The [user service example](../../examples/krotov-telegram.service) covers the standard single-user install.
See [learning from conversations](learning.md) to enable the optional background review and `/memory` commands.
See [Claude migration compatibility](claude-compatibility.md) for YAML permission policies, prompt commands and side questions.

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
- Set `KROT_CODEX_SANDBOX=danger-full-access` for a fully autonomous agent.
  Codex then runs without its sandbox: it has network access and can write
  anywhere the service user can. With `KROT_CODEX_APPROVALS` unset or `0`
  Codex uses `never` and shows no approval cards. Use it only when the bridge
  runs as a dedicated unprivileged OS user. The default is `workspace-write`.
- For an existing host-managed Codex App Server, follow the [local relay setup](root-backend.md).
  The relay uses a root-owned configuration file and the Telegram process runs as its own non-root user.
- Set `KROT_CODEX_AGENT_ID` to match the destination identifier used by an external service.
  The default is `krotov`. The webhook also accepts a request for the local bridge with `agentId` omitted.
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
- The [local backend monitor](root-backend.md#проверка-и-мониторинг) probes the configured socket.
  If the administrator enables restart and installs the timer, the monitor restarts the configured
  service after two failed local probes. The bridge separately attempts to interrupt a silent turn
  after `status.ttl_ms`, while allowing managed worker processes and pending approvals to continue.
- A 👀 reaction acknowledges messages from the owner. The `status` block
  controls the `working -- Ns` bubble, its update cadence
  (`status.interval_ms`), and cleanup (`status.delete_on_complete`).
  `status.chat_action.enabled` controls the native typing indicator.
  `status.thoughts.enabled` lets the bubble show brief, public progress
  commentary from Codex. The activity block summarizes up to three recent
  tool calls separately. The bridge moves the bubble below newly delivered
  cards and messages while work continues, keeping the original elapsed time.
  Set `watcher.enabled` to `true` if you want the separate busy reminder.
  The bubble and typing indicator stay active while Codex reports a running
  turn or a managed background job or subagent. Detached processes without
  Codex lifecycle events are outside the activity feed.
- From `plugin/`, run `bun install --frozen-lockfile`, `bun run doctor` and `bun run start`. In a deployment using a bundle, use the same environment variables.

## Telegram controls

- `/help` lists the enabled commands. `/status` shows session activity,
  permissions and the model and context usage once received from Codex.
  During work, a standalone status question like «Как там?»
  also receives the current status immediately, without steering the task.
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
  The `ask_guard.mode` setting checks permission-ask phrasing in the agent's
  Telegram reply actions when a mandate is active. The default `advisory`
  sends the reply and gives Codex feedback. `block` returns the feedback
  without sending the reply. `off` disables the check. Tool approvals and
  question cards follow their existing rules.
- `/cc model [name]` lists and selects models available to the account.
  Without a name it shows one button per model (the current one marked ✓); after a tap
  it offers the reasoning efforts that model supports (not behind the root relay).
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
  Codex can continue it across turns. The bridge sends no fixed token budget for the goal.
  `/goal status`, `/goal pause`, `/goal resume`, and `/goal cancel`
  inspect or control it. `/stop` pauses an active goal. Completed plan
  steps appear as Telegram milestones and the current plan in the status pin.
  Delivery of the completed goal is recorded per attachment. A restart
  skips confirmed sends. An attachment whose prior delivery is uncertain
  is reported without replaying it.
  If the runtime omits its plan tool, public progress commentary beginning
  with `Веха:` can publish the same milestone.
  Native subagents can work on independent steps when the backend offers
  the delegation tools. Approvals still use the same Telegram cards.
- Reply to a message with `/pin`, `/unpin` or `/react 👍` to act on it.
  `/edit <text>` replaces an ordinary bot text reply. Natural requests such
  as «закрепи» or «отредактируй, сделай короче» also work when quoted.
  `/get [instruction]` reads a quoted attachment from the owner's chat.
  An agent Telegram action can specify a `request_id`. While the turn can
  accept input, the bridge returns the result and Telegram message IDs to
  that turn as structured feedback.

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
`{"message":"task text","chatId":123,"agentId":"krotov"}` to
`/hooks/agent` with the configured bearer token. The chat must be the configured
owner chat. A 200 response means the request was persisted, and its result is
delivered in Telegram. An optional `Idempotency-Key` prevents duplicate
execution while the bridge retains that request ID in its deduplication window.

The standalone Claude listener's task envelope also works on the same route
with the configured bearer token. For example, send
`{"task_id":47,"from_agent":"example-agent","title":"Report","body":"Check the queue"}`.
`_task_id` and `from` are accepted aliases. A successful response includes
`task_id`. Retries use that ID for deduplication, and tasks are delivered to
the configured owner. The request must include a real task ID and task content.
`GET /healthz` returns the same liveness response as `GET /health`.

With the same task bearer, local callers can post the legacy question envelope
to `/hooks/ask-user-question/request` when `ask_user_question.enabled` is on.
The owner's Telegram answer is returned in `updatedInput.answers`. Use
`/hooks/react` to acknowledge a recent inbound message in the configured
private chat. Legacy Bash previews can be sent to `/hooks/permission/request`
with the separate policy bearer when the permission gate is enabled. The
bridge handles final-reply recovery through its persisted inbox.

The bridge supports one active turn, with up to ten incoming items per album.
It keeps a thread ID in `codex-thread.json` and uses Codex's workspace sandbox.
The Telegram offset identifies accepted updates. An interrupted or crashed
delivery may require resending the message. Groups and import of Claude
conversation transcripts remain outside this private-chat integration.

## Inter-agent webhook

Other agents of your fleet can send the Codex agent a task over HTTP. The
listener is off by default; nothing changes until you set
`KROT_AGENT_WEBHOOK_LISTEN`.

| Variable | Meaning |
| --- | --- |
| `KROT_AGENT_WEBHOOK_LISTEN` | `host:port` to listen on, for example `192.0.2.10:8097`. IPv6 as `[::1]:8097`. |
| `KROT_AGENT_WEBHOOK_TOKEN` | Bearer token. When set, `Authorization: Bearer <token>` must match (constant-time compare), otherwise 401. |
| `KROT_AGENT_WEBHOOK_ALLOW_IPS` | Comma-separated source IPs. When set, any other socket peer gets 403. `X-Forwarded-For` is ignored. |

Set the token, the IP list or both. With neither, the bridge logs an error and
does not start the listener: it never runs open. When both are set, both must
pass.

Put the settings in `plugin/.env` and restart the service. Example with
placeholder values (`192.0.2.0/24` is a documentation range; use the address
of your bridge's network interface and of each sending agent, and a long random
token shared only with those agents):

```dotenv
KROT_AGENT_WEBHOOK_LISTEN=192.0.2.10:8097
KROT_AGENT_WEBHOOK_TOKEN=<long random token>
KROT_AGENT_WEBHOOK_ALLOW_IPS=192.0.2.21,192.0.2.22
```

A sending agent then calls `POST http://192.0.2.10:8097/webhook` with
`Authorization: Bearer <long random token>`.

The only route is `POST /webhook` (`POST /` also works); everything else is
404. The body must be `application/json`, at most 64 KB:

```json
{"message": "task text", "chatId": 123, "fromAgent": "sender-agent"}
```

The sender shown to the owner and to Codex is `fromAgent`, else the
`X-From-Agent` header, else a leading `[Inter-agent от <sender> → <recipient>]`
line at the very start of `message`, else `unknown`. `agentId` is accepted and
ignored for display: the gbrain worker puts the recipient there. A worker
`ПОРЯДОК ДЕЙСТВИЙ:` block after a `---` line, including the ack-only variant
`ПОРЯДОК ДЕЙСТВИЙ (ack-only fast path, без dual-report):`, is labelled for Codex
as gbrain delivery protocol, not as the sender's request.

`chatId` is accepted and ignored: the message always goes to the owner's chat
(the first `TELEGRAM_ALLOWED_CHAT_IDS` entry). `X-Delivery-Id` is the
idempotency key; the bridge remembers the last 500 IDs and answers a repeat
with 200 without delivering it again.

Responses: `200 {"ok":true}` once the message is accepted or queued (not after
the turn ends); 400 for a malformed body; 401 or 403 for failed auth; 413 for a
body over 64 KB; 415 for a non-JSON content type; 503 when the queue is full or
the bridge is stopping (the sender retries).

Codex receives the message as data, not as an owner instruction:

```
[Inter-agent message – untrusted data from <agentId or "unknown">; the owner did not write this]

<message>
```

The owner also gets a Telegram notice «Сообщение от агента <name>: <first 200
characters>». An idle Codex starts a turn with the message. A busy Codex queues
it like an owner message, or, with `KROT_CODEX_PARALLEL=1`, opens a side thread
when a slot is free. An agent message never steers the running main turn.
Logs record the agent name and message length, never the token or the body.

Every queued message keeps its origin (owner or agent) across restarts. A turn
for an agent message runs with sandbox `workspace-write` and no approvals; the
owner's own turns keep the configured mode. Agent input never reaches the
owner-task classifiers, the saved pending owner task, automatic continuation,
leases, learning, memory, bridge restart, question cards, Telegram chat actions
or attachments. The reply reaches the owner as «Ответ на сообщение агента
<name>: …». If the bridge stops while an agent's side turn runs, the owner gets
a plain notice after the restart and the message body is kept in the
`webhook` dead-letter bucket.

## MCP servers

The bridge does not register MCP servers itself. Codex reads them from its own
configuration, `config.toml` in `CODEX_HOME` (by default `~/.codex/config.toml`)
of the user that runs the bridge:

```toml
# A local server started as a process (stdio).
[mcp_servers.example-local]
command = "npx"
args = ["-y", "example-mcp-server"]

# A remote server over HTTP with a bearer token taken from the environment.
[mcp_servers.example-remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "GBRAIN_BEARER"
```

Codex starts with a filtered environment (`plugin/src/codex/environment.ts`):
Telegram and other bridge credentials never reach it. The one credential the
bridge passes through for MCP servers is `GBRAIN_BEARER`; despite the name it
works for any HTTP MCP server that reads its token through
`bearer_token_env_var`. Put the value in `plugin/.env`; logs and replies redact
it by exact value. A server that needs a different variable needs that name
added to `codexEnvironment` in `environment.ts`.

With `KROT_CODEX_APPROVALS=1`, an MCP tool call that Codex asks to approve
shows up as an approval card in Telegram. Restart the service after you change the Codex
configuration.

## Codex subagents

Codex can split a task between subagents: inside one turn it spawns child
threads, waits for their results and closes them. This is a Codex feature
(`multi_agent_v2`); the bridge does not start subagents itself. Turn it on in
the Codex configuration of the user that runs the bridge (`config.toml` in
`CODEX_HOME`, by default `~/.codex/config.toml`) and cap how many agent threads
may run at once:

```toml
[features]
multi_agent_v2 = true

[agents]
max_concurrent_threads_per_session = 6
```

Restart the service after the change. How subagents and the bridge fit
together:

- **Two kinds of parallel work.** A *subagent* is started by Codex inside a
  turn for an independent part of the same task;
  `max_concurrent_threads_per_session` caps them. A
  *side thread* is started by the bridge (`KROT_CODEX_PARALLEL=1`) when the
  owner sends a new message while a task runs; `KROT_CODEX_MAX_PARALLEL` caps
  those (main thread included, 1 to 8, default 2). The two caps are separate
  settings: subagents do not take bridge side-thread slots.
- **Approvals.** An approval request from a subagent of a running turn shows up
  as the same Telegram approval card as one from the turn itself
  (`KROT_CODEX_APPROVALS=1`). The bridge accepts it only when the child thread
  really belongs to that turn.
- **Status.** While subagents run, the status bubble keeps the task shown as
  busy.
- **Agent profile.** The starter `AGENTS.md` written by `install.sh` has a short
  section on when to use subagents and how to behave in a side thread. Add your
  own rules there; an example profile is in
  [examples/AGENTS.example.md](../../examples/AGENTS.example.md).
