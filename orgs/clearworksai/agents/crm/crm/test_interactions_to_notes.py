from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("interactions-to-notes.py")
SPEC = importlib.util.spec_from_file_location("crm_interactions_to_notes", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load interactions-to-notes.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class InteractionToNotesTests(unittest.TestCase):
    def make_record(self) -> dict[str, object]:
        return {
            "ts": "2026-07-30T08:15:00Z",
            "contact_id": "acme-client",
            "type": "meeting",
            "summary": "Reviewed the launch plan and agreed to send the revised brief",
            "sentiment": "positive",
            "commitments": ["Send revised brief by Friday"],
            "followups_created": ["followup-acme-2026-08-01-a1b2c3d4"],
            "source_ref": "ff:meeting-123",
        }

    def test_render_note_uses_stable_filename_and_human_readable_sections(self) -> None:
        record = MODULE.InteractionRecord.from_payload(self.make_record())

        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            note_path = MODULE.note_path_for_record(record, output_root)

        expected_hash = hashlib.sha256(
            "acme-client|ff:meeting-123|2026-07-30T08:15:00Z".encode("utf-8")
        ).hexdigest()[:12]
        self.assertEqual(note_path.name, f"acme-client__{expected_hash}.md")

        rendered = MODULE.render_note(record)
        self.assertIn('contact_id: "acme-client"', rendered)
        self.assertIn('type: "meeting"', rendered)
        self.assertIn("On 2026-07-30T08:15:00Z, acme-client had a positive meeting interaction.", rendered)
        self.assertIn("Reviewed the launch plan and agreed to send the revised brief.", rendered)
        self.assertIn("## Commitments", rendered)
        self.assertIn("- Send revised brief by Friday", rendered)
        self.assertIn("## Follow-ups created", rendered)
        self.assertIn("- followup-acme-2026-08-01-a1b2c3d4", rendered)

    def test_transform_is_idempotent_and_skips_malformed_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            input_path = tmp_path / "interactions.jsonl"
            output_root = tmp_path / "notes"
            input_path.write_text(
                json.dumps(self.make_record()) + "\n" + "{not-json}\n" + "\n",
                encoding="utf-8",
            )

            first = MODULE.transform_interactions(input_path, output_root)

            self.assertEqual(first["records_seen"], 2)
            self.assertEqual(first["valid_records"], 1)
            self.assertEqual(first["notes_written"], 1)
            self.assertEqual(first["notes_unchanged"], 0)
            self.assertEqual(first["skipped_lines"], 1)

            note_files = sorted(output_root.glob("*.md"))
            self.assertEqual(len(note_files), 1)
            first_bytes = note_files[0].read_bytes()

            second = MODULE.transform_interactions(input_path, output_root)

            self.assertEqual(second["records_seen"], 2)
            self.assertEqual(second["valid_records"], 1)
            self.assertEqual(second["notes_written"], 0)
            self.assertEqual(second["notes_unchanged"], 1)
            self.assertEqual(second["skipped_lines"], 1)
            self.assertEqual(note_files[0].read_bytes(), first_bytes)

    def test_transform_accepts_legacy_timestamp_field(self) -> None:
        legacy = self.make_record()
        legacy["timestamp"] = legacy.pop("ts")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            input_path = tmp_path / "interactions.jsonl"
            output_root = tmp_path / "notes"
            input_path.write_text(json.dumps(legacy) + "\n", encoding="utf-8")

            result = MODULE.transform_interactions(input_path, output_root)

            self.assertEqual(result["valid_records"], 1)
            self.assertEqual(result["skipped_lines"], 0)
            note_files = sorted(output_root.glob("*.md"))
            self.assertEqual(len(note_files), 1)
            self.assertIn("2026-07-30T08:15:00Z", note_files[0].read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
