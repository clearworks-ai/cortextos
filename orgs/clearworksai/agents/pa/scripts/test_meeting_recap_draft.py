from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
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

    def test_process_meetings_check_draft_append_race_skips_duplicate_draft(self):
        """Review 2026-09-05 finding: the ledger key-check -> gws +draft ->
        ledger-append sequence must be atomic w.r.t. other recap workers, or
        two concurrent workers can both see the key absent, both call
        gws +draft, and both append -- producing a duplicate external Gmail
        draft. Simulated race: monkeypatch client_file_lock so that, right
        as our own critical section is entered, a second recap worker's
        entire check -> draft -> append cycle for the SAME key runs to
        completion first. With the fix, our re-check (now inside the lock)
        sees that key and skips drafting -- the gws shim is called exactly
        once (by the simulated other worker), never twice."""
        meeting = {
            "id": "meeting-race",
            "title": "Race client recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mark@msia.org"],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }
        key = MODULE.ledger_key(meeting)
        calls: list[list[str]] = []

        def runner(args):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, stdout="drafted", stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            real_lock = MODULE.client_file_lock
            state = {"entered": 0}

            @contextlib.contextmanager
            def racing_lock(path):
                if state["entered"] == 0 and str(path) == str(ledger_path):
                    state["entered"] += 1
                    # Simulate a second recap worker winning the race: it
                    # calls gws +draft AND appends the ledger key before our
                    # own critical section starts.
                    runner(["gws", "gmail", "+draft", "--other-worker"])
                    MODULE._append_ledger_locked(ledger_path, key, "Other worker's subject")
                with real_lock(path):
                    yield

            MODULE.client_file_lock = racing_lock
            try:
                summary = MODULE.process_meetings(
                    [meeting],
                    ledger_path=ledger_path,
                    voice_guidance="Keep it direct.",
                    vip_list=set(),
                    runner=runner,
                )
            finally:
                MODULE.client_file_lock = real_lock

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], ["gws", "gmail", "+draft", "--other-worker"])
        self.assertEqual(summary["drafts_created"], 0)
        self.assertEqual(summary["skipped_ledger"], 1)

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


    def test_main_dry_run_prints_subject_body_without_gws_or_ledger(self):
        meeting = {
            "id": "meeting-dry",
            "title": "MSIA recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mark@msia.org"],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

        def boom(*_a, **_k):
            raise AssertionError("gws/subprocess must not run in --dry-run")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            payload_path = tmp_path / "payload.json"
            ledger_path = tmp_path / "ledger.txt"
            voice_path = tmp_path / "voice.md"
            vip_path = tmp_path / "vip.txt"
            payload_path.write_text(json.dumps({"meetings": [meeting]}), encoding="utf-8")
            ledger_path.write_text("", encoding="utf-8")
            voice_path.write_text("", encoding="utf-8")
            vip_path.write_text("", encoding="utf-8")
            stdout = io.StringIO()
            with mock.patch.object(MODULE.subprocess, "run", boom):
                with contextlib.redirect_stdout(stdout):
                    rc = MODULE.main(
                        [
                            "--payload",
                            str(payload_path),
                            "--ledger",
                            str(ledger_path),
                            "--voice",
                            str(voice_path),
                            "--vip-list",
                            str(vip_path),
                            "--dry-run",
                        ]
                    )
            self.assertEqual(rc, 0)
            out = stdout.getvalue()
            self.assertIn("to: josh@clearworks.ai", out)
            self.assertIn("cc: (none)", out)
            self.assertIn("attendees: mark@msia.org", out)
            self.assertIn("Recap: MSIA recap — 2026-07-27", out)
            self.assertIn("Reviewed the audit findings.", out)
            self.assertIn("Josh: Send findings deck", out)
            self.assertEqual(ledger_path.read_text(encoding="utf-8"), "")

    def test_main_dry_run_prints_attendees_two_emails(self):
        meeting = {
            "id": "meeting-dry-two",
            "title": "MSIA recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mark@msia.org", "sue@msia.org"],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

        def boom(*_a, **_k):
            raise AssertionError("gws/subprocess must not run in --dry-run")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            payload_path = tmp_path / "payload.json"
            ledger_path = tmp_path / "ledger.txt"
            voice_path = tmp_path / "voice.md"
            vip_path = tmp_path / "vip.txt"
            payload_path.write_text(json.dumps({"meetings": [meeting]}), encoding="utf-8")
            ledger_path.write_text("", encoding="utf-8")
            voice_path.write_text("", encoding="utf-8")
            vip_path.write_text("", encoding="utf-8")
            stdout = io.StringIO()
            with mock.patch.object(MODULE.subprocess, "run", boom):
                with contextlib.redirect_stdout(stdout):
                    rc = MODULE.main(
                        [
                            "--payload",
                            str(payload_path),
                            "--ledger",
                            str(ledger_path),
                            "--voice",
                            str(voice_path),
                            "--vip-list",
                            str(vip_path),
                            "--dry-run",
                        ]
                    )
            self.assertEqual(rc, 0)
            out = stdout.getvalue()
            self.assertIn("attendees: mark@msia.org, sue@msia.org", out)

    def test_main_dry_run_prints_attendees_none(self):
        meeting = {
            "id": "meeting-dry-none",
            "title": "MSIA recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": [],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

        def boom(*_a, **_k):
            raise AssertionError("gws/subprocess must not run in --dry-run")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            payload_path = tmp_path / "payload.json"
            ledger_path = tmp_path / "ledger.txt"
            voice_path = tmp_path / "voice.md"
            vip_path = tmp_path / "vip.txt"
            payload_path.write_text(json.dumps({"meetings": [meeting]}), encoding="utf-8")
            ledger_path.write_text("", encoding="utf-8")
            voice_path.write_text("", encoding="utf-8")
            vip_path.write_text("", encoding="utf-8")
            stdout = io.StringIO()
            with mock.patch.object(MODULE.subprocess, "run", boom):
                with contextlib.redirect_stdout(stdout):
                    rc = MODULE.main(
                        [
                            "--payload",
                            str(payload_path),
                            "--ledger",
                            str(ledger_path),
                            "--voice",
                            str(voice_path),
                            "--vip-list",
                            str(vip_path),
                            "--dry-run",
                        ]
                    )
            self.assertEqual(rc, 0)
            out = stdout.getvalue()
            self.assertIn("attendees: (none)", out)


import os


def test_apply_calls_gws_and_keys_ledger_by_source(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    calls_file = tmp_path / "gws-calls.txt"
    gws = bindir / "gws"
    gws.write_text(f'#!/bin/sh\necho "$@" >> {calls_file}\nexit 0\n')
    gws.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")

    payload = {
        "meetings": [
            {
                "id": "unused-legacy-id",
                "title": "Tacticals sync",
                "date": "2026-09-04T17:00:00Z",
                "summary": {"overview": "Scoped tactical reports."},
                "next_steps": [],
                "source": {"kind": "omi", "id": "OMI-999"},
            }
        ]
    }
    payload_path = tmp_path / "recap-payload.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    ledger = tmp_path / "recap-ledger.txt"

    rc = MODULE.main(["--payload", str(payload_path), "--ledger", str(ledger)])
    assert rc == 0
    calls_text = calls_file.read_text(encoding="utf-8")
    assert calls_text.count("+draft") == 1
    tokens = calls_text.split()
    assert "gmail" in tokens
    assert "+draft" in tokens
    assert "send" not in tokens
    assert ledger.read_text(encoding="utf-8").strip().startswith("omi:OMI-999")


def test_legacy_no_source_falls_back_to_fireflies_prefixed_id(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    gws = bindir / "gws"
    gws.write_text("#!/bin/sh\nexit 0\n")
    gws.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    payload = {"meetings": [{"id": "legacy123", "title": "T", "date": "2026-01-01", "next_steps": []}]}
    payload_path = tmp_path / "p.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    ledger = tmp_path / "l.txt"
    rc = MODULE.main(["--payload", str(payload_path), "--ledger", str(ledger)])
    assert rc == 0
    assert ledger.read_text(encoding="utf-8").strip().startswith("fireflies:legacy123")


class AppendLedgerAtomicTests(unittest.TestCase):
    """S-3 (reviewify-standards.json): append_ledger must use the shared
    atomic_write helper (scripts/brain/atomic.py), same import mechanism as
    meeting_writeback.py, instead of a hand-rolled temp+os.replace. The ledger
    row also now carries the draft subject after the key (`<key>\\t<subject>`)
    so an orchestrator resume can recover it, with backward-compat reading of
    legacy no-tab rows."""

    def test_append_ledger_uses_atomic_write_no_stray_tmp_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            ledger = tmp_dir / "ledger.txt"
            MODULE.append_ledger(ledger, "fireflies:a", "Recap: A — 2026-09-04")
            # append_ledger's own former hand-rolled tmp scheme used
            # ".{name}.tmp" — assert that's gone, and atomic_write's own
            # ".tmp-*" residue is cleaned up (os.replace already happened).
            # P1 (review 2026-09-05): append_ledger now also holds
            # client_file_lock, whose sibling "<ledger>.lock" file is an
            # intentional, permanent lock handle (same as
            # meeting_writeback.py's own client-file locks) -- not stray
            # tmp-write residue, so it's expected here and excluded below.
            leftovers = [
                p.name
                for p in tmp_dir.iterdir()
                if p.name not in ("ledger.txt", "ledger.txt.lock")
            ]
            self.assertEqual(leftovers, [])

    def test_append_ledger_row_format_is_key_tab_subject(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            MODULE.append_ledger(ledger, "fireflies:a", "Recap: A — 2026-09-04")
            line = ledger.read_text(encoding="utf-8").strip()
            self.assertEqual(line, "fireflies:a\tRecap: A — 2026-09-04")

    def test_append_ledger_two_sequential_appends_keep_both_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            MODULE.append_ledger(ledger, "fireflies:a", "Subject A")
            MODULE.append_ledger(ledger, "fireflies:b", "Subject B")
            lines = [ln for ln in ledger.read_text(encoding="utf-8").splitlines() if ln.strip()]
            self.assertEqual(lines, ["fireflies:a\tSubject A", "fireflies:b\tSubject B"])

    def test_append_ledger_concurrent_read_does_not_drop_a_key(self):
        """P1 (review 2026-09-05): append_ledger's read -> atomic_write was
        not serialized, so two concurrent recap workers could both read the
        same "existing" snapshot and the later write would drop the
        earlier one's row. Simulated race: monkeypatch client_file_lock so
        a second append runs to completion during the first append's lock
        acquisition; with the fix (both appends serialized under the same
        `<ledger>.lock`), both rows survive."""
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            real_lock = MODULE.client_file_lock
            state = {"entered": 0}

            @contextlib.contextmanager
            def racing_lock(path):
                if state["entered"] == 0 and str(path) == str(ledger):
                    state["entered"] += 1
                    MODULE.append_ledger(ledger, "fireflies:b", "Subject B")
                with real_lock(path):
                    yield

            MODULE.client_file_lock = racing_lock
            try:
                MODULE.append_ledger(ledger, "fireflies:a", "Subject A")
            finally:
                MODULE.client_file_lock = real_lock

            lines = [ln for ln in ledger.read_text(encoding="utf-8").splitlines() if ln.strip()]
        self.assertEqual(set(lines), {"fireflies:a\tSubject A", "fireflies:b\tSubject B"})

    def test_load_ledger_backward_compat_with_legacy_no_tab_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            ledger.write_text("fireflies:legacy 1735689600\n", encoding="utf-8")
            seen = MODULE.load_ledger(ledger)
            self.assertEqual(seen, {"fireflies:legacy"})

    def test_load_ledger_dedup_still_works_with_new_tab_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            MODULE.append_ledger(ledger, "fireflies:a", "Subject A")
            seen = MODULE.load_ledger(ledger)
            self.assertEqual(seen, {"fireflies:a"})

    def test_load_ledger_subjects_recovers_subject_and_handles_legacy_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "ledger.txt"
            ledger.write_text(
                "fireflies:legacy 1735689600\n"
                "fireflies:new\tRecap: New — 2026-09-04\n",
                encoding="utf-8",
            )
            subjects = MODULE.load_ledger_subjects(ledger)
            self.assertEqual(subjects["fireflies:legacy"], "")
            self.assertEqual(subjects["fireflies:new"], "Recap: New — 2026-09-04")


class LedgerKeySingleSourceOfTruthTests(unittest.TestCase):
    """S-4 (reviewify-standards.json): ledger_key must delegate to
    writeback_render._source_key (single source of truth) instead of
    re-implementing the same `<kind>:<id>` derivation."""

    def test_ledger_key_delegates_to_writeback_render_source_key(self):
        meeting = {"id": "m1", "source": {"kind": "omi", "id": "OMI-1"}}
        self.assertEqual(MODULE.ledger_key(meeting), "omi:OMI-1")

    def test_ledger_key_legacy_fallback_unchanged(self):
        meeting = {"id": "legacy123"}
        self.assertEqual(MODULE.ledger_key(meeting), "fireflies:legacy123")

    def test_ledger_key_matches_writeback_render_source_key_exactly(self):
        import writeback_render  # already importable: MODULE's own sys.path shim

        meeting = {"id": "x", "source": {"kind": "gmail", "id": "t1"}}
        self.assertEqual(MODULE.ledger_key(meeting), writeback_render._source_key(meeting))


if __name__ == "__main__":
    unittest.main()


def test_marcos_meeting_is_never_suppressed():
    # Josh 2026-08-11: suppression is a broken system — Marcos needs zero suppression.
    meeting = {
        "title": "Alloi — Marcos Santa Ana",
        "client_context": "Alloi",
        "attendees": [{"email": "marcos@alloi.us"}, {"email": "josh@clearworks.ai"}],
    }
    assert meeting_recap_draft.SUPPRESSED_NAMES == ()
    assert meeting_recap_draft.is_suppressed_meeting(meeting) is False
