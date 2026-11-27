## Findings / Changes

### 1. Telegram Guest Mode

**Verified on core.telegram.org (quoted by the fetch subagents):**
- Introduced in Bot API 10.0, 8 May 2026, under the heading "Guest Mode": "allowing bots to receive certain messages and issue replies within chats they are not a member of". The current version is Bot API 10.5, 22 November 2026, with no guest changes. (https://core.telegram.org/bots/api-changelog)
- `Update.guest_message` (Message): "New guest message. The bot can use the field Message.guest_query_id and the method answerGuestQuery to send a message in response." (https://core.telegram.org/bots/api#update)
- `Message.guest_query_id` (String): "Use this identifier with the method answerGuestQuery to send a response message. If non-empty, the message belongs to the chat where the guest bot was summoned, which may not coincide with other existing bot chats sharing the same identifier." (https://core.telegram.org/bots/api#message)
- `Message.guest_bot_caller_user` / `guest_bot_caller_chat`: "For a message sent by a guest bot, this is the user/chat whose original message triggered the bot's response". These describe the bot's sent answer, so the inbound caller is `message.from`.
- `answerGuestQuery(guest_query_id: String, result: InlineQueryResult)`: "Use this method to reply to a received guest message. On success, a SentGuestMessage object is returned." (https://core.telegram.org/bots/api#answerguestquery)
- Enabling: "open your bot's settings in BotFather's MiniApp and enable 'Guest Mode'". There is also `setMySettings.supports_guest_queries` and `BotFullInfo.supports_guest_queries`. (https://core.telegram.org/bots/features#guest-bots, https://core.telegram.org/bots/api#setmysettings)
- Trigger and scope: works "in any group or private chat"; fires when a user "mentions a guest bot … or replies to one of its messages"; the bot "is able to issue one reply".
- Privacy: the update "includes the summoning message and, when present, the specific message it was replying to"; "Guest mode does not grant access to a chat's message history or participant list"; no later updates "unless it is mentioned again or directly replied to".
- Limit: "You can mention up to 3 guest bots in your message at the same time".
- Bot API 10.1 (11 June 2026) allows a Rich Message "as InputMessageContent in results of inline, guest, and Web App queries".

**Not stated by Telegram (searched, absent):** the lifetime of a guest query, a text-length limit, which InlineQueryResult types are allowed, and whether the sent answer can be edited.
- "≤4096 chars" and "~15 min" are our own conventions; `plugin/src/telegram/guest-queries.ts:55-58` says so itself ("Telegram does not document the guest-query lifetime").
- The code comment "Bot API 10.0, 2026-07-04" is the date of our implementation; Telegram's date is 8 May 2026.

**Reference implementation** (a private Telegram channel plugin outside this repository, read-only):
- `src/telegram/guest-queries.ts` is a one-shot registry (pending → inflight → answered, 15 min TTL, cap 64, redelivery is a no-op, in memory only).
- `handleGuestMessage` in `src/telegram/handlers.ts` gates on the caller ID before registering.
- The answer is an `InlineQueryResultArticle` with `input_message_content.message_text`; one optional file is staged through the owner DM.

**The bridge already carries copies of this, unloaded:**
- `plugin/src/telegram/guest-queries.ts`
- `handleGuestMessage` at `plugin/src/telegram/handlers.ts:913`
- `answerGuestQuery` in the Telegram API wrapper at `plugin/src/channel/tools.ts:596-629`, passed through all three safety layers
- `guest_message` in `ALLOWED_UPDATES` at `plugin/src/telegram/poller.ts:104-115`
- the `guest_mode` config block at `plugin/src/config.ts:433-436`

### 2. Current access model of the bridge (verified in code)
- **Strictly one owner.** `plugin/src/codex/server.ts:115-118` refuses to start unless there is exactly one allowed user and that user's private chat.
- **Every handler repeats the owner check** (`ctx.from.id !== ownerId || ctx.chat?.type !== 'private'`) at `server.ts:1331,1339,1349,1357,1640`.
- **One conversation.** A single thread ID in `codex-thread.json`, a single queue in `codex-inbox.json` (`CodexInbox(root, ownerId)` rejects any non-owner message on load, `inbox.ts:29-46`), and one `codex app-server` child.
- **No pairing.** `TELEGRAM_ACCESS_MODE=pairing` is rejected (`config.ts:564-572`).
- **A two-level trust model already exists.** `Provenance = owner | agent` (`codex/provenance.ts:19-20`), and a missing origin means "not the owner".
- **Untrusted turns are already restricted.** `session.ts:378-389` sends `approvalPolicy: 'never'` and a `workspaceWrite` sandbox per turn; approvals, questions and chat actions are declined for them (`session.ts:778-882`); an agent side thread never forks the owner thread (`session.ts:464-466`).
- **A read-only sandbox type exists but is unused.** `CodexSandboxPolicy` includes `{ type: 'readOnly'; networkAccess: boolean }` (`session.ts:31-41`).
- **Codex inherits owner credentials.** The child gets `HOME`, `CODEX_HOME`, `GH_CONFIG_DIR` and `GBRAIN_BEARER` (`codex/environment.ts:3`), so every thread in that app-server shares the owner's GitHub access, MCP bearer token and MCP servers.
- **The hook sees the thread ID.** `plugin/scripts/codex-permission-hook.ts` is a PreToolUse hook that receives `session_id` and fails closed on error. It is an optional install today.
- **Unloaded legacy helpers that fit this work:** `telegram/gate.ts`, `telegram/addressing.ts` (mention / reply-to-bot), `router/route-key.ts` (`<chatId>` or `<chatId>__t<topicId>`), `state/thread-store.ts` (reply into the right topic).

### 3. Design

**Core rule: privilege belongs to the chat's thread, never to a message.**
- Only the owner's private chat is owner-privileged.
- Any other chat has a ceiling of member or guest, including when the owner speaks in a group. Other people's text sits in that thread's history; giving the owner full rights there would be a confused deputy.
- Non-owner threads get no capabilities, so prompt injection can only produce bad text.

**Roles**

| | owner | member | guest |
|---|---|---|---|
| Where | own private chat | own private chat, approved groups | Guest Mode query; open group |
| Thread | current main thread, unchanged | one persistent thread per chat key | fresh thread per query, discarded |
| Codex sandbox / approvals | as configured today | `readOnly`, network off, `approvalPolicy: never` | same |
| Tools | all | none in v1 | none |
| Working folder | `TELEGRAM_WORKSPACE_ROOT` | own empty folder | shared empty folder |
| Cards, HUD, leases, memory, learning, restart, `/cc`, `/doctor` | yes | no | no |
| Inbound media | yes | voice and photo, 10 MB cap | text only |
| Outbound | text and files | text only | one text answer ≤4096 chars |
| Commands | all | `/new`, `/help`, `/whoami` | none |

**(a) Guest Mode answers**
1. `guest_message` arrives; drop it if `from` is missing or a bot, or `guest_query_id` is empty.
2. Audience gate on `from.id`: `allowlist` (owner and members, the default) or `anyone` (opt-in). A dropped query is never answered.
3. Rate limit, then `GuestQueryRegistry.register` (reuse the existing file as is).
4. Start a fresh guest-profile thread and never fork the owner thread. The summoning text and the replied-to message are framed as untrusted data, reusing `prompt/build.ts`.
5. Hard turn timeout of 120 s; on timeout, interrupt and spend the single answer on a short apology.
6. Claim, then `answerGuestQuery` with an article result carrying HTML text. Truncate at 4096 characters with a marker and run `redactSecrets`. Confirm on success. A failed send is treated as ambiguous and not retried.
7. The answer is always guest-level, even when the owner summons the bot, because it is public in a foreign chat.
8. No files in v1. The reference stages files through the owner DM, which I rejected as leak surface for little value.
9. `/guest on|off|public` in the owner DM; `doctor` reports `supports_guest_queries`.

**(b) Multiple chats**
- **Chat key:** reuse `route-key.ts`. One Codex thread, one queue and one folder per key.
- **Owner path untouched.** Non-owner traffic goes through a new, separate "public lane" (its own small queue and scheduler). The owner's inbox, steer, goal and lease code is not generalised.
- **Scheduling:** FIFO per chat; at most `KROT_CODEX_MAX_PARALLEL − 1` non-owner turns at once, so one slot is always the owner's. A non-owner message never steers a turn.
- **Group rules:** the bot acts only on `@bot`, a reply to its message, or `/cmd@bot`. Unaddressed messages are neither stored nor sent to the model. Each addressed message is prefixed with a sanitised sender label (ID, role, name stripped of control characters and capped).
- **Group approval:** add `my_chat_member` to allowed updates. A new group sends the owner a card (members only / open / deny). An unapproved group is ignored and left after 24 h.
- **Group modes:** `members` (only listed users may summon; default) or `open` (unlisted users are served as guests with guest limits).
- **Topics:** per-topic thread by default; replies carry `message_thread_id`.
- **Private chat of a member:** the gate requires `chat.id == from.id` and an allowlisted ID.

**(c) Users**
- **Identity** is the numeric Telegram ID only; usernames can be reassigned.
- **Unlimited:** no cap in the schema, held as an in-memory map.
- **Owner commands** (owner private chat only, never from a forwarded message):
  - `/users` (paged list)
  - `/users add <id> [member|guest] [note]`
  - `/users remove <id>`
  - `/users role <id> <role>`
  - `/users invite [role]`
  - `/chats`
  - `/chats remove <id>`
- **Removal** drops that user's queued messages and interrupts their running turn.
- **Pairing:** `/users invite` mints a single-use code (10 min, ≥40 bits, stored as SHA-256). The person sends `/start <code>`; the owner then gets a confirm card showing ID and name. The code alone never grants access. Five bad codes mute that ID for an hour.
- **Unknown users:** silent drop. The one exception is `/start`, which replies once per day with their numeric ID so a client can pass it to the owner (toggle available).
- **Env/config:** `KROT_MULTIUSER=1` is the feature flag. `TELEGRAM_ALLOWED_USER_IDS` stays exactly one ID, the owner. `KROT_MEMBER_USER_IDS` is a CSV of members that cannot be removed from chat. `KROT_PUBLIC_WORKSPACE_ROOT` must be absolute and outside both the owner workspace and the state directory.
- **The owner role exists only in env.** The state file's schema rejects `role: "owner"`, so nothing written to it can create a second owner.

**Security layers**
1. **Deterministic gate before any model:** ID → role → chat ceiling → rate limit. Callback queries are checked against the owner ID as today.
2. **Bridge capability matrix:** widen `Provenance` with `{ origin: 'user', role, userId, chatKey }` and keep "missing means untrusted". Everything already gated on `origin === 'owner'` stays closed for the new origin.
3. **Per-thread Codex settings:** `readOnly` sandbox with network off, `approvalPolicy: never`, `cwd` set to the per-chat folder, no `dynamicTools`, fresh thread. Every app-server request from such a thread is auto-declined (existing path).
4. **Hooks pack:**
   - The permission hook asks the bridge on loopback for the thread's role by `session_id`. Anything that is not an owner thread, or an owner subagent thread the bridge can confirm, gets every tool call denied. Bridge unreachable means deny.
   - With `KROT_MULTIUSER=1` the bridge refuses to start unless the hook is installed in the Codex config.
   - `/doctor` runs a live canary: a guest-profile turn asked to run a command must come back denied.
5. **Process isolation (phase 2):** a second app-server for non-owner threads under a separate Linux user, with its own `CODEX_HOME` and login, a scrubbed env (no `GH_CONFIG_DIR`, no `GBRAIN_BEARER`) and no MCP servers. The repo's relay (`KROT_CODEX_PROXY`, `plugin/docs/root-backend.md`) is the precedent. Only after this may members get `workspaceWrite` in their own folder.

Why layer 3 is not enough alone: to my knowledge a Codex read-only sandbox still lets commands read any file, so a tool call that got through could `cat` a key into a reply. This is from memory and unverified here; it is why layers 4 and 5 exist.

**Prompt injection from guests**
- Structural: no tools, no owner history, no steer, no fork, no memory or learning writes, replies only to the origin chat.
- Framing: an untrusted-data prefix like the existing agent frame, plus a short instruction block for the role.
- Output: `redactSecrets` on every non-owner reply; no file extraction for non-owners.
- Likely leak: the owner's global instructions in `CODEX_HOME` probably load in non-owner threads on the shared app-server (inferred). Phase 2 removes that.

**Rate limits** (token bucket per user, per chat and global; defaults configurable)
- Member: 30 per hour, 200 per day, 10 min turn timeout.
- Guest: 5 per hour, 20 per day, 4000 input characters, 120 s turn timeout.
- All `anyone` guest queries together: 60 per hour.
- Over the limit: one notice per window, then silence.
- Budget guard: non-owner turns pause when the weekly Codex limit passes 80% (data already in `status/codex-limits.ts`).

**Audit log**
- `audit/YYYY-MM.jsonl` in the state directory, append-only, mode 0600.
- Line: `{ts, event, user_id, role, chat_key, thread_id?, profile?, reason?, ms?, tokens?, text_len?, text_sha?}`.
- Events: `access.change`, `chat.approve`, `inbound.accept`, `inbound.drop`, `turn.start`, `turn.end`, `tool.denied`, `rate.hit`, `guest.answer`, `pairing.*`.
- No message bodies by default (`KROT_AUDIT_BODIES=1` opts in, redacted).
- Every `access.change` also sends the owner a Telegram notice. `/audit [n]` shows the last entries.

**State files** (state directory, written atomically, 0600)
- `access.json`:
  ```json
  {"version":1,
   "users":{"123456":{"role":"member","note":"Иван","added_at":"2026-11-26T10:00:00Z","added_by":"chat"}},
   "chats":{"-1001234":{"mode":"members","title":"Team","topics":"per-topic","approved_at":"2026-11-26T10:00:00Z"}},
   "guest_mode":{"enabled":false,"audience":"allowlist"},
   "invites":{"<sha256>":{"role":"member","expires_at":"2026-11-26T10:10:00Z"}}}
  ```
- `public-threads.json`: `{"version":1,"threads":{"<chatKey>":{"thread_id":"…","role":"member","cwd":"…","last_used_at":"…"}}}`
- `public-inbox.json`: per-chat queues, cap 16 per chat.
- `rate-limits.json`: daily counters only; hourly buckets stay in memory.
- `audit/`: as above.
- `codex-thread.json` and `codex-inbox.json` are untouched.

**Migration**
- Flag off (the default): behaviour is identical to today.
- Flag on: the owner check at `server.ts:115-118` stays; a missing `access.json` means owner only.
- More than one ID in `TELEGRAM_ALLOWED_USER_IDS` still fails at start, with a message pointing to `KROT_MEMBER_USER_IDS`.
- The inherited `guest_mode.allowed_user_ids` and `policy.yaml` are ignored with a warning.
- Rollback: unset the flag; the files stay.

**Tests to write first**
1. Access store: rejects `role: owner`; unlimited adds; atomic write; corrupt file fails closed to owner only; env members cannot be removed.
2. Gate table: role × chat type × addressed or not → allow/drop reason; an owner in a group gets the member ceiling.
3. Commands: `/users` is ignored from a member, in a group, and when forwarded; removal interrupts the user's turn.
4. Pairing: single use, expiry, the code alone grants nothing, lockout.
5. Session (fake app-server): a non-owner turn sends `readOnly`, `never`, the per-chat `cwd`, no `dynamicTools`, and never `thread/fork`; approval, question and tool requests are declined.
6. Hook: non-owner thread → deny for shell, `apply_patch` and MCP; bridge down → deny; owner thread unchanged.
7. Guest Mode: unlisted caller gets no API call; exactly one `answerGuestQuery`; redelivery gives no second answer; truncation at 4096; timeout apology; secret redaction.
8. Groups and topics: unaddressed messages ignored; the reply carries `message_thread_id`; two topics get two threads; an unapproved group is ignored.
9. Rate limits and audit: bucket arithmetic with a fake clock; no bodies by default; budget guard.
10. Regression: with the flag off the existing suite passes untouched.

**Slices for parallel coders**
- **S0, spike, blocks S3 and S4:** dump the app-server schema (`codex app-server generate-ts`) and answer three questions: can a thread have tools disabled; what can a `readOnly` sandbox read; does PreToolUse fire for every tool kind.
- **S1:** access store, roles, env, `/users`, pairing, `/start` ID reply.
- **S2:** gate, addressing, chat keys, group approval, `my_chat_member`.
- **S3:** public lane, public threads, the session profile, the widened provenance.
- **S4:** hook thread-role endpoint, hook deny, startup check, doctor canary.
- **S5:** Guest Mode (needs S3's profile API).
- **S6:** rate limits, audit, budget guard.
- **S7:** phase 2 isolated backend.
- **S8:** docs, `install.sh`, `/doctor`.
- S1, S2, S4 and S6 share no files, except a single integration point in `codex/server.ts` that one integrator should own.


## S0 result (orchestrator, live codex 0.172, 2026-11-26)
- `thread/start` takes `sandbox` (readOnly|workspaceWrite|dangerFullAccess), `approvalPolicy`, `cwd`, `ephemeral` and a free `config` map, so tools can be switched off per thread via feature keys.
- Live: `codex exec -s read-only --disable shell_tool --disable unified_exec --disable apply_patch_freeform --disable browser_use --disable computer_use --disable apps --disable plugins --disable image_generation` asked to run `id` answered NO_SHELL with no command_execution item. Use the same keys as `config: {"features.<name>": false}` on thread/start for guest/member threads, and `mcp_servers: {}`.
- PreToolUse coverage per tool kind still unverified: keep the hook as second layer, not the only one.
- R3 fix: each public CODEX_HOME carries the owner's `codex-permission-hook --thread-role`, written by the bridge, never copied: exactly one PreToolUse command naming the hook is taken from the owner's config.toml `hooks` table or hooks.json, validated (`<abs bun> <abs codex-permission-hook.js|ts> <abs policy> <port> <abs token file> [scope] --thread-role`, plain arguments only) and rewritten to run on the bridge's own bun; the bridge writes it as the only `[[hooks.PreToolUse]]` entry of the public config.toml (matcher `*`, timeout 135 s), forces `features.hooks = true` whatever the owner set, and never writes or copies a hooks.json (a planted one is cleared at the rebuild); no other owner hook is carried. Without such a command the public home is not built. Public thread IDs are unknown to the owner session, and an unknown thread is denied in multi-user mode, so the hook denies every public tool call, allowlisted MCP tools included if Codex runs PreToolUse for MCP. Unverified offline: whether Codex runs a hook copied into a fresh CODEX_HOME without a trust confirmation (live check needed). Further R3 fixes: stdio MCP servers are refused for public roles (they would run as the bridge user); credentials in args or the url need `public_safe`; a rebuild clears the home but `sessions/` and `bridge-thread.json`, and only after the role home is checked to be exactly `<state>/codex-public/<role>`, not a symlink, not overlapping the owner Codex home and neither HOME nor a folder containing it; `multi_agent`, `multi_agent_v2`, `enable_fanout`, `view_image`, `request_permissions_tool`, `code_mode`, `code_mode_only` are off; the probe also reads `config/read` and fails unless every one of those features is false and nothing else but `hooks` is on (no thread tool-list RPC is known for 0.172); skills must load from `<home>/skills/<name>/` and an empty skills answer fails; every newly opened public thread runs the skills check for its own folder before its first turn; symlinked chat folders are refused; `/doctor` quarantines a role whose probe or canary fails; `KROT_CODEX_PROXY` with `KROT_MULTIUSER=1` refuses to start.
- Correction (live 0.172, 2026-11-26): `config: { mcp_servers: {} }` deep-merges into config.toml and keeps every owner MCP server. Public threads therefore run on a separate `codex app-server` per role (member, guest) with its own CODEX_HOME under the state directory (`codex-public/<role>`, mode 700), built at every start from the allowlist `public-access.toml` (skills copied read-only from `public-skills/`, listed MCP servers only, defined in `public-access.toml` itself under `[mcp_servers.<name>]` and never read from the owner's Codex config, credentials only with `public_safe = true` and only from `KROT_PUBLIC_MCP_*` variables, web search for members only) plus a copy of `auth.json`. The startup probe and `/doctor` call `mcpServerStatus/list`, `skills/list` and `app/list` on a fresh public thread and fail closed unless it reaches exactly the allowlist. A dead public app-server answers «временно недоступно»; there is no fallback to the owner's app-server.
- Probe shapes (live 0.172, `codex app-server generate-json-schema`): `mcpServerStatus/list` → `{data, nextCursor}`, followed page by page (at most 20). `skills/list {cwds, forceReload: true}` → `{data: [{cwd, errors, skills: [{name, enabled, scope, ...}]}]}`; a non-empty `errors` fails closed; scope `system` skills (Codex unpacks its bundled ones into `$CODEX_HOME/skills/.system/` at every start) are left out of the comparison and are not allow-listed for any role (no shell, apply_patch or image generation to drive them); `user`, `repo` and `admin` skills must match the allowlist exactly. `app/list` → `{data, nextCursor}` must be `{data: [], nextCursor: null}`; an RPC error fails closed. The public config.toml sets `[apps._default] enabled = false` next to `features.apps = false`, and every public thread/start and thread/resume carries `config.web_search`: `disabled` for guests, `live` only for members with `web_search = true`.
