from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "ff-transcript-persist.py"
SPEC = importlib.util.spec_from_file_location("ff_transcript_persist_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load ff-transcript-persist.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TranscriptPersistTests(unittest.TestCase):
    def make_transcript(
        self,
        text: str,
        *,
        meeting_id: str = "01KX41NJQJE6R278AGZ26BDB6H",
        title: str = "Acme Follow Up",
        meeting_date: str = "2026-07-10T16:00:00Z",
        organizer: str = "josh@clearworks.ai",
        participants: list[str] | None = None,
    ) -> dict[str, object]:
        return {
            "id": meeting_id,
            "title": title,
            "date": meeting_date,
            "duration": 55,
            "organizer_email": organizer,
            "participants": participants or ["josh@clearworks.ai", "sara@acme.com"],
            "summary": {"overview": "Reviewed the latest scope and next steps."},
            "transcript_url": "https://app.fireflies.ai/view/meeting",
            "sentences": [{"speaker_name": "Josh Weiss", "text": text}],
        }

    def test_transcript_filename_uses_date_and_meeting_id(self) -> None:
        transcript = self.make_transcript("Discussed onboarding.")
        self.assertEqual(
            MODULE.transcript_filename(transcript),
            "2026-07-10-01KX41NJQJE6R278AGZ26BDB6H.md",
        )

    def test_build_transcript_markdown_contains_frontmatter_contract(self) -> None:
        transcript = self.make_transcript("Discussed onboarding.")
        body = MODULE.build_transcript_markdown(transcript)

        self.assertIn('title: "Acme Follow Up"', body)
        self.assertIn('meeting_id: "01KX41NJQJE6R278AGZ26BDB6H"', body)
        self.assertIn('source: fireflies', body)
        self.assertIn('doc_kind: transcript', body)
        self.assertIn("## Transcript", body)
        self.assertIn("Josh Weiss: Discussed onboarding.", body)

    def test_build_transcript_markdown_keeps_full_body_untruncated(self) -> None:
        huge_sentence = "A" * 50050
        transcript = self.make_transcript(huge_sentence)
        body = MODULE.build_transcript_markdown(transcript)

        self.assertIn(huge_sentence, body)
        self.assertGreater(len(body), 50050)

    def test_run_persist_dry_run_writes_nothing(self) -> None:
        transcript = self.make_transcript("Dry run only.")
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "ledger.txt"
            transcripts_dir = Path(tmpdir) / "transcripts"
            output = []

            original_require_env = MODULE.FF.require_env
            original_select_transcripts = MODULE.select_transcripts
            try:
                MODULE.FF.require_env = lambda _name: "token"
                MODULE.select_transcripts = lambda *args, **kwargs: [transcript]
                with unittest.mock.patch("builtins.print", side_effect=output.append):
                    rc = MODULE.run_persist(
                        dry_run=True,
                        limit=5,
                        meeting_id="",
                        backfill=False,
                        ledger_path=ledger_path,
                        transcripts_dir=transcripts_dir,
                    )
            finally:
                MODULE.FF.require_env = original_require_env
                MODULE.select_transcripts = original_select_transcripts

            self.assertEqual(rc, 0)
            self.assertFalse(transcripts_dir.exists())
            payload = json.loads(output[0])
            self.assertEqual(payload["persisted"], 1)
            self.assertTrue(payload["dry_run"])

    def test_run_persist_is_idempotent_via_ledger(self) -> None:
        transcript = self.make_transcript("Persist this transcript.")
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "ledger.txt"
            transcripts_dir = Path(tmpdir) / "transcripts"

            def run_once() -> int:
                original_require_env = MODULE.FF.require_env
                original_select_transcripts = MODULE.select_transcripts
                try:
                    MODULE.FF.require_env = lambda _name: "token"
                    MODULE.select_transcripts = lambda *args, **kwargs: [transcript]
                    return MODULE.run_persist(
                        dry_run=False,
                        limit=5,
                        meeting_id="",
                        backfill=False,
                        ledger_path=ledger_path,
                        transcripts_dir=transcripts_dir,
                    )
                finally:
                    MODULE.FF.require_env = original_require_env
                    MODULE.select_transcripts = original_select_transcripts

            self.assertEqual(run_once(), 0)
            output_path = transcripts_dir / MODULE.transcript_filename(transcript)
            first_mtime = output_path.stat().st_mtime_ns
            self.assertEqual(run_once(), 0)
            self.assertEqual(output_path.stat().st_mtime_ns, first_mtime)
            self.assertEqual(MODULE.FF.load_ledger(ledger_path), {str(transcript["id"])})

    def test_persist_one_skips_suppressed_meeting(self) -> None:
        transcript = self.make_transcript(
            "Suppressed meeting.",
            title="Marcos Santa Ana catch-up",
            participants=["marcos@clearworks.ai"],
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            status, relative_path, preview = MODULE.persist_one(
                transcript,
                transcripts_dir=Path(tmpdir),
                ledger_ids=set(),
                ledger_path=Path(tmpdir) / "ledger.txt",
                dry_run=False,
            )
        self.assertEqual(status, "empty")
        self.assertIsNone(relative_path)
        self.assertIsNone(preview)

    def test_atomic_write_leaves_no_tmp_file(self) -> None:
        transcript = self.make_transcript("Atomic write check.")
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "ledger.txt"
            transcripts_dir = Path(tmpdir) / "transcripts"
            original_require_env = MODULE.FF.require_env
            original_select_transcripts = MODULE.select_transcripts
            try:
                MODULE.FF.require_env = lambda _name: "token"
                MODULE.select_transcripts = lambda *args, **kwargs: [transcript]
                rc = MODULE.run_persist(
                    dry_run=False,
                    limit=5,
                    meeting_id="",
                    backfill=False,
                    ledger_path=ledger_path,
                    transcripts_dir=transcripts_dir,
                )
            finally:
                MODULE.FF.require_env = original_require_env
                MODULE.select_transcripts = original_select_transcripts

            self.assertEqual(rc, 0)
            self.assertEqual(list(transcripts_dir.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
