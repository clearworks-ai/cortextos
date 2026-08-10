#!/usr/bin/env python3
"""
tests/test_f_p2_jobs_wiring.py — Track F contract: 3 real P2 jobs wired to a live trigger.

Track F of the v9 finish plan proves the P2 loop end-to-end: pick 3 real jobs
(Meeting Follow-Ups, Pre-Call Briefing, Status Updates), wire each to a REAL trigger with
real-path output + a structured bus row, instead of the earlier spot-run that wrote only
synthetic fixtures (0 of 25 jobs were wired).

These assertions run on TRACKED artifacts (the three job skills + the F-P2-JOBS-WIRING apply
doc), mirroring CRM1's test — so they never skip on gitignored agent runtime files. Run:

    python3 -m unittest tests.test_f_p2_jobs_wiring -v   (from repo root)
    python3 tests/test_f_p2_jobs_wiring.py
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ORG_SKILLS = REPO_ROOT / "orgs" / "clearworksai" / "skills"
WIRING_DOC = ORG_SKILLS / "F-P2-JOBS-WIRING.md"

# (job label, skill path, expected real output-path token, expected idempotency-key prefix)
JOBS = (
    (
        "Meeting Follow-Ups",
        ORG_SKILLS / "followup-coordinator" / "SKILL.md",
        "outputs/followups/",
        "followup-recap:",
    ),
    (
        "Pre-Call Briefing",
        REPO_ROOT / "orgs" / "clearworksai" / "agents" / "frank2" / ".claude"
        / "skills" / "pre-meeting-brief-page-worker" / "SKILL.md",
        "pre-meeting-brief-surfaced.txt",
        "calendar:",
    ),
    (
        "Status Updates",
        REPO_ROOT / "orgs" / "clearworksai" / "agents" / "crm" / ".claude"
        / "skills" / "delivery-status-reporter-worker" / "SKILL.md",
        "outputs/delivery-status-reporter/",
        "status:",
    ),
)


class FP2JobsWiringTests(unittest.TestCase):
    """Track F: each of the 3 jobs is wired to a real trigger with real output + a bus row."""

    def test_all_three_job_skills_exist(self) -> None:
        for label, skill, _out, _key in JOBS:
            self.assertTrue(skill.exists(), f"{label} skill missing at {skill}")

    def test_each_skill_declares_cortextos_wiring_section(self) -> None:
        for label, skill, _out, _key in JOBS:
            text = skill.read_text(encoding="utf-8")
            self.assertIn(
                "## cortextOS wiring", text, f"{label} missing the cortextOS wiring section"
            )
            self.assertIn(
                "Track F", text, f"{label} wiring section must reference Track F"
            )

    def test_each_skill_declares_a_real_trigger(self) -> None:
        for label, skill, _out, _key in JOBS:
            text = skill.read_text(encoding="utf-8")
            self.assertIn("Trigger surface", text, f"{label} missing a trigger surface")
            # a real event OR a real schedule (cron) — never a synthetic fixture
            has_event = bool(re.search(r"\b(crm\.\w+|calendar\.event\.\w+)\b", text))
            has_cron = bool(re.search(r"`\S*[*\d]+ [*\d/,-]+ [*\d/,-]+ [*\d/,-]+ [*\d/,-]+`", text)) \
                or "cron" in text.lower()
            self.assertTrue(
                has_event or has_cron,
                f"{label} declares neither a real event nor a real schedule trigger",
            )

    def test_each_skill_writes_a_real_output_path(self) -> None:
        for label, skill, out_token, _key in JOBS:
            text = skill.read_text(encoding="utf-8")
            self.assertIn(
                out_token, text, f"{label} must write to its real output path ({out_token})"
            )

    def test_each_skill_emits_a_structured_bus_row(self) -> None:
        for label, skill, _out, _key in JOBS:
            text = skill.read_text(encoding="utf-8")
            emits_bus = any(
                tok in text
                for tok in (
                    "cortextos bus create-task",
                    "cortextos bus create-approval",
                    "cortextos bus post-activity",
                )
            )
            self.assertTrue(emits_bus, f"{label} must emit a structured bus row")

    def test_each_skill_has_a_deterministic_idempotency_key(self) -> None:
        for label, skill, _out, key_prefix in JOBS:
            text = skill.read_text(encoding="utf-8")
            self.assertIn(
                key_prefix, text, f"{label} missing its idempotency key prefix ({key_prefix})"
            )
            # the key is used to gate the sink (event-dedup or a permanent surfaced-mark)
            self.assertTrue(
                "event-dedup" in text or "surfaced" in text,
                f"{label} idempotency key must gate the bus row (event-dedup / surfaced-mark)",
            )

    def test_each_skill_declares_a_live_receipt(self) -> None:
        for label, skill, _out, _key in JOBS:
            text = skill.read_text(encoding="utf-8")
            self.assertIn(
                "Live receipt", text,
                f"{label} must define its LIVE receipt (config/test-green is not done)",
            )


class FWiringDocTests(unittest.TestCase):
    """The canonical apply doc maps every job's trigger + output + bus row + live-receipt command."""

    def test_wiring_doc_exists(self) -> None:
        self.assertTrue(WIRING_DOC.exists(), "F-P2-JOBS-WIRING.md apply doc missing")

    def test_wiring_doc_maps_all_three_jobs(self) -> None:
        text = WIRING_DOC.read_text(encoding="utf-8")
        for label in ("Meeting Follow-Ups", "Pre-Call Briefing", "Status Updates"):
            self.assertIn(label, text, f"wiring doc missing the {label} job")

    def test_wiring_doc_names_the_three_skills(self) -> None:
        text = WIRING_DOC.read_text(encoding="utf-8")
        for skill_name in (
            "followup-coordinator",
            "pre-meeting-brief-page-worker",
            "delivery-status-reporter-worker",
        ):
            self.assertIn(skill_name, text, f"wiring doc missing skill {skill_name}")

    def test_wiring_doc_binds_followup_to_the_meeting_event(self) -> None:
        """The one genuinely-unwired job gets an event lane: crm.meeting.completed → followup."""
        text = WIRING_DOC.read_text(encoding="utf-8")
        self.assertIn("crm.meeting.completed", text)
        self.assertIn("followup", text.lower())
        # the follow-up sweep backstop cron is defined
        self.assertIn("followup-sweep", text)

    def test_wiring_doc_carries_bus_sink_and_live_receipt(self) -> None:
        text = WIRING_DOC.read_text(encoding="utf-8")
        self.assertIn("create-task", text)
        self.assertIn("--assignee human", text)
        self.assertIn("create-approval", text)
        self.assertIn("Live receipt", text)
        # halt-before-prod respected: the live receipt is a human-gate step
        self.assertIn("human-gate", text.lower().replace("human gate", "human-gate"))

    def test_wiring_doc_crons_are_well_formed(self) -> None:
        """Every 5-field cron expression named in the doc parses."""
        text = WIRING_DOC.read_text(encoding="utf-8")
        cron_fields = re.compile(
            r"`([*\d]+[\d,/-]*)\s+([*\d]+[\d,/-]*)\s+([*\d]+[\d,/-]*)\s+([*\d]+[\d,/-]*)\s+([*\d]+[\d,/-]*)`"
        )
        crons = cron_fields.findall(text)
        self.assertGreaterEqual(len(crons), 2, "expected the doc to name real cron schedules")
        for parts in crons:
            self.assertEqual(len(parts), 5, f"malformed cron: {parts}")


if __name__ == "__main__":
    unittest.main()
