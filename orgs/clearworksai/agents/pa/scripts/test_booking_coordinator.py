from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("booking_coordinator.py")
SPEC = importlib.util.spec_from_file_location("booking_coordinator_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load booking_coordinator.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


UTC = timezone.utc


class SchedulingIntentTests(unittest.TestCase):
    def test_positive_phrasings_detected(self):
        for text in [
            "Yes, let's find a time next week to talk.",
            "Sounds great — when are you free for a quick call?",
            "Can we reschedule our meeting to Thursday?",
            "Let's grab 30 minutes to go over the audit.",
            "What times work for you on your end?",
            "Happy to hop on a call — book a time that suits you.",
        ]:
            self.assertTrue(MODULE.detect_scheduling_intent(text), f"missed: {text!r}")

    def test_non_scheduling_not_detected(self):
        for text in [
            "Thanks for the deck, looks good. No changes needed.",
            "Here's the invoice for last month's work.",
            "Just confirming receipt of the documents.",
            "The report is attached for your records.",
        ]:
            self.assertFalse(MODULE.detect_scheduling_intent(text), f"false positive: {text!r}")

    def test_classify_routes_and_makes_candidate_rows(self):
        emails = [
            {"id": "m1", "from": "prospect@acme.com", "subject": "Re: intro",
             "snippet": "yes let's find a time to chat", "threadId": "t1"},
            {"id": "m2", "from": "billing@vendor.com", "subject": "Invoice",
             "snippet": "your invoice is attached", "threadId": "t2"},
        ]
        result = MODULE.classify_emails(emails)
        self.assertEqual(len(result["scheduling_intent"]), 1)
        self.assertEqual(result["scheduling_intent"][0]["id"], "m1")
        self.assertEqual(len(result["other"]), 1)
        candidates = MODULE.scheduling_rows_to_candidates(result["scheduling_intent"])
        self.assertEqual(candidates[0]["state"], "proposed")
        self.assertEqual(candidates[0]["thread_id"], "t1")
        self.assertEqual(candidates[0]["recovery_touches"], 0)


class ProposeDraftTests(unittest.TestCase):
    def freebusy(self, busy_blocks):
        return {"calendars": {"primary": {"busy": busy_blocks}}}

    def test_slots_avoid_busy_blocks_and_draft_never_sends(self):
        # Window: Mon 2026-08-10 all working hours. One busy block 9-10am.
        ws = datetime(2026, 8, 10, 9, 0, tzinfo=UTC)
        we = datetime(2026, 8, 10, 17, 0, tzinfo=UTC)
        fb = self.freebusy([{"start": "2026-08-10T09:00:00+00:00", "end": "2026-08-10T10:00:00+00:00"}])
        row = {"prospect": "prospect@acme.com", "thread_id": "t9", "state": "proposed"}
        plan = MODULE.propose_plan(row, fb, window_start=ws, window_end=we, tz_label="PT")

        self.assertEqual(plan["action"], "propose-slots")
        # Invariant: this path never sends.
        self.assertFalse(plan["send"])
        # No emitted argv is a send command; the draft argv uses +draft only.
        self.assertIn("+draft", plan["draft_argv"])
        self.assertNotIn("+send", plan["draft_argv"])
        self.assertNotIn("send", [a for a in plan["draft_argv"] if a in ("+send", "send")])
        # Every proposed slot misses the 9-10 busy block.
        for slot in plan["slots"]:
            start = MODULE._parse_iso(slot["start"])
            self.assertFalse(
                datetime(2026, 8, 10, 9, tzinfo=UTC) <= start < datetime(2026, 8, 10, 10, tzinfo=UTC),
                f"slot {slot['start']} overlaps busy block",
            )
        # Draft body carries the zcal link (send-the-link, not a slot-create API).
        self.assertIn("zcal.co", plan["draft"]["body"])
        # Tentative hold is validate-only (dry-run), never a real insert.
        self.assertIn("--dry-run", plan["hold_validate_argv"])

    def test_no_slots_when_fully_busy(self):
        ws = datetime(2026, 8, 10, 9, 0, tzinfo=UTC)
        we = datetime(2026, 8, 10, 17, 0, tzinfo=UTC)
        fb = self.freebusy([{"start": "2026-08-10T09:00:00+00:00", "end": "2026-08-10T17:00:00+00:00"}])
        row = {"prospect": "p@acme.com", "thread_id": "t", "state": "proposed"}
        plan = MODULE.propose_plan(row, fb, window_start=ws, window_end=we)
        self.assertEqual(plan["action"], "no-slots")
        self.assertFalse(plan["send"])


class NoShowSweepTests(unittest.TestCase):
    def test_booked_past_45min_no_transcript_opens_recovery(self):
        now = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
        rows = [
            {"prospect": "a@x.com", "state": "booked",
             "call_time": "2026-08-10T11:00:00+00:00", "recovery_touches": 0},  # 60m ago, no close
            {"prospect": "b@x.com", "state": "booked",
             "call_time": "2026-08-10T11:50:00+00:00", "recovery_touches": 0},  # 10m ago -> not yet
            {"prospect": "c@x.com", "state": "booked",
             "call_time": "2026-08-10T11:00:00+00:00", "closed_by": "fireflies"},  # transcript arrived
        ]
        cands = MODULE.no_show_candidates(rows, now=now)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]["prospect"], "a@x.com")
        self.assertEqual(cands[0]["next_state"], "no-show-1")
        self.assertEqual(cands[0]["action"], "recovery-draft")

    def test_recovery_capped_at_two_touches(self):
        now = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
        rows = [{"prospect": "a@x.com", "state": "booked",
                 "call_time": "2026-08-10T11:00:00+00:00", "recovery_touches": 2}]
        cands = MODULE.no_show_candidates(rows, now=now)
        self.assertEqual(cands[0]["next_state"], "not-now")
        self.assertEqual(cands[0]["action"], "stop-recovery")


