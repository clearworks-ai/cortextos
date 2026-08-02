#!/usr/bin/env python3
"""Unit tests for ff-extractor.py (stdlib unittest only)."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from unittest import mock


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "ff-extractor.py"


def load_mod():
    spec = importlib.util.spec_from_file_location("ff_extractor", SCRIPT_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ff_extractor"] = mod
    spec.loader.exec_module(mod)
    return mod


ff = load_mod()


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestEnrichment(unittest.TestCase):
    def test_enriched_outbound(self):
        meeting_id = "m-out-1"
        meeting_day = date(2026, 7, 24)
        item = ff.ExtractedItem(
            action="Send proposal to Acme",
            owner="Josh",
            due_date="tomorrow",
            status="pending",
        )
        josh_sentences = ["I'll send the proposal tomorrow"]
        result = ff.refine_outbound_item(
            item,
            meeting_id=meeting_id,
            meeting_day=meeting_day,
            josh_sentences=josh_sentences,
            source_ref=f"{meeting_id} · Acme Call",
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.owner, "Josh")
        self.assertEqual(result.deadline, "2026-07-25")
        self.assertIn("proposal", result.source_quote.lower())
        self.assertEqual(result.direction, "outbound")
        self.assertEqual(result.id, ff.commitment_id(meeting_id, item.action))

        entries = ff.commitment_entries([result], enriched=True)
        self.assertEqual(entries[0]["owner"], "Josh")
        self.assertEqual(entries[0]["deadline"], "2026-07-25")
        self.assertIn("proposal", entries[0]["sourceQuote"].lower())

    def test_enriched_inbound_quote_from_non_josh(self):
        meeting_id = "m-in-1"
        meeting_day = date(2026, 7, 24)
        item = ff.ExtractedItem(
            action="Send contract to Josh by Friday",
            owner="Sarah",
            due_date="2026-07-25",
            status="pending",
        )
        transcript = {
            "id": meeting_id,
            "title": "Acme",
            "date": "2026-07-24T15:00:00Z",
            "sentences": [
                {
                    "speaker_name": "Sarah",
                    "text": "I will send contract to Josh by Friday morning.",
                },
                {
                    "speaker_name": "Josh Weiss",
                    "text": "Sounds good.",
                },
            ],
        }
        commitments = ff.refine_items(transcript, [item])
        self.assertEqual(len(commitments), 1)
        c = commitments[0]
        self.assertEqual(c.owner, "Sarah")
        self.assertEqual(c.direction, "inbound")
        self.assertIn("contract", c.source_quote.lower())
        self.assertIn("josh", c.source_quote.lower())
        self.assertEqual(
            c.source_quote,
            "I will send contract to Josh by Friday morning.",
        )


class TestWireStability(unittest.TestCase):
    def test_post_body_keys_only_wire_five(self):
        c = ff.RefinedCommitment(
            id="ff_x",
            text="Do thing (due 2026-07-25)",
            source="ff",
            source_ref="m · T",
            direction="outbound",
            owner="Josh",
            deadline="2026-07-25",
            source_quote="I'll do the thing",
        )
        captured: dict[str, Any] = {}

        def fake_urlopen(req, timeout=30):
            captured["body"] = req.data
            captured["url"] = req.full_url
            return FakeResponse(json.dumps({"ok": True}).encode("utf-8"))

        ff.post_commitments(
            ingest_url="https://example.test/ingest",
            ingest_token="tok",
            commitments=[c],
            urlopen=fake_urlopen,
        )
        body = json.loads(captured["body"].decode("utf-8"))
        keys = set(body["commitments"][0].keys())
        self.assertEqual(keys, {"id", "text", "direction", "source", "sourceRef"})


class TestModeRouting(unittest.TestCase):
    def test_no_flags_commitments(self):
        with mock.patch.object(ff, "execute", return_value=0) as ex:
            with mock.patch.object(ff, "execute_recap", return_value=0) as er:
                with mock.patch.object(ff, "execute_full", return_value=0) as ef:
                    rc = ff.main([])
                    self.assertEqual(rc, 0)
                    ex.assert_called_once()
                    er.assert_not_called()
                    ef.assert_not_called()

    def test_recap_flag(self):
        with mock.patch.object(ff, "execute", return_value=0) as ex:
            with mock.patch.object(ff, "execute_recap", return_value=0) as er:
                with mock.patch.object(ff, "execute_full", return_value=0) as ef:
                    rc = ff.main(["--recap"])
                    self.assertEqual(rc, 0)
                    er.assert_called_once()
                    ex.assert_not_called()
                    ef.assert_not_called()

    def test_mode_full(self):
        with mock.patch.object(ff, "execute", return_value=0) as ex:
            with mock.patch.object(ff, "execute_recap", return_value=0) as er:
                with mock.patch.object(ff, "execute_full", return_value=0) as ef:
                    rc = ff.main(["--mode", "full"])
                    self.assertEqual(rc, 0)
                    ef.assert_called_once()
                    ex.assert_not_called()
                    er.assert_not_called()

    def test_mode_commitments_with_recap_conflict(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            rc = ff.main(["--mode", "commitments", "--recap"])
        self.assertEqual(rc, 2)
        self.assertIn("conflicts", buf.getvalue().lower())


class TestFullModeIsolation(unittest.TestCase):
    def test_full_mode_watermark_untouched_and_no_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            wm = Path(tmp) / "watermark.json"
            wm.write_text(json.dumps({"timestamp": "2020-01-01T00:00:00Z", "meeting_id": "old"}), encoding="utf-8")
            before_bytes = wm.read_bytes()
            before_mtime = wm.stat().st_mtime

            t1 = {
                "id": "meet-a",
                "title": "Call A",
                "date": "2026-07-24T12:00:00Z",
                "organizer_email": "a@x.com",
                "participants": ["Josh", "Sarah"],
                "summary": {"overview": "x", "shorthand_bullet": "y", "action_items": "z"},
                "sentences": [
                    {"speaker_name": "Josh Weiss", "text": "I'll send the proposal tomorrow to Acme."},
                ],
            }
            t2 = {
                "id": "meet-b",
                "title": "Call B",
                "date": "2026-07-23T12:00:00Z",
                "organizer_email": "b@x.com",
                "participants": ["Josh"],
                "summary": {"overview": "x", "shorthand_bullet": "y", "action_items": "z"},
                "sentences": [
                    {"speaker_name": "Josh Weiss", "text": "I'll email the deck tomorrow."},
                ],
            }

            def fake_fetch(api_key, limit=20, urlopen=None):
                return [t1, t2]

            def fake_casual(text, openrouter_api_key="", urlopen=None):
                return False

            def fake_extract(text, client_context="", openrouter_api_key="", urlopen=None):
                return [
                    ff.ExtractedItem(
                        action="Send proposal to Acme",
                        owner="Josh",
                        due_date="tomorrow",
                        status="pending",
                    )
                ]

            ingest_calls: list[Any] = []

            def tracking_urlopen(*a, **k):
                ingest_calls.append((a, k))
                raise AssertionError("urlopen should not be called in full mode unit path")

            env = {
                "FIREFLIES_API_KEY": "ff-key",
                "OPENROUTER_API_KEY": "or-key",
            }
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch.object(ff, "fetch_recent_transcripts", side_effect=fake_fetch):
                    with mock.patch.object(ff, "is_casual_transcript", side_effect=fake_casual):
                        with mock.patch.object(ff, "extract_action_items", side_effect=fake_extract):
                            with mock.patch.object(ff, "is_suppressed_meeting", return_value=False):
                                out = io.StringIO()
                                with redirect_stdout(out):
                                    rc = ff.run_full(limit=2, meeting_id="", urlopen=tracking_urlopen)
            self.assertEqual(rc, 0)
            data = json.loads(out.getvalue())
            self.assertEqual(data["mode"], "full")
            self.assertGreaterEqual(len(data["meetings"]), 1)
            ns = data["meetings"][0]["next_steps"]
            if ns:
                self.assertIn("owner", ns[0])
                self.assertIn("deadline", ns[0])
                self.assertIn("sourceQuote", ns[0])
            self.assertEqual(wm.read_bytes(), before_bytes)
            self.assertEqual(wm.stat().st_mtime, before_mtime)
            self.assertEqual(ingest_calls, [])

    def test_meeting_id_filter(self):
        t1 = {
            "id": "keep-me",
            "title": "Keep",
            "date": "2026-07-24T12:00:00Z",
            "organizer_email": "a@x.com",
            "participants": ["Josh"],
            "summary": {"overview": "", "shorthand_bullet": "", "action_items": ""},
            "sentences": [{"speaker_name": "Josh", "text": "I'll ship v2 tomorrow."}],
        }
        t2 = {
            "id": "drop-me",
            "title": "Drop",
            "date": "2026-07-23T12:00:00Z",
            "organizer_email": "b@x.com",
            "participants": ["Josh"],
            "summary": {"overview": "", "shorthand_bullet": "", "action_items": ""},
            "sentences": [{"speaker_name": "Josh", "text": "I'll ship v1 tomorrow."}],
        }

        def fake_fetch(api_key, limit=20, urlopen=None):
            return [t1, t2]

        env = {"FIREFLIES_API_KEY": "ff", "OPENROUTER_API_KEY": "or"}
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(ff, "fetch_recent_transcripts", side_effect=fake_fetch):
                with mock.patch.object(ff, "is_casual_transcript", return_value=False):
                    with mock.patch.object(
                        ff,
                        "extract_action_items",
                        return_value=[
                            ff.ExtractedItem(
                                action="Ship v2",
                                owner="Josh",
                                due_date="tomorrow",
                                status="pending",
                            )
                        ],
                    ):
                        with mock.patch.object(ff, "is_suppressed_meeting", return_value=False):
                            out = io.StringIO()
                            with redirect_stdout(out):
                                rc = ff.run_full(limit=10, meeting_id="keep-me", urlopen=lambda *a, **k: None)
        self.assertEqual(rc, 0)
        data = json.loads(out.getvalue())
        self.assertEqual(len(data["meetings"]), 1)
        self.assertEqual(data["meetings"][0]["id"], "keep-me")


class TestRecapMeeting(unittest.TestCase):
    def test_build_recap_meeting_attendees_union_speakers(self):
        transcript = {
            "id": "m1",
            "title": "Sync",
            "date": "2026-07-24T12:00:00Z",
            "organizer_email": "a@x.com",
            "participants": ["alice@example.com"],
            "speakers": [
                {"id": "1", "name": "Alice Example"},
                {"id": "2", "name": "Bob Speaker"},
            ],
            "summary": {"overview": "", "shorthand_bullet": "", "action_items": ""},
            "sentences": [
                {"speaker_name": "Bob Speaker", "text": "I'll send the deck tomorrow."},
            ],
        }
        with mock.patch.object(ff, "is_casual_transcript", return_value=False):
            with mock.patch.object(ff, "extract_action_items", return_value=[]):
                meeting = ff.build_recap_meeting(
                    transcript,
                    openrouter_api_key="or-key",
                    urlopen=lambda *a, **k: (_ for _ in ()).throw(
                        AssertionError("urlopen should not be called")
                    ),
                )
        self.assertIsNotNone(meeting)
        assert meeting is not None
        self.assertIn("alice@example.com", meeting["attendees"])
        self.assertIn("Alice Example", meeting["attendees"])
        self.assertIn("Bob Speaker", meeting["attendees"])

        dedup_transcript = {
            "id": "m2",
            "title": "Sync",
            "date": "2026-07-24T12:00:00Z",
            "organizer_email": "a@x.com",
            "participants": ["Alice Example"],
            "speakers": [{"id": "1", "name": "alice example"}],
            "summary": {"overview": "", "shorthand_bullet": "", "action_items": ""},
            "sentences": [
                {"speaker_name": "alice example", "text": "I'll send the deck tomorrow."},
            ],
        }
        with mock.patch.object(ff, "is_casual_transcript", return_value=False):
            with mock.patch.object(ff, "extract_action_items", return_value=[]):
                dedup_meeting = ff.build_recap_meeting(
                    dedup_transcript,
                    openrouter_api_key="or-key",
                    urlopen=lambda *a, **k: (_ for _ in ()).throw(
                        AssertionError("urlopen should not be called")
                    ),
                )
        self.assertIsNotNone(dedup_meeting)
        assert dedup_meeting is not None
        self.assertEqual(
            len([attendee for attendee in dedup_meeting["attendees"] if attendee.lower() == "alice example"]),
            1,
        )


if __name__ == "__main__":
    unittest.main()
