"""Tests for the DESIGN-B-crm.md records-administrator event lane.

Every "event trigger" is a structured ``EVENT crm.* — <json>`` bus message self-sent by the
script that performs the write (webhook-bridge / pa-forward carry the externally-sourced ones).
These tests assert the emit fires by pointing CRM_EVENT_EMIT_LOG at a temp file instead of the
live bus, so no daemon is needed.

Coverage:
  E1 crm.deal.created      -> reconcile-intake.emit_deal_created_event
  E2 crm.deal.stage_changed-> sync-board.emit_stage_changed_event
  E3 crm.contact.created   -> upsert-contact.py end-to-end (the single choke point) + create-only guard
  E7 crm.email.captured    -> comms-backfill.emit_crm_event
Plus: the weekly records-admin-sweep backstop cron exists in config.json, and AGENTS.md maps
every emitted event type to a runbook action (E4/E5/E6/E8 land via runbook, not a python emit).
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
AGENT_DIR = CRM_DIR.parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, CRM_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_events(log_path: Path) -> list[str]:
    if not log_path.exists():
        return []
    return [ln for ln in log_path.read_text(encoding="utf-8").splitlines() if ln.strip()]


class EmitSeamTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "events.log"
        os.environ["CRM_EVENT_EMIT_LOG"] = str(self.log)

    def tearDown(self) -> None:
        os.environ.pop("CRM_EVENT_EMIT_LOG", None)
        self.tmp.cleanup()

    def test_e1_deal_created_emit(self) -> None:
        rc = _load("reconcile_intake", "reconcile-intake.py")
        rc.emit_deal_created_event({"clearpath_id": 42, "name": "Acme Build", "company": "Acme"})
        events = _read_events(self.log)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].startswith("EVENT crm.deal.created — "))
        payload = json.loads(events[0].split(" — ", 1)[1])
        self.assertEqual(payload["clearpath_id"], 42)

    def test_e2_stage_changed_emit(self) -> None:
        sb = _load("sync_board", "sync-board.py")
        sb.emit_stage_changed_event({"clearpath_id": 7, "from": "qualified", "to": "won"})
        events = _read_events(self.log)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].startswith("EVENT crm.deal.stage_changed — "))
        payload = json.loads(events[0].split(" — ", 1)[1])
        self.assertEqual(payload["to"], "won")

    def test_e7_email_captured_emit(self) -> None:
        cb = _load("comms_backfill", "comms-backfill.py")
        cb.emit_crm_event("crm.email.captured", json.dumps({"contact_id": "jane-doe", "type": "email"}))
        events = _read_events(self.log)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].startswith("EVENT crm.email.captured — "))

    def test_shared_helper_seam(self) -> None:
        common = _load("crm_connect_common", "crm_connect_common.py")
        common.emit_crm_event("crm.deal.created", json.dumps({"x": 1}))
        self.assertEqual(len(_read_events(self.log)), 1)


class ContactCreatedEndToEndTests(unittest.TestCase):
    """E3 through the real choke point: upsert-contact.py, which every ingest path funnels through."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.contacts = self.root / "contacts.json"
        self.contacts.write_text('{"contacts": []}\n', encoding="utf-8")
        (self.root / "_ingest_suppression.json").write_text("{}", encoding="utf-8")
        self.log = self.root / "events.log"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run_upsert(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["CRM_CONTACTS_PATH"] = str(self.contacts)
        env["CRM_SUPPRESSION_PATH"] = str(self.root / "_ingest_suppression.json")
        env["CRM_EVENT_EMIT_LOG"] = str(self.log)
        return subprocess.run(
            ["python3", str(CRM_DIR / "upsert-contact.py"), *args],
            capture_output=True, text=True, env=env, cwd=str(CRM_DIR),
        )

    def test_e3_emitted_on_new_person_contact(self) -> None:
        result = self._run_upsert("--name", "Jane Doe", "--type", "person", "--email", "jane@acme.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        events = _read_events(self.log)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].startswith("EVENT crm.contact.created — "))
        payload = json.loads(events[0].split(" — ", 1)[1])
        self.assertEqual(payload["contact_id"], "jane-doe")

    def test_e3_not_re_emitted_on_update(self) -> None:
        """Create fires once; a subsequent update of the same contact must NOT re-emit (create-only)."""
        self._run_upsert("--name", "Jane Doe", "--type", "person", "--email", "jane@acme.com")
        self._run_upsert("--match-email", "--name", "Jane Doe", "--email", "jane@acme.com", "--role", "VP")
        events = _read_events(self.log)
        self.assertEqual(len(events), 1, "update path must not emit a second crm.contact.created")

    def test_e3_not_emitted_for_company_type(self) -> None:
        result = self._run_upsert("--name", "Acme Inc", "--type", "company")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(_read_events(self.log), [], "company-type upsert must not emit contact.created")


class SweepAndRunbookWiringTests(unittest.TestCase):
    """The weekly backstop cron and the runbook that consumes the events must actually be wired."""

    def test_records_admin_sweep_cron_present(self) -> None:
        config_path = AGENT_DIR / "config.json"
        if not config_path.exists():
            self.skipTest("config.json not present in this checkout (gitignored agent runtime data)")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        names = {c.get("name") for c in config.get("crons", [])}
        self.assertIn("records-admin-sweep", names)
        sweep = next(c for c in config["crons"] if c.get("name") == "records-admin-sweep")
        # Weekly, Sunday 20:00 — the drift catcher, not a daily.
        self.assertEqual(sweep.get("cron"), "0 20 * * 0")

    def test_runbook_maps_every_emitted_event(self) -> None:
        agents_path = AGENT_DIR / "AGENTS.md"
        if not agents_path.exists():
            self.skipTest("AGENTS.md not present in this checkout (gitignored agent runtime data)")
        text = agents_path.read_text(encoding="utf-8")
        self.assertIn("Records-Admin Event Runbook", text)
        for event_type in (
            "crm.contact.created", "crm.deal.created", "crm.deal.stage_changed",
            "crm.meeting.completed", "crm.email.captured", "crm.doc.received",
        ):
            self.assertIn(event_type, text, f"runbook is missing an action row for {event_type}")


if __name__ == "__main__":
    unittest.main()
