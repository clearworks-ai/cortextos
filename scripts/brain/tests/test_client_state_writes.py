"""FR-006/FR-008 (C6/C8): CRM writes, owner_name-based task dedup/planning,
WriterError/TaskEnumerationError on any failed subprocess. G-CRM-1/G-DEDUP-1/
G-TASK-1."""
from __future__ import annotations

import difflib
import sys
from dataclasses import dataclass
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from helpers_client_state import FakeRunner

import client_state_writes as csw

CRM_DIR = Path("/fake/crm")


@dataclass
class _Msg:
    id: str


def test_ensure_contact_known_email_no_upsert_call():
    contacts = [{"id": "c1", "name": "Jane Doe", "emails": ["jane@example.com"]}]
    runner = FakeRunner()
    contact_id = csw.ensure_contact(runner, CRM_DIR, "Jane Doe", "Jane@Example.com", contacts)
    assert contact_id == "c1"
    assert runner.calls == []


def test_ensure_contact_unknown_email_argv_pinned():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "upsert-contact.py")), rc=0, stdout="c2\n")
    contact_id = csw.ensure_contact(runner, CRM_DIR, "Marcos Ruiz", "marcos@acme.com", [])
    assert contact_id == "c2"
    assert runner.calls == [[
        "python3", str(CRM_DIR / "upsert-contact.py"),
        "--name", "Marcos Ruiz", "--email", "marcos@acme.com", "--match-email", "--source-ref", "gmail:auto",
    ]]


def test_ensure_contact_raises_writer_error_on_nonzero_rc():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "upsert-contact.py")), rc=1, stdout="", stderr="boom")
    try:
        csw.ensure_contact(runner, CRM_DIR, "Marcos", "marcos@acme.com", [])
        assert False, "expected WriterError"
    except csw.WriterError as exc:
        assert "boom" in str(exc)


def test_ensure_contact_fallback_reloads_contacts_json(tmp_path):
    crm_dir = tmp_path
    (crm_dir / "contacts.json").write_text(
        '{"contacts": [{"id": "c-suppressed", "name": "Blocked", "emails": ["blocked@acme.com"]}]}',
        encoding="utf-8",
    )
    runner = FakeRunner()
    runner.record(("python3", str(crm_dir / "upsert-contact.py")), rc=0, stdout="", stderr="SUPPRESSED: not written")
    contact_id = csw.ensure_contact(runner, crm_dir, "Blocked", "blocked@acme.com", [])
    assert contact_id == "c-suppressed"


def test_write_interaction_argv_pinned():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0,
                   stdout='{"contact_id": "c1", "type": "email"}')
    msg = _Msg(id="abc123")
    extraction = {"summary": "Discussed Q3 renewal",
                  "decisions": [{"text": "Go with tier 2"}, {"text": "Send updated MSA"}]}
    csw.write_interaction(runner, CRM_DIR, "c1", msg, extraction)
    assert runner.calls == [[
        "python3", str(CRM_DIR / "add-interaction.py"),
        "--contact-id", "c1", "--type", "email", "--summary", "Discussed Q3 renewal",
        "--source-ref", "gmail:abc123", "--decision", "Go with tier 2", "--decision", "Send updated MSA",
    ]]


def test_write_interaction_raises_writer_error_on_nonzero_rc():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=1, stdout="", stderr="disk full")
    msg = _Msg(id="m9")
    try:
        csw.write_interaction(runner, CRM_DIR, "c1", msg, {"summary": "x", "decisions": []})
        assert False, "expected WriterError"
    except csw.WriterError as exc:
        assert "disk full" in str(exc)


def test_write_interaction_raises_writer_error_on_unparsable_stdout():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0, stdout="not json")
    msg = _Msg(id="m9")
    try:
        csw.write_interaction(runner, CRM_DIR, "c1", msg, {"summary": "x", "decisions": []})
        assert False, "expected WriterError"
    except csw.WriterError:
        pass
