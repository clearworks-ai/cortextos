from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("knowledge-capture.py")
SPEC = importlib.util.spec_from_file_location("knowledge_capture_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load knowledge-capture.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class KnowledgeCaptureTests(unittest.TestCase):
    def make_transcript(
        self,
        text: str,
        *,
        meeting_id: str = "meeting_123",
        title: str = "Acme Next Steps",
        meeting_date: str = "2026-07-10T16:00:00Z",
        participants: list[str] | None = None,
    ) -> dict[str, object]:
        return {
            "id": meeting_id,
            "title": title,
            "date": meeting_date,
            "organizer_email": "josh@clearworks.ai",
            "participants": participants or ["sara@acme.com"],
            "sentences": [{"speaker_name": "Josh Weiss", "text": text}],
        }

    def stub_payload(self) -> dict[str, object]:
        return {
            "topic": "Next Steps",
            "summary": "This conversation clarified the immediate next steps and confirmed the current engagement scope.",
            "keyTakeaways": ["Proposal update is due next week."],
            "openQuestions": ["Whether the stakeholder review will happen on Monday."],
            "relatedCandidates": ["missing-topic"],
        }

    def run_capture(self, transcript: dict[str, object], *, dry_run: bool, client_record: dict[str, object] | None = None) -> tuple[int, dict[str, object], Path, Path]:
        tmpdir_ctx = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir_ctx.cleanup)
        capture_dir = Path(tmpdir_ctx.name) / "capture"
        transcripts_dir = Path(tmpdir_ctx.name) / "transcripts"
        watermark_path = Path(tmpdir_ctx.name) / "watermark.json"
        printed: list[str] = []

        original_require_env = MODULE.FF.require_env
        original_fetch_recent = MODULE.FF.fetch_recent_transcripts
        original_select_recent = MODULE.FF.select_recent_transcripts
        original_is_casual = MODULE.FF.is_casual_transcript
        original_match_client = MODULE.FF.matched_client_context_record_for_transcript
        original_synthesize = MODULE.synthesize_note_payload
        try:
            MODULE.FF.require_env = lambda _name: "token"
            MODULE.FF.fetch_recent_transcripts = lambda *args, **kwargs: [transcript]
            MODULE.FF.select_recent_transcripts = lambda *args, **kwargs: [transcript]
            MODULE.FF.is_casual_transcript = lambda *args, **kwargs: False
            MODULE.FF.matched_client_context_record_for_transcript = lambda _transcript: client_record
            MODULE.synthesize_note_payload = lambda *args, **kwargs: self.stub_payload()
            with unittest.mock.patch("builtins.print", side_effect=printed.append):
                rc = MODULE.run_capture(
                    dry_run=dry_run,
                    limit=5,
                    since="",
                    transcripts_dir=transcripts_dir,
                    capture_dir=capture_dir,
                    watermark_path=watermark_path,
                )
        finally:
            MODULE.FF.require_env = original_require_env
            MODULE.FF.fetch_recent_transcripts = original_fetch_recent
            MODULE.FF.select_recent_transcripts = original_select_recent
            MODULE.FF.is_casual_transcript = original_is_casual
            MODULE.FF.matched_client_context_record_for_transcript = original_match_client
            MODULE.synthesize_note_payload = original_synthesize

        payload = json.loads(printed[0])
        return rc, payload, capture_dir, watermark_path

    def test_dry_run_writes_nothing_and_prints_valid_json(self) -> None:
        transcript = self.make_transcript("We reviewed the roadmap.")
        rc, payload, capture_dir, _watermark_path = self.run_capture(transcript, dry_run=True)
        self.assertEqual(rc, 0)
        self.assertEqual(payload["dry_run"], True)
        self.assertEqual(payload["written"], 0)
        self.assertFalse(capture_dir.exists())

    def test_render_note_matches_template_contract(self) -> None:
        transcript = self.make_transcript("We reviewed the roadmap.")
        client_record = {"client_name": "Acme", "path": Path("/tmp/acme.md")}
        filename, body = MODULE.render_note(transcript, client_record=client_record, capture_payload=self.stub_payload())

        self.assertEqual(filename, "2026-07-10-acme-next-steps.md")
        self.assertIn('type: knowledge-capture', body)
        self.assertIn('source: "fireflies:meeting_123"', body)
        self.assertIn("## Key Takeaways", body)
        self.assertIn("## Open Questions / Unknowns", body)
        self.assertIn("## Related", body)

    def test_second_run_skips_existing_source(self) -> None:
        transcript = self.make_transcript("We reviewed the roadmap.")
        with tempfile.TemporaryDirectory() as tmpdir:
            capture_dir = Path(tmpdir) / "capture"
            capture_dir.mkdir(parents=True, exist_ok=True)
            existing = capture_dir / "2026-07-10-acme-next-steps.md"
            existing.write_text('---\nsource: "fireflies:meeting_123"\n---\n', encoding="utf-8")
            watermark_path = Path(tmpdir) / "watermark.json"
            transcripts_dir = Path(tmpdir) / "transcripts"
            printed: list[str] = []

            original_require_env = MODULE.FF.require_env
            original_fetch_recent = MODULE.FF.fetch_recent_transcripts
            original_select_recent = MODULE.FF.select_recent_transcripts
            original_is_casual = MODULE.FF.is_casual_transcript
            original_match_client = MODULE.FF.matched_client_context_record_for_transcript
            original_synthesize = MODULE.synthesize_note_payload
            try:
                MODULE.FF.require_env = lambda _name: "token"
                MODULE.FF.fetch_recent_transcripts = lambda *args, **kwargs: [transcript]
                MODULE.FF.select_recent_transcripts = lambda *args, **kwargs: [transcript]
                MODULE.FF.is_casual_transcript = lambda *args, **kwargs: False
                MODULE.FF.matched_client_context_record_for_transcript = lambda _transcript: None
                MODULE.synthesize_note_payload = lambda *args, **kwargs: self.stub_payload()
                with unittest.mock.patch("builtins.print", side_effect=printed.append):
                    rc = MODULE.run_capture(
                        dry_run=False,
                        limit=5,
                        since="",
                        transcripts_dir=transcripts_dir,
                        capture_dir=capture_dir,
                        watermark_path=watermark_path,
                    )
            finally:
                MODULE.FF.require_env = original_require_env
                MODULE.FF.fetch_recent_transcripts = original_fetch_recent
                MODULE.FF.select_recent_transcripts = original_select_recent
                MODULE.FF.is_casual_transcript = original_is_casual
                MODULE.FF.matched_client_context_record_for_transcript = original_match_client
                MODULE.synthesize_note_payload = original_synthesize

            payload = json.loads(printed[0])
            self.assertEqual(rc, 0)
            self.assertEqual(payload["written"], 0)
            self.assertEqual(payload["skipped"], 1)

    def test_casual_transcript_is_skipped(self) -> None:
        transcript = self.make_transcript("Hello there.")
        with tempfile.TemporaryDirectory() as tmpdir:
            capture_dir = Path(tmpdir) / "capture"
            watermark_path = Path(tmpdir) / "watermark.json"
            transcripts_dir = Path(tmpdir) / "transcripts"
            printed: list[str] = []

            original_require_env = MODULE.FF.require_env
            original_fetch_recent = MODULE.FF.fetch_recent_transcripts
            original_select_recent = MODULE.FF.select_recent_transcripts
            original_is_casual = MODULE.FF.is_casual_transcript
            try:
                MODULE.FF.require_env = lambda _name: "token"
                MODULE.FF.fetch_recent_transcripts = lambda *args, **kwargs: [transcript]
                MODULE.FF.select_recent_transcripts = lambda *args, **kwargs: [transcript]
                MODULE.FF.is_casual_transcript = lambda *args, **kwargs: True
                with unittest.mock.patch("builtins.print", side_effect=printed.append):
                    rc = MODULE.run_capture(
                        dry_run=False,
                        limit=5,
                        since="",
                        transcripts_dir=transcripts_dir,
                        capture_dir=capture_dir,
                        watermark_path=watermark_path,
                    )
            finally:
                MODULE.FF.require_env = original_require_env
                MODULE.FF.fetch_recent_transcripts = original_fetch_recent
                MODULE.FF.select_recent_transcripts = original_select_recent
                MODULE.FF.is_casual_transcript = original_is_casual

            payload = json.loads(printed[0])
            self.assertEqual(rc, 0)
            self.assertEqual(payload["casual"], 1)
            self.assertFalse(capture_dir.exists())

    def test_missing_client_link_is_dropped(self) -> None:
        transcript = self.make_transcript("We reviewed the roadmap.")
        client_record = {"client_name": "Acme", "path": Path("/tmp/does-not-exist.md")}
        _filename, body = MODULE.render_note(transcript, client_record=client_record, capture_payload=self.stub_payload())

        self.assertIn("## Related", body)
        self.assertIn("- none", body)
        self.assertNotIn("[[does-not-exist]]", body)

    def test_watermark_advances_only_on_successful_write(self) -> None:
        transcript = self.make_transcript("We reviewed the roadmap.")
        rc, payload, _capture_dir, watermark_path = self.run_capture(transcript, dry_run=False)
        self.assertEqual(rc, 0)
        self.assertEqual(payload["written"], 1)
        self.assertTrue(watermark_path.exists())

        _rc, payload_dry, _capture_dir2, watermark_path2 = self.run_capture(transcript, dry_run=True)
        self.assertEqual(payload_dry["written"], 0)
        self.assertFalse(watermark_path2.exists())


if __name__ == "__main__":
    unittest.main()