class CalendarDeltaTests(unittest.TestCase):
    def test_booked_moved_cancelled(self):
        prior = [
            {"id": "e1", "start": "2026-08-11T10:00:00Z"},
            {"id": "e2", "start": "2026-08-11T14:00:00Z"},  # will be cancelled
        ]
        new = [
            {"id": "e1", "start": "2026-08-11T11:00:00Z"},  # moved
            {"id": "e3", "start": "2026-08-12T09:00:00Z"},  # newly booked
        ]
        deltas = MODULE.calendar_deltas(new, prior)
        self.assertEqual([e["id"] for e in deltas["booked"]], ["e3"])
        self.assertEqual([m["id"] for m in deltas["moved"]], ["e1"])
        self.assertEqual([e["id"] for e in deltas["cancelled"]], ["e2"])


class TrackerAtomicWriteTests(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "state" / "booking-tracker.json"
            rows = [{"prospect": "a@x.com", "state": "proposed"}]
            MODULE.write_tracker_atomic(path, rows)
            self.assertEqual(MODULE.load_tracker(path), rows)


class CliTests(unittest.TestCase):
    def test_classify_cli_end_to_end(self):
        payload = {"emails": [
            {"id": "m1", "from": "p@acme.com", "subject": "Re: chat",
             "snippet": "let's set up a call", "threadId": "t1"},
        ]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(payload, fh)
            payload_path = fh.name
        proc = subprocess.run(
            [sys.executable, str(MODULE_PATH), "classify", "--payload", payload_path],
            capture_output=True, text=True, check=True,
        )
        out = json.loads(proc.stdout)
        self.assertEqual(len(out["scheduling_intent"]), 1)
        self.assertEqual(out["candidates"][0]["state"], "proposed")


if __name__ == "__main__":
    unittest.main()
