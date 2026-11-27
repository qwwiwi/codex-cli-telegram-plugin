# Codex hooks pack

Optional hooks for an autonomous Codex agent (approval mode `never`): safety guards in front of
every shell command, a git gate, optional remote MCP context, and
checks at the end of a turn. Bun scripts, no dependencies beyond the bridge's own checkout.

Install: `./install.sh --hooks` (on by default for a fresh install in mode `never`; `--no-hooks`
skips it), or directly `bun codex-hooks/src/install.ts`. The installer writes the six event
entries into `$CODEX_HOME/hooks.json` (keeping hooks of other tools), creates the switchboard
`~/.config/krotov-plugin/codex-hooks.json` if it is missing and sets `KROT_CODEX_HOOKS=1` in
`plugin/.env`, so `bun run doctor` checks the pack.

**Managed hooks (v0.4).** The installer also stages a root-owned copy of the pack in
`/etc/codex/hooks/`: a one-file bundle, a copy of the bun binary, an empty `bunfig.toml` and a
launcher `run`, plus `/etc/codex/requirements.toml` with `[hooks] managed_dir` and one handler per
event, `'/etc/codex/hooks/run' <Event>`. This configuration is host-wide. Every Codex user gets
the same managed handlers. The hook uses the invoker's `HOME` or the passwd home of the real uid
when `HOME` is empty or unset. `CODEX_HOME` defaults to `$HOME/.codex` so the instruction file
guard protects each user's own `AGENTS.md` and `AGENTS.override.md`.

**Bridge user and other users on the host.** Only the bridge user gets the full pack. The installer
records its own uid (one number, no path) in `/etc/codex/hooks/bridge-uid`, installed by root with
the rest of the pack, and the launcher passes `CODEX_HOOKS_MANAGED_DIR=/etc/codex/hooks` in its
clean environment. `bridge-uid` is trusted only when it is a small regular file (opened without
following a symlink and without blocking, so a symlink or a FIFO is refused), owned by root and not
writable by group or others, in a root-owned directory (and parent) that is not a symlink and not
writable by group or others, and holds one positive uid (never 0: the installer refuses to record
root). A hook run is the bridge user's when a trusted `bridge-uid` holds the real uid of the hook
process. For the bridge user nothing changes: every hook below runs, with that user's switchboard,
state and optional remote MCP configuration.

Every other user that a trusted `bridge-uid` proves is not the bridge user (for example
`codex exec "Reply with OK"` as another Linux user) gets nothing from the pack: all six events,
PreToolUse included, print nothing and exit 0. No context, no session check, no safety rule, no
remote MCP or Telegram call, no network, no log and no files in their home (no `~/.trash`). The pack
is the bridge's guard; other users keep whatever Codex itself enforces for them.

When `bridge-uid` is missing, unreadable, malformed, a symlink or FIFO, or writable by others, the
pack cannot tell who the bridge user is and fails closed for everyone, the bridge user included:
- SessionStart, PreCompact, UserPromptSubmit, PostToolUse and Stop print nothing and exit 0.
- PreToolUse runs only the safety rule (destructive commands, secret files, the snapshot to
  `~/.trash` before a deletion), fail-closed, with the default switchboard. Its deny reasons are
  neutral. The bridge workflow guards (git gate, editing on main, the repository baseline) and the
  activity log do not run.
- Doctor reports it as an error, the installer stages `bridge-uid` again (even when its bytes
  match) and full access stays off (the bridge runs in `workspace-write`): rerun
  `./install.sh --hooks` as the bridge user and run the `sudo install` line it prints. Do not run
  the installer itself with sudo: it refuses to record root as the bridge user.

When a trusted `bridge-uid` names another uid than the user running the bridge, the bridge's own
hook runs are no-ops; doctor, the installer and the full-access gate report it with the same
instruction, and full access stays off.

A user-level install (the handlers in the installing user's own `hooks.json`, no
`CODEX_HOOKS_MANAGED_DIR`) is always the full pack: only that user runs it.

