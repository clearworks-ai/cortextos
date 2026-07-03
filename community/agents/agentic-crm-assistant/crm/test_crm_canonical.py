#!/usr/bin/env python3
"""Behavioral tests for WS9 crm-canonical: canonical entity id + ingestion.

Run from community/agents/agentic-crm-assistant/crm:

    python3 test_crm_canonical.py

Exits 0 on all-pass, 1 on any failure. Zero external dependencies; every
scenario runs against tempdir fixtures — the checked-in contacts.json and
interactions.jsonl are never touched, and nothing hits the network.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def _load(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


upsert_mod = _load("upsert-contact.py", "upsert_contact_mod")
common = _load("_ingest_common.py", "_ingest_common")
fireflies = _load("fireflies_to_crm.py", "fireflies_to_crm")
omi = _load("omi_to_crm.py", "omi_to_crm")
gmail = _load("gmail_to_crm.py", "gmail_to_crm")
clearpath_push = _load("clearpath_to_crm_push.py", "clearpath_to_crm_push")

FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def _get(contacts_path: Path, contact_id: str) -> dict:
    payload = json.loads(contacts_path.read_text())
    return next(c for c in payload["contacts"] if c["id"] == contact_id)


def test_entity_id_stable_across_upserts():
    print("\n[test 1] crm_entity_id generated once, stable across repeated upserts")
    with tempfile.TemporaryDirectory() as tmp:
        contacts_path = Path(tmp) / "contacts.json"
        cid = upsert_mod.upsert_contact({"name": "Ada Lovelace"}, contacts_path)
        _check("slug id returned", cid == "ada-lovelace", detail=cid)
        first = _get(contacts_path, cid)
        entity_id = first.get("crm_entity_id")
        _check("crm_entity_id is a valid uuid4", uuid.UUID(entity_id).version == 4)

        for i in range(3):
            cid2 = upsert_mod.upsert_contact(
                {"name": "Ada Lovelace", "emails": [f"ada{i}@example.com"]},
                contacts_path,
            )
            _check(f"upsert {i + 1} returns same slug id", cid2 == cid)
        after = _get(contacts_path, cid)
        _check(
            "crm_entity_id NEVER regenerated on update",
            after["crm_entity_id"] == entity_id,
            detail=f"{after['crm_entity_id']} != {entity_id}",
        )
        _check("emails merged across upserts", len(after["emails"]) == 3)
        payload = json.loads(contacts_path.read_text())
        _check("only one contact exists", len(payload["contacts"]) == 1)


def test_clearpath_id_nullable_and_preserved():
    print("\n[test 2] clearpath_id nullable, preserved when omitted, settable")
    with tempfile.TemporaryDirectory() as tmp:
        contacts_path = Path(tmp) / "contacts.json"
        cid = upsert_mod.upsert_contact({"name": "Stoss Landscape"}, contacts_path)
        contact = _get(contacts_path, cid)
        _check("clearpath_id defaults to None (nullable)", contact["clearpath_id"] is None)

        # None round-trips through another update.
        upsert_mod.upsert_contact({"name": "Stoss Landscape", "notes": "hi"}, contacts_path)
        contact = _get(contacts_path, cid)
        _check("clearpath_id=None round-trips", contact["clearpath_id"] is None)

        # Explicitly settable.
        upsert_mod.upsert_contact(
            {"name": "Stoss Landscape", "clearpath_id": 30}, contacts_path
        )
        contact = _get(contacts_path, cid)
        _check("clearpath_id set when explicitly provided", contact["clearpath_id"] == 30)

        # Omitting the flag on a later update must NOT clear it.
        upsert_mod.upsert_contact(
            {"name": "Stoss Landscape", "notes": "later"}, contacts_path
        )
        contact = _get(contacts_path, cid)
        _check(
            "clearpath_id NOT cleared when omitted on update",
            contact["clearpath_id"] == 30,
            detail=repr(contact["clearpath_id"]),
        )


def test_legacy_contact_backfill():
    print("\n[test 3] legacy contact without crm_entity_id gets a stable backfill")
    with tempfile.TemporaryDirectory() as tmp:
        contacts_path = Path(tmp) / "contacts.json"
        legacy = {
            "id": "grace-hopper",
            "name": "Grace Hopper",
            "type": "person",
            "emails": ["grace@navy.mil"],
            "tags": ["legacy"],
        }
        contacts_path.write_text(
            json.dumps({"version": "1.0.0", "contacts": [legacy]}, indent=2, sort_keys=True)
            + "\n"
        )
        cid = upsert_mod.upsert_contact({"name": "Grace Hopper"}, contacts_path)
        _check("slug id unchanged by backfill", cid == "grace-hopper")
        contact = _get(contacts_path, cid)
        backfilled = contact.get("crm_entity_id")
        _check("crm_entity_id backfilled on legacy contact", bool(backfilled))
        _check("legacy fields survive (emails)", contact["emails"] == ["grace@navy.mil"])
        _check("legacy fields survive (tags)", "legacy" in contact["tags"])

        upsert_mod.upsert_contact({"name": "Grace Hopper", "role": "RADM"}, contacts_path)
        contact = _get(contacts_path, cid)
        _check(
            "backfilled id stable thereafter",
            contact["crm_entity_id"] == backfilled,
        )


def test_cli_behavior_preserved():
    print("\n[test 4] CLI prints contact_id and exits 0 (backward compatible)")
    with tempfile.TemporaryDirectory() as tmp:
        contacts_path = Path(tmp) / "contacts.json"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = upsert_mod.main(
                [
                    "--name",
                    "Marcos Santa Ana",
                    "--email",
                    "marcos@alloi.com",
                    "--contacts-path",
                    str(contacts_path),
                ]
            )
        _check("exit code 0", rc == 0)
        _check("prints contact_id", out.getvalue().strip() == "marcos-santa-ana")

        out2 = io.StringIO()
        with contextlib.redirect_stdout(out2):
            rc2 = upsert_mod.main(
                [
                    "--name",
                    "Marcos Santa Ana",
                    "--clearpath-id",
                    "29",
                    "--contacts-path",
                    str(contacts_path),
                ]
            )
        _check("exit code 0 with --clearpath-id", rc2 == 0)
        contact = _get(contacts_path, "marcos-santa-ana")
        _check("--clearpath-id flag lands as int", contact["clearpath_id"] == 29)


def _seed_contacts(tmp: Path) -> Path:
    contacts_path = tmp / "contacts.json"
    upsert_mod.upsert_contact(
        {"name": "Josh Weiss", "emails": ["weissjosh0@gmail.com"]}, contacts_path
    )
    return contacts_path


def test_ingestion_scaffolds_create_only_new():
    print("\n[test 5] ingestion scaffolds create only-new people from fixtures")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        contacts_path = _seed_contacts(tmp_path)
        interactions_path = tmp_path / "interactions.jsonl"

        ff_fixture = tmp_path / "fireflies.json"
        ff_fixture.write_text(
            json.dumps(
                {
                    "id": "tr_1",
                    "title": "Busywork Audit kickoff",
                    "meeting_attendees": [
                        {"displayName": "Josh Weiss", "email": "weissjosh0@gmail.com"},
                        {"displayName": "Elaine Roark", "email": "elaine@stoss.com"},
                    ],
                }
            )
        )

        # Dry-run default: nothing written.
        before = contacts_path.read_bytes()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = fireflies.main(
                [
                    "--input",
                    str(ff_fixture),
                    "--contacts-path",
                    str(contacts_path),
                    "--interactions-path",
                    str(interactions_path),
                ]
            )
        summary = json.loads(out.getvalue())
        _check("fireflies dry-run exits 0", rc == 0)
        _check("fireflies dry-run is default", summary["dry_run"] is True)
        _check("fireflies dry-run would create only Elaine", summary["would_create"] == ["elaine-roark"])
        _check("fireflies dry-run skips existing Josh", "josh-weiss" in summary["skipped_existing"])
        _check("fireflies dry-run writes nothing", contacts_path.read_bytes() == before)
        _check("fireflies dry-run appends no interactions", not interactions_path.exists())

        # Execute against the tempdir.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = fireflies.main(
                [
                    "--input",
                    str(ff_fixture),
                    "--contacts-path",
                    str(contacts_path),
                    "--interactions-path",
                    str(interactions_path),
                    "--execute",
                ]
            )
        summary = json.loads(out.getvalue())
        _check("fireflies execute creates only Elaine", summary["created"] == ["elaine-roark"])
        elaine = _get(contacts_path, "elaine-roark")
        _check("new person got a canonical crm_entity_id", bool(elaine.get("crm_entity_id")))
        _check("new person clearpath_id is None", elaine["clearpath_id"] is None)
        lines = [json.loads(l) for l in interactions_path.read_text().splitlines()]
        _check("one interaction appended", len(lines) == 1)
        record = lines[0]
        _check(
            "interaction matches add-interaction.py schema",
            set(record) == {"ts", "contact_id", "type", "summary", "sentiment", "commitments", "followups_created", "source_ref"},
            detail=str(sorted(record)),
        )
        _check("interaction type is meeting", record["type"] == "meeting")
        _check("interaction contact is Elaine", record["contact_id"] == "elaine-roark")

        # Re-running is idempotent: Elaine now exists, nothing new created.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fireflies.main(
                [
                    "--input",
                    str(ff_fixture),
                    "--contacts-path",
                    str(contacts_path),
                    "--interactions-path",
                    str(interactions_path),
                    "--execute",
                ]
            )
        summary = json.loads(out.getvalue())
        _check("fireflies re-run creates nothing (dedup by email)", summary["created"] == [])


def test_omi_and_gmail_scaffolds():
    print("\n[test 6] omi + gmail scaffolds dedup and never touch the network")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        contacts_path = _seed_contacts(tmp_path)
        interactions_path = tmp_path / "interactions.jsonl"

        omi_fixture = tmp_path / "omi.json"
        omi_fixture.write_text(
            json.dumps({"people": [{"name": "Josh Weiss"}, {"name": "Paul Kaye", "id": "p1"}]})
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = omi.main(
                [
                    "--input",
                    str(omi_fixture),
                    "--contacts-path",
                    str(contacts_path),
                    "--interactions-path",
                    str(interactions_path),
                    "--execute",
                ]
            )
        summary = json.loads(out.getvalue())
        _check("omi exits 0", rc == 0)
        _check("omi creates only Paul (name dedup for Josh)", summary["created"] == ["paul-kaye"])

        gmail_fixture = tmp_path / "gmail.json"
        gmail_fixture.write_text(
            json.dumps(
                {
                    "messages": [
                        {"id": "m1", "from": "Eva Smith <eva@rethinkmedia.org>", "subject": "Contract"},
                        {"id": "m2", "from": "Josh Weiss <weissjosh0@gmail.com>", "subject": "Re: Contract"},
                    ]
                }
            )
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = gmail.main(
                [
                    "--input",
                    str(gmail_fixture),
                    "--contacts-path",
                    str(contacts_path),
                    "--interactions-path",
                    str(interactions_path),
                    "--execute",
                ]
            )
        summary = json.loads(out.getvalue())
        _check("gmail exits 0", rc == 0)
        _check("gmail creates only Eva (email dedup for Josh)", summary["created"] == ["eva-smith"])

        for name, mod in (("fireflies", fireflies), ("omi", omi), ("gmail", gmail)):
            raised = None
            try:
                mod.fetch_live()
            except NotImplementedError as exc:
                raised = exc
            _check(f"{name}.fetch_live is a stub (NotImplementedError)", raised is not None)


def test_clearpath_push_scaffold_dry_run():
    print("\n[test 7] clearpath push scaffold: injected conn, dry-run counts, match order")

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def execute(self, query):
            self.query = query

        def fetchall(self):
            return self._rows

    class FakeConn:
        def __init__(self, rows):
            self._rows = rows

        def cursor(self):
            return FakeCursor(self._rows)

        def close(self):
            pass

    with tempfile.TemporaryDirectory() as tmp:
        contacts_path = Path(tmp) / "contacts.json"
        # Existing contact matched by email (no clearpath_id yet).
        upsert_mod.upsert_contact(
            {"name": "Mark Lurie", "emails": ["mark@msia.org"]}, contacts_path
        )
        rows = [
            (19, "Mark Lurie", "mark@msia.org", "MSIA", "Director"),
            (42, "New Person", "new@example.com", "Acme", None),
        ]
        before = contacts_path.read_bytes()
        summary = clearpath_push.run_push(FakeConn(rows), contacts_path)  # dry_run default
        _check("dry_run is the default", summary["dry_run"] is True)
        _check("would_update matches by email", summary["would_update"] == 1)
        _check("would_create counts new rows", summary["would_create"] == 1)
        _check("dry-run writes nothing", contacts_path.read_bytes() == before)

        summary = clearpath_push.run_push(FakeConn(rows), contacts_path, dry_run=False)
        mark = _get(contacts_path, "mark-lurie")
        _check("execute sets clearpath_id from real PK", mark["clearpath_id"] == 19)
        entity_before = mark["crm_entity_id"]
        clearpath_push.run_push(FakeConn(rows), contacts_path, dry_run=False)
        mark = _get(contacts_path, "mark-lurie")
        _check("entity id stable across clearpath pushes", mark["crm_entity_id"] == entity_before)
        payload = json.loads(contacts_path.read_text())
        _check("no duplicate contacts after re-push", len(payload["contacts"]) == 2)


def test_checked_in_data_untouched():
    print("\n[test 8] checked-in crm data files untouched by importing modules")
    checked_in = (HERE / "contacts.json").read_text()
    _check(
        "contacts.json is still the pristine template",
        json.loads(checked_in) == {"version": "1.0.0", "contacts": []},
    )


if __name__ == "__main__":
    test_entity_id_stable_across_upserts()
    test_clearpath_id_nullable_and_preserved()
    test_legacy_contact_backfill()
    test_cli_behavior_preserved()
    test_ingestion_scaffolds_create_only_new()
    test_omi_and_gmail_scaffolds()
    test_clearpath_push_scaffold_dry_run()
    test_checked_in_data_untouched()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (8 scenarios)")
    sys.exit(0)
