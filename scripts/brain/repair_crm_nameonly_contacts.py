#!/usr/bin/env python3
"""repair_crm_nameonly_contacts.py

Removes name-only, email-less contacts that a brain R2 live-apply run
mistakenly upserted into a CRM agent's contacts.json for a single meeting,
plus the interaction rows it appended for those contacts in
interactions.jsonl.

Background: on 2026-09-06T06:01:19Z, live-applying meeting
fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA upserted two email-less contacts
(`ivette-ramos`, `joseph-chang`) that duplicate real contacts already
present under different ids/names, and appended one interaction row per
contact for that meeting. This script reverses exactly that damage and
nothing else.

Guardrails — a named contact is removed ONLY if ALL of the following hold:
  - its id/slug is in --contacts
  - its `emails` list is exactly [] (empty)
  - its `source_refs` list is exactly [f"fireflies:{meeting_id}"] — i.e. the
    contact has no other provenance referencing it

If any named contact fails this guard (not found, has emails, or has other
source_refs), the script REFUSES entirely: exit code 2, no files touched.

Interaction rows are removed ONLY if BOTH hold:
  - row["contact_id"] is in --contacts
  - the row references the given meeting id (source_ref names it)

Default mode is DRY-RUN: prints exactly what would change, writes nothing.
Pass --apply to perform the change. On --apply, both files are backed up
next to their originals as `<name>.bak-<UTC-ISO-stamp>` before being
rewritten atomically (temp file + os.replace, matching brain/atomic.py).

The script is idempotent: once the two contacts and their interaction rows
are gone, a second run finds nothing left to remove and exits 0 as a no-op
(dry-run or --apply).

Usage:
    python3 repair_crm_nameonly_contacts.py \\
        --crm-dir /path/to/crm/crm \\
        --meeting-id 01M1MW2GAZ1DQ0C6PG3KJ557JA \\
        --contacts ivette-ramos,joseph-chang
        [--apply]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atomic import atomic_write  # noqa: E402


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def load_contacts(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("contacts"), list):
        raise ValueError(f"unexpected contacts.json shape at {path}: expected {{'contacts': [...]}}")
    return data


def load_interactions(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return rows


def dump_interactions_bytes(rows: list[dict[str, Any]]) -> bytes:
    lines = [json.dumps(r, ensure_ascii=False) for r in rows]
    text = "\n".join(lines)
    if lines:
        text += "\n"
    return text.encode("utf-8")


def check_guard(contact: dict[str, Any], meeting_id: str) -> tuple[bool, str]:
    emails = contact.get("emails")
    if emails != []:
        return False, f"emails not empty: {emails!r}"
    expected_refs = [f"fireflies:{meeting_id}"]
    source_refs = contact.get("source_refs")
    if source_refs != expected_refs:
        return False, f"source_refs != {expected_refs!r} (got {source_refs!r})"
    return True, ""


def row_references_meeting(row: dict[str, Any], meeting_id: str) -> bool:
    needle = f"fireflies:{meeting_id}"
    source_ref = row.get("source_ref")
    if source_ref == needle:
        return True
    if isinstance(source_ref, str) and meeting_id in source_ref:
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Remove name-only, email-less contacts (and their interaction rows) "
        "mistakenly upserted for one meeting. Dry-run by default.",
    )
    ap.add_argument("--crm-dir", required=True, help="Directory containing contacts.json and interactions.jsonl")
    ap.add_argument("--meeting-id", required=True, help="Fireflies meeting id, e.g. 01M1MW2GAZ1DQ0C6PG3KJ557JA")
    ap.add_argument(
        "--contacts",
        required=True,
        help="Comma-separated contact ids/slugs to remove, e.g. ivette-ramos,joseph-chang",
    )
    ap.add_argument("--apply", action="store_true", help="Write changes. Default is dry-run (no writes).")
    args = ap.parse_args()

    crm_dir = Path(args.crm_dir)
    contacts_path = crm_dir / "contacts.json"
    interactions_path = crm_dir / "interactions.jsonl"
    meeting_id = args.meeting_id
    target_ids = [s.strip() for s in args.contacts.split(",") if s.strip()]

    if not target_ids:
        print("ERROR: --contacts produced an empty list", file=sys.stderr)
        return 2
    if not contacts_path.is_file():
        print(f"ERROR: not found: {contacts_path}", file=sys.stderr)
        return 2
    if not interactions_path.is_file():
        print(f"ERROR: not found: {interactions_path}", file=sys.stderr)
        return 2

    contacts_data = load_contacts(contacts_path)
    contacts = contacts_data["contacts"]
    interactions = load_interactions(interactions_path)

    before_contact_count = len(contacts)
    before_interaction_count = len(interactions)

    found_contacts: dict[str, dict[str, Any]] = {}
    for c in contacts:
        cid = c.get("id")
        if cid in target_ids:
            found_contacts[cid] = c

    # --- Guard: every named contact must pass, or refuse entirely ---
    failures: list[str] = []
    already_absent: list[str] = []
    for cid in target_ids:
        if cid not in found_contacts:
            already_absent.append(cid)
            continue
        ok, reason = check_guard(found_contacts[cid], meeting_id)
        if not ok:
            failures.append(f"{cid}: guard failed ({reason})")

    if failures:
        print("REFUSING: guard check failed for one or more named contacts:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        print("No files were modified.", file=sys.stderr)
        return 2

    # --- Compute removals (contacts already absent = idempotent no-op for them) ---
    removed_contacts = [found_contacts[cid] for cid in target_ids if cid in found_contacts]
    kept_contacts = [c for c in contacts if c.get("id") not in target_ids]

    removed_rows = []
    kept_rows = []
    for row in interactions:
        if row.get("contact_id") in target_ids and row_references_meeting(row, meeting_id):
            removed_rows.append(row)
        else:
            kept_rows.append(row)

    after_contact_count = len(kept_contacts)
    after_interaction_count = len(kept_rows)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"=== repair_crm_nameonly_contacts.py [{mode}] ===")
    print(f"crm-dir:     {crm_dir}")
    print(f"meeting-id:  {meeting_id}")
    print(f"targets:     {target_ids}")
    if already_absent:
        print(f"already absent from contacts.json (idempotent no-op): {already_absent}")
    print()
    print(f"contacts.json:      {before_contact_count} -> {after_contact_count} (removing {len(removed_contacts)})")
    print(
        f"interactions.jsonl: {before_interaction_count} -> {after_interaction_count} "
        f"(removing {len(removed_rows)})"
    )
    print()
    print("Removed contacts:")
    print(json.dumps(removed_contacts, indent=2, ensure_ascii=False))
    print()
    print("Removed interaction rows:")
    print(json.dumps(removed_rows, indent=2, ensure_ascii=False))

    if not removed_contacts and not removed_rows:
        print()
        print("Nothing to remove — already clean (idempotent). No files modified.")
        return 0

    if not args.apply:
        print()
        print("Dry-run only; no files modified. Re-run with --apply to write changes.")
        return 0

    # --- Backups (written before any mutation) ---
    stamp = utc_stamp()
    contacts_backup = contacts_path.with_name(contacts_path.name + f".bak-{stamp}")
    interactions_backup = interactions_path.with_name(interactions_path.name + f".bak-{stamp}")

    atomic_write(contacts_backup, contacts_path.read_bytes())
    atomic_write(interactions_backup, interactions_path.read_bytes())

    # --- Write updated files atomically ---
    new_contacts_data = dict(contacts_data)
    new_contacts_data["contacts"] = kept_contacts
    contacts_bytes = (json.dumps(new_contacts_data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    atomic_write(contacts_path, contacts_bytes)

    interactions_bytes = dump_interactions_bytes(kept_rows)
    atomic_write(interactions_path, interactions_bytes)

    print()
    print(f"Backups written: {contacts_backup.name}, {interactions_backup.name}")
    print("Apply complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