The launcher changes to `/etc/codex/hooks` and starts the root-owned bun with `--no-env-file` and
the empty bunfig. It passes the invoker's home variables in a clean environment with fixed
`PATH`, `TMPDIR` and `LANG`. Overrides such as `CODEX_HOOKS_CONFIG`, `XDG_*`, `GBRAIN_*`, and
`TELEGRAM_WORKSPACE_ROOT` are stripped. Managed handlers have a 30-second Codex timeout.
Codex 0.172 command handlers have no `onFailure` setting: a PreToolUse hook that crashes, exits
with another code, is killed or times out lets the tool run. So the pack fails closed by itself,
with the blocking form Codex honours (exit code 2, the reason on stderr).

What blocks a PreToolUse call in Codex rust-v0.172.0 (codex-rs/hooks/src/events/pre_tool_use.rs
204-298, engine/command_runner.rs 292-382, engine/output_parser.rs 121-181):

| Hook result | Codex 0.172 |
|---|---|
| exit 2 with a nonblank stderr (stdout ignored) | block, stderr is the reason |
| exit 2 with a blank stderr | failed: **the tool runs** |
| exit 0, valid JSON `hookSpecificOutput.permissionDecision: "deny"` with a nonblank `permissionDecisionReason` (or legacy `decision: "block"` + `reason`) | block |
| exit 0 with `{}`, empty stdout, malformed JSON | **the tool runs** |
| any other exit code, a signal, a spawn error, a timeout | **the tool runs** |
| an `onFailure` field | does not exist |

So the managed launcher owns the verdict of the bridge user's PreToolUse. The bundle only reports
it, and the launcher answers Codex itself; no JSON of the bundle that could be a deny is forwarded.

The contract between the bundle and the launcher (`run` starts `codex-hooks.js PreToolUse
launcher-verdict`, with the envelope it drained from Codex as the bundle's stdin, the bundle's
stdout in a temporary file and its stderr dropped). An allow is always explicit: the bundle's
first line is the fixed word `ALLOW`, also for a no-op of a user that is not the bridge. An exit 0
without it is no verdict and blocks:

| Bundle | Launcher answers Codex |
|---|---|
| exit 3 (a code only the bundle's deny uses), the bare reason on stdout | exit 2, stdout empty, stderr `Заблокировано защитой Codex: <reason>` |
| exit 3 with a reason that has no visible character (empty, line breaks, NBSP and other Unicode spaces, control characters) | exit 2, stderr `Заблокировано защитой Codex: причина не указана` |
| exit 0, stdout exactly the line `ALLOW` | exit 0, stdout empty |
| exit 0, the line `ALLOW`, then exactly the line `{}` | exit 0, `{}` |
| exit 0, the line `ALLOW`, then exactly one line `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<text>"}}` whose text has no `"`, no raw control character (a tab included), and a backslash only as `\uXXXX` with four lowercase hex digits | exit 0, that line |
| exit 0 with anything else: an empty stdout, `{}` or the context line without `ALLOW` before it, deny JSON in any form, truncated JSON, trailing objects, a third line, a line without its line break or with two, a NUL or another control byte anywhere, more than 65536 bytes | exit 2, stderr `Заблокировано защитой Codex: хук защиты Codex не сработал (<cause>), …` |
| any other exit code (1, 2, 124, 137, …), a signal, a missing bun, no temporary directory | the same exit 2 with the cause |
| the judge (the drain of the envelope, bun, the read of its answer and the verdict together) not done in 25 seconds | the same exit 2 with the cause |
| the envelope on stdin longer than 4194304 bytes (4 MiB), or not read to its end in 2 seconds | the same exit 2 with the cause; bun is not started |

Every block is exit 2 with nothing on stdout and one stderr line that starts with the fixed
prefix `Заблокировано защитой Codex: `, so the reason Codex reads is never blank. The reason is
the first 8192 bytes of the bundle's stdout as one line: line breaks and tabs become spaces and
control characters are removed. It counts as visible when it has an ASCII graphic character or a
Cyrillic letter; otherwise the fallback text is used.

The launcher checks the raw bytes of an exit-0 answer before the shell reads them: the file is at
most 65536 bytes, it has one or two line breaks, and deleting every control byte except the line
break (`tr -d`, then `wc -c`) leaves the same byte count. A command substitution alone would drop
a NUL byte and trailing line breaks without a trace. After the read, exactly one byte (the final
line break) may be missing.

The context line and `{}` are the only JSON the launcher passes. Its shape can be checked in `sh`: the
bundle writes every `"`, backslash and control character of the text as `\uXXXX`, so a text
without a `"` cannot end the JSON string early and the object cannot carry another key. The
launcher also rejects a malformed escape (`\uZZZZ`, a short or uppercase one, any other backslash)
and a raw control character, so the line it passes is always valid JSON.

How the pieces fit:
- the hook gives up after 18 seconds and denies; the deadline starts before stdin is read and
  the scope is resolved; a crash inside the hook does the same. Only PreToolUse has this deadline:
  SessionStart, PreCompact, UserPromptSubmit, PostToolUse and Stop run within the 30-second Codex
  timeout and fail open;
- an envelope the guard cannot judge (no or blank `tool_name`, a `tool_input` that is not an
  object, apply_patch without a readable nonblank patch, a shell tool without a command) is denied;
- in verdict mode the bundle turns its own answer into the contract above: a deny, a failed run
  and every answer it does not know as an allow leave with exit 3;
- a PreToolUse call of the bridge user has one absolute deadline. The launcher Codex waits for
  does no file work of its own: after the `bridge-uid` lookup it runs itself again as the judge
  (`run PreToolUse judge <its pid>`) under one `timeout` of 25 seconds (killed 1 second later).
  Everything that touches `/tmp` (`mktemp`, the drain, `wc`, bun, the read of the answer) happens
  inside that judge, so a stalled `/tmp` ends as a block, not as a Codex timeout;
- the judge makes one owner-only directory `/tmp/codex-hooks.<launcher pid>.*` and drains
  Codex's stdin into it: at most 4 MiB is kept and the rest is read and dropped, under a `timeout`
  of 2 seconds (killed 1 second later). An envelope above the cap or one that does not end in time
  blocks. Then the judge closes its stdin (`exec 0</dev/null`) and bun reads the envelope from the
  file. Codex waits for its write of the envelope as well as for the hook result
  (command_runner.rs 296), so nothing that runs later, including a bun that outlives its timeout,
  may hold that pipe;
- inside the judge bun is stopped after 20 seconds (killed 1 second later), and the answer is read
  from the file with a size cap (`head -c`), so no read happens outside the watchdog;
- the directory is removed after the verdict is written, by the outer launcher, in a detached
  process with closed stdio (`rm -rf … &`): the launcher exits right after its answer and never
  waits for the cleanup. The same removal runs when the watchdog had to stop the judge;
- the `bridge-uid` lookup (`find`, `cat`, `wc`, `id`) runs under its own timeout (2 seconds,
  killed 1 second later); a lookup that does not finish counts as "cannot tell" (safety guard).
  The whole launcher stays within 29 seconds (lookup 2 + 1, judge 25 + 1 with the drain 2 + 1 and
  bun 20 + 1 inside it), below the 30-second Codex timeout.

Known limits (by design, fail closed):
- under heavy load a call can be blocked although nothing is wrong with it: the envelope must be
  drained within 2 seconds and bun must answer within 20 seconds (the hook itself gives up after
  18). The block names the cause; repeat the call when the host is less busy;
- an envelope above 4 MiB (4194304 bytes) is always refused, for example a very large
  `apply_patch`. Split the change into smaller calls;
- an `lstat` error other than "no such file" (a transient I/O error, no permission) on a path a
  command or patch would overwrite denies the call: the guard cannot tell whether a file is there
  to snapshot.

A user-level install (`bun main.ts PreToolUse` from `hooks.json`, no launcher) keeps the JSON
form: deny JSON at exit 0, and deny JSON plus the reason on stderr at exit 2 after a crash or the
deadline.

What the pack cannot cover: the launcher shell itself killed (out of memory, a signal from
outside, Codex killing it) ends as a signal, which Codex 0.172 treats as "the tool runs"; and
synchronous work inside bun cannot be interrupted by the 18-second deadline (the launcher's
timeout then ends it). A launcher killed from outside leaves its `/tmp/codex-hooks.<pid>.*`
directory behind (owner-only, at most the 4 MiB envelope and the answer), and a bun that ignores
the stop signal can outlive the answer by a few seconds. In the managed
install the bundle's stderr (a crash trace) is not shown; `hooks.log` in the state directory
keeps the pack's own log.

The launcher needs GNU coreutils (`timeout`, `mktemp`, `head`, `tr`, `cat`, `wc`, `id`, `rm`), `sed`
and GNU findutils (`find -perm /022`); it uses `/usr/bin/timeout` when present. Without `timeout`
the launcher cannot start bun or prove another user, so it blocks every PreToolUse call, of every user.

`bridge-uid` must hold 1 to 10 digits and at most one trailing newline, nothing else (no spaces,
no NUL), with a value from 1 to 4294967294; the launcher and the TypeScript reader apply the same
rule. Anything else means "cannot tell": the safety guard runs.

A user a trusted `bridge-uid` proves is not the bridge gets exit 0 and no output from the
launcher, which then does not start bun at all. Other events keep failing open. Hook errors report
the failing operation when available, with recognized secrets redacted.

Codex runs system-layer hooks without a trust step and the agent cannot edit them. The installer
prints one `sudo install …` line for the owner. For an existing managed installation it stages any
changed bundle, launcher, `bridge-uid` or `requirements.toml` and prints the replacement command.
The guards count as active only when the installed launcher is byte-identical to the current one
and `/etc/codex/requirements.toml` exactly matches a generated pack template. The five-event
template from before Brain also qualifies. A file containing extra handlers triggers a full restage. Run
`./install.sh --hooks` again after the sudo line: it then drops the user-level copy from
`hooks.json` and, in mode `never`, writes `KROT_CODEX_SANDBOX=danger-full-access` to
`plugin/.env`. Full access is written only when every managed file and its directory is
root-owned and a live self-test passes: the exact PreToolUse command, started from a hostile
working directory, must block `rm -rf /` the launcher's way (exit 2, the prefixed reason on
stderr, nothing on stdout), allow `ls` and load nothing from that directory (a timeout, a missing
executable, another exit code or a deny left as JSON on stdout fails). While the guards are
not active, a `danger-full-access` line left by an earlier install is removed. The self-test does
not prove that Codex loads `requirements.toml`, so full access also needs Codex's own App Server
`hooks/list` to show the five core managed handlers from `/etc/codex/requirements.toml`
(`handlerType` `command` with exactly the launcher command, `isManaged: true`, `enabled: true`,
`trustStatus` `managed`, a managed `source`; any field missing fails closed); a Codex that does not answer `hooks/list` gets no full access, and the user-level hooks
stay. The bridge repeats the same check at startup: a `danger-full-access` setting without live
guards falls back to `workspace-write`, with a log warning and an error line in `/doctor`. `safety` and
`git-gate` cannot be switched off in the switchboard. Until then the user-level hooks need the
trust step: open `codex` as the bridge user and trust them.

