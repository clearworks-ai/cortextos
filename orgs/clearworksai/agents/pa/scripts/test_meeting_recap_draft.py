from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("meeting_recap_draft.py")
SPEC = importlib.util.spec_from_file_location("meeting_recap_draft_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load meeting_recap_draft.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TrustTierTests(unittest.TestCase):
    def internal_meeting(self) -> dict[str, object]:
        return {
            "id": "m-internal",
            "title": "Internal sync",
            "date": "2026-07-27T09:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["ops@clearworks.ai"],
            "summary": {"overview": "Reviewed ops queue", "bullets": "", "action_items": ""},
            "client_context": "",
            "next_steps": [{"text": "Tighten the queue", "direction": "outbound", "owner": "Josh"}],
        }

    def client_meeting(self) -> dict[str, object]:
        return {
            "id": "m-client",
            "title": "OCG recap",
            "date": "2026-07-27T10:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mpo@owenscg.com"],
            "summary": {"overview": "Reviewed the audit scope", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=OCG. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

    def test_l1_default_for_client_facing_recap(self):
        tier, confidence, reason = MODULE.determine_trust_tier(self.client_meeting(), set())
        self.assertEqual(tier, "L1")
        self.assertGreater(confidence, 0.5)
        self.assertEqual(reason, "client-facing-default")

    def test_l2_internal_high_confidence_auto_file(self):
        tier, confidence, reason = MODULE.determine_trust_tier(self.internal_meeting(), set())
        self.assertEqual(tier, "L2")
        self.assertGreater(confidence, 0.9)
        self.assertEqual(reason, "internal-high-confidence")

    def test_l3_vip_overrides_internal_auto_file(self):
        meeting = self.internal_meeting()
        meeting["title"] = "VIP board prep"
        tier, confidence, reason = MODULE.determine_trust_tier(meeting, {"vip board prep"})
        self.assertEqual(tier, "L3")
        self.assertGreater(confidence, 0.9)
        self.assertEqual(reason, "vip-list")


class ProcessMeetingsTests(unittest.TestCase):
    def test_process_meetings_drafts_client_facing_recap(self):
        meeting = {
            "id": "meeting-client",
            "title": "MSIA recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mark@msia.org"],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }
        calls: list[list[str]] = []

        def runner(args):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, stdout="drafted", stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            summary = MODULE.process_meetings(
                [meeting],
                ledger_path=ledger_path,
                voice_guidance="Keep it direct.",
                vip_list=set(),
                runner=runner,
            )

        self.assertEqual(summary["drafts_created"], 1)
        self.assertEqual(summary["auto_filed"], 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:3], ["gws", "gmail", "+draft"])

    def test_process_meetings_auto_files_internal_l2_without_runner(self):
        meeting = {
            "id": "meeting-internal",
            "title": "Internal sync",
            "date": "2026-07-27T12:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["ops@clearworks.ai"],
            "summary": {"overview": "Reviewed the ops queue.", "bullets": "", "action_items": ""},
            "client_context": "",
            "next_steps": [{"text": "Tighten the queue", "direction": "outbound", "owner": "Josh"}],
        }

        def runner(args):
            raise AssertionError(f"runner should not be called for L2 auto-file: {args}")

        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            summary = MODULE.process_meetings(
                [meeting],
                ledger_path=ledger_path,
                voice_guidance="",
                vip_list=set(),
                runner=runner,
            )
            ledger_contents = ledger_path.read_text(encoding="utf-8")

        self.assertEqual(summary["drafts_created"], 0)
        self.assertEqual(summary["auto_filed"], 1)
        self.assertIn("meeting-internal", ledger_contents)

    def test_build_body_includes_client_context_and_next_steps(self):
        meeting = {
            "id": "meeting-body",
            "title": "OCG recap",
            "date": "2026-07-27T13:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mpo@owenscg.com"],
            "summary": {"overview": "Reviewed the audit scope.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=OCG. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

        body = MODULE.build_body(meeting, "Keep it direct.")

        self.assertIn("Relationship context:", body)
        self.assertIn("Here’s the quick recap.", body)
        self.assertIn("Next steps:", body)
        self.assertIn("Josh: Send findings deck", body)


if __name__ == "__main__":
    unittest.main()
