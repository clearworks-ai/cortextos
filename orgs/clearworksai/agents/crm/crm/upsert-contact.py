#!/usr/bin/env python3
"""Create or update a contact in crm/contacts.json."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = Path(os.environ.get("CRM_CONTACTS_PATH", CRM_DIR / "contacts.json"))
SUPPRESSION_PATH = Path(os.environ.get("CRM_SUPPRESSION_PATH", CRM_DIR / "_ingest_suppression.json"))


def _norm(value: str) -> str:
    """Lowercase + strip accents for diacritic-insensitive matching."""
    nfkd = unicodedata.normalize("NFKD", value or "")
    return "".join(c for c in nfkd if not unicodedata.combining(c)).strip().lower()


def normalize_email(value: str) -> str:
    return (value or "").strip().lower()


def load_suppression() -> dict:
    if not SUPPRESSION_PATH.exists():
        return {}
    try:
        return json.loads(SUPPRESSION_PATH.read_text())
    except (ValueError, OSError):
        return {}


def check_suppressed(contact_id: str, name: str, emails: list) -> str | None:
    """Return a reason string if this contact is on the permanent ingest block list."""
    sup = load_suppression()
    if not sup:
        return None
    if contact_id and contact_id in set(sup.get("contact_ids", [])):
        return f"contact_id:{contact_id}"
    nname = _norm(name)
    if nname and nname in {_norm(n) for n in sup.get("names", [])}:
        return f"name:{name}"
    block_domains = {d.lower().lstrip("@") for d in sup.get("domains", [])}
    for email in emails or []:
        dom = (email or "").split("@")[-1].strip().lower()
        if dom and dom in block_domains:
            return f"domain:{dom}"
    return None


JUNK_NAME_PATTERNS = [
    (r"^admin\b", "admin-prefix"),
    (r"^(no[\s-]?reply|do[\s-]?not[\s-]?reply)\b", "noreply-prefix"),
    (r"^(mailer-daemon|postmaster)$", "bounceback"),
    (r"^(notifications?|notification)\b", "notifications-prefix"),
    (r"\bdigest$", "digest-suffix"),
    (r"\breminder$", "reminder-suffix"),
    (r"^@", "email-as-name"),
]


def detect_junk_name(name: str) -> tuple[bool, str | None]:
    n = (name or "").strip().lower()
    if not n:
        return True, "empty"
    for pat, reason in JUNK_NAME_PATTERNS:
        if re.search(pat, n):
            return True, reason
    return False, None


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "contact"


def load_contacts() -> dict:
    if not CONTACTS_PATH.exists():
        return {"version": "1.0.0", "contacts": []}
    return json.loads(CONTACTS_PATH.read_text())


def contact_emails(contact: dict) -> list[str]:
    values: list[str] = []
    primary = contact.get("email")
    if isinstance(primary, str):
        values.append(primary)
    stored = contact.get("emails")
    if isinstance(stored, list):
        for item in stored:
            if isinstance(item, str):
                values.append(item)
    return values


def find_contact_by_email(contacts: list[dict], emails: list[str]) -> dict | None:
    wanted = {normalize_email(email) for email in emails if normalize_email(email)}
    if not wanted:
        return None

    for contact in contacts:
        existing = {normalize_email(email) for email in contact_emails(contact) if normalize_email(email)}
        if existing & wanted:
            return contact
    return None


def merge_unique(existing: list, additions: list) -> list:
    seen = set()
    merged = []
    for item in [*existing, *additions]:
        if item and item not in seen:
            seen.add(item)
            merged.append(item)
    return merged


def main() -> int:
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
    parser.add_argument("--industry")
    parser.add_argument("--location")
    parser.add_argument("--context", default="")
    parser.add_argument("--notes", default="")
    parser.add_argument("--source-ref", action="append", default=[])
    parser.add_argument("--match-email", action="store_true")
    args = parser.parse_args()

    junk, reason = detect_junk_name(args.name)
    if junk:
        args.category = "other"
        args.priority = "low"
        args.tag = list(args.tag or []) + [
            "auto-flagged:junk-name",
            f"junk-name-reason:{reason}",
        ]

    data = load_contacts()
    contacts = data.setdefault("contacts", [])
    matched_contact = None
    if args.match_email and not args.contact_id:
        matched_contact = find_contact_by_email(contacts, args.email)
    contact_id = args.contact_id or matched_contact.get("id") if matched_contact else args.contact_id or slugify(args.name)

    blocked = check_suppressed(contact_id, args.name, args.email)
    if blocked:
        print(
            f"SUPPRESSED ({blocked}): contact blocked from ingest per "
            f"crm/_ingest_suppression.json — not written.",
            file=sys.stderr,
        )
        return 0

    contact = matched_contact or next((item for item in contacts if item.get("id") == contact_id), None)
    is_new_contact = contact is None
    if contact is None:
        contact = {
            "id": contact_id,
            "type": args.type,
            "name": args.name,
            "category": args.category,
            "priority": args.priority,
            "relationship_strength": None,
            "tags": [],
            "aliases": [],
            "emails": [],
            "phones": [],
            "handles": {},
            "company": None,
            "industry": None,
            "role": None,
            "location": None,
            "context": "",
            "preferences": {},
            "important_dates": [],
            "last_meaningful_contact": None,
            "followup_cadence_days": None,
            "notes": "",
            "source_refs": [],
            "email_status": None,
            "enrichment": None,
        }
        contacts.append(contact)

    contact.update(
        {
            "type": args.type,
            "name": args.name,
            "category": args.category,
            "priority": args.priority,
            "company": args.company if args.company is not None else contact.get("company"),
            "industry": args.industry if args.industry is not None else contact.get("industry"),
            "role": args.role if args.role is not None else contact.get("role"),
            "location": args.location if args.location is not None else contact.get("location"),
        }
    )
    if args.context:
        contact["context"] = args.context
    if args.notes:
        contact["notes"] = args.notes

    contact["emails"] = merge_unique(contact.get("emails", []), args.email)
    contact["phones"] = merge_unique(contact.get("phones", []), args.phone)
    contact["tags"] = merge_unique(contact.get("tags", []), args.tag)
    contact["aliases"] = merge_unique(contact.get("aliases", []), args.alias)
    contact["source_refs"] = merge_unique(contact.get("source_refs", []), args.source_ref)

    CONTACTS_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(contact_id)

    if is_new_contact and args.type == "person" and not junk:
        emit_contact_created_event(contact_id, args.name, args.email)

    return 0


def emit_contact_created_event(contact_id: str, name: str, emails: list) -> None:
    """DESIGN-B-crm.md E3: single choke point for new-contact creation. Best-effort,
    never blocks the write that already landed above."""
    payload = json.dumps({"contact_id": contact_id, "name": name, "emails": emails})
    _emit_crm_event("crm.contact.created", payload)


def _emit_crm_event(event_type: str, payload: str) -> None:
    """Self-inbox ``EVENT <type> — <json>`` (fast-checker wakes the crm session). Best-effort.
    Test seam: when CRM_EVENT_EMIT_LOG is set, append the line to that file instead of the bus."""
    line = f"EVENT {event_type} — {payload}"
    log_path = os.environ.get("CRM_EVENT_EMIT_LOG")
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        return
    try:
        subprocess.run(
            ["cortextos", "bus", "send-message", "crm", "normal", line],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


if __name__ == "__main__":
    raise SystemExit(main())
