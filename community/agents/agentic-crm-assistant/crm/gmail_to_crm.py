#!/usr/bin/env python3
"""SCAFFOLD: Gmail senders → new CRM people (WS9).

Passive source: inbound Gmail messages carry senders. Genuinely new senders
become contacts (via upsert_contact, minting a canonical crm_entity_id);
known people are skipped. One 'email' interaction line is appended per
created contact, in the exact add-interaction.py shape.

Fixture-driven and --dry-run by default. fetch_live() is a stub — this
scaffold never touches the Gmail API.
"""

from __future__ import annotations

import argparse
import json
from email.utils import parseaddr
from pathlib import Path
from typing import Any

import _ingest_common as common

JsonObject = dict[str, Any]


def fetch_live() -> Any:
    """Stub for the live Gmail fetch.

    TODO(WS9): fetch messages via gws-dwd (`gws-dwd gmail +triage` for ids,
    `+read --id` for bodies) or the Gmail API, and return the same payload
    shape the --input fixtures use. Apply the standing comms filters
    (exclude sanebox.com, notify.railway.app, vendor pitch spam).
    """
    raise NotImplementedError("fetch_live is a scaffold stub; use --input <fixture.json>")


def extract_people(payload: Any) -> list[JsonObject]:
    """Pull senders out of a Gmail payload ({'messages': [...]} or a list)."""
    if isinstance(payload, dict):
        messages = payload.get("messages") or []
    elif isinstance(payload, list):
        messages = payload
    else:
        messages = []
    people: list[JsonObject] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        sender = message.get("from") or message.get("sender") or ""
        name, email = parseaddr(sender)
        if not name and not email:
            continue
        subject = message.get("subject") or "(no subject)"
        ref = message.get("id")
        people.append(
            {
                "name": name or "",
                "email": email or "",
                "summary": f"Emailed: '{subject}'",
                "source_ref": f"gmail:{ref}" if ref else "gmail",
            }
        )
    return people


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ingest new people from a Gmail payload (dry-run default)"
    )
    parser.add_argument("--input", required=True, help="JSON fixture of messages")
    parser.add_argument("--contacts-path", default=str(common.CONTACTS_PATH))
    parser.add_argument("--interactions-path", default=str(common.INTERACTIONS_PATH))
    parser.add_argument("--execute", action="store_true", help="Write; default is dry-run")
    args = parser.parse_args(argv)

    payload = common.load_fixture(args.input)
    summary = common.ingest_people(
        extract_people(payload),
        contacts_path=Path(args.contacts_path),
        interactions_path=Path(args.interactions_path),
        interaction_type="email",
        source_label="gmail",
        dry_run=not args.execute,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
