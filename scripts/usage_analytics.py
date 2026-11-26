#!/usr/bin/env python3
"""Summarize local Codex rollouts. Only numeric usage and identifiers are exported."""
import argparse
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID


FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens")
# Standard USD per million tokens, verified 2026-11-26:
# https://developers.openai.com/api/docs/pricing (Short/Long tables).
RATES = {"gpt-6.2-sol": (2, .10, 10), "gpt-6.2-astra": (8, .40, 40)}
IDS = re.compile(r"^ID входящих сообщений Telegram: (\d+(?:, \d+)*)$", re.MULTILINE)
KINDS = {"main": "Основные", "side": "Параллельные", "agent": "Субагенты", "other": "Прочие"}


def counts(usage):
    if not isinstance(usage, dict) or not {"input_tokens", "output_tokens"} <= usage.keys():
        return None
    values = tuple(usage.get(k, 0) for k in FIELDS)
    if all(type(n) is int and n >= 0 for n in values) and values[0] >= values[1]:
        return values
    return None


def estimate(model, delta, last):
    rates = RATES.get(model)
    inp, cached, out, writes = delta
    if rates is None or writes or delta != last:
        return None
    ir, cr, outr = rates
    long = inp > 272000
    return (((inp-cached)*ir + cached*cr)*(2 if long else 1)
            + out*outr*(1.5 if long else 1))/1e6


def inherited(meta, turn):
    if not meta.get("forked_from_id"):
        return False
    try:
        session_id, turn_id = UUID(meta["id"]), UUID(turn)
        return (session_id.version == turn_id.version == 7
                and turn_id.int >> 80 < session_id.int >> 80)
    except (ValueError, TypeError, AttributeError):
        return False


def read_rollout(path, main, start_day, end_day, warnings):
    meta = {}
    turns = {}
    windows = {}
    live = None
    previous = None
    replay = False
    kind = "other"
    model = None
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except (ValueError, RecursionError):
                if line.endswith("\n"):
                    warnings["malformed_event"] += 1
                continue
            if not isinstance(event, dict) or not isinstance(event.get("payload"), dict):
                continue
            p = event["payload"]
            entry = event.get("type")
            t = p.get("type") if entry == "event_msg" else None
            timestamp = event.get("timestamp")
            if not isinstance(timestamp, str):
                continue
            if entry == "session_meta" and not meta and isinstance(p.get("id"), str):
                meta = {k: p.get(k) for k in ("id", "forked_from_id", "parent_thread_id")}
                if isinstance(p.get("source"), dict) and "subagent" in p["source"]:
                    kind = "agent"
                elif meta["id"] == main:
                    kind = "main"
            if not meta:
                continue
            if t == "task_started":
                turn = p.get("turn_id")
                live = None
                replay = inherited(meta, turn)
                if isinstance(turn, str) and not replay:
                    live = turns.setdefault(turn, {
                        "turn": turn, "root": p.get("root_turn_id") if isinstance(p.get("root_turn_id"), str) else None,
                        "session": meta["id"],
                        "task": None, "events": [], "model": None})
            elif entry == "turn_context":
                if live and live["turn"] == p.get("turn_id"):
                    model = p.get("model") if isinstance(p.get("model"), str) else None
                    live["model"] = model
            elif entry == "response_item" and p.get("type") == "message" and p.get("role") == "user" and live:
                for block in p["content"] if isinstance(p.get("content"), list) else []:
                    body = block.get("text") if isinstance(block, dict) else None
                    if not isinstance(body, str):
                        continue
                    if body.startswith("Ты параллельный поток того же агента") and kind != "agent":
                        kind = "side"
                    elif body.startswith("Служебное правило канала Telegram."):
                        if kind == "other":
                            kind = "main"
                        match = IDS.search(body)
                        if match:
                            live["task"] = match[1]
            elif t in ("task_complete", "turn_aborted") and live and p.get("turn_id", live["turn"]) == live["turn"]:
                live = None
            elif t == "token_count":
                # Cumulative values supply the baseline even outside the time filter.
                info = p["info"] if isinstance(p.get("info"), dict) else {}
                current = counts(info.get("total_token_usage"))
                last = counts(info.get("last_token_usage"))
                base = previous
                if current is not None:
                    previous = current
                if replay:
                    continue
                try:
                    stamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    if stamp.tzinfo is None:
                        continue
                    stamp = stamp.astimezone(timezone.utc)
                except ValueError:
                    continue
                day = stamp.date().isoformat()
                if not start_day <= day <= end_day:
                    continue
                limits = p["rate_limits"] if isinstance(p.get("rate_limits"), dict) else {}
                for window in (limits.get("primary"), limits.get("secondary")):
                    if (isinstance(window, dict) and window.get("window_minutes") == 10080
                            and limits.get("limit_id") in ("codex", None)
                            and type(window.get("used_percent")) in (int, float)
                            and 0 <= window["used_percent"] <= 100):
                        at = stamp.isoformat()
                        if day not in windows or at > windows[day]["at"]:
                            windows[day] = {"at": at, "used_percent": window["used_percent"],
                                            "resets_at": window.get("resets_at")}
                if not current or not live:
                    continue
                if base is None:
                    # A resumed rollout can start at a nonzero session total.
                    delta = last if last is not None else current
                else:
                    delta = tuple(n-b for n, b in zip(current, base))
                if any(n < 0 for n in delta) or delta[0] < delta[1]:
                    warnings["counter_reset"] += 1
                    delta = last
                if delta and any(delta):
                    live["events"].append((day, delta, estimate(model, delta, last)))
    return meta, kind, turns, windows


