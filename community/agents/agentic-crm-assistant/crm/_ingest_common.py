#!/usr/bin/env python3
"""Shared helpers for the WS9 ingestion scaffolds (fireflies/omi/gmail → CRM).

The crm agent is the ONE place for entity identity (WS9 crm-canonical).
Passive sources (Fireflies attendees, Omi people, Gmail senders) create
people here by calling ``upsert_contact()`` directly — never by shelling
out — and append interaction lines in the exact JSONL shape that
``add-interaction.py`` writes.

Everything is fixture-driven and dry-run-by-default; nothing in this module
touches the network.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = CRM_DIR / "contacts.json"
INTERACTIONS_PATH = CRM_DIR / "interactions.jsonl"

JsonObject = dict[str, Any]


def _load_module(filename: str, module_name: str):
    """Import a hyphenated sibling script (e.g. upsert-contact.py)."""
    path = CRM_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_upsert_module = _load_module("upsert-contact.py", "crm_upsert_contact")

# Canonical mutation entrypoint: importable, no subprocess.
upsert_contact = _upsert_module.upsert_contact
slugify = _upsert_module.slugify
load_contacts = _upsert_module.load_contacts


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def contact_index(contacts_path: Path) -> dict[str, dict[str, JsonObject]]:
    """Index existing contacts by lowercase email, alias, and slug id."""
    payload = load_contacts(contacts_path)
    by_email: dict[str, JsonObject] = {}
    by_alias: dict[str, JsonObject] = {}
    by_id: dict[str, JsonObject] = {}
    for contact in payload.get("contacts", []):
        if not isinstance(contact, dict):
            continue
        cid = contact.get("id")
        if isinstance(cid, str) and cid:
            by_id[cid] = contact
        for email in contact.get("emails") or []:
            if isinstance(email, str) and email:
                by_email[email.strip().lower()] = contact
        for alias in contact.get("aliases") or []:
            if isinstance(alias, str) and alias:
                by_alias[alias.strip().lower()] = contact
        name = contact.get("name")
        if isinstance(name, str) and name:
            by_alias.setdefault(name.strip().lower(), contact)
    return {"email": by_email, "alias": by_alias, "id": by_id}


def find_existing(person: JsonObject, index: dict[str, dict[str, JsonObject]]) -> JsonObject | None:
    """Dedup a source person against contacts.json by email, then alias/name."""
    email = (person.get("email") or "").strip().lower()
    if email and email in index["email"]:
        return index["email"][email]
    name = (person.get("name") or "").strip()
    if name:
        lowered = name.lower()
        if lowered in index["alias"]:
            return index["alias"][lowered]
        slug = slugify(name)
        if slug in index["id"]:
            return index["id"][slug]
    return None


def interaction_record(
    contact_id: str,
    interaction_type: str,
    summary: str,
    source_ref: str | None = None,
    sentiment: str = "unknown",
    ts: str | None = None,
) -> JsonObject:
    """Exact record shape add-interaction.py writes (same keys, same order)."""
    return {
        "ts": ts or now_iso(),
        "contact_id": contact_id,
        "type": interaction_type,
        "summary": summary,
        "sentiment": sentiment,
        "commitments": [],
        "followups_created": [],
        "source_ref": source_ref,
    }


def append_interaction(record: JsonObject, interactions_path: Path = INTERACTIONS_PATH) -> None:
    """Same JSONL append convention as add-interaction.py."""
    with interactions_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def ingest_people(
    people: list[JsonObject],
    *,
    contacts_path: Path,
    interactions_path: Path,
    interaction_type: str,
    source_label: str,
    dry_run: bool = True,
    ts: str | None = None,
) -> JsonObject:
    """Create genuinely-new people and log one interaction each.

    Existing contacts (matched by email, then alias/name, then slug) are
    skipped — passive sources create people, they never mutate identity.
    Returns a summary dict; with ``dry_run`` (the default) nothing is written.
    """
    index = contact_index(contacts_path)
    created: list[str] = []
    skipped: list[str] = []

    for person in people:
        name = (person.get("name") or "").strip()
        email = (person.get("email") or "").strip()
        if not name and not email:
            continue
        existing = find_existing(person, index)
        if existing is not None:
            skipped.append(existing.get("id") or name or email)
            continue

        display = name or email.split("@")[0]
        if dry_run:
            created.append(slugify(display))
            continue

        contact_id = upsert_contact(
            {
                "name": display,
                "emails": [email] if email else [],
                "source_refs": [source_label],
            },
            contacts_path,
        )
        append_interaction(
            interaction_record(
                contact_id,
                interaction_type,
                person.get("summary") or f"Ingested from {source_label}",
                source_ref=person.get("source_ref") or source_label,
                ts=ts,
            ),
            interactions_path,
        )
        created.append(contact_id)
        # Refresh index so duplicate people inside one payload dedup too.
        index = contact_index(contacts_path)

    return {
        "source": source_label,
        "dry_run": dry_run,
        "would_create" if dry_run else "created": created,
        "skipped_existing": skipped,
    }


def load_fixture(input_path: str | Path) -> Any:
    """Parse a source payload from a JSON fixture file (--input)."""
    return json.loads(Path(input_path).read_text(encoding="utf-8"))
