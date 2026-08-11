from __future__ import annotations

import importlib.util
import json
import sys
import contextlib
import io
import os
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("meeting_writeback.py")
SPEC = importlib.util.spec_from_file_location("meeting_writeback_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load meeting_writeback.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def make_meeting(**overrides: object) -> dict[str, object]:
    meeting: dict[str, object] = {
        "id": "meeting_abc",
        "title": "Acme Q3 sync",
        "date": "2026-06-08T16:00:00Z",
        "organizer": "Dana Prospect",
        "attendees": ["Dana Prospect", "Josh Weiss"],
        "client_context": "This meeting maps to client=Acme.",
        "summary": {"overview": "Reviewed the audit scope."},
        "next_steps": [
            {"text": "Send the revised proposal", "owner": "Josh", "deadline": "2026-06-12"}
        ],
        "decisions": ["Move to phase 2"],
        "deal_state": "advanced to proposal",
        "meeting_type": "sales_call",
        "commitmentIds": ["ff_meeting_abc_0011"],
    }
    meeting.update(overrides)
    return meeting


class MeetingWritebackTests(unittest.TestCase):
    def _env(self, tmp: Path) -> tuple[Path, Path]:
        org_root = tmp / "org"
        (org_root / "knowledge" / "clients").mkdir(parents=True, exist_ok=True)
        ledger = tmp / "ledger.txt"
        ledger.touch()
        return org_root, ledger

    def test_files_new_client_and_meeting_md(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)

            result = MODULE.process_writeback(
                {"meetings": [make_meeting()]},
                org_root=org_root,
                ledger_path=ledger,
            )

            self.assertEqual(result["written_count"], 1)
            self.assertEqual(result["created_client_count"], 1)
            self.assertEqual(result["created_clients"], ["Acme"])

            meeting_md = (org_root / result["written_meetings"][0]).read_text(encoding="utf-8")
            self.assertIn("**Source:** fireflies:meeting_abc", meeting_md)
            self.assertIn("advanced to proposal", meeting_md)
            self.assertIn("| Send the revised proposal | Josh | 2026-06-12 |", meeting_md)

            client_md = (org_root / "knowledge" / "clients" / "acme.md").read_text(encoding="utf-8")
            self.assertIn("## History (dated, newest first)", client_md)
            self.assertIn("2026-06-08 — Q3 sync (meeting: knowledge/meetings/", client_md)
            self.assertIn("| Send the revised proposal | Josh | 2026-06-12 | knowledge/meetings/", client_md)

    def test_owner_and_deadline_fallbacks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)
            meeting = make_meeting(next_steps=[{"text": "Follow up somehow"}])

            MODULE.process_writeback(
                {"meetings": [meeting]}, org_root=org_root, ledger_path=ledger
            )

            client_md = (org_root / "knowledge" / "clients" / "acme.md").read_text(encoding="utf-8")
            self.assertIn("| Follow up somehow | NEEDS-OWNER | NEEDS-DEADLINE |", client_md)

    def test_appends_to_existing_client_without_losing_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)

            # First meeting seeds the client + one history entry.
            MODULE.process_writeback(
                {"meetings": [make_meeting(id="meeting_one", title="Acme kickoff")]},
                org_root=org_root,
                ledger_path=ledger,
            )
            client_path = org_root / "knowledge" / "clients" / "acme.md"
            after_first = client_path.read_text(encoding="utf-8")
            self.assertIn("kickoff", after_first)

            # Second meeting must RMW-append, preserving the first entry.
            MODULE.process_writeback(
                {"meetings": [make_meeting(id="meeting_two", title="Acme review", date="2026-06-10T16:00:00Z")]},
                org_root=org_root,
                ledger_path=ledger,
            )
            after_second = client_path.read_text(encoding="utf-8")
            self.assertIn("kickoff", after_second)  # prior history survived
            self.assertIn("review", after_second)
            # newest-first ordering
            self.assertLess(after_second.index("review"), after_second.index("kickoff"))

    def test_writes_fr002_event_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)
            ctx_tmp = tmp / "evt"
            ctx_tmp.mkdir()

            MODULE.process_writeback(
                {"meetings": [make_meeting()]},
                org_root=org_root,
                ledger_path=ledger,
                ctx_tmp=str(ctx_tmp),
            )

            safe_id = MODULE._safe_id("meeting_abc")
            event_path = ctx_tmp / f"ff-meeting-event-{safe_id}.json"
            self.assertTrue(event_path.exists())
            event = json.loads(event_path.read_text(encoding="utf-8"))
            self.assertEqual(
                set(event),
                {"meeting_id", "meeting_type", "attendees", "client", "commitmentIds", "writeback_ok"},
            )
            self.assertEqual(event["meeting_id"], "meeting_abc")
            self.assertEqual(event["meeting_type"], "sales_call")
            self.assertEqual(event["client"], "Acme")
            self.assertEqual(event["commitmentIds"], ["ff_meeting_abc_0011"])
            self.assertTrue(event["writeback_ok"])
            self.assertIn("Dana Prospect", event["attendees"])

    def test_event_payload_webhook_fast_path_filters_by_ff_meeting_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)
            ctx_tmp = tmp / "evt"
            ctx_tmp.mkdir()

            MODULE.process_writeback(
                {"meetings": [make_meeting(id="wanted"), make_meeting(id="ignored", title="Beta call")]},
                org_root=org_root,
                ledger_path=ledger,
                ff_meeting_id="wanted",
                ctx_tmp=str(ctx_tmp),
            )

            self.assertTrue((ctx_tmp / f"ff-meeting-event-{MODULE._safe_id('wanted')}.json").exists())
            self.assertFalse((ctx_tmp / f"ff-meeting-event-{MODULE._safe_id('ignored')}.json").exists())

    def test_ledger_append_records_every_meeting(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)

            MODULE.process_writeback(
                {"meetings": [make_meeting(id="meeting_one"), make_meeting(id="meeting_two", title="Acme review")]},
                org_root=org_root,
                ledger_path=ledger,
            )
            rows = [ln for ln in ledger.read_text(encoding="utf-8").splitlines() if ln.strip()]
            self.assertEqual(len(rows), 2)
            ids = {ln.split()[0] for ln in rows}
            self.assertEqual(ids, {"meeting_one", "meeting_two"})

    def test_concurrent_writeback_same_client_no_clobber(self) -> None:
        # FR-008: two threads file the SAME client concurrently. The per-client
        # flock must serialize the read-modify-write so BOTH History entries
        # survive (neither overwrites the other's fresh read).
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)

            # Seed the client file first so both threads hit the SAME existing file.
            MODULE.process_writeback(
                {"meetings": [make_meeting(id="seed", title="Acme seed", date="2026-06-01T16:00:00Z")]},
                org_root=org_root,
                ledger_path=ledger,
            )

            barrier = threading.Barrier(2)
            errors: list[BaseException] = []

            def worker(meeting_id: str, title: str, ledger_path: Path) -> None:
                try:
                    barrier.wait()  # maximize overlap on the RMW window
                    MODULE.process_writeback(
                        {"meetings": [make_meeting(id=meeting_id, title=title, date="2026-06-10T16:00:00Z")]},
                        org_root=org_root,
                        ledger_path=ledger_path,
                    )
                except BaseException as exc:  # noqa: BLE001 - surface to main thread
                    errors.append(exc)

            # Separate ledger files per worker so the assertion targets the client
            # file RMW (the FR-008 concern), not the shared append handle.
            t1 = threading.Thread(target=worker, args=("meeting_alpha", "Acme alpha", tmp / "l1.txt"))
            t2 = threading.Thread(target=worker, args=("meeting_beta", "Acme beta", tmp / "l2.txt"))
            (tmp / "l1.txt").touch()
            (tmp / "l2.txt").touch()
            t1.start()
            t2.start()
            t1.join()
            t2.join()

            self.assertEqual(errors, [])
            client_md = (org_root / "knowledge" / "clients" / "acme.md").read_text(encoding="utf-8")
            # Both concurrent entries AND the seed must be present — proof the
            # lock serialized instead of one overwriting the other's read.
            self.assertIn("alpha", client_md)
            self.assertIn("beta", client_md)
            self.assertIn("seed", client_md)

    def test_main_cli_reads_env_and_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            org_root, ledger = self._env(tmp)
            payload_path = tmp / "ff-writeback.json"
            payload_path.write_text(json.dumps({"meetings": [make_meeting()]}), encoding="utf-8")
            result_json = tmp / "result.json"

            env = {"ORG_ROOT": str(org_root), "LEDGER_FILE": str(ledger), "CTX_TMP": str(tmp)}
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, env, clear=False):
                with contextlib.redirect_stdout(stdout):
                    rc = MODULE.main(["--payload", str(payload_path)])
            self.assertEqual(rc, 0)
            printed = json.loads(stdout.getvalue())
            self.assertEqual(printed["written_count"], 1)
            result_json.write_text(stdout.getvalue(), encoding="utf-8")  # mirrors SKILL redirect


if __name__ == "__main__":
    unittest.main()
