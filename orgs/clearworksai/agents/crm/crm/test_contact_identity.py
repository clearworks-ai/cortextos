from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from contact_identity import resolve_contact_id, validate_alias_targets


NORMALIZE_PATH = Path(__file__).with_name("normalize-contact-aliases.py")
SPEC = importlib.util.spec_from_file_location("normalize_contact_aliases", NORMALIZE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load normalize-contact-aliases.py")
NORMALIZE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NORMALIZE)


class ContactIdentityTests(unittest.TestCase):
    def test_known_alias_resolves_and_unknown_alias_is_preserved(self) -> None:
        aliases = {"abbey": "abbey-calasia", "calasia": "abbey-calasia"}
        self.assertEqual(resolve_contact_id("abbey", aliases), "abbey-calasia")
        self.assertEqual(resolve_contact_id("calasia", aliases), "abbey-calasia")
        self.assertEqual(resolve_contact_id("john-murawski", aliases), "john-murawski")
        self.assertEqual(resolve_contact_id("unknown-person", aliases), "unknown-person")

    def test_unknown_canonical_target_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown canonical contact"):
            validate_alias_targets({"abbey": "missing-contact"}, {"abbey-calasia"})

    def test_reconcile_existing_interactions_is_idempotent_and_dedupes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aliases_path = root / "aliases.json"
            aliases_path.write_text(json.dumps({"abbey": "abbey-calasia", "calasia": "abbey-calasia"}))
            interactions_path = root / "interactions.jsonl"
            rows = [
                {"source_ref": "fireflies:one", "contact_id": "abbey", "summary": "first"},
                {"source_ref": "fireflies:one", "contact_id": "abbey-calasia", "summary": "duplicate"},
                {"source_ref": "fireflies:two", "contact_id": "calasia", "summary": "second"},
                {"source_ref": "fireflies:three", "contact_id": "unknown-person", "summary": "unknown"},
            ]
            interactions_path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")

            first = NORMALIZE.reconcile(interactions_path, aliases_path)
            snapshot = interactions_path.read_text()
            second = NORMALIZE.reconcile(interactions_path, aliases_path)

            self.assertEqual(first, {"changed": 2, "deduped": 1, "rows": 3})
            self.assertEqual(second, {"changed": 0, "deduped": 0, "rows": 3})
            self.assertEqual(interactions_path.read_text(), snapshot)
            normalized = [json.loads(line) for line in snapshot.splitlines()]
            self.assertEqual([row["contact_id"] for row in normalized], ["abbey-calasia", "abbey-calasia", "unknown-person"])


if __name__ == "__main__":
    unittest.main()
