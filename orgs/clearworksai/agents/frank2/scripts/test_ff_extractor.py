from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import urllib.error
import unittest
import unittest.mock
from datetime import date
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("ff-extractor.py")
SPEC = importlib.util.spec_from_file_location("ff_extractor_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load ff-extractor.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FirefliesExtractorTests(unittest.TestCase):
    def make_transcript(self, sentence: str, *, meeting_date: str = "2026-06-08T16:00:00Z") -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": meeting_date,
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": sentence,
                }
            ],
        }

    def test_refine_keeps_due_based_first_person_commitment(self) -> None:
        transcript = self.make_transcript("I'll send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Send the proposal to Acme (due 2026-06-10)")
        self.assertEqual(commitments[0].id, MODULE.commitment_id("meeting_123", "Send the proposal to Acme"))
        self.assertEqual(commitments[0].source, "ff")
        self.assertEqual(commitments[0].source_ref, "meeting_123 · Acme Follow Up")

    def test_refine_keeps_named_counterparty_without_due(self) -> None:
        transcript = self.make_transcript("Let me call Sara about the contract this afternoon.")
        items = [
            MODULE.ExtractedItem(
                action="Call Sara about the contract",
                owner="Josh Weiss",
                due_date="",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Call Sara about the contract")

    def test_refine_keeps_llm_assigned_josh_owner_without_verbatim_first_person(self) -> None:
        # We now trust the model's owner=Josh assignment rather than requiring a
        # verbatim "I'll" sentence; a concrete Josh item with a due date is kept.
        transcript = self.make_transcript("Josh should send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].text, "Send the proposal to Acme (due 2026-06-10)")

    def test_refine_drops_already_handled_in_meeting(self) -> None:
        transcript = self.make_transcript("I introduced Rachel to the cyber insurance contact just now.")
        items = [
            MODULE.ExtractedItem(
                action="Introduce Rachel to cyber insurance contacts",
                owner="Josh",
                due_date="During meeting (completed verbally)",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_refine_drops_vague_software_commitment(self) -> None:
        transcript = self.make_transcript("I will improve the software by Friday.")
        items = [
            MODULE.ExtractedItem(
                action="Improve the software",
                owner="Josh",
                due_date="Friday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_refine_drops_considering_mexico(self) -> None:
        transcript = self.make_transcript("I'm considering Mexico for later this year.")
        items = [
            MODULE.ExtractedItem(
                action="Consider Mexico",
                owner="Josh",
                due_date="",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(commitments, [])

    def test_commitment_id_is_deterministic_after_normalization(self) -> None:
        first = MODULE.commitment_id("meeting_123", "Call Sara about the contract")
        second = MODULE.commitment_id("meeting_123", "  call  Sara about the contract!!! ")

        self.assertEqual(first, second)
        self.assertRegex(first, r"^ff_meeting_123_[0-9a-f]{12}$")

    def test_resolve_due_date_supports_relative_terms(self) -> None:
        meeting_day = date(2026, 6, 8)

        self.assertEqual(MODULE.resolve_due_date("tomorrow", meeting_day), "2026-06-09")
        self.assertEqual(MODULE.resolve_due_date("Wednesday", meeting_day), "2026-06-10")
        self.assertEqual(MODULE.resolve_due_date("next Wednesday", meeting_day), "2026-06-10")
        self.assertIsNone(MODULE.resolve_due_date("later soon", meeting_day))

    def test_outbound_metadata_unchanged(self) -> None:
        transcript = self.make_transcript("I'll send the proposal to Acme by Wednesday.")
        items = [
            MODULE.ExtractedItem(
                action="Send the proposal to Acme",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(transcript, items)

        self.assertEqual(len(commitments), 1)
        self.assertEqual(commitments[0].direction, "outbound")
        self.assertEqual(commitments[0].source, "ff")
        self.assertTrue(commitments[0].id.startswith("ff_"))
        self.assertFalse(commitments[0].id.startswith("ffin_"))


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


class InboundDirectionTests(unittest.TestCase):
    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": "Sounds good, send it over when it's ready.",
                }
            ],
        }

    def test_inbound_kept_for_named_client_committing_to_josh(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send Josh the signed contract",
                owner="Sara",
                due_date="tomorrow",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(len(commitments), 1)
        commitment = commitments[0]
        self.assertEqual(commitment.direction, "inbound")
        self.assertEqual(commitment.source, "ff-inbound")
        self.assertTrue(commitment.id.startswith("ffin_"))
        self.assertEqual(commitment.text, "[inbound] Sara: Send Josh the signed contract (due 2026-06-09)")
        self.assertEqual(commitment.source_ref, "meeting_123 · Acme Follow Up")

    def test_inbound_dropped_for_generic_owners(self) -> None:
        for owner in ("Unassigned", "the team", "Team", "everyone", "Client", "we", "they", ""):
            items = [
                MODULE.ExtractedItem(
                    action="Send Josh the signed contract",
                    owner=owner,
                    due_date="tomorrow",
                    status="pending",
                )
            ]

            commitments = MODULE.refine_items(self.make_transcript(), items)

            self.assertEqual(commitments, [], f"owner {owner!r} should be dropped")

    def test_inbound_dropped_for_vague_action(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Look into the contract for Josh",
                owner="Sara",
                due_date="tomorrow",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_inbound_dropped_without_josh_tie(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send the deck to Rachel",
                owner="Sara",
                due_date="later sometime",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_inbound_dropped_when_already_handled(self) -> None:
        items = [
            MODULE.ExtractedItem(
                action="Send Josh the signed contract",
                owner="Sara",
                due_date="During meeting (completed verbally)",
                status="pending",
            )
        ]

        commitments = MODULE.refine_items(self.make_transcript(), items)

        self.assertEqual(commitments, [])

    def test_marcos_suppressed_in_both_directions(self) -> None:
        outbound_items = [
            MODULE.ExtractedItem(
                action="Send proposal to Marcos Santa Ana",
                owner="Josh",
                due_date="Wednesday",
                status="pending",
            )
        ]
        inbound_items = [
            MODULE.ExtractedItem(
                action="Send Josh the revised scope",
                owner="Marcos Santa Ana",
                due_date="tomorrow",
                status="pending",
            )
        ]

        self.assertEqual(MODULE.refine_items(self.make_transcript(), outbound_items), [])
        self.assertEqual(MODULE.refine_items(self.make_transcript(), inbound_items), [])

    def test_inbound_and_outbound_ids_differ_for_same_action(self) -> None:
        action = "Send the signed contract"
        outbound_id = MODULE.directional_commitment_id("meeting_123", action, "outbound")
        inbound_id = MODULE.directional_commitment_id("meeting_123", action, "inbound")

        self.assertNotEqual(outbound_id, inbound_id)
        self.assertEqual(outbound_id, MODULE.commitment_id("meeting_123", action))
        self.assertRegex(outbound_id, r"^ff_meeting_123_[0-9a-f]{12}$")
        self.assertRegex(inbound_id, r"^ffin_meeting_123_[0-9a-f]{12}$")

    def test_post_commitments_includes_direction(self) -> None:
        captured: dict[str, object] = {}

        def fake_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(b'{"ok": true}')

        commitments = [
            MODULE.RefinedCommitment(
                id="ff_meeting_123_abcdefabcdef",
                text="Send the proposal to Acme (due 2026-06-10)",
                source="ff",
                source_ref="meeting_123 · Acme Follow Up",
                direction="outbound",
            ),
            MODULE.RefinedCommitment(
                id="ffin_meeting_123_abcdefabcdef",
                text="[inbound] Sara: Send Josh the signed contract (due 2026-06-09)",
                source="ff-inbound",
                source_ref="meeting_123 · Acme Follow Up",
                direction="inbound",
            ),
        ]

        result = MODULE.post_commitments(
            ingest_url="https://briefs.example/api/tasks/ingest",
            ingest_token="token",
            commitments=commitments,
            urlopen=fake_urlopen,
        )

        self.assertEqual(result, {"ok": True})
        sent = captured["body"]["commitments"]
        self.assertEqual(len(sent), 2)
        for entry in sent:
            self.assertEqual(set(entry), {"id", "text", "direction", "source", "sourceRef"})
        self.assertEqual(sent[0]["direction"], "outbound")
        self.assertEqual(sent[1]["direction"], "inbound")


class RunStdoutContractTests(unittest.TestCase):
    ENV = {
        "FIREFLIES_API_KEY": "ff-test",
        "OPENROUTER_API_KEY": "or-test",
        "BRIEFS_INGEST_URL": "https://briefs.example/api/tasks/ingest",
        "TASKS_INGEST_TOKEN": "tok-test",
    }

    def make_urlopen(self, transcripts: list[dict[str, object]], calls: list[str]):
        def fake_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            url = request.full_url
            calls.append(url)
            if "fireflies" in url:
                body: dict[str, object] = {"data": {"transcripts": transcripts}}
            elif "openrouter" in url:
                prompt = json.loads(request.data.decode("utf-8"))["messages"][-1]["content"]
                if prompt.startswith("Extract action items"):
                    content = json.dumps(
                        [
                            {
                                "action": "Send the proposal to Acme",
                                "owner": "Josh",
                                "dueDate": "tomorrow",
                                "status": "pending",
                            },
                            {
                                "action": "Send Josh the signed contract",
                                "owner": "Sara",
                                "dueDate": "tomorrow",
                                "status": "pending",
                            },
                        ]
                    )
                else:
                    content = json.dumps({"is_casual": False})
                body = {"choices": [{"message": {"content": content}}]}
            else:
                body = {"ok": True}
            return FakeResponse(json.dumps(body).encode("utf-8"))

        return fake_urlopen

    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": "I'll send the proposal to Acme tomorrow.",
                }
            ],
        }

    def run_and_capture(self, transcripts: list[dict[str, object]], *, dry_run: bool) -> tuple[dict[str, object], list[str], Path]:
        calls: list[str] = []
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(
                        limit=5,
                        dry_run=dry_run,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen(transcripts, calls),
                    )
            self.assertEqual(exit_code, 0)
            watermark_exists = watermark_path.exists()
        printed = json.loads(stdout.getvalue())
        printed["_watermark_exists"] = watermark_exists
        return printed, calls, watermark_path

    def assert_items_shape(self, items: list[dict[str, object]]) -> None:
        for entry in items:
            self.assertEqual(set(entry), {"id", "text", "direction", "source", "sourceRef"})

    def test_no_fresh_transcripts_prints_empty_items(self) -> None:
        printed, calls, _ = self.run_and_capture([], dry_run=False)

        self.assertEqual(printed["items"], [])
        self.assertEqual(printed["meetings"], 0)
        self.assertFalse(printed["posted"])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_dry_run_prints_items_and_does_not_post_or_advance_watermark(self) -> None:
        printed, calls, _ = self.run_and_capture([self.make_transcript()], dry_run=True)

        self.assertTrue(printed["dry_run"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        directions = {entry["direction"] for entry in printed["items"]}
        self.assertEqual(directions, {"outbound", "inbound"})
        self.assertFalse(any("briefs.example" in url for url in calls))
        self.assertFalse(printed["_watermark_exists"])

    def test_dry_run_succeeds_with_ingest_env_unset(self) -> None:
        # SKILL DEGRADED path: BRIEFS_INGEST_URL / TASKS_INGEST_TOKEN missing →
        # --dry-run must still run extract-only (exit 0, items printed, no POST).
        calls: list[str] = []
        degraded_env = {
            "FIREFLIES_API_KEY": "ff-test",
            "OPENROUTER_API_KEY": "or-test",
        }
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, degraded_env, clear=True):
                self.assertNotIn("BRIEFS_INGEST_URL", os.environ)
                self.assertNotIn("TASKS_INGEST_TOKEN", os.environ)
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(
                        limit=5,
                        dry_run=True,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen([self.make_transcript()], calls),
                    )
            self.assertEqual(exit_code, 0)
            self.assertFalse(watermark_path.exists())

        printed = json.loads(stdout.getvalue())
        self.assertTrue(printed["dry_run"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_non_dry_run_still_requires_ingest_env(self) -> None:
        degraded_env = {
            "FIREFLIES_API_KEY": "ff-test",
            "OPENROUTER_API_KEY": "or-test",
        }
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            with unittest.mock.patch.dict(os.environ, degraded_env, clear=True):
                with self.assertRaises(ValueError):
                    MODULE.run(
                        limit=5,
                        dry_run=False,
                        watermark_path=watermark_path,
                        urlopen=self.make_urlopen([self.make_transcript()], []),
                    )

    def test_noop_print_includes_items_array(self) -> None:
        calls: list[str] = []

        def casual_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            url = request.full_url
            calls.append(url)
            if "fireflies" in url:
                body: dict[str, object] = {"data": {"transcripts": [self.make_transcript()]}}
            elif "openrouter" in url:
                body = {"choices": [{"message": {"content": json.dumps({"is_casual": True})}}]}
            else:
                body = {"ok": True}
            return FakeResponse(json.dumps(body).encode("utf-8"))

        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run(limit=5, dry_run=False, watermark_path=watermark_path, urlopen=casual_urlopen)
            self.assertEqual(exit_code, 0)

        printed = json.loads(stdout.getvalue())
        self.assertTrue(printed["noop"])
        self.assertEqual(printed["items"], [])
        self.assertFalse(any("briefs.example" in url for url in calls))

    def test_posted_print_includes_items(self) -> None:
        printed, calls, _ = self.run_and_capture([self.make_transcript()], dry_run=False)

        self.assertTrue(printed["posted"])
        self.assertEqual(len(printed["items"]), 2)
        self.assert_items_shape(printed["items"])
        sources = {entry["source"] for entry in printed["items"]}
        self.assertEqual(sources, {"ff", "ff-inbound"})
        self.assertTrue(any("briefs.example" in url for url in calls))
        self.assertTrue(printed["_watermark_exists"])


class FailureContractTests(unittest.TestCase):
    ENV = {
        "FIREFLIES_API_KEY": "ff-test",
        "OPENROUTER_API_KEY": "or-test",
        "BRIEFS_INGEST_URL": "https://briefs.example/api/tasks/ingest",
        "TASKS_INGEST_TOKEN": "tok-test",
    }

    def make_transcript(self) -> dict[str, object]:
        return {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [{"speaker_name": "Josh Weiss", "text": "I'll send the proposal tomorrow."}],
        }

    def test_execute_prints_error_json_and_notifies_on_openrouter_failure(self) -> None:
        def failing_urlopen(request: object, timeout: int | None = None) -> FakeResponse:
            url = request.full_url
            if "fireflies" in url:
                return FakeResponse(json.dumps({"data": {"transcripts": [self.make_transcript()]}}).encode("utf-8"))
            if "openrouter" in url:
                raise urllib.error.HTTPError(
                    url=url,
                    code=402,
                    msg="Payment Required",
                    hdrs=None,
                    fp=io.BytesIO(b'{"error":{"message":"credit balance too low"}}'),
                )
            raise AssertionError(f"unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.execute(
                        limit=5,
                        dry_run=False,
                        watermark_path=Path(tmp) / "watermark.json",
                        urlopen=failing_urlopen,
                    )

        self.assertEqual(exit_code, 1)
        printed = json.loads(stdout.getvalue())
        self.assertEqual(printed["items"], [])
        self.assertIn("credit balance too low", printed["error"])

    def test_execute_marks_dry_run_in_error_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, {"FIREFLIES_API_KEY": "ff-test"}, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.execute(
                        limit=5,
                        dry_run=True,
                        watermark_path=Path(tmp) / "watermark.json",
                    )

        self.assertEqual(exit_code, 1)
        printed = json.loads(stdout.getvalue())
        self.assertTrue(printed["dry_run"])
        self.assertEqual(printed["items"], [])
        self.assertIn("missing required env: OPENROUTER_API_KEY", printed["error"])


class RecapModeTests(unittest.TestCase):
    ENV = {
        "FIREFLIES_API_KEY": "ff-test",
        "OPENROUTER_API_KEY": "or-test",
    }

    def make_recap_transcript(self, **overrides) -> dict[str, object]:
        base = {
            "id": "meeting_r1",
            "title": "Acme Strategy Sync",
            "date": "2026-07-21T14:00:00Z",
            "organizer_email": "josh@clearworks.ai",
            "participants": ["josh@clearworks.ai", "sara@acme.com"],
            "summary": {
                "overview": "Discussed Q3 roadmap and deliverable timeline",
                "shorthand_bullet": "Q3 roadmap finalized",
                "action_items": "Send revised proposal by Friday",
                "keywords": ["roadmap", "timeline"],
            },
            "sentences": [
                {
                    "speaker_name": "Josh Weiss",
                    "text": "I'll send the proposal to Acme by Friday.",
                }
            ],
        }
        base.update(overrides)
        return base

    def fake_urlopen(self, responses):
        def urlopen_wrapper(request, timeout: int | None = None):
            url = request.full_url
            if "fireflies" in url:
                transcript_list = responses if responses else [self.make_recap_transcript()]
                return FakeResponse(json.dumps({"data": {"transcripts": transcript_list}}).encode("utf-8"))
            if "openrouter" in url:
                # Check the prompt to determine if this is classifier or extractor
                body = json.loads(request.data)
                messages = body.get("messages", [])
                if messages and len(messages) > 0:
                    content = messages[0].get("content", "")
                    
                    # Classifier prompt contains "is_casual" and asks for is_casual field
                    if "is_casual" in content:
                        return FakeResponse(json.dumps({
                            "choices": [{
                                "message": {
                                    "content": json.dumps({
                                        "contacts_mentioned": [],
                                        "extractions": [],
                                        "is_casual": False
                                    })
                                }
                            }]
                        }).encode("utf-8"))
                    else:
                        # Extractor prompt
                        return FakeResponse(json.dumps({
                            "choices": [{
                                "message": {
                                    "content": json.dumps([
                                        {
                                            "action": "Send revised proposal",
                                            "owner": "Josh",
                                            "dueDate": "Friday",
                                            "status": "pending"
                                        }
                                    ])
                                }
                            }]
                        }).encode("utf-8"))
                else:
                    raise AssertionError(f"unexpected OpenRouter request: {url}")
            raise AssertionError(f"unexpected URL: {url}")
        return urlopen_wrapper

    def test_parse_args_recap_defaults(self):
        args = MODULE.parse_args(["--recap"])
        self.assertTrue(args.recap)
        self.assertTrue(args.recap_ledger.endswith("state/meeting-recap-drafts-surfaced.txt"))

    def test_load_recap_ledger_missing_and_malformed(self):
        # Missing file
        self.assertEqual(MODULE.load_recap_ledger(Path("/nonexistent/path.txt")), set())
        
        # File with content including malformed lines
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "test-ledger.txt"
            ledger_path.write_text("m1 1720000000\n\ngarbage-only-token\n m2 999\n")
            result = MODULE.load_recap_ledger(ledger_path)
            self.assertEqual(result, {"m1", "garbage-only-token", "m2"})

    def test_run_recap_skips_ledgered_meeting_before_llm(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            ledger_path.write_text("meeting_r1 1720000000\n")
            
            openrouter_calls = []
            def counting_urlopen(request, timeout: int | None = None):
                if "openrouter" in request.full_url:
                    openrouter_calls.append(request.full_url)
                return self.fake_urlopen([])(request, timeout)
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=counting_urlopen,
                    )
            
            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertEqual(printed["meetings"], [])
            self.assertEqual(printed["skipped_ledger"], 1)
            self.assertEqual(len(openrouter_calls), 0)  # No LLM calls due to ledger skip

    def test_run_recap_suppresses_marcos_meeting(self):
        marcos_transcript = self.make_recap_transcript(title="Sync with Marcos Santa Ana")
        
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            ledger_path.write_text("")
            
            openrouter_calls = []
            def counting_urlopen(request, timeout: int | None = None):
                if "openrouter" in request.full_url:
                    openrouter_calls.append(request.full_url)
                return self.fake_urlopen([marcos_transcript])(request, timeout)
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=counting_urlopen,
                    )
            
            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertEqual(printed["meetings"], [])
            self.assertEqual(printed["skipped_suppressed"], 1)
            self.assertEqual(len(openrouter_calls), 0)

    def test_run_recap_skips_casual_meeting(self):
        # Create a transcript that will be classified as casual
        casual_transcript = self.make_recap_transcript(
            sentences=[{"speaker_name": "Josh Weiss", "text": "Hi everyone, how are you doing?"}]
        )
        
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            ledger_path.write_text("")
            
            openrouter_calls = []
            def counting_urlopen(request, timeout: int | None = None):
                if "fireflies" in request.full_url:
                    return FakeResponse(json.dumps({"data": {"transcripts": [casual_transcript]}}).encode("utf-8"))
                if "openrouter" in request.full_url:
                    openrouter_calls.append(request.full_url)
                    # Check the prompt to determine if this is classifier or extractor
                    body = json.loads(request.data)
                    messages = body.get("messages", [])
                    if messages and len(messages) > 0:
                        content = messages[0].get("content", "")
                        
                        # Classifier prompt contains "is_casual"
                        if "is_casual" in content:
                            return FakeResponse(json.dumps({
                                "choices": [{
                                    "message": {
                                        "content": json.dumps({
                                            "contacts_mentioned": [],
                                            "extractions": [],
                                            "is_casual": True
                                        })
                                    }
                                }]
                            }).encode("utf-8"))
                        else:
                            # Extractor prompt (shouldn't be called for casual)
                            return FakeResponse(json.dumps({
                                "choices": [{
                                    "message": {
                                        "content": json.dumps([
                                            {
                                                "action": "Some action",
                                                "owner": "Josh",
                                                "dueDate": "Friday",
                                                "status": "pending"
                                            }
                                        ])
                                    }
                                }]
                            }).encode("utf-8"))
                    else:
                        raise AssertionError(f"unexpected OpenRouter request: {request.full_url}")
                raise AssertionError(f"unexpected URL: {request.full_url}")
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=counting_urlopen,
                    )
            
            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertEqual(printed["meetings"], [])
            self.assertEqual(printed["skipped_casual"], 1)
            # Classifier was called but extractor was not
            self.assertEqual(len([c for c in openrouter_calls if "openrouter" in c]), 1)

    def test_run_recap_emits_contract_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            ledger_path.write_text("")
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=self.fake_urlopen([]),
                    )
            
            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertTrue(printed["recap"])
            self.assertEqual(len(printed["meetings"]), 1)
            
            meeting = printed["meetings"][0]
            self.assertEqual(meeting["id"], "meeting_r1")
            self.assertEqual(meeting["title"], "Acme Strategy Sync")
            self.assertIn("date", meeting)
            self.assertIn("organizer", meeting)
            self.assertIn("attendees", meeting)
            self.assertIn("summary", meeting)
            self.assertIn("overview", meeting["summary"])
            self.assertIn("bullets", meeting["summary"])
            self.assertIn("action_items", meeting["summary"])
            self.assertIn("next_steps", meeting)
            
            # Verify next_steps have the expected structure from refine_items
            if meeting["next_steps"]:
                for step in meeting["next_steps"]:
                    self.assertIn("id", step)
                    self.assertIn("text", step)
                    self.assertIn("direction", step)
                    self.assertIn("source", step)
                    self.assertIn("sourceRef", step)

    def test_run_recap_never_touches_watermark_or_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            watermark_path = Path(tmp) / "watermark.json"
            ledger_path = Path(tmp) / "ledger.txt"
            
            # Create initial files
            watermark_path.write_text('{"last_transcript_id": "old_id"}')
            ledger_path.write_text("old_meeting 1720000000\n")
            
            initial_watermark = watermark_path.read_bytes()
            initial_ledger = ledger_path.read_bytes()
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, self.ENV, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=self.fake_urlopen([]),
                    )
            
            self.assertEqual(exit_code, 0)
            # Watermark should be byte-identical (recap mode never touches it)
            self.assertTrue(watermark_path.exists())
            self.assertEqual(watermark_path.read_bytes(), initial_watermark)
            # Ledger should be byte-identical (read-only)
            self.assertEqual(ledger_path.read_bytes(), initial_ledger)

    def test_execute_recap_error_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, {}, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.execute_recap(
                        limit=10,
                        ledger_path=ledger_path,
                    )
            
            self.assertEqual(exit_code, 1)
            printed = json.loads(stdout.getvalue())
            self.assertTrue(printed["recap"])
            self.assertEqual(printed["meetings"], [])
            self.assertIn("error", printed)
            self.assertIn("missing required env", printed["error"])

    def test_recap_mode_does_not_require_ingest_env(self):
        recap_only_env = {
            "FIREFLIES_API_KEY": "ff-test",
            "OPENROUTER_API_KEY": "or-test",
        }
        
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = Path(tmp) / "ledger.txt"
            ledger_path.write_text("")
            
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, recap_only_env, clear=True):
                with contextlib.redirect_stdout(stdout):
                    exit_code = MODULE.run_recap(
                        limit=10,
                        ledger_path=ledger_path,
                        urlopen=self.fake_urlopen([]),
                    )
            
            self.assertEqual(exit_code, 0)
            printed = json.loads(stdout.getvalue())
            self.assertTrue(printed["recap"])

    def test_existing_dry_run_contract_unchanged(self):
        args = MODULE.parse_args([])
        self.assertFalse(args.recap)
        self.assertFalse(args.dry_run)


if __name__ == "__main__":
    unittest.main()
