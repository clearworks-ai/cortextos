#!/usr/bin/env python3
"""Unit tests for weekly-review-audit.py (stdlib unittest only)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "weekly-review-audit.py"


def load_mod():
    spec = importlib.util.spec_from_file_location("weekly_review_audit", SCRIPT_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["weekly_review_audit"] = mod
    spec.loader.exec_module(mod)
    return mod


audit = load_mod()


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class TestParseIso(unittest.TestCase):
    def test_parse_iso_handles_trailing_z(self) -> None:
        parsed = audit._parse_iso("2026-08-03T12:34:56Z")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.tzinfo, timezone.utc)
        self.assertEqual(parsed.isoformat(), "2026-08-03T12:34:56+00:00")

    def test_parse_iso_returns_none_for_empty_or_garbage(self) -> None:
        self.assertIsNone(audit._parse_iso(""))
        self.assertIsNone(audit._parse_iso("not-a-timestamp"))


class TestDetectStaleApprovals(unittest.TestCase):
    def test_pending_old_approval_creates_finding_for_requesting_agent(self) -> None:
        now = datetime.now(timezone.utc)
        approvals = [{
            "id": "approval-1",
            "title": "Review queue item",
            "status": "pending",
            "created_at": iso_z(now - timedelta(hours=72)),
            "requesting_agent": "frank2",
        }]

        findings = audit.detect_stale_approvals(approvals, now)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].pillar, "frank2")

    def test_recent_pending_approval_is_not_flagged(self) -> None:
        now = datetime.now(timezone.utc)
        approvals = [{
            "id": "approval-2",
            "status": "pending",
            "created_at": iso_z(now - timedelta(hours=2)),
            "requesting_agent": "frank2",
        }]

        findings = audit.detect_stale_approvals(approvals, now)

        self.assertEqual(findings, [])

    def test_non_pending_old_approval_is_ignored(self) -> None:
        now = datetime.now(timezone.utc)
        approvals = [{
            "id": "approval-3",
            "status": "approved",
            "created_at": iso_z(now - timedelta(hours=72)),
            "requesting_agent": "frank2",
        }]

        findings = audit.detect_stale_approvals(approvals, now)

        self.assertEqual(findings, [])

    def test_missing_requesting_agent_defaults_to_larry(self) -> None:
        now = datetime.now(timezone.utc)
        approvals = [{
            "id": "approval-4",
            "status": "pending",
            "created_at": iso_z(now - timedelta(hours=72)),
        }]

        findings = audit.detect_stale_approvals(approvals, now)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].pillar, "larry")


class TestDetectMulticaIssues(unittest.TestCase):
    def test_zero_errors_is_clean(self) -> None:
        findings = audit.detect_multica_issues({"errors": 0, "scanned": 5})
        self.assertEqual(findings, [])

    def test_nonzero_errors_creates_larry_finding(self) -> None:
        findings = audit.detect_multica_issues({"errors": 3, "scanned": 5})
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].pillar, "larry")

    def test_none_input_is_clean(self) -> None:
        findings = audit.detect_multica_issues(None)
        self.assertEqual(findings, [])


class TestDetectStaleUpstreamSync(unittest.TestCase):
    def test_recent_upstream_sync_is_clean(self) -> None:
        now = datetime.now(timezone.utc)
        cron_state = {
            "crons": [
                {"name": "upstream-sync", "last_fire": iso_z(now - timedelta(days=2))},
            ],
        }

        findings = audit.detect_stale_upstream_sync(cron_state, now)

        self.assertEqual(findings, [])

    def test_stale_upstream_sync_creates_finding(self) -> None:
        now = datetime.now(timezone.utc)
        cron_state = {
            "crons": [
                {"name": "upstream-sync", "last_fire": iso_z(now - timedelta(days=10))},
            ],
        }

        findings = audit.detect_stale_upstream_sync(cron_state, now)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].kind, "upstream_sync_stale")
        self.assertEqual(findings[0].pillar, "larry")

    def test_missing_upstream_sync_record_creates_missing_finding(self) -> None:
        now = datetime.now(timezone.utc)

        findings = audit.detect_stale_upstream_sync({"crons": []}, now)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].kind, "upstream_sync_missing")

    def test_none_cron_state_creates_missing_finding(self) -> None:
        now = datetime.now(timezone.utc)

        findings = audit.detect_stale_upstream_sync(None, now)

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].kind, "upstream_sync_missing")


class TestRenderReport(unittest.TestCase):
    def test_render_report_clean_run_contains_fixed_headings_and_clean_fix_tasks(self) -> None:
        report = audit.render_report("2026-08-03", [])

        self.assertIn("## SYSTEM AUDIT", report)
        self.assertIn("## FIX TASKS", report)
        self.assertIn("## PIPELINE MOVEMENT", report)
        self.assertIn("- none — clean run", report)

    def test_render_report_includes_fix_task_id(self) -> None:
        finding = audit.Finding(
            kind="stale_approval",
            detail="Approval is stale",
            pillar="frank2",
            fix_task_id="task-123",
        )

        report = audit.render_report("2026-08-03", [finding])

        self.assertIn("task-123", report)


if __name__ == "__main__":
    unittest.main()
