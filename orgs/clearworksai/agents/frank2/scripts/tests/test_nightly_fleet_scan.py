#!/usr/bin/env python3
"""Unit tests for nightly-fleet-scan.py (stdlib unittest only).

Covers the deterministic FLOW: crash-loop threshold, hook-error ANSI-stripped
grep, silent-agent heartbeat threshold, frustration keyword grep, and the
noise-rejection cases (below-threshold, fresh heartbeat, out-of-window events).
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "nightly-fleet-scan.py"


def load_mod():
    spec = importlib.util.spec_from_file_location("nightly_fleet_scan", SCRIPT_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["nightly_fleet_scan"] = mod
    spec.loader.exec_module(mod)
    return mod


nfs = load_mod()

NOW = datetime(2026, 8, 11, 2, 3, 0, tzinfo=timezone.utc)


class Fixture:
    """Builds a throwaway logs/state/memory tree for one scan."""

    def __init__(self, root: Path):
        self.logs = root / "logs"
        self.state = root / "state" / "agents"
        self.memory = root / "memory"

    def restarts(self, agent: str, text: str) -> None:
        d = self.logs / agent
        d.mkdir(parents=True, exist_ok=True)
        (d / "restarts.log").write_text(text, encoding="utf-8")

    def crashes(self, agent: str, text: str) -> None:
        d = self.logs / agent
        d.mkdir(parents=True, exist_ok=True)
        (d / "crashes.log").write_text(text, encoding="utf-8")

    def stdout(self, agent: str, text: str) -> None:
        d = self.logs / agent
        d.mkdir(parents=True, exist_ok=True)
        (d / "stdout.log").write_text(text, encoding="utf-8")

    def heartbeat(self, agent: str, last_fired_at: str | None) -> None:
        d = self.state / agent
        d.mkdir(parents=True, exist_ok=True)
        cron = {"name": "heartbeat", "schedule": "4h", "enabled": True}
        if last_fired_at is not None:
            cron["last_fired_at"] = last_fired_at
        (d / "crons.json").write_text(
            json.dumps({"crons": [cron]}), encoding="utf-8"
        )

    def daily_memory(self, agent: str, day: str, text: str) -> None:
        d = self.memory / agent / "memory"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{day}.md").write_text(text, encoding="utf-8")

    def run(self, agents: tuple[str, ...], window_hours: float = 24.0) -> dict:
        return nfs.scan(
            logs_dir=self.logs,
            state_dir=self.state,
            memory_dir=self.memory,
            agents=agents,
            now=NOW,
            window_hours=window_hours,
        )


class TestHelpers(unittest.TestCase):
    def test_strip_ansi_removes_csi_and_osc(self):
        raw = "\x1b]0;title\x07\x1b[38;5;174m✻ hook error\x1b[39m"
        self.assertEqual(nfs.strip_ansi(raw), "✻ hook error")

    def test_parse_ts_bracketed_and_plain(self):
        a = nfs.parse_ts("[2026-08-04T17:22:20Z] CRASH")
        b = nfs.parse_ts("2026-08-04T19:04:22.270Z type=crash")
        self.assertIsNotNone(a)
        self.assertIsNotNone(b)
        self.assertEqual(a.tzinfo, timezone.utc)

    def test_parse_ts_none_when_absent(self):
        self.assertIsNone(nfs.parse_ts("no timestamp here"))


class TestCrashLoop(unittest.TestCase):
    def test_flags_when_over_threshold_in_window(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            lines = "\n".join(
                f"[2026-08-11T0{i}:00:00Z] CRASH: exit_code=1 crash_count={i}"
                for i in range(1, 5)  # 4 crashes, all within 24h of NOW
            )
            fx.restarts("maven", lines)
            fx.heartbeat("maven", NOW.isoformat())  # fresh -> not silent
            out = fx.run(("maven",))
            cands = [c for c in out["candidates"] if c["issue_type"] == "crash_loop"]
            self.assertEqual(len(cands), 1)
            self.assertEqual(cands[0]["count"], 4)
            self.assertTrue(cands[0]["evidence"].startswith("[2026-08-11"))

    def test_does_not_flag_below_threshold(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.restarts("maven", "[2026-08-11T01:00:00Z] CRASH: exit_code=1")  # only 1
            fx.heartbeat("maven", NOW.isoformat())
            out = fx.run(("maven",))
            self.assertEqual(
                [c for c in out["candidates"] if c["issue_type"] == "crash_loop"], []
            )

    def test_ignores_events_outside_window(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            # 4 crashes but all >24h before NOW -> excluded
            lines = "\n".join(
                f"[2026-08-01T0{i}:00:00Z] CRASH: exit_code=1" for i in range(1, 5)
            )
            fx.restarts("maven", lines)
            fx.heartbeat("maven", NOW.isoformat())
            out = fx.run(("maven",))
            self.assertEqual(
                [c for c in out["candidates"] if c["issue_type"] == "crash_loop"], []
            )

    def test_counts_watchdog_hard_restart_token(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            lines = "\n".join(
                f"[2026-08-11T0{i}:00:00Z] WATCHDOG-HARD-RESTART: frozen: stdout unchanged 601s"
                for i in range(1, 5)
            )
            fx.restarts("muse", lines)
            fx.heartbeat("muse", NOW.isoformat())
            out = fx.run(("muse",))
            self.assertEqual(
                len([c for c in out["candidates"] if c["issue_type"] == "crash_loop"]), 1
            )


class TestHookError(unittest.TestCase):
    def test_flags_ansi_wrapped_hook_error(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.stdout(
                "frank2",
                "normal line\n\x1b[38;5;174mPreToolUse hook error: boom\x1b[39m\nmore\n",
            )
            fx.heartbeat("frank2", NOW.isoformat())
            out = fx.run(("frank2",))
            cands = [c for c in out["candidates"] if c["issue_type"] == "hook_error"]
            self.assertEqual(len(cands), 1)
            self.assertIn("hook error", cands[0]["evidence"])
            self.assertNotIn("\x1b", cands[0]["evidence"])

    def test_no_hook_error_clean_stdout(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.stdout("frank2", "all good\nthinking\ninbox clear\n")
            fx.heartbeat("frank2", NOW.isoformat())
            out = fx.run(("frank2",))
            self.assertEqual(
                [c for c in out["candidates"] if c["issue_type"] == "hook_error"], []
            )


class TestSilentAgent(unittest.TestCase):
    def test_flags_stale_heartbeat(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.heartbeat("larry", "2026-08-10T19:00:00Z")  # ~7h before NOW
            out = fx.run(("larry",))
            cands = [c for c in out["candidates"] if c["issue_type"] == "silent_agent"]
            self.assertEqual(len(cands), 1)
            self.assertGreater(cands[0]["count"], 5.0)

    def test_fresh_heartbeat_not_flagged(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.heartbeat("larry", "2026-08-11T01:30:00Z")  # 33 min before NOW
            out = fx.run(("larry",))
            self.assertEqual(
                [c for c in out["candidates"] if c["issue_type"] == "silent_agent"], []
            )

    def test_missing_crons_json_not_flagged(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))  # no heartbeat written for 'sre'
            out = fx.run(("sre",))
            self.assertEqual(out["candidates"], [])


class TestFrustration(unittest.TestCase):
    def test_flags_keyword_in_daily_memory(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.daily_memory("sage", "2026-08-11", "the pipeline is broken and I can't trust it\n")
            fx.heartbeat("sage", NOW.isoformat())
            out = fx.run(("sage",))
            cands = [c for c in out["candidates"] if c["issue_type"] == "frustration"]
            self.assertEqual(len(cands), 1)

    def test_no_frustration_neutral_memory(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.daily_memory("sage", "2026-08-11", "shipped the feature, all green\n")
            fx.heartbeat("sage", NOW.isoformat())
            out = fx.run(("sage",))
            self.assertEqual(
                [c for c in out["candidates"] if c["issue_type"] == "frustration"], []
            )


class TestFlowContract(unittest.TestCase):
    def test_healthy_fleet_yields_empty_candidates(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            for a in ("frank2", "maven", "sage"):
                fx.heartbeat(a, NOW.isoformat())
                fx.stdout(a, "thinking\ninbox clear\n")
                fx.restarts(a, "[2026-08-11T00:00:00Z] type=daemon-stop reason=SIGTERM\n")
            out = fx.run(("frank2", "maven", "sage"))
            self.assertEqual(out["candidates"], [])
            self.assertEqual(out["agents_scanned"], ["frank2", "maven", "sage"])

    def test_output_is_deterministically_ordered(self):
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            fx.heartbeat("sage", "2026-08-10T00:00:00Z")   # silent
            fx.heartbeat("maven", "2026-08-10T00:00:00Z")  # silent
            out1 = fx.run(("sage", "maven"))
            out2 = fx.run(("maven", "sage"))
            order1 = [(c["agent"], c["issue_type"]) for c in out1["candidates"]]
            order2 = [(c["agent"], c["issue_type"]) for c in out2["candidates"]]
            self.assertEqual(order1, order2)  # agent-then-type sort, input-order independent

    def test_only_a_few_candidates_survive_a_noisy_tree(self):
        """The whole point: a big noisy corpus collapses to a SHORT candidate list."""
        with TemporaryDirectory() as tmp:
            fx = Fixture(Path(tmp))
            # Lots of benign stdout noise + a couple of below-threshold crashes.
            for a in ("frank2", "maven", "sage", "muse", "larry"):
                fx.heartbeat(a, NOW.isoformat())
                fx.stdout(a, "\n".join(f"line {i} thinking" for i in range(1000)))
                fx.restarts(a, "[2026-08-11T01:00:00Z] CRASH: exit_code=1\n")  # 1 crash < threshold
            # One genuinely bad agent.
            fx.restarts(
                "maven",
                "\n".join(f"[2026-08-11T0{i}:00:00Z] CRASH: exit_code=1" for i in range(1, 6)),
            )
            out = fx.run(("frank2", "maven", "sage", "muse", "larry"))
            # Thousands of log lines -> exactly one candidate handed to the LLM.
            self.assertEqual(len(out["candidates"]), 1)
            self.assertEqual(out["candidates"][0]["agent"], "maven")
            self.assertEqual(out["candidates"][0]["issue_type"], "crash_loop")


if __name__ == "__main__":
    unittest.main()
