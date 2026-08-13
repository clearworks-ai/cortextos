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


class CommsSecretRedactionTests(unittest.TestCase):
    def test_redacts_labeled_credentials_and_bearer_tokens(self) -> None:
        module = _load("comms_backfill_redaction", "comms-backfill.py")
        source = (
            "API key / Client ID: abcDEF123456789 "
            "Authorization: Bearer token.value-123456789"
        )
        self.assertEqual(
            module.redact_secrets(source),
            "API key / Client ID: [REDACTED] Authorization: Bearer [REDACTED]",
        )

    def test_does_not_redact_benign_support_language(self) -> None:
        module = _load("comms_backfill_benign", "comms-backfill.py")
        source = "We need help with an API key limit issue."
        self.assertEqual(module.redact_secrets(source), source)

    def test_existing_interaction_scrub_is_atomic_and_idempotent(self) -> None:
        module = _load("comms_backfill_existing", "comms-backfill.py")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "interactions.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "contact_id": "person",
                        "summary": "Password: secret-value",
                        "source_ref": "gmail:1",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(module.redact_existing_interactions(path), 1)
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8"))["summary"],
                "Password: [REDACTED]",
            )
            self.assertEqual(module.redact_existing_interactions(path), 0)


class CommsContactBoundaryTests(unittest.TestCase):
    def test_github_reply_relay_is_not_a_contact(self) -> None:
        module = _load("comms_backfill_relay", "comms-backfill.py")
        self.assertTrue(
            module.is_skip_email(
                "reply+opaque-token@reply.github.com"
            )
        )

    def test_upsert_returns_canonical_writer_id(self) -> None:
        module = _load("comms_backfill_upsert_id", "comms-backfill.py")
        original_run = module.subprocess.run
        try:
            module.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(
                args=args, returncode=0, stdout="canonical-id\n", stderr=""
            )
            self.assertEqual(
                module.upsert("Name / With Slash", "name@example.com"),
                "canonical-id",
            )
        finally:
            module.subprocess.run = original_run


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


# --- FR-CRM1: the three Altari CRM skills run as SKILLS under the crm agent ---
# These assertions run on TRACKED artifacts (org skills + the CRM1-WIRING apply doc),
# so they do not skip when the gitignored agent runtime files are absent.

REPO_ROOT = AGENT_DIR.parents[3]  # orgs/clearworksai/agents/crm -> repo root
ORG_SKILLS = REPO_ROOT / "orgs" / "clearworksai" / "skills"
WIRING_DOC = ORG_SKILLS / "CRM1-WIRING.md"
CRM1_SKILLS = (
    "data-enrichment-specialist",
    "records-administrator",
    "pipeline-operations-manager",
)


class CRM1ClusterWiringTests(unittest.TestCase):
    """FR-CRM1: enrichment + records + pipeline-ops run as versioned org SKILLS under the crm
    agent on crm events/schedule (the SKILL path, not the legacy cron), emitting via the A6 sink."""

    def test_three_skills_are_versioned_org_skills(self) -> None:
        for name in CRM1_SKILLS:
            skill = ORG_SKILLS / name / "SKILL.md"
            self.assertTrue(skill.exists(), f"{name} not present as a tracked org skill")

    def test_each_skill_declares_crm_wiring_and_a6_sink(self) -> None:
        for name in CRM1_SKILLS:
            text = (ORG_SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("cortextOS CRM wiring", text, f"{name} missing CRM wiring section")
            self.assertIn("Trigger surface", text, f"{name} missing a trigger surface")
            self.assertIn("A6 sink", text, f"{name} missing the A6 sink section")
            self.assertIn("create-task", text, f"{name} A6 sink must use bus create-task")
            self.assertIn("--assignee human", text, f"{name} A6 sink must file a HUMAN task")
            # idempotency: a deterministic crm-* key so re-runs never duplicate
            self.assertIn("crm-", text, f"{name} A6 sink missing an idempotency key")

    def test_pipeline_ops_is_bound_to_stage_changed(self) -> None:
        """The previously-unwired skill: pipeline-operations-manager fires on crm.deal.stage_changed."""
        text = (ORG_SKILLS / "pipeline-operations-manager" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("crm.deal.stage_changed", text)
        # It replaces the legacy inline weekly-brief cron with the named skill on a schedule.
        self.assertIn("pipeline-ops", text)

    def test_wiring_doc_maps_pipeline_ops_and_a6(self) -> None:
        self.assertTrue(WIRING_DOC.exists(), "CRM1-WIRING.md apply doc missing")
        text = WIRING_DOC.read_text(encoding="utf-8")
        self.assertIn("pipeline-operations-manager", text)
        self.assertIn("crm.deal.stage_changed", text)
        # every emitted event type is mapped to a skill in the apply doc's runbook
        for event_type in (
            "crm.contact.created", "crm.deal.created", "crm.deal.stage_changed",
            "crm.meeting.completed", "crm.email.captured", "crm.doc.received",
        ):
            self.assertIn(event_type, text, f"wiring doc missing runbook row for {event_type}")
        # the A6 human-task sink remains for genuinely ambiguous decisions,
        # while deterministic history-preserving hygiene must not be approval-gated.
        self.assertIn("create-task", text)
        self.assertIn("--assignee human", text)
        self.assertIn("exact-authoritative-identifier dedupe", text)
        self.assertIn("maintenance, not `data-deletion`", text)
        self.assertIn("permanently destructive", text)

    def test_records_admin_autonomy_boundary(self) -> None:
        text = (ORG_SKILLS / "records-administrator" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("exact-authoritative-identifier duplicate", text)
        self.assertIn("machine-generated orphan", text)
        self.assertIn("no task or approval sink needed", text)
        self.assertIn("fuzzy matches and permanent history loss require a human", text)


if __name__ == "__main__":
    unittest.main()
