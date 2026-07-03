#!/usr/bin/env python3
"""Create or update a contact in crm/contacts.json.

WS9 (crm-canonical): the crm agent is the ONE place for entity identity.

- ``crm_entity_id`` is the CANONICAL entity id: a uuid4 string generated once
  at contact creation and NEVER regenerated on update. Legacy contacts that
  lack one are backfilled on their next upsert and keep that id stable
  forever after.
- ``clearpath_id`` is an OPTIONAL, NULLABLE external-link field. It is an
  external reference, NOT identity — the Stoss Landscape record carries a
  SYNTHETIC clearpath_id=30 that does not exist in Clearpath, so the field
  can never be required or used as a join key without validation. Updating a
  contact without providing it never clears an existing value.
- The slugified ``id`` remains the file's list key for full backward
  compatibility; existing contacts.json entries load unchanged.
"""

from __future__ import annotations

import argparse
import json
import re
import uuid
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = CRM_DIR / "contacts.json"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "contact"


def load_contacts(contacts_path: Path = CONTACTS_PATH) -> dict:
    if not contacts_path.exists():
        return {"version": "1.0.0", "contacts": []}
    return json.loads(contacts_path.read_text())


def merge_unique(existing: list, additions: list) -> list:
    seen = set()
    merged = []
    for item in [*existing, *additions]:
        if item and item not in seen:
            seen.add(item)
            merged.append(item)
    return merged


def _new_contact_skeleton(contact_id: str, name: str) -> dict:
    return {
        "id": contact_id,
        # Canonical entity id: minted exactly once, at creation.
        "crm_entity_id": str(uuid.uuid4()),
        # External reference only (nullable). See module docstring: a
        # synthetic value (Stoss Landscape clearpath_id=30) exists in the
        # wild, so this must stay optional and unvalidated-by-default.
        "clearpath_id": None,
        "type": "person",
        "name": name,
        "category": "other",
        "priority": "normal",
        "relationship_strength": None,
        "tags": [],
        "aliases": [],
        "emails": [],
        "phones": [],
        "handles": {},
        "company": None,
        "role": None,
        "location": None,
        "context": "",
        "preferences": {},
        "important_dates": [],
        "last_meaningful_contact": None,
        "followup_cadence_days": None,
        "notes": "",
        "source_refs": [],
    }


def upsert_contact(data: dict, contacts_path: Path = CONTACTS_PATH) -> str:
    """Create or update a contact; returns the slug ``id`` (the list key).

    ``data`` keys mirror the CLI flags: contact_id, name, type, category,
    priority, emails, phones, tags, aliases, company, role, location,
    context, notes, source_refs, clearpath_id.
    """
    payload = load_contacts(contacts_path)
    contacts = payload.setdefault("contacts", [])

    name = data.get("name") or ""
    contact_id = data.get("contact_id") or data.get("id") or slugify(name)

    contact = next((item for item in contacts if item.get("id") == contact_id), None)
    if contact is None:
        if not name:
            raise ValueError("name is required to create a new contact")
        contact = _new_contact_skeleton(contact_id, name)
        contacts.append(contact)

    # Backfill the canonical entity id for legacy contacts that predate it.
    # NEVER regenerate an existing crm_entity_id — it is stable for life.
    if not contact.get("crm_entity_id"):
        contact["crm_entity_id"] = str(uuid.uuid4())

    if name:
        contact["name"] = name
    for field in ("type", "category", "priority", "company", "role", "location"):
        value = data.get(field)
        if value is not None:
            contact[field] = value
    if data.get("context"):
        contact["context"] = data["context"]
    if data.get("notes"):
        contact["notes"] = data["notes"]

    # clearpath_id: only set when explicitly provided. Updating a contact
    # without it must NOT clear an existing value (it stays nullable).
    if data.get("clearpath_id") is not None:
        contact["clearpath_id"] = data["clearpath_id"]
    elif "clearpath_id" not in contact:
        contact["clearpath_id"] = None

    contact["emails"] = merge_unique(contact.get("emails", []), list(data.get("emails") or []))
    contact["phones"] = merge_unique(contact.get("phones", []), list(data.get("phones") or []))
    contact["tags"] = merge_unique(contact.get("tags", []), list(data.get("tags") or []))
    contact["aliases"] = merge_unique(contact.get("aliases", []), list(data.get("aliases") or []))
    contact["source_refs"] = merge_unique(
        contact.get("source_refs", []), list(data.get("source_refs") or [])
    )

    contacts_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return contact_id


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create or update a CRM contact")
    parser.add_argument("--id", dest="contact_id")
    parser.add_argument("--name", required=True)
    parser.add_argument("--type", default="person", choices=["person", "company"])
    parser.add_argument("--category", default="other")
    parser.add_argument("--priority", default="normal")
    parser.add_argument("--email", action="append", default=[])
    parser.add_argument("--phone", action="append", default=[])
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--alias", action="append", default=[])
    parser.add_argument("--company")
    parser.add_argument("--role")
    parser.add_argument("--location")
    parser.add_argument("--context", default="")
    parser.add_argument("--notes", default="")
    parser.add_argument("--source-ref", action="append", default=[])
    parser.add_argument(
        "--clearpath-id",
        default=None,
        help="Optional external Clearpath reference (nullable; never cleared when omitted)",
    )
    parser.add_argument("--contacts-path", default=str(CONTACTS_PATH))
    args = parser.parse_args(argv)

    clearpath_id: int | str | None = args.clearpath_id
    if isinstance(clearpath_id, str) and clearpath_id.isdigit():
        clearpath_id = int(clearpath_id)

    data = {
        "contact_id": args.contact_id,
        "name": args.name,
        "type": args.type,
        "category": args.category,
        "priority": args.priority,
        "emails": args.email,
        "phones": args.phone,
        "tags": args.tag,
        "aliases": args.alias,
        "company": args.company,
        "role": args.role,
        "location": args.location,
        "context": args.context,
        "notes": args.notes,
        "source_refs": args.source_ref,
        "clearpath_id": clearpath_id,
    }

    contact_id = upsert_contact(data, Path(args.contacts_path))
    print(contact_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
