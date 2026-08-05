"""Tests for the ingest-meeting-decisions.py connector (crm-decision-persistence).

Monkeypatches the connector's `_run` seam so the produced add-interaction / upsert-engagement
commands are asserted WITHOUT executing them — never touches live interactions.jsonl or
pipeline.json. Contact/pipeline lookups use temp fixtures via CRM_CONTACTS_PATH / CRM_PIPELINE_PATH.
"""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent


def _load_connector():
    spec = importlib.util.spec_from_file_location(
        "ingest_meeting_decisions", CRM_DIR / "ingest-meeting-decisions.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.mod = _load_connector()
        self.calls: list[list[str]] = []
        # Capture every produced command instead of executing it.
        self.mod._run = lambda argv, env=None: self.calls.append(argv) or subprocess.CompletedProcess(argv, 0, "{}", "")

    def _fixtures(self, tmp, contacts=None, engagements=None):
        (Path(tmp) / "contacts.json").write_text(json.dumps({"contacts": contacts or []}))
        (Path(tmp) / "pipeline.json").write_text(json.dumps({"engagements": engagements or []}))
        os.environ["CRM_CONTACTS_PATH"] = str(Path(tmp) / "contacts.json")
        os.environ["CRM_PIPELINE_PATH"] = str(Path(tmp) / "pipeline.json")

    def tearDown(self):
        os.environ.pop("CRM_CONTACTS_PATH", None)
        os.environ.pop("CRM_PIPELINE_PATH", None)

    def _add_calls(self):
        return [c for c in self.calls if "add-interaction.py" in c[1]]

    def _upsert_calls(self):
        return [c for c in self.calls if "upsert-engagement.py" in c[1]]

    def test_writes_decisions_no_stage_when_dealstate_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fixtures(tmp, contacts=[{"id": "mark-lurie", "emails": ["mark@msia.org"]}])
            payload = {"meetings": [{
                "meeting_id": "M1", "contact_id": "mark-lurie",
                "decisions": ["Do X", "Do Y"], "deal_state": None,
            }]}
            self.mod.process_payload(payload)
            adds = self._add_calls()
            self.assertEqual(len(adds), 1)
            self.assertIn("--decision", adds[0])
            self.assertEqual(adds[0].count("--decision"), 2)
            self.assertEqual(self._upsert_calls(), [])  # no stage change

    def test_maps_dealstate_to_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fixtures(
                tmp,
                contacts=[{"id": "jane", "emails": ["jane@x.com"]}],
                engagements=[{"clearpath_id": 42, "primary_contact_id": "jane", "contact_ids": ["jane"]}],
            )
            payload = {"meetings": [{
                "meeting_id": "M2", "contact_id": "jane",
                "decisions": ["Agreed terms"], "deal_state": "They gave a verbal yes, contract signed",
            }]}
            self.mod.process_payload(payload)
            ups = self._upsert_calls()
            self.assertEqual(len(ups), 1)
            self.assertIn("--stage", ups[0])
            self.assertEqual(ups[0][ups[0].index("--stage") + 1], "won")
            self.assertIn("42", ups[0])

    def test_freetext_dealstate_no_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fixtures(
                tmp,
                contacts=[{"id": "mark-lurie", "emails": ["mark@msia.org"]}],
                engagements=[{"clearpath_id": 19, "primary_contact_id": "mark-lurie", "contact_ids": ["mark-lurie"]}],
            )
            payload = {"meetings": [{
                "meeting_id": "M3", "contact_id": "mark-lurie",
                "decisions": ["Proceed with automation"],
                "deal_state": "Moving from audit into implementation phase",  # unmapped
            }]}
            summary = self.mod.process_payload(payload)
            self.assertEqual(self._upsert_calls(), [])            # NO stage flip on free text
            add = self._add_calls()[0]
            self.assertIn("--deal-state", add)                    # preserved as text on the row
            self.assertEqual(summary["actions"][0]["mapped_stage"], None)

    def test_skips_on_unresolved_contact(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fixtures(tmp, contacts=[{"id": "someone", "emails": ["someone@else.com"]}])
            payload = {"meetings": [{
                "meeting_id": "M4",
                "attendees": [{"email": "stranger@nowhere.com"}],  # not in contacts.json
                "decisions": ["Do X"], "deal_state": None,
            }]}
            summary = self.mod.process_payload(payload)
            self.assertEqual(self._add_calls(), [])               # no writes
            self.assertEqual(self._upsert_calls(), [])
            self.assertEqual(summary["actions"][0]["skipped"], "unresolved_contact")

    def test_stage_map_targets_are_known_stages(self):
        # Every mapped stage must be a real KNOWN_STAGES value (guard against a typo mapping
        # to a stage upsert-engagement.py would reject).
        known = {"lead", "qualified", "proposal_sent", "negotiation", "won",
                 "active_client", "dormant", "closed_won", "closed_lost", "lost"}
        for _keywords, stage in self.mod.DEAL_STATE_STAGE_MAP:
            self.assertIn(stage, known, f"mapped stage {stage} not in KNOWN_STAGES")


if __name__ == "__main__":
    unittest.main()
