"""Tests for repair_crm_nameonly_contacts.py.

R-1 (FINAL-fable-round2.json, Important): the producers
(add-interaction.py, upsert-contact.py) never pass ensure_ascii=False, so
re-serialising every retained row/record with different JSON options
rewrites hundreds of unrelated bytes on the real production files. These
tests prove the fix with byte-preserving fixtures: one variant matching the
real producers' ASCII-escaped convention, one deliberately using raw UTF-8
(ensure_ascii=False), each carrying a non-ASCII name ("José") on a RETAINED
record. After --apply, every retained line/record must be byte-identical to
its original on-disk text; only the two targeted contacts + their two
interaction rows may differ.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import repair_crm_nameonly_contacts as repair  # noqa: E402

MEETING_ID = "01M1MW2GAZ1DQ0C6PG3KJ557JA"


def _contact(cid, *, name=None, emails=None, source_refs=None, extra=None):
    c = {
        "id": cid,
        "name": name or cid,
        "emails": emails if emails is not None else [],
        "source_refs": source_refs if source_refs is not None else [f"fireflies:{MEETING_ID}"],
        "category": "prospect",
        "company": "Acme",
    }
    if extra:
        c.update(extra)
    return c


def _write_contacts_json(path: Path, contacts: list[dict], *, ensure_ascii: bool) -> str:
    data = {"contacts": contacts, "source": "fireflies", "version": "1.0.0"}
    text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=ensure_ascii) + "\n"
    path.write_text(text, encoding="utf-8")
    return text


def _interaction_row(contact_id, *, summary="hi", source_ref=None):
    return {
        "commitments": [],
        "contact_id": contact_id,
        "followups_created": [],
        "sentiment": "neutral",
        "source_ref": source_ref or f"fireflies:{MEETING_ID}",
        "summary": summary,
    }


def _write_interactions_jsonl(path: Path, rows: list[dict], *, ensure_ascii: bool) -> str:
    lines = [json.dumps(r, ensure_ascii=ensure_ascii) for r in rows]
    text = "\n".join(lines) + "\n"
    path.write_text(text, encoding="utf-8")
    return text


def _base_scenario(tmp_path, *, ensure_ascii: bool):
    """Kept contact/row carries a non-ASCII name; two target contacts +
    their interaction rows are the only expected removal."""
    jose_name = "José Núñez"
    contacts = [
        _contact("jose-nunez", name=jose_name, emails=["jose@acme.com"], source_refs=["fireflies:OTHER"]),
        _contact("ivette-ramos"),
        _contact("joseph-chang"),
        _contact("existing-real", emails=["real@acme.com"], source_refs=["fireflies:OTHER"]),
    ]
    rows = [
        _interaction_row("jose-nunez", summary=f"Met with {jose_name}"),
        _interaction_row("ivette-ramos"),
        _interaction_row("joseph-chang"),
        _interaction_row("existing-real", summary="unrelated"),
    ]
    crm_dir = tmp_path / "crm"
    crm_dir.mkdir()
    contacts_text = _write_contacts_json(crm_dir / "contacts.json", contacts, ensure_ascii=ensure_ascii)
    interactions_text = _write_interactions_jsonl(crm_dir / "interactions.jsonl", rows, ensure_ascii=ensure_ascii)
    return crm_dir, contacts_text, interactions_text


def _argv(crm_dir, *, apply=False):
    argv = [
        "--crm-dir", str(crm_dir),
        "--meeting-id", MEETING_ID,
        "--contacts", "ivette-ramos,joseph-chang",
    ]
    if apply:
        argv.append("--apply")
    return argv


# --- R-1: byte-preservation, ensure_ascii=True (matches real producers) ----

def test_apply_byte_preserves_retained_content_ascii_escaped(tmp_path, capsys):
    crm_dir, contacts_text, interactions_text = _base_scenario(tmp_path, ensure_ascii=True)
    # Sanity: the fixture really is ASCII-escaped on disk (matches producers).
    assert "\\u00e9" in contacts_text or "\\u00fa" in contacts_text
    assert all(ord(ch) < 128 for ch in (crm_dir / "contacts.json").read_text(encoding="utf-8"))

    rc = repair.main(_argv(crm_dir, apply=True))
    assert rc == 0

    new_contacts = json.loads((crm_dir / "contacts.json").read_text(encoding="utf-8"))
    ids = {c["id"] for c in new_contacts["contacts"]}
    assert ids == {"jose-nunez", "existing-real"}

    # The retained contacts' JSON text must be byte-identical to their
    # original on-disk spans (self-check the script itself performs).
    orig = json.loads(contacts_text)
    orig_by_id = {c["id"]: c for c in orig["contacts"]}
    for c in new_contacts["contacts"]:
        assert c == orig_by_id[c["id"]]

    new_lines = (crm_dir / "interactions.jsonl").read_text(encoding="utf-8").splitlines(keepends=True)
    orig_lines = interactions_text.splitlines(keepends=True)
    kept_orig_lines = [
        ln for ln in orig_lines
        if json.loads(ln)["contact_id"] not in ("ivette-ramos", "joseph-chang")
    ]
    assert new_lines == kept_orig_lines  # byte-identical, not just JSON-equal


def test_apply_byte_preserves_retained_content_raw_unicode(tmp_path):
    # Same scenario, but the fixture is written with ensure_ascii=False
    # (raw UTF-8 "é"/"ú" bytes on disk) — the script must detect this and
    # reproduce it, not force everything to ASCII-escaped or vice versa.
    crm_dir, contacts_text, interactions_text = _base_scenario(tmp_path, ensure_ascii=False)
    raw_bytes = (crm_dir / "contacts.json").read_bytes()
    assert any(b >= 0x80 for b in raw_bytes)  # sanity: really has raw UTF-8 bytes

    rc = repair.main(_argv(crm_dir, apply=True))
    assert rc == 0

    new_contacts_bytes = (crm_dir / "contacts.json").read_bytes()
    # The retained records' exact bytes (including raw UTF-8 "é") must
    # reappear verbatim, not re-escaped to é.
    assert "José Núñez".encode("utf-8") in new_contacts_bytes

    new_lines = (crm_dir / "interactions.jsonl").read_text(encoding="utf-8").splitlines(keepends=True)
    orig_lines = interactions_text.splitlines(keepends=True)
    kept_orig_lines = [
        ln for ln in orig_lines
        if json.loads(ln)["contact_id"] not in ("ivette-ramos", "joseph-chang")
    ]
    assert new_lines == kept_orig_lines


def test_removed_count_is_exactly_two_and_two(tmp_path):
    crm_dir, contacts_text, interactions_text = _base_scenario(tmp_path, ensure_ascii=True)
    before_contacts = len(json.loads(contacts_text)["contacts"])
    before_rows = len(interactions_text.splitlines())

    rc = repair.main(_argv(crm_dir, apply=True))
    assert rc == 0

    after_contacts = json.loads((crm_dir / "contacts.json").read_text(encoding="utf-8"))["contacts"]
    after_rows = (crm_dir / "interactions.jsonl").read_text(encoding="utf-8").splitlines()
    assert before_contacts - len(after_contacts) == 2
    assert before_rows - len(after_rows) == 2


# --- Guard / dry-run / idempotency (pre-existing contract) -----------------

def test_dry_run_writes_nothing(tmp_path):
    crm_dir, contacts_text, interactions_text = _base_scenario(tmp_path, ensure_ascii=True)
    rc = repair.main(_argv(crm_dir, apply=False))
    assert rc == 0
    assert (crm_dir / "contacts.json").read_text(encoding="utf-8") == contacts_text
    assert (crm_dir / "interactions.jsonl").read_text(encoding="utf-8") == interactions_text
    assert list(crm_dir.glob("*.bak-*")) == []


def test_guard_refuses_when_target_has_email(tmp_path):
    contacts = [_contact("ivette-ramos", emails=["ivette@real.com"]), _contact("joseph-chang")]
    rows = [_interaction_row("ivette-ramos"), _interaction_row("joseph-chang")]
    crm_dir = tmp_path / "crm"
    crm_dir.mkdir()
    contacts_text = _write_contacts_json(crm_dir / "contacts.json", contacts, ensure_ascii=True)
    interactions_text = _write_interactions_jsonl(crm_dir / "interactions.jsonl", rows, ensure_ascii=True)

    rc = repair.main(_argv(crm_dir, apply=True))
    assert rc == 2
    # Refuses entirely — no files touched, not even the compliant contact.
    assert (crm_dir / "contacts.json").read_text(encoding="utf-8") == contacts_text
    assert (crm_dir / "interactions.jsonl").read_text(encoding="utf-8") == interactions_text


def test_idempotent_second_run_is_noop(tmp_path):
    crm_dir, _, _ = _base_scenario(tmp_path, ensure_ascii=True)
    rc1 = repair.main(_argv(crm_dir, apply=True))
    assert rc1 == 0
    after_first_contacts = (crm_dir / "contacts.json").read_bytes()
    after_first_interactions = (crm_dir / "interactions.jsonl").read_bytes()

    rc2 = repair.main(_argv(crm_dir, apply=True))
    assert rc2 == 0
    assert (crm_dir / "contacts.json").read_bytes() == after_first_contacts
    assert (crm_dir / "interactions.jsonl").read_bytes() == after_first_interactions


def test_apply_writes_backups(tmp_path):
    crm_dir, contacts_text, interactions_text = _base_scenario(tmp_path, ensure_ascii=True)
    rc = repair.main(_argv(crm_dir, apply=True))
    assert rc == 0
    contacts_backups = list(crm_dir.glob("contacts.json.bak-*"))
    interactions_backups = list(crm_dir.glob("interactions.jsonl.bak-*"))
    assert len(contacts_backups) == 1
    assert len(interactions_backups) == 1
    assert contacts_backups[0].read_text(encoding="utf-8") == contacts_text
    assert interactions_backups[0].read_text(encoding="utf-8") == interactions_text


# --- Format-detection helpers ------------------------------------------------

def test_detect_ensure_ascii_true_when_no_nonascii_bytes():
    assert repair.detect_ensure_ascii('{"a": "caf\\u00e9"}'.encode("utf-8")) is True


def test_detect_ensure_ascii_false_when_raw_utf8_bytes_present():
    assert repair.detect_ensure_ascii("café".encode("utf-8")) is False


def test_detect_indent_two():
    assert repair.detect_indent('{\n  "contacts": [\n  ]\n}\n') == 2


def test_detect_indent_none_for_compact():
    assert repair.detect_indent('{"contacts": []}') is None
