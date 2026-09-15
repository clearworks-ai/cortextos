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


GOOD_BODY = (
    "Mark — good talking through the audit findings today. Quick recap so nothing gets lost:\n\n"
    "What I'm doing\n- Getting the findings deck over to you this week so everything sits in one place.\n\n"
    "What I need from you\n- A read of the deck when it lands, and a note on anything that reads differently than you remember.\n\n"
    "Next step: I get the deck out, you flag anything that needs a decision before we move.\n\nJosh"
)


def claude_wrapper(body: str = GOOD_BODY) -> str:
    return json.dumps({"type": "result", "subtype": "success", "result": json.dumps({"body": body})})


def fake_runner(calls: list[list[str]], body: str = GOOD_BODY, claude_rc: int = 0, gws_stdout: str = "drafted"):
    """Answers the compose call (claude) with a valid customer email and gws +draft with a
    success — tests exercise the real compose/validate path, only the transports are fake."""
    def runner(args):
        calls.append(list(args))
        if list(args)[:2] == ["claude", "-p"]:
            return subprocess.CompletedProcess(args, claude_rc, stdout=claude_wrapper(body) if claude_rc == 0 else "", stderr="" if claude_rc == 0 else "Credit balance is too low")
        return subprocess.CompletedProcess(args, 0, stdout=gws_stdout, stderr="")
    return runner


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
        runner = fake_runner(calls)

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
        gws_calls = [c for c in calls if c[:3] == ["gws", "gmail", "+draft"]]
        self.assertEqual(len(gws_calls), 1)
        # the SENT body is the composed customer email, never the internal template
        body = gws_calls[0][gws_calls[0].index("--body") + 1]
        self.assertEqual(body, GOOD_BODY)
        self.assertNotIn("Relationship context", body)
        self.assertNotIn("drafted automatically", body)
        self.assertEqual(sum(1 for c in calls if c[:2] == ["claude", "-p"]), 1)

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
        runner = fake_runner(calls)

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

        draft_calls = [c for c in calls if c[:3] == ["gws", "gmail", "+draft"]]
        self.assertEqual(draft_calls, [["gws", "gmail", "+draft", "--other-worker"]])
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
            with mock.patch.object(MODULE.subprocess, "run", boom), \
                 mock.patch.object(MODULE, "compose_customer_email", lambda m, v, r: GOOD_BODY):
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
            self.assertIn("Following up on our Jul 27 conversation", out)
            self.assertIn("Mark — good talking through", out)
            self.assertNotIn("Recap: MSIA recap", out)
            self.assertNotIn("Josh: Send findings deck", out)
            self.assertNotIn("drafted automatically", out)
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
            with mock.patch.object(MODULE.subprocess, "run", boom), \
                 mock.patch.object(MODULE, "compose_customer_email", lambda m, v, r: GOOD_BODY):
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
            with mock.patch.object(MODULE.subprocess, "run", boom), \
                 mock.patch.object(MODULE, "compose_customer_email", lambda m, v, r: GOOD_BODY):
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

    monkeypatch.setattr(MODULE, "compose_customer_email", lambda m, v, r: GOOD_BODY)
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
    monkeypatch.setattr(MODULE, "compose_customer_email", lambda m, v, r: GOOD_BODY)
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
    assert MODULE.SUPPRESSED_NAMES == ()
    assert MODULE.is_suppressed_meeting(meeting) is False


