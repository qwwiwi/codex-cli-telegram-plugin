# Changes

This repository is a fork of Krotov-plugin by Pavel Krotov
([github.com/PashaKrot](https://github.com/PashaKrot)), Apache-2.0.
The fork point is upstream commit `bb1d1ce` ("Make Krotov Plugin a deployment-neutral
template"). Everything below was added on top of it by Dashi Eshiev (qwwiwi) and
contributors. Dates are commit dates.

## 2026-11-25

- **Codex limits line in the HUD** (`23d1804`). The pinned context HUD gets one more
  line with the used share of each Codex limit window (5 hours, week) and the weekly
  reset time in Moscow time, for example
  `Лимиты Codex: 5ч 12% · неделя 40% (сброс 01.12 10:00 МСК)`. Limits are cached for
  a minute and refreshed in the background; a failed read keeps the last value and
  never blocks the HUD. Code: `plugin/src/status/codex-limits.ts`.
- **`GH_CONFIG_DIR` passthrough** (`26462e1`). `GH_CONFIG_DIR` is added to the
  environment allowlist the bridge passes to `codex app-server`, so the agent keeps
  its own `gh` login. Code: `plugin/src/codex/server.ts` (`codexEnvironment`).
- **HUD moves to the bottom after each turn** (`de24369`). Instead of editing the
  pinned HUD in place (where it sank into the history), the bridge deletes the old
  card (unpins it when Telegram refuses the delete), sends a fresh one and pins it.
  Bumps are debounced per chat. Code: `plugin/src/status/context-hud.ts` (`bump`).
- **Autonomous sandbox mode** (`9ead1f9`). New env var `KROT_CODEX_SANDBOX`
  (`workspace-write`, the default, or `danger-full-access`). With
  `danger-full-access` and without `KROT_CODEX_APPROVALS=1`, Codex runs with no
  sandbox and no approval cards. Not allowed together with `KROT_CODEX_PROXY`.
  Code: `plugin/src/codex/session.ts`, `plugin/src/config.ts`.
- **Delete the bot's own pin service messages** (`88d5a1c`). Each HUD re-pin makes
  Telegram post a "pinned a message" service line; the bridge now deletes the ones
  produced by the bot itself. Code: `plugin/src/codex/pin-service.ts`.
- **Parallel answers while busy** (`3d3c50a`). Behind `KROT_CODEX_PARALLEL=1`
  (off by default). While the main turn runs, a new owner message that is not a
  correction of the task is answered by a separate side thread in the same
  app-server. `KROT_CODEX_MAX_PARALLEL` caps the number of threads (main included,
  default 2); `KROT_CODEX_CORRECTION_WORDS` overrides the correction keywords.
  Code: `plugin/src/codex/parallel.ts`, `plugin/src/codex/session.ts`.

## Documentation

- English README, Russian README (`README.ru.md`), `docs/ARCHITECTURE.md`,
  `NOTICE` and this file.
