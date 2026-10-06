from __future__ import annotations

import importlib.util
import io
import json
import shutil
import tempfile
import unittest
import unittest.mock
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("fireflies-ingest.py")
SPEC = importlib.util.spec_from_file_location("crm_fireflies_ingest", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load fireflies-ingest.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CRM_DIR = MODULE_PATH.parent


class FirefliesIngestTests(unittest.TestCase):
    def setUp(self) -> None:
        fireflies = unittest.mock.patch.object(
            MODULE, "fireflies_query", side_effect=AssertionError("live Fireflies forbidden")
        )
        fireflies.start()
        self.addCleanup(fireflies.stop)

    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "01KZ71M4876B6NKT8V3TFCQBRW",
            "title": "MSIA Workflow Follow Up",
            "date": "2026-08-05T18:00:00Z",
            "duration": 42,
            "organizer_email": "josh@clearworks.ai",
            "participants": ["josh@clearworks.ai", "mark@msia.org"],
            "speakers": [{"id": "1", "name": "Josh Weiss"}, {"id": "2", "name": "Mark Lurie"}],
            "summary": {
                "overview": "Reviewed the spreadsheet automation findings and agreed on the next share-out.",
                "short_summary": "",
                "action_items": "- Send the workflow report tomorrow\n- Schedule the Wendy follow-up next week",
                "keywords": ["MSIA", "workflow"],
                "bullet_gist": "",
            },
            "transcript_url": "https://app.fireflies.ai/view/01KZ71M4876B6NKT8V3TFCQBRW",
            "sentences": [{"speaker_name": "Josh Weiss", "text": "I'll send the workflow report tomorrow."}],
        }

    def make_fixture_root(self) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for script in ("add-followup.py", "add-interaction.py", "upsert-contact.py", "contact_identity.py"):
            shutil.copy2(CRM_DIR / script, root / script)
        (root / "contact-aliases.json").write_text("{}\n", encoding="utf-8")
        (root / "meetings").mkdir(parents=True, exist_ok=True)
        (root / "contacts.json").write_text('{"version":"1.0.0","contacts":[]}\n', encoding="utf-8")
        (root / "followups.jsonl").write_text("", encoding="utf-8")
        (root / "interactions.jsonl").write_text("", encoding="utf-8")
        (root / "_ingest_suppression.json").write_text("{}\n", encoding="utf-8")
        environment = unittest.mock.patch.dict(MODULE.os.environ, {
            "CRM_CONTACTS_PATH": str(root / "contacts.json"),
            "CRM_INTERACTIONS_PATH": str(root / "interactions.jsonl"),
            "CRM_FOLLOWUPS_PATH": str(root / "followups.jsonl"),
            "CRM_SUPPRESSION_PATH": str(root / "_ingest_suppression.json"),
            "CRM_EVENT_EMIT_LOG": str(root / "events.log"),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        environment.start()
        self.addCleanup(environment.stop)
        return root

    def patch_paths(self, root: Path):
        return unittest.mock.patch.multiple(
            MODULE,
            CRM_DIR=root,
            SEEN_PATH=root / "ingested-transcripts.txt",
            MEETINGS_DIR=root / "meetings",
        )

    def test_main_point_read_only(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        (root / "ingested-transcripts.txt").write_text("other-id  fixture\n")
        (root / "meetings" / "existing.md").write_text("Existing meeting\n")
        before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        with (
            self.patch_paths(root),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", transcript["id"]]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "fetch_transcript", return_value=transcript) as fetch,
            unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
            unittest.mock.patch.object(MODULE, "mark_seen") as mark,
        ):
            exit_code = MODULE.main()
        ingest.assert_not_called()
        mark.assert_not_called()
        fetch.assert_called_once_with(transcript["id"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(output.getvalue()), transcript)
        self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_main_point_apply_unseen(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        with (
            self.patch_paths(root),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", transcript["id"], "--apply"]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "fetch_transcript", return_value=transcript) as fetch,
            unittest.mock.patch.object(MODULE, "run_ingest", wraps=MODULE.run_ingest) as ingest,
        ):
            exit_code = MODULE.main()
        ingest.assert_called_once_with([transcript])
        fetch.assert_called_once_with(transcript["id"])
        self.assertEqual(exit_code, 0, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["count"], 1)
        self.assertIn(transcript["id"], (root / "ingested-transcripts.txt").read_text())
        self.assertEqual(len(json.loads((root / "contacts.json").read_text())["contacts"]), 1)
        self.assertEqual(len((root / "interactions.jsonl").read_text().splitlines()), 1)
        self.assertEqual(len((root / "followups.jsonl").read_text().splitlines()), 2)
        self.assertEqual(len(list((root / "meetings").glob("*.md"))), 1)

    def test_main_point_apply_seen_rejected(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        (root / "ingested-transcripts.txt").write_text(f"{transcript['id']}  already ingested\n")
        before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        with (
            self.patch_paths(root),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", transcript["id"], "--apply"]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "fetch_transcript", return_value=transcript),
            unittest.mock.patch.object(MODULE, "run_ingest", return_value=(0, {"ok": True})) as ingest,
            unittest.mock.patch.object(MODULE, "mark_seen") as mark,
        ):
            exit_code = MODULE.main()
        ingest.assert_not_called()
        mark.assert_not_called()
        self.assertNotEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertFalse(payload["ok"])
        self.assertIn("already seen", payload["error"])
        self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_main_point_apply_seen_reprocess(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        (root / "ingested-transcripts.txt").write_text(f"{transcript['id']}  already ingested\n")
        with (
            self.patch_paths(root),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", transcript["id"], "--apply", "--reprocess"]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "fetch_transcript", return_value=transcript),
            unittest.mock.patch.object(MODULE, "run_ingest", wraps=MODULE.run_ingest) as ingest,
        ):
            exit_code = MODULE.main()
        ingest.assert_called_once_with([transcript])
        self.assertEqual(exit_code, 0, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["count"], 1)
        self.assertEqual(len((root / "ingested-transcripts.txt").read_text().splitlines()), 2)

    def test_main_rejects_empty_point_apply_id(self) -> None:
        for point_id in ("", " "):
            with (
                self.subTest(point_id=repr(point_id)),
                self.patch_paths(self.make_fixture_root()),
                unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", point_id, "--apply"]),
                unittest.mock.patch("sys.stdout", new_callable=io.StringIO),
                unittest.mock.patch("sys.stderr", new_callable=io.StringIO),
                unittest.mock.patch.object(MODULE, "list_new") as listing,
                unittest.mock.patch.object(MODULE, "fetch_transcript") as fetch,
                unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
                unittest.mock.patch.object(MODULE, "mark_seen") as mark,
            ):
                with self.assertRaises(SystemExit) as error:
                    MODULE.main()
                self.assertEqual(error.exception.code, 2)
                listing.assert_not_called()
                fetch.assert_not_called()
                ingest.assert_not_called()
                mark.assert_not_called()

    def test_main_rejects_unsafe_flag_combinations(self) -> None:
        for flags in (
            ["--meeting-id", "fixture-id", "--mark", "fixture-id"],
            ["--meeting-id", "fixture-id", "--apply", "--mark", "fixture-id"],
            ["--reprocess"],
            ["--reprocess", "--apply"],
            ["--meeting-id", "fixture-id", "--reprocess"],
        ):
            with (
                self.subTest(flags=flags),
                self.patch_paths(self.make_fixture_root()),
                unittest.mock.patch("sys.argv", ["fireflies-ingest.py", *flags]),
                unittest.mock.patch("sys.stdout", new_callable=io.StringIO),
                unittest.mock.patch("sys.stderr", new_callable=io.StringIO),
                unittest.mock.patch.object(MODULE, "fetch_transcript") as fetch,
                unittest.mock.patch.object(MODULE, "list_new") as listing,
                unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
                unittest.mock.patch.object(MODULE, "mark_seen") as mark,
            ):
                with self.assertRaises(SystemExit) as error:
                    MODULE.main()
                self.assertEqual(error.exception.code, 2)
                fetch.assert_not_called()
                listing.assert_not_called()
                ingest.assert_not_called()
                mark.assert_not_called()

    def test_main_lists_without_arguments(self) -> None:
        rows = [{"id": "fixture-id", "title": "Fixture meeting"}]
        with (
            self.patch_paths(self.make_fixture_root()),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py"]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "list_new", return_value=rows) as listing,
            unittest.mock.patch.object(MODULE, "fetch_transcript") as fetch,
            unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
            unittest.mock.patch.object(MODULE, "mark_seen") as mark,
        ):
            self.assertEqual(MODULE.main(), 0)
        listing.assert_called_once_with(MODULE.DEFAULT_LOOKBACK_S)
        fetch.assert_not_called()
        ingest.assert_not_called()
        mark.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {"new": rows, "count": 1})

    def test_main_batch_apply_preserves_dispatch_and_exit_code(self) -> None:
        for rows, transcripts in (([{"id": "one"}, {}, {"id": "two"}], [{"id": "one"}, {"id": "two"}]), ([], [])):
            with (
                self.subTest(rows=rows),
                self.patch_paths(self.make_fixture_root()),
                unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--apply", "--lookback", "123"]),
                unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
                unittest.mock.patch.object(MODULE, "list_new", return_value=rows) as listing,
                unittest.mock.patch.object(MODULE, "fetch_transcript", side_effect=transcripts) as fetch,
                unittest.mock.patch.object(MODULE, "run_ingest", return_value=(1, {"ok": False})) as ingest,
            ):
                self.assertEqual(MODULE.main(), 1)
            listing.assert_called_once_with(123)
            self.assertEqual(fetch.call_args_list, [unittest.mock.call(row["id"]) for row in transcripts])
            ingest.assert_called_once_with(transcripts)
            self.assertEqual(json.loads(output.getvalue()), {"ok": False})

    def test_main_point_read_only_seen_and_fetch_failure(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        (root / "ingested-transcripts.txt").write_text(f"{transcript['id']}  already ingested\n")
        before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        for failure in (None, RuntimeError("fixture fetch failed")):
            with (
                self.subTest(failure=failure),
                self.patch_paths(root),
                unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", transcript["id"]]),
                unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
                unittest.mock.patch.object(MODULE, "fetch_transcript", return_value=transcript, side_effect=failure),
                unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
                unittest.mock.patch.object(MODULE, "mark_seen") as mark,
            ):
                self.assertEqual(MODULE.main(), 1 if failure else 0)
            ingest.assert_not_called()
            mark.assert_not_called()
            expected = {"ok": False, "error": "fixture fetch failed"} if failure else transcript
            self.assertEqual(json.loads(output.getvalue()), expected)
            self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    def test_main_point_apply_fails_closed_when_seen_ledger_unreadable(self) -> None:
        with (
            self.patch_paths(self.make_fixture_root()),
            unittest.mock.patch("sys.argv", ["fireflies-ingest.py", "--meeting-id", "fixture-id", "--apply"]),
            unittest.mock.patch("sys.stdout", new_callable=io.StringIO) as output,
            unittest.mock.patch.object(MODULE, "load_seen", side_effect=OSError("ledger unreadable")),
            unittest.mock.patch.object(MODULE, "fetch_transcript") as fetch,
            unittest.mock.patch.object(MODULE, "run_ingest") as ingest,
            unittest.mock.patch.object(MODULE, "mark_seen") as mark,
        ):
            self.assertEqual(MODULE.main(), 1)
        fetch.assert_not_called()
        ingest.assert_not_called()
        mark.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "error": "ledger unreadable"})

    def test_run_ingest_writes_contact_interaction_followups_and_meeting_file(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()

        with self.patch_paths(root):
            exit_code, payload = MODULE.run_ingest([transcript])

        self.assertEqual(exit_code, 0, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["count"], 1)
        processed = payload["processed"][0]
        self.assertEqual(processed["transcript_id"], transcript["id"])
        self.assertEqual(processed["primary_contact_id"], "mark-lurie")
        self.assertEqual(len(processed["contacts_upserted"]), 1)
        self.assertEqual(len(processed["followups_created"]), 2)

        contacts = json.loads((root / "contacts.json").read_text(encoding="utf-8"))
        self.assertEqual([contact["id"] for contact in contacts["contacts"]], ["mark-lurie"])

        interactions = [
            json.loads(line)
            for line in (root / "interactions.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(interactions), 1)
        self.assertEqual(interactions[0]["contact_id"], "mark-lurie")
        self.assertEqual(interactions[0]["source_ref"], f"fireflies:{transcript['id']}")

        followups = [
            json.loads(line)
            for line in (root / "followups.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(followups), 2)
        self.assertTrue(all(row["source_ref"] == f"fireflies:{transcript['id']}" for row in followups))

        meeting_files = list((root / "meetings").glob("*.md"))
        self.assertEqual(len(meeting_files), 1)
        meeting_text = meeting_files[0].read_text(encoding="utf-8")
        self.assertIn("MSIA Workflow Follow Up", meeting_text)
        self.assertIn("Followups created", meeting_text)
        self.assertIn(f"Fireflies ID:** `{transcript['id']}`", meeting_text)

        seen_lines = (root / "ingested-transcripts.txt").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(seen_lines), 1)
        self.assertIn(str(transcript["id"]), seen_lines[0])

    def test_run_ingest_reports_partial_writes_on_step_failure(self) -> None:
        root = self.make_fixture_root()
        transcript = self.make_transcript()
        original_run_helper = MODULE.run_helper

        def failing_run_helper(script: str, args: list[str]) -> str:
            if script == "add-interaction.py":
                raise RuntimeError("forced add-interaction failure")
            return original_run_helper(script, args)

        with self.patch_paths(root):
            with unittest.mock.patch.object(MODULE, "run_helper", side_effect=failing_run_helper):
                exit_code, payload = MODULE.run_ingest([transcript])

        self.assertEqual(exit_code, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["failed_transcript"], transcript["id"])
        self.assertEqual(payload["failed_step"], "add_interaction")
        self.assertEqual(payload["processed"], [])
        self.assertEqual(payload["partial_writes"]["contacts_upserted"], ["mark-lurie"])
        self.assertFalse(payload["partial_writes"]["interaction_logged"])
        self.assertEqual(payload["partial_writes"]["followups_created"], [])
        self.assertIsNone(payload["partial_writes"]["meeting_file"])

        contacts = json.loads((root / "contacts.json").read_text(encoding="utf-8"))
        self.assertEqual([contact["id"] for contact in contacts["contacts"]], ["mark-lurie"])
        self.assertEqual((root / "interactions.jsonl").read_text(encoding="utf-8"), "")
        self.assertEqual((root / "followups.jsonl").read_text(encoding="utf-8"), "")
        self.assertEqual(list((root / "meetings").glob("*.md")), [])
        self.assertFalse((root / "ingested-transcripts.txt").exists())

    def test_upsert_contacts_uses_email_matching_without_forcing_name_slug(self) -> None:
        with unittest.mock.patch.object(MODULE, "run_helper", return_value="michelle-jaimes") as helper:
            contacts = MODULE.upsert_contacts(
                [{"name": "Michelle", "email": "michelle@oakrootsaccounting.com"}],
                "fireflies:test",
            )

        self.assertEqual(contacts[0]["id"], "michelle-jaimes")
        args = helper.call_args.args[1]
        self.assertIn("--match-email", args)
        self.assertNotIn("--id", args)

    def test_upsert_contacts_passes_meeting_timestamp(self) -> None:
        with unittest.mock.patch.object(MODULE, "run_helper", return_value="niccolo-boldrin") as helper:
            MODULE.upsert_contacts(
                [{"name": "Niccolo Boldrin", "email": "niccolo.boldrin@acmartin.com"}],
                "fireflies:test",
                "2026-08-13T17:30:00+00:00",
            )

        args = helper.call_args.args[1]
        timestamp_index = args.index("--last-meaningful-contact") + 1
        self.assertEqual(args[timestamp_index], "2026-08-13T17:30:00+00:00")

    def test_upsert_contacts_normalizes_configured_calasia_alias(self) -> None:
        root = self.make_fixture_root()
        (root / "contact-aliases.json").write_text(
            json.dumps({"abbey": "abbey-calasia", "calasia": "abbey-calasia"}) + "\n",
            encoding="utf-8",
        )
        with self.patch_paths(root):
            with unittest.mock.patch.object(MODULE, "run_helper", return_value="abbey") as helper:
                contacts = MODULE.upsert_contacts([{"name": "Abbey", "email": ""}], "fireflies:test")

        self.assertEqual(contacts[0]["id"], "abbey-calasia")
        args = helper.call_args.args[1]
        self.assertEqual(args[args.index("--id") + 1], "abbey-calasia")

    def test_attendee_collection_dedupes_email_participants_and_named_speakers(self) -> None:
        transcript = {
            "organizer_email": "josh@clearworks.ai",
            "participants": [
                "niccolo.boldrin@acmartin.com",
                "brian.skowvron@acmartin.com",
                "paul.veloz@acmartin.com",
            ],
            "speakers": [
                {"name": "Niccolo Boldrin"},
                {"name": "Brian Skowvron"},
                {"name": "Paul Veloz"},
            ],
        }

        attendees = MODULE.collect_external_attendees(transcript)

        self.assertEqual(
            attendees,
            [
                {"name": "Niccolo Boldrin", "email": "niccolo.boldrin@acmartin.com"},
                {"name": "Brian Skowvron", "email": "brian.skowvron@acmartin.com"},
                {"name": "Paul Veloz", "email": "paul.veloz@acmartin.com"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