class DraftLinkCaptureTests(unittest.TestCase):
    """Josh 2026-09-13: "i need those telegramed to me the links to the drafts and
    the copy every time." gws-dwd already prints {"draft_id": ...} on stdout; the
    recap script was throwing it away, so there was no link to send."""

    def _meeting(self):
        return {
            "id": "meeting-link",
            "title": "MSIA recap",
            "date": "2026-07-27T11:00:00Z",
            "organizer": "josh@clearworks.ai",
            "attendees": ["mark@msia.org"],
            "summary": {"overview": "Reviewed the audit findings.", "bullets": "", "action_items": ""},
            "client_context": "Clearworks maps this meeting to client=MSIA. Deal stage=won.",
            "next_steps": [{"text": "Send findings deck", "direction": "outbound", "owner": "Josh"}],
        }

    def test_draft_id_and_link_and_copy_are_surfaced(self):
        runner = fake_runner([], gws_stdout='{"draft_id": "r-8891234", "message_id": "m-42"}')

        with tempfile.TemporaryDirectory() as tmp:
            summary = MODULE.process_meetings(
                [self._meeting()],
                ledger_path=Path(tmp) / "ledger.txt",
                voice_guidance="Keep it direct.",
                vip_list=set(),
                runner=runner,
            )

        self.assertEqual(summary["drafts_created"], 1)
        self.assertEqual(len(summary["drafts"]), 1)
        d = summary["drafts"][0]
        self.assertEqual(d["draft_id"], "r-8891234")
        # Josh 2026-09-13: "THE link goes to my personal gmail". /mail/u/0/ is
        # whichever account the browser signed into FIRST, so on a multi-account
        # browser it opens the wrong inbox. Gmail accepts the account ADDRESS in
        # place of the index, which pins it to the right mailbox every time.
        self.assertEqual(
            d["link"],
            "https://mail.google.com/mail/u/josh@clearworks.ai/#drafts?compose=r-8891234",
        )
        self.assertTrue(d["subject"])
        # the COPY has to travel with it — Josh reads the draft from Telegram; it is the
        # composed customer email, not the internal summary
        self.assertEqual(d["body"], GOOD_BODY)

    def test_unparseable_draft_output_still_counts_the_draft(self):
        """The draft really was created; a missing/garbled id must not fail the step
        or lose the copy — it just means no link."""
        runner = fake_runner([])

        with tempfile.TemporaryDirectory() as tmp:
            summary = MODULE.process_meetings(
                [self._meeting()],
                ledger_path=Path(tmp) / "ledger.txt",
                voice_guidance="Keep it direct.",
                vip_list=set(),
                runner=runner,
            )

        self.assertEqual(summary["drafts_created"], 1)
        self.assertEqual(summary["draft_failures"], [])
        self.assertEqual(len(summary["drafts"]), 1)
        self.assertIsNone(summary["drafts"][0]["draft_id"])
        self.assertIsNone(summary["drafts"][0]["link"])
        self.assertTrue(summary["drafts"][0]["body"])