def metrics():
    return {"input": 0, "cached_input": 0, "output": 0, "total": 0, "events": 0,
            "estimated_usd": 0.0, "unpriced_events": 0}


def add(row, delta, cost):
    inp, cache, out, _ = delta
    row["input"] += inp
    row["cached_input"] += cache
    row["output"] += out
    row["total"] += inp + out
    row["events"] += 1
    if cost is None:
        row["unpriced_events"] += 1
    else:
        row["estimated_usd"] += cost


def snapshot(codex, state, days, today):
    start = today - timedelta(days=days-1)
    daily = {(start + timedelta(days=i)).isoformat(): metrics() for i in range(days)}
    try:
        main = json.loads((state / "codex-thread.json").read_text())
    except (ValueError, OSError):
        main = None
    sessions, turns, windows = {}, {}, {}
    warnings = Counter()
    for folder in ("sessions", "archived_sessions"):
        for path in sorted((codex / folder).rglob("*.jsonl")):
            try:
                meta, kind, rows, limits = read_rollout(path, main, start.isoformat(), today.isoformat(), warnings)
            except OSError:
                warnings["unreadable_rollout"] += 1
                continue
            if not meta:
                continue
            sid = meta["id"]
            sessions[sid] = {"kind": kind, "parent": meta.get("parent_thread_id") or meta.get("forked_from_id")}
            for turn, row in rows.items():
                old = turns.get(turn)
                if old is None or len(row["events"]) > len(old["events"]):
                    turns[turn] = row
            for day, window in limits.items():
                if day not in windows or window["at"] > windows[day]["at"]:
                    windows[day] = window
    total, categories, session_usage, tasks = metrics(), defaultdict(metrics), defaultdict(metrics), defaultdict(metrics)
    measured_turns = []
    for turn in turns.values():
        if not turn["events"]:
            continue
        sid = turn["session"]
        kind = sessions[sid]["kind"]
        root = turn.get("root") or turn["turn"]
        task = turn["task"] or turns.get(root, {}).get("task")
        task_id = "telegram:" + task if task else "turn:" + root
        summary = metrics()
        for day, delta, cost in turn["events"]:
            for group in (total, daily[day], categories[kind], session_usage[sid], summary, tasks[task_id]):
                add(group, delta, cost)
        measured_turns.append({k: turn[k] for k in ("turn", "root", "session", "model")} |
                              {"task": task_id, **summary})
    for day, values in daily.items():
        values["weekly_quota"] = windows.get(day)
    return {"days": days, "totals": total, "daily": daily, "categories": dict(categories),
            "sessions": {k: sessions[k] | values for k, values in session_usage.items()},
            "tasks": tasks, "turns": measured_turns, "quota": windows.get(max(windows)) if windows else None,
            "warnings": dict(warnings)}


def render(data):
    t = data["totals"]
    cache_pct = 100*t["cached_input"]/t["input"] if t["input"] else 0
    lines = [f"Расход Codex за {data['days']} дн. · UTC", "",
             f"Всего {t['total']:,} токенов · {len(data['sessions'])} сессий",
             f"Вход {t['input']:,} · из кэша {t['cached_input']:,} ({cache_pct:.1f}%) · выход {t['output']:,}"]
    q = data["quota"]
    if q:
        lines.append(f"Недельная квота аккаунта: {q['used_percent']:g}% на {q['at'][:16].replace('T', ' ')} UTC")
    if t["events"] > t["unpriced_events"]:
        lines.append(f"Оценка по тарифам API: ${t['estimated_usd']:.2f} по оценённым событиям")
    if t["unpriced_events"]:
        lines.append(f"События без оценки цены: {t['unpriced_events']}")
    for k, v in data["categories"].items():
        share = 100*v["total"]/t["total"] if t["total"] else 0
        lines.append(f"{KINDS[k]}: {v['total']:,} ({share:.2f}% токенов)")
    lines.extend(["", "По дням UTC · токены / последняя недельная квота"])
    for day, value in data["daily"].items():
        q = value["weekly_quota"]
        pct = f"{q['used_percent']:g}%" if q else "–"
        lines.append(f"{day}   {value['total']:,} / {pct}")
    if data["tasks"]:
        lines.extend(["", "Крупнейшие поручения · доля токенов за период"])
        for task, v in sorted(data["tasks"].items(), key=lambda item: -item[1]["total"])[:5]:
            label = task.removeprefix("telegram:") if task.startswith("telegram:") else task[-12:]
            lines.append(f"{label}   {v['total']:,} ({100*v['total']/t['total']:.2f}%)" if t["total"] else f"{label}   0")
    if data["warnings"]:
        lines.append("Замечаний к журналам: " + str(sum(data["warnings"].values())))
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.getenv("CODEX_HOME") or Path.home()/".codex"))
    state = Path(os.getenv("XDG_STATE_HOME") or Path.home()/".local/state")/"krotov-plugin"
    parser.add_argument("--state-dir", type=Path, default=Path(os.getenv("TELEGRAM_STATE_DIR") or state))
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    report = snapshot(args.codex_home, args.state_dir, args.days, datetime.now(timezone.utc).date())
    print(json.dumps(report, ensure_ascii=False) if args.json else render(report))


if __name__ == "__main__":
    main()
