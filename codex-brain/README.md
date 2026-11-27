# codex-brain

Memory module of the Codex Telegram plugin ("Codex Brain", milestone M5). It has no Telegram
dependency: the bridge (`plugin/src/codex/`), the hooks pack (`codex-hooks/`) and the `brain`
CLI all use it through the interfaces in `src/contract.ts`.

Brain provides a local journal, owner facts, open tasks, summaries and context handoff.
For Telegram commands and migration, see the [memory guide](../plugin/docs/learning.md).

## On by default

Brain needs no setup. Its settings live in `<brain_home>/config.json`:

```json
{ "enabled": false, "summarizer": { "model": "gpt-6.1-terra", "effort": "high" }, "resume_reemit": false }
```

- No file, or no `enabled` key → Brain is **on**.
- `"enabled": false` → off; nothing but `/memory on` (or editing the file) turns it back on,
  so the choice survives updates and re-installs.
- A file that is not valid JSON, or an `enabled` that is not `true`/`false`, keeps Brain off
  and the problem is shown in the status.
- The bridge's legacy `memory.enabled` setting is never read here.

## Where the files are

`brain_home` is `$CODEX_HOME/brain`, or `~/.codex/brain` when `CODEX_HOME` is unset. Hooks
installed as managed hooks see only `PATH`, `HOME`, `CODEX_HOME`, `TMPDIR`, `LANG`, so nothing
else may move it; `CODEX_BRAIN_HOME` is honoured only by the CLI and tests
(`resolveBrainHome(env, { allowOverride: true })`).

Each scope (`local` for the terminal, `b-<hash>` for a bridge pair) is a directory with the
layout shown below, created by `ensureScope(brainHome, scope)`:

```
<brain_home>/
  config.json   scope.json (default scope for the CLI)   summarizer.json
  sessions/<session>.json      session -> scope and role
  intents/<id>.json            bridge session intents, claimed by the new thread's SessionStart
  lock/                        lock for config.json and intents
  <scope>/
    facts/<id>.md   INDEX.md   journal/<day>.jsonl   recent.md   recent-summary.md
    digest/<day>.md|.json   archive/<month>.tar.gz(.sha256)
    handoff/current.md|.json   handoff/history/   pending/<id>.json
    state/  snapshot/<session>.txt|.json   boundaries/<session>.json   permits/<turn>.json
            receipts/<turn>.json   prompts/<turn>.json   manifest.json   delta.jsonl
            evicted.jsonl   plan.json   questions.json   note.json   lock/
```

A hook looks up its `session_id` in the shared registry at `<brain_home>/sessions/`.
`sessions`,
`intents` and `lock` are therefore not valid scope names.

How a session gets its scope: the bridge records an intent before `thread/start`; the
SessionStart hook of an unknown session claims it (`SessionRegistry.claim`). No live intent → a
terminal session in scope `local`; conflicting intents → a guest with no personal memory.

Directories are `0700`, files `0600`. External ids (sessions, turns, proposals) go through
`safeSegment`, so they can never leave the scope directory.

## Store rules for every slice

- Replace a file only with `writeFileAtomic` (temp file, fsync, rename). Append JSONL lines with
  `appendLine`. A write killed before its rename leaves the old file intact plus an orphaned
  `.<name>.tmp-*` file, which no reader looks at and which may be deleted.
- Hold the scope lock (`withLock(paths.lockDir, fn)`) for every write that must not interleave
  with another process. The lock is `state/lock/held`; a dead holder's lock is broken, a live one
  makes the caller give up after 1 second (half the 2-second hook step budget). A holder from
  another pid namespace (container) is judged by age only. Files above the scopes use
  `<brain_home>/lock` the same way (`writeBrainConfig` does). Keep the locked section to
  file work: never hold it across a model call. Do not nest it; a nested call times out.
- `appendLine` fsyncs the directory when it creates the file.
- Parse everything read from disk with the schema in `contract.ts`.
- Pass every text through `redactSecrets` (`plugin/src/safety/redact.ts`) before it is written.
- Budgets use `estimateTokens`, which deliberately over-counts (Russian text included).

## The contract

`src/contract.ts` holds every type, zod schema, constant and interface shared between slices.
In-memory fakes of its interfaces are in `plugin/tests/brain/fakes.ts`.

## Memory provenance

Rolling summaries and daily digests use two passes. The owner pass reads only non-forwarded
input from `owner-direct` and `terminal` exchanges and can produce owner memory and proposals.
The reference pass reads the other inputs, replies and errors. Its lines appear in HOT with an
`agent reply` or `not from the owner` label and cannot create proposals. Code assigns provenance
from the pass and journal metadata and admits only refs supplied to that pass.

Readers require the current provenance version for rolling summaries, digests, cached HOT,
model-generated proposals and stored handoffs. Handoff reads and delivery use `handoff/current.json`.
An older or unversioned handoff is withheld, including any next-step note it contains. New handoffs
use a note only when it names the same session and records a trusted origin.

## Building and testing

The package has no `package.json`: it uses the plugin's toolchain and its `zod`. Because
`codex-brain/` is not below `plugin/node_modules`, `codex-brain/tsconfig.json` maps `zod` to
`../plugin/node_modules/zod` (Bun honours that mapping when running and bundling), and
`plugin/tsconfig.json` does the same for `tsc`.

```sh
bun install --cwd plugin --frozen-lockfile --ignore-scripts
cd plugin && bun test brain && ./node_modules/.bin/tsc --noEmit -p .
```
