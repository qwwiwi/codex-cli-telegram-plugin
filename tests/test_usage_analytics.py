"""Exercise the usage CLI with synthetic local Codex rollouts."""

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "usage_analytics.py"


def uuid7(time):
    milliseconds = int(time.timestamp() * 1000)
    return str(UUID(int=(milliseconds << 80) | (7 << 76) | (2 << 62)))


def event(time, kind, **payload):
    return {"timestamp": time.isoformat(), "type": kind, "payload": payload}


def counts(amount):
    return {
        "input_tokens": amount,
        "cached_input_tokens": amount // 2,
        "output_tokens": amount // 4,
        "total_tokens": amount + amount // 4,
    }


def usage(time, running, last, pct=20):
    return event(time, "event_msg", type="token_count", info={
        "total_token_usage": counts(running), "last_token_usage": counts(last),
    }, rate_limits={
        "limit_id": "codex",
        "secondary": {"window_minutes": 10080, "used_percent": pct,
                      "resets_at": int((time + timedelta(days=6)).timestamp())},
    })


def turn_start(time, turn_id):
    return [
        event(time, "event_msg", type="task_started", turn_id=turn_id),
        event(time, "turn_context", turn_id=turn_id, model="gpt-6.2-sol"),
    ]


class UsageReportTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.midnight = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0)

    def write(self, name, entries, archived=False):
        path = self.base / ("archived_sessions" if archived else "sessions") / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")

    def report(self):
        output = subprocess.check_output([
            sys.executable, str(SCRIPT), "--codex-home", str(self.base),
            "--state-dir", str(self.base / "state"), "--days", "2", "--json",
        ], text=True)
        self.assertNotIn("private-user-message", output)
        return json.loads(output)

    def test_daily_deltas_with_duplicate_and_midnight(self):
        before = self.midnight - timedelta(seconds=1)
        session_id = uuid7(before - timedelta(minutes=1))
        turn_id = uuid7(before)
        sample = usage(before, 80, 80)
        self.write("main.jsonl", [
            event(before, "session_meta", id=session_id, source="cli"),
            *turn_start(before, turn_id),
            event(before, "response_item", type="message", role="user",
                  content=[{"type": "input_text", "text": "private-user-message"}]),
            sample, sample, usage(self.midnight, 120, 40, pct=21),
        ])
        result = self.report()
        self.assertEqual(result["totals"]["total"], 150)
        self.assertEqual(result["totals"]["events"], 2)
        self.assertEqual(result["totals"]["input"], 120)
        self.assertEqual(result["totals"]["cached_input"], 60)
        self.assertEqual(result["totals"]["output"], 30)
        self.assertEqual(result["daily"][before.date().isoformat()]["total"], 100)
        self.assertEqual(result["daily"][self.midnight.date().isoformat()]["total"], 50)
        self.assertEqual(result["daily"][self.midnight.date().isoformat()]["weekly_quota"]["used_percent"], 21)

    def test_subagent_usage_groups_under_originating_owner_task(self):
        time = self.midnight - timedelta(hours=1)
        turn_id = uuid7(time)
        parent = uuid7(time - timedelta(minutes=1))
        self.write("root.jsonl", [
            event(time, "session_meta", id=parent, source="cli"),
            *turn_start(time, turn_id),
            event(time, "response_item", type="message", role="user", content=[{
                "type": "input_text", "text": "Служебное правило канала Telegram.\n"
                "ID входящих сообщений Telegram: 123\nprivate-user-message"}]),
            usage(time, 80, 80),
        ])
        agent = uuid7(self.midnight - timedelta(seconds=2))
        child_turn = uuid7(self.midnight)
        self.write("agent.jsonl", [
            event(self.midnight, "session_meta", id=agent, parent_thread_id=parent,
                  source={"subagent": {"thread_spawn": {"parent_thread_id": parent}}}),
            event(self.midnight, "event_msg", type="task_started", turn_id=child_turn,
                  root_turn_id=turn_id),
            event(self.midnight, "turn_context", turn_id=child_turn, model="unknown"),
            usage(self.midnight, 40, 40),
        ])
        result = self.report()
        self.assertEqual(result["tasks"]["telegram:123"]["total"], 150)
        self.assertEqual(result["categories"]["main"]["total"], 100)
        self.assertEqual(result["categories"]["agent"]["total"], 50)
        self.assertEqual(result["totals"]["unpriced_events"], 1)

    def test_fork_replay_and_duplicate_archive_count_once(self):
        first = self.midnight - timedelta(hours=1)
        parent = uuid7(first - timedelta(minutes=1))
        parent_turn = uuid7(first)
        parent_events = [
            *turn_start(first, parent_turn), usage(first, 80, 80),
            event(first, "event_msg", type="task_complete", turn_id=parent_turn),
        ]
        records = [event(first, "session_meta", id=parent, source="cli"), *parent_events]
        self.write("root.jsonl", records)
        self.write("root-copy.jsonl", records, archived=True)
        child = uuid7(self.midnight - timedelta(seconds=1))
        child_turn = uuid7(self.midnight)
        self.write("child.jsonl", [
            event(self.midnight, "session_meta", id=child, forked_from_id=parent,
                  source="cli"),
            *parent_events, *turn_start(self.midnight, child_turn),
            usage(self.midnight, 120, 40),
        ])
        result = self.report()
        self.assertEqual(result["totals"]["total"], 150)


if __name__ == "__main__":
    unittest.main()
