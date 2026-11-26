# Codex usage analytics

Send `/usage` in the private owner chat to see the last seven UTC calendar days, including today. Use `/usage 1` for today or `/usage 30` for a longer view. Today's bucket is partial until midnight UTC. The bridge can keep processing messages while the local report runs. Python 3.9 or later is required.

## Dashboard data

From the repository root, run:

```sh
python3 scripts/usage_analytics.py --days 7 --json
```

The report reads retained rollout files in the Codex home on the bridge host. Supply `--codex-home` for another local installation and `--state-dir` for the bridge state directory. If Codex runs on another machine, its logs must be available to the collector for its usage to appear. Export JSON outside the repository. Exports may include internal session, turn and Telegram message identifiers.

## Measurement

- Cached reads are included in the input count reported by Codex. Adding them to input again would double count them. Output can include reasoning tokens.
- Use tokens per task, the cached fraction of input and the daily series to compare local workloads. A task's fraction of observed tokens uses a different denominator from subscription quota.
- Weekly quota is an account-wide observation with a reset time. Parallel runs and other devices can advance the same counter. Its precision is limited to the value returned by Codex. A quota reading alone cannot establish the precise charge for a single task.
- An estimate at API list prices expresses comparable API usage in USD. Subscription billing, credits and actual charges must be obtained separately.

## Protocol references

Codex App Server publishes thread token usage, account quota windows and optional account-wide daily token buckets. These have different scopes. This collector reads local rollout events to retain turn-level attribution. Coverage depends on the available history and Codex log format.

- [Thread and token usage notifications](https://developers.openai.com/codex/app-server/)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing/)
