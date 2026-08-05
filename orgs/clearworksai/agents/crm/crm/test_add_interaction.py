"""Tests for add-interaction.py decisions/deal_state persistence (crm-decision-persistence).

Uses CRM_INTERACTIONS_PATH pointed at a tempdir — never the live interactions.jsonl.
"""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent
ADD = CRM_DIR / "add-interaction.py"


def run_add(root: Path, *args: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["CRM_INTERACTIONS_PATH"] = str(root / "interactions.jsonl")
    return subprocess.run(
        ["python3", str(ADD), *args], capture_output=True, text=True, env=env
    )


def read_rows(root: Path) -> list[dict]:
    p = root / "interactions.jsonl"
    if not p.exists():
        return []
    return [json.loads(ln) for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]


class AddInteractionDecisionTests(unittest.TestCase):
    def test_decisions_field_populated_on_new_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r = run_add(
                root, "--contact-id", "mark-lurie", "--type", "meeting",
                "--source-ref", "fireflies:M1", "--sentiment", "positive",
                "--decision", "Do X", "--decision", "Do Y",
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            rows = read_rows(root)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["decisions"], ["Do X", "Do Y"])

    def test_decisions_default_empty_when_omitted(self):
        # Back-compat: a caller that never passes --decision (and no --summary) still works.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r = run_add(root, "--contact-id", "c1", "--type", "email", "--source-ref", "email:1")
            self.assertEqual(r.returncode, 0, r.stderr)
            rows = read_rows(root)
            self.assertEqual(rows[0]["decisions"], [])

    def test_decisions_update_not_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = ["--contact-id", "mark-lurie", "--type", "meeting", "--source-ref", "fireflies:M1"]
            run_add(root, *base, "--decision", "Do X")
            # Same key + same decisions -> no-op, still one row.
            r2 = run_add(root, *base, "--decision", "Do X")
            self.assertIn("duplicate", r2.stdout)
            self.assertEqual(len(read_rows(root)), 1)
            # Same key + NEW decisions -> update in place, still one row.
            r3 = run_add(root, *base, "--decision", "Do X", "--decision", "Do Z")
            self.assertIn("updated", r3.stdout)
            rows = read_rows(root)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["decisions"], ["Do X", "Do Z"])

    def test_atomic_update_preserves_other_fields_and_other_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # An unrelated row must survive the rewrite untouched (incl. a malformed line).
            p = root / "interactions.jsonl"
            p.write_text(
                json.dumps({"contact_id": "other", "type": "call", "source_ref": "x:1", "summary": "keep me"}) + "\n"
                + "{ this is malformed json }\n",
                encoding="utf-8",
            )
            run_add(root, "--contact-id", "mark-lurie", "--type", "meeting",
                    "--source-ref", "fireflies:M1", "--summary", "Cathcup", "--sentiment", "positive",
                    "--decision", "Do X")
            # update decisions on that new row
            run_add(root, "--contact-id", "mark-lurie", "--type", "meeting",
                    "--source-ref", "fireflies:M1", "--decision", "Do X", "--decision", "Do Y")
            text = p.read_text(encoding="utf-8")
            self.assertIn("keep me", text)              # unrelated row preserved
            self.assertIn("this is malformed json", text)  # malformed line preserved verbatim
            rows = [json.loads(ln) for ln in text.splitlines() if ln.strip() and ln.strip().startswith("{") and "malformed" not in ln]
            mark = [r for r in rows if r.get("contact_id") == "mark-lurie"][0]
            self.assertEqual(mark["decisions"], ["Do X", "Do Y"])
            self.assertEqual(mark["summary"], "Cathcup")     # summary untouched by the update
            self.assertEqual(mark["sentiment"], "positive")  # sentiment untouched


if __name__ == "__main__":
    unittest.main()
