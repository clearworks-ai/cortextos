#!/usr/bin/env python3
"""SCAFFOLD: push Clearpath Postgres contacts into the canonical CRM store.

WS9 crm-canonical: the crm agent owns entity identity (``crm_entity_id``);
``clearpath_id`` is only an external-link field set here from the REAL
Clearpath primary key. It is never a join key on its own — synthetic values
exist in the wild (Stoss Landscape carries clearpath_id=30 which does not
exist in Clearpath), so matching validates against email and slug too.

This is code-only scaffolding:
  - --dry-run is the DEFAULT (prints would-create/would-update counts)
  - --execute is an explicit gate
  - psycopg2 is imported lazily, only when a live connection is needed
  - tests inject a fake connection via ``run_push(conn=...)``

NEVER run this against production without staging validation first.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any

CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = CRM_DIR / "contacts.json"

JsonObject = dict[str, Any]


def _load_upsert_module():
    spec = importlib.util.spec_from_file_location(
        "crm_upsert_contact", CRM_DIR / "upsert-contact.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_upsert = _load_upsert_module()
upsert_contact = _upsert.upsert_contact
load_contacts = _upsert.load_contacts
slugify = _upsert.slugify


def connect_clearpath():
    """Lazy live connection. Requires DATABASE_PUBLIC_URL (railway.internal
    URLs fail from outside Railway — use the public proxy URL)."""
    dsn = os.environ.get("DATABASE_PUBLIC_URL")
    if not dsn:
        raise RuntimeError("DATABASE_PUBLIC_URL is not set; refusing to guess a DSN")
    import psycopg2  # lazy: scaffold must import without the dependency

    return psycopg2.connect(dsn)


def fetch_clearpath_rows(conn) -> list[JsonObject]:
    """Read contacts (and their engagement org context) from Clearpath.

    Read-only. The injected ``conn`` only needs cursor()/execute()/fetchall().
    """
    query = (
        "SELECT c.id, c.name, c.email, c.company, c.role "
        "FROM contacts c ORDER BY c.id"
    )
    cursor = conn.cursor()
    cursor.execute(query)
    rows = cursor.fetchall()
    return [
        {
            "clearpath_id": row[0],
            "name": row[1],
            "email": row[2],
            "company": row[3],
            "role": row[4],
        }
        for row in rows
    ]


def match_existing(row: JsonObject, contacts: list[JsonObject]) -> JsonObject | None:
    """Match order: clearpath_id, then email, then slug — never create dupes."""
    cp_id = row.get("clearpath_id")
    if cp_id is not None:
        for contact in contacts:
            if contact.get("clearpath_id") == cp_id:
                return contact
    email = (row.get("email") or "").strip().lower()
    if email:
        for contact in contacts:
            if email in [e.lower() for e in contact.get("emails") or []]:
                return contact
    name = (row.get("name") or "").strip()
    if name:
        slug = slugify(name)
        for contact in contacts:
            if contact.get("id") == slug:
                return contact
    return None


def run_push(
    conn,
    contacts_path: Path = CONTACTS_PATH,
    *,
    dry_run: bool = True,
) -> JsonObject:
    """Map Clearpath rows onto upsert_contact() calls.

    dry_run (default) only counts; --execute performs the upserts, always
    setting clearpath_id from the real Clearpath PK.
    """
    rows = fetch_clearpath_rows(conn)
    contacts = load_contacts(contacts_path).get("contacts", [])

    would_create: list[str] = []
    would_update: list[str] = []

    for row in rows:
        existing = match_existing(row, contacts)
        data = {
            "name": row.get("name") or "",
            "emails": [row["email"]] if row.get("email") else [],
            "company": row.get("company"),
            "role": row.get("role"),
            "clearpath_id": row.get("clearpath_id"),
            "source_refs": [f"clearpath:{row.get('clearpath_id')}"],
        }
        if existing is not None:
            data["contact_id"] = existing.get("id")
            would_update.append(existing.get("id") or slugify(data["name"]))
        else:
            would_create.append(slugify(data["name"]))
        if not dry_run:
            upsert_contact(data, contacts_path)
            # Refresh the in-memory list from disk so two Clearpath rows that
            # resolve to the same not-yet-persisted contact (slug-only match,
            # no clearpath_id/email hit) dedup against the freshly created
            # entry instead of creating duplicates — same index-refresh
            # pattern as _ingest_common.ingest_people().
            contacts = load_contacts(contacts_path).get("contacts", [])

    return {
        "dry_run": dry_run,
        "would_create": len(would_create),
        "would_update": len(would_update),
        "create_ids": would_create,
        "update_ids": would_update,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Push Clearpath contacts into the canonical CRM (dry-run default)"
    )
    parser.add_argument("--contacts-path", default=str(CONTACTS_PATH))
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually perform upserts. Without this flag it is a dry run.",
    )
    args = parser.parse_args(argv)

    conn = connect_clearpath()
    try:
        summary = run_push(
            conn, Path(args.contacts_path), dry_run=not args.execute
        )
    finally:
        conn.close()
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