class ComposeCustomerEmailTests(unittest.TestCase):
    """Josh 2026-09-15: 'the meeting recaps are not customer emails … this is an
    internal summary'. The draft body is composed as an email FROM Josh TO the
    counterparty and validated; the internal template never reaches Gmail."""

    def _meeting(self):
        return {
            "id": "m-eva", "title": "Eva Galanes-Rosenbaum and Josh Weiss", "date": "2026-09-15T21:00:00Z",
            "organizer": "eva@rethinkmedia.org", "attendees": ["eva@rethinkmedia.org", "josh@clearworks.ai"],
            "client_context": "Rethink Media",
            "summary": {"overview": "Josh described his podcast pipeline. Eva described hiring pain.", "bullets": [], "action_items": []},
            "decisions": ["Eva will send the applicant screening work to Josh."],
            "next_steps": [
                {"text": "Forward applicant data to Josh", "direction": "inbound", "owner": "Eva Galanes-Rosenbaum", "deadline": "2026-09-19"},
                {"text": "Build a screening rubric", "direction": "outbound", "owner": "Josh Weiss", "deadline": None},
            ],
        }

    def test_counterparty_first_names_from_inbound_owners_then_emails(self):
        self.assertEqual(MODULE.counterparty_first_names(self._meeting()), ["Eva"])
        m = dict(self._meeting(), next_steps=[])
        self.assertEqual(MODULE.counterparty_first_names(m), ["Eva"])  # from eva@rethinkmedia.org, never josh@clearworks.ai

    def test_prompt_carries_only_payload_facts_split_by_side(self):
        prompt = MODULE.build_compose_prompt(self._meeting(), "Direct and warm.")
        self.assertIn("Quick recap so nothing gets lost", prompt)
        self.assertIn("What I'm doing", prompt)
        self.assertIn("What I need from you", prompt)
        self.assertIn("THEIR COMMITMENTS", prompt)
        self.assertIn("- Forward applicant data to Josh (by 2026-09-19)", prompt)
        self.assertIn("MY COMMITMENTS", prompt)
        self.assertIn("- Build a screening rubric", prompt)
        self.assertIn("Never the word Fireflies", prompt)
        self.assertIn("Direct and warm.", prompt)

    def test_internal_summary_shapes_are_rejected(self):
        m = self._meeting()
        shape = "\n\nWhat I'm doing\n- Building the screening rubric once the applicant data lands.\n\nWhat I need from you\n- The applicant data by Friday.\n\nNext step: send me the data and I'll turn the rubric around.\n\nJosh"
        for bad in (
            "Eva — good talking. Quick recap:\n\nJosh described a podcast pipeline. " + shape,
            "Eva — good talking. Quick recap:\n\nNext steps:\n1. Eva Galanes-Rosenbaum: forward the data\n2. Josh: build the rubric" + shape,
            "Eva — good talking. Quick recap:" + shape.replace("\n\nJosh", "\n\n— drafted automatically from the Fireflies transcript; review before sending.\n\nJosh"),
            "Hello team — good talking. Quick recap:" + shape,
            "Eva — good talking. Quick recap:" + shape.replace("\n\nJosh", "\n\nBest regards, Clearworks AI"),
            "Eva — good talking. Quick recap:" + shape.replace("What I need from you", "Your side"),
            "Eva — good talking. Quick recap:" + shape.replace("What I'm doing", "**What I'm doing**"),
        ):
            with self.assertRaises(MODULE.ComposeError, msg=bad[:60]):
                MODULE.validate_customer_email(bad, m)

    def test_composed_body_is_what_gmail_receives_and_a_rejected_body_creates_no_draft(self):
        m = self._meeting()
        good = ("Eva — good catching up today. Quick recap so nothing gets lost:\n\nWhat I'm doing\n- Sending you the podcast link.\n- Building the screening rubric from the job description once the applicant data lands.\n\n"
                "What I need from you\n- The applicant data and the hand-off process by Friday.\n\nNext step: send the data when you're ready and I'll turn the rubric around.\n\nJosh")
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            summary = MODULE.process_meetings([m], ledger_path=Path(tmp) / "l.txt", voice_guidance="", vip_list=set(),
                                              runner=fake_runner(calls, body=good), voice_prompt="Direct.")
        self.assertEqual(summary["drafts_created"], 1)
        gws = [c for c in calls if c[:3] == ["gws", "gmail", "+draft"]][0]
        self.assertEqual(gws[gws.index("--body") + 1], good)
        self.assertEqual(gws[gws.index("--subject") + 1], "Following up on our Sep 15 conversation")

        calls = []
        bad = "Eva — good catching up. Quick recap:\n\nJosh described his pipeline in detail and Eva described her hiring bottleneck at length today.\n\nWhat I'm doing\n- The rubric.\n\nWhat I need from you\n- The data.\n\nNext step: data, then rubric.\n\nJosh"
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "l.txt"
            summary = MODULE.process_meetings([m], ledger_path=ledger, voice_guidance="", vip_list=set(),
                                              runner=fake_runner(calls, body=bad), voice_prompt="Direct.")
            self.assertEqual(summary["drafts_created"], 0)
            self.assertEqual(len(summary["draft_failures"]), 1)
            self.assertIn("compose:", summary["draft_failures"][0]["stderr"])
            self.assertFalse(ledger.exists() and ledger.read_text().strip())
        self.assertEqual([c for c in calls if c[:3] == ["gws", "gmail", "+draft"]], [])

    def test_model_transport_failure_creates_no_draft_and_is_reported(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            summary = MODULE.process_meetings([self._meeting()], ledger_path=Path(tmp) / "l.txt", voice_guidance="", vip_list=set(),
                                              runner=fake_runner(calls, claude_rc=1), voice_prompt="Direct.")
        self.assertEqual(summary["drafts_created"], 0)
        self.assertIn("claude exit 1", summary["draft_failures"][0]["stderr"])
        self.assertEqual([c for c in calls if c[:3] == ["gws", "gmail", "+draft"]], [])


class VoiceBundleTests(unittest.TestCase):
    def test_voice_bundle_loads_humanizer_prompt_sample_and_exemplar_when_present(self):
        bundle = MODULE.load_voice_prompt()
        if not MODULE.HUMANIZER_DIR.exists():
            self.skipTest("humanizer skill not on this host")
        self.assertIn("HUMANIZER — JOSH VOICE PATTERNS", bundle)
        self.assertIn("UNIVERSAL CONTENT GUIDE", bundle)
        if MODULE.JOSH_VOICE_PROMPT_PATH.exists():
            self.assertIn("JOSH VOICE PROMPT:", bundle)
        if MODULE.APPROVED_EXEMPLAR_PATH.exists():
            self.assertIn("APPROVED RECAP EXEMPLAR", bundle)
            self.assertIn("Quick recap so nothing gets lost", bundle)
