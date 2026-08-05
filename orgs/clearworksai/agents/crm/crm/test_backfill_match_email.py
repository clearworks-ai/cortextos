from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
UPSERT_SCRIPT = HERE / "upsert-contact.py"
CALENDAR_BACKFILL = HERE / "calendar-backfill.py"
COMMS_BACKFILL = HERE / "comms-backfill.py"


class BackfillArgContractTests(unittest.TestCase):
    """Static source assertions encoding the bug's invariant: neither backfill script
    passes an explicit --id to upsert-contact.py (which would short-circuit the tested
    find_contact_by_email lookup); both pass --match-email so id resolution is delegated
    to upsert-contact.py (reuse-by-email, slugify-fallback for new contacts)."""

    def test_calendar_backfill_passes_match_email_not_id(self) -> None:
        src = CALENDAR_BACKFILL.read_text(encoding="utf-8")
        self.assertIn('"--match-email"', src)
        # calendar-backfill.py has exactly one upsert-contact.py call and no other --id use.
        self.assertNotIn('"--id"', src)

    def test_comms_backfill_passes_match_email_not_id(self) -> None:
        src = COMMS_BACKFILL.read_text(encoding="utf-8")
        self.assertIn('"--match-email"', src)
        self.assertNotIn('"--id"', src)


class BackfillBehavioralTests(unittest.TestCase):
    """End-to-end through upsert-contact.py, exercising the exact call shape the corrected
    backfills now make (--match-email, no --id)."""

    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def read_json(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def run_upsert(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env["CRM_CONTACTS_PATH"] = str(root / "contacts.json")
        env["CRM_SUPPRESSION_PATH"] = str(root / "_ingest_suppression.json")
        return subprocess.run(
            ["python3", str(UPSERT_SCRIPT), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(HERE),
        )

    def test_rerun_does_not_duplicate_existing_email(self) -> None:
        """A backfill re-run whose display name would slugify to a DIFFERENT id must
        resolve the existing contact by email — no new 'mark' / 'mark-msia-org' record."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_json(
                root / "contacts.json",
                {
                    "contacts": [
                        {
                            "id": "mark-lurie",
                            "name": "Mark Lurie",
                            "emails": ["mark@msia.org"],
                            "tags": [],
                            "source_refs": [],
                        }
                    ]
                },
            )
            self.write_json(root / "_ingest_suppression.json", {})

            result = self.run_upsert(
                root, "--match-email", "--name", "Mark", "--type", "person",
                "--email", "mark@msia.org",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "mark-lurie")

            contacts = self.read_json(root / "contacts.json")["contacts"]
            self.assertEqual(len(contacts), 1, "must not mint a duplicate")
            ids = {c["id"] for c in contacts}
            self.assertEqual(ids, {"mark-lurie"})
            self.assertNotIn("mark", ids)

    def test_new_contact_fallback_slugify_preserved(self) -> None:
        """No email match => new contact created with slugify(name) — fallback unchanged."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_json(root / "contacts.json", {"contacts": []})
            self.write_json(root / "_ingest_suppression.json", {})

            result = self.run_upsert(
                root, "--match-email", "--name", "Jane New", "--type", "person",
                "--email", "jane@newco.com",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "jane-new")

            contacts = self.read_json(root / "contacts.json")["contacts"]
            self.assertEqual(len(contacts), 1)
            self.assertEqual(contacts[0]["id"], "jane-new")


if __name__ == "__main__":
    unittest.main()