## The hooks

Each hook can be switched off in `~/.config/krotov-plugin/codex-hooks.json` (`"enabled": {"recall": false}`).
A broken or missing file means all hooks on. Network hooks have a short timeout (MCP 3 s,
`gh` 8 s) and fail open with a line in `~/.local/state/krotov-plugin/codex-hooks/hooks.log`. The two guards fail
closed: if they crash, the tool call is denied.

| # | id | Event | What it does |
|---|---|---|---|
| 1 | `gbrain-inbox` | SessionStart | Remote inbox, own tasks and a heartbeat `online`, injected as context |
| 13 | `session-sanity` | SessionStart | `model` set, `approval_policy` not other than `never`, `multi_agent(_v2) = true`, every configured MCP server answers, `~/.codex/AGENTS.md` exists; problems + a request to the owner: «запусти /doctor» in the chat |
| 11 | `active-briefs` | SessionStart, first prompt | repos under `~/workspace`, `~/projects` with `brief/BRIEF.md` + `brief/CHECKLIST.md`: «repo – N строк – следующая открытая: R..», cached by mtime |
| 2 | `recall` | UserPromptSubmit | Remote recall on the owner message, top 5 lines |
| 3 | `correction` | UserPromptSubmit | asks a Brain session to save a correction or explicit memory request with `brain remember`. Uses the legacy workspace `learning/` lesson when Brain is unavailable for that session |
| 12 | `subagent-nudge` | UserPromptSubmit | research or multi-part ask («параллельно», «изучи», «сравни», 3+ list items or questions): split into subagents |
| 4 | `safety` | PreToolUse | denies writes to the invoking user's `$CODEX_HOME/AGENTS.md` and `AGENTS.override.md` (`$CODEX_HOME` defaults to `~/.codex`), including patch changes, redirects and permission changes; denies `rm -r` on `/`, `~`, a top-level directory or a variable path; force push, remote branch delete, `filter-branch`/`filter-repo`, `reset --hard`/`rebase` on main; DROP/TRUNCATE against a non-local database; `sudo`; `curl \| sh`; printing `.env`, `*.key`, `*.pem`, `~/.secrets/*`, `gbrain.env`, bare `printenv` |
| 5 | `git-gate` | PreToolUse | allows only `git push [-u] <remote> <branch>` to a non-main branch; merges are gated by the GitHub ruleset and the `codex-hooks/check` status, not by receipts |
| 14a | `main-branch-edit` | PreToolUse | editing a repo that is on main: reminds to branch, once per repo per turn |
| 6 | `secret-warning` | PostToolUse | a token-shaped secret in tool output (the bridge redactor's shapes, `findSecretKinds`): tells the model not to repeat it |
| 7 | `activity-log` | PostToolUse | one JSON line per tool call (tool, cwd, redacted command, exit code; never the output) in `~/.local/state/krotov-plugin/codex-hooks/activity.jsonl`, rotated to `.1` at 5 MB |
| 8 | `hanging-prs` | Stop | own open PRs (`gh search prs --author @me`) older than 2 h: finish or merge; at most once per 2 h |
| 9 | `done-evidence` | Stop | «готово / сделано / done» while the turn ran tools but no test or check command: return for evidence |
| 14b | `dirty-repo` | Stop | a repo touched this turn has uncommitted changes or unpushed commits: commit, push, open a PR |
| 10 | `turn-summary` | Stop | heartbeat `online` to a remote task server with the turn summary (redacted) as its note |

Stop returns at most once per turn and never while `stop_hook_active` is set, so a hook cannot
loop the agent.

### Codex Brain

Brain uses `$CODEX_HOME/brain` and defaults to enabled. Set `{"enabled": false}` in its
`config.json` to turn off all Brain steps. Brain runs in full hook scope for registered owner
sessions and sessions registered as `terminal` in the `local` scope. SessionStart can also claim
a live bridge intent. An unknown session without an intent, a guest or a side session receives
no Brain context and contributes no terminal journal entries.

- **SessionStart** puts HOT first. Startup and clear append a short recent tail. Compaction
  appends the current session's handoff once. Resume emits stored HOT only with
  `"resume_reemit": true`. The handler uses `additionalContextLimit = 6000`.
- **PreCompact** flushes the journal and writes the handoff. The response is always `{}`.
- **UserPromptSubmit** emits unseen owner edits once and captures a redacted prompt for a
  terminal turn with no bridge permit.
- **Stop** can ask once for a missed owner-direct save, sharing the pack's single continuation.
  A terminal turn with no bridge permit is journaled when the reply is final.

Brain steps use file I/O and have a two-second deadline. A Brain failure answers `{}` and logs
one line. Doctor reports PreCompact separately from the five handlers required for full access.
For a managed upgrade, rerun `./install.sh --hooks` and use its printed root command to install the
staged bundle and `requirements.toml` as needed. A user-level upgrade requires trusting the changed
SessionStart and new PreCompact handlers in Codex.

**Strict reader.** The guards read only plain commands: literal words joined by `&&`, `||`, `;`,
`|` and literal redirects. Keywords (`if`, `for`, …), subshells and groups, `$(...)`/backticks,
heredocs into a shell, `&`, `bash -c`, `eval` and a variable in program position are unparsed.
An unparsed line that mentions a guarded token (`rm`, `git push/reset/clean/…`, `gh`, a DB client,
`sudo`, a secret path, `curl … sh`) is denied with «write it as plain commands, one per line».
The same hint applies to opaque shell syntax or inline interpreter code that references the
owner's instruction files. Plain reads of these files and edits to repository `AGENTS.md` files
are allowed by this rule.

**Push and checks.** The only push form is `git push [-u] <remote> <branch>` to a literal branch
that is not main/master (`git -C <dir>` is the only global option). Checks are GitHub's job:
`bun codex-hooks/src/main.ts check <sha>` runs `scripts/check.sh` in a clean worktree at that
commit and posts the commit status `codex-hooks/check` through `gh`. Protect main with a ruleset
(required PR, required status `codex-hooks/check`, no force push or deletion, empty bypass list);
doctor and session start warn when main has no pull-request rule.

**Secrets.** A command naming a secret path (`.env`, `*.key`, `*.pem`, `~/.secrets/`, …) anywhere
in a word runs only with a non-printing program: `test`, `[`, `ls`, `stat`, `chmod`,
`grep -q/-c/-l`, `source`, `rm`, or `cp`/`mv` writing onto it. The activity log and the turn
state hold tool, program names, verdict and exit code, never command text; the recall query drops
paths, links, addresses and token-like words.

**Snapshot before delete.** For a recognised deletion with literal targets the hook saves what
would be lost under `~/.trash/<stamp>-<call>/<absolute path>` and checks the copy before the
command runs: removal (`rm`, `rmdir`, `unlink`, `find -delete`, `git clean`, a patch delete) as a
hardlink copy; in-place destruction (`> file`, `truncate`, `shred`, `mv`/`cp` onto a file, a patch
update, a sqlite `DROP`) as a real copy; `git reset --hard`/`checkout --`/`restore` as
`refs/backup/<stamp>` (from `git stash create`); `git branch -D` as `refs/backup/branches/<name>-<stamp>`.
Paths go through `realpath`; temp dirs, `~/.cache`, `node_modules`, `dist`, `build`, `.next`,
`target`, `__pycache__` and `.venv` need no snapshot; git-ignored files are snapshotted like any
other. Nothing inside `~/.trash` may be deleted, overwritten or moved out. A snapshot that fails or
exceeds the caps (50 000 files, 256 MB copied, another filesystem) denies with an `mv … ~/.trash/`
hint. Local Postgres/MySQL `DROP`/`TRUNCATE` is denied in v0.4. Deletions inside scripts and
interpreters are invisible to any hook. `bun codex-hooks/src/install.ts --uninstall` removes
exactly the pack's handlers, `KROT_CODEX_HOOKS` and `KROT_CODEX_SANDBOX=danger-full-access` from
`plugin/.env`.

### Optional remote MCP hooks

The three remote MCP hooks (`gbrain-inbox`, `recall`, `turn-summary`) and the remote MCP part of
`session-sanity` need two things the pack does not ship: your agent id and the addresses of your
MCP servers. Without either, they skip and write one line to `hooks.log`
(`MCP hooks skipped: ...`); every other hook works as usual.

- **Agent id:** `"agent"` in the switchboard, or the env variable `CODEX_HOOKS_AGENT_ID` (env wins).
- **Server addresses:** Each tool in the compatibility settings block `gbrain.tools` names its
  `server` (defaults `swarm`, `tasks`, `recall`). A server's URL is taken, in this order, from the
  env variable `CODEX_HOOKS_GBRAIN_URL_<SERVER>` (the name upper-cased, other characters as `_`),
  from `gbrain.urls` in the switchboard, or from the `url` of the `[mcp_servers.<server>]` entry in
  `$CODEX_HOME/config.toml`. So if Codex already knows your MCP servers under these names,
  nothing else is needed.
- **Key:** `GBRAIN_BEARER` / `GBRAIN_API_KEY` from the environment, else read from the file named by
  `gbrain.envFile` (default `~/.secrets/gbrain.env`, a `GBRAIN_BEARER=...` line). The same key goes
  to every server, only as the `Authorization` header; it is never printed or logged.

Example switchboard for remote MCP endpoints.

```json
{
  "agent": "my-agent",
  "gbrain": {
    "urls": {
      "swarm": "https://mcp.example.com/swarm/mcp",
      "tasks": "https://mcp.example.com/task/mcp",
      "recall": "https://mcp.example.com/recall/mcp"
    },
    "envFile": "~/.secrets/gbrain.env"
  }
}
```

The tools and arguments the hooks call by default (`<agent>` is the configured agent id):

| Hook | Server | Tool and arguments |
|---|---|---|
| `gbrain-inbox` | `swarm` | `list_my_pending` (no arguments) |
| `gbrain-inbox` | `tasks` | `task_list {assignee: <agent>}`, then `agent_heartbeat {agent: <agent>, status: "online"}` |
| `recall` | `recall` | `recall {query, limit: 5}` |
| `turn-summary` | `tasks` | `agent_heartbeat {agent: <agent>, status: "online", note: <summary>}` |

`agent_heartbeat` accepts `status` `online` or `busy` and an optional `note`. A tool's `server`,
`name` and `arguments` can be changed in `gbrain.tools` of the switchboard.

Other env overrides: `CODEX_HOOKS_CONFIG` (path of the switchboard) and `CODEX_HOOKS_STATE_DIR`
(state directory, default `~/.local/state/krotov-plugin/codex-hooks`).

Doctor (`bun run doctor`, and the `/doctor` command in the chat) checks the pack when
`KROT_CODEX_HOOKS=1`: hooks registered for every event and trusted by Codex. `/doctor` lists a
missing or untrusted pack as a problem and shows a healthy one as a line under the report.

The PreToolUse hook's deny for `$CODEX_HOME/AGENTS.md` and `AGENTS.override.md` is a best-effort
early warning. The Linux immutable flag is the enforcement boundary. At deployment, the owner
sets it on each existing file with `sudo chattr +i "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"`.
Set the same flag on `AGENTS.override.md` if present. Bot startup warns the
owner once when it finds an unprotected file, and `/doctor` shows each file's protection status.

To edit the file, the owner runs `sudo chattr -i "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"`, makes the
edit, and runs `sudo chattr +i "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"` to restore protection.
Use the override's path when editing it.

## The Codex hook contract (verified)

Codex CLI 0.172.0 could not be run inside the job that built this pack, so the contract was read
from the installed binary (`@openai/codex-linux-x64/.../bin/codex`): it embeds the JSON schema of
every hook's input and output (titles `pre-tool-use.command.input`, `stop.command.output`, ...)
and the error messages of its output parser.

- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.
- Input (stdin JSON): common `session_id`, `turn_id`, `cwd`, `model`, `permission_mode`,
  `transcript_path`, `hook_event_name`; PreToolUse/PostToolUse add `tool_name`, `tool_input`,
  `tool_use_id` (+ `tool_response`); UserPromptSubmit `prompt`; SessionStart `source`
  (`startup|resume|clear|compact|fork`); Stop `last_assistant_message`, `stop_hook_active`.
- Output (stdout JSON): `continue`, `stopReason`, `suppressOutput`, `systemMessage` everywhere;
  `hookSpecificOutput.additionalContext` for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse.
- Blocking a tool call: `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`.
  `allow` and `ask` are rejected by 0.172.0 ("PreToolUse hook returned unsupported
  permissionDecision:allow"). Exit code 2 with the reason on stderr also blocks.
- Stop / PostToolUse / UserPromptSubmit: `decision: "block"` + `reason`; for Stop the reason is
  the continuation prompt ("Stop hook requested continuation without a prompt; ignoring the block").
- Config: a `hooks.json` with `{"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type": "command", "command": ...}]}]}}`;
  handler types `command`, `mcpTool`, `prompt`.
- Trust: persisted in `config.toml` as `hooks.state."<key>".trusted_hash`; App Server
  `hooks/list` reports `sourcePath`, `eventName`, `currentHash`, `trustStatus` per hook;
  `--dangerously-bypass-hook-trust` skips the check for one invocation ("Intended only for
  automation that already vets hook sources").

Not verified: that Codex reads the user-level file at `$CODEX_HOME/hooks.json` (the binary names
`hooks.json` and the plugin path `hooks/hooks.json`; the location follows the Codex docs as
quoted in the brief; doctor's `hooks/list` check shows whether Codex picked the file up), the exact name of the per-handler timeout field in `hooks.json` (the pack sets
none and keeps its own timeouts short), the `<key>` format and hash algorithm of the trust
record (so the installer does not write it), and the parameters of `hooks/list` (doctor sends
`{}` and reports a warning if Codex rejects it).
