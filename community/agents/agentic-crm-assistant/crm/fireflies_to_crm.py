#!/usr/bin/env python3
"""SCAFFOLD: Fireflies meeting attendees → new CRM people (WS9).

Passive source: Fireflies transcripts carry meeting attendees. Genuinely
new attendees become contacts (via upsert_contact, minting a canonical
crm_entity_id); known people are skipped. One 'meeting' interaction line is
appended per created contact, in the exact add-interaction.py shape.

Fixture-driven and --dry-run by default. fetch_live() is a stub — this
scaffold never touches the Fireflies API.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import _ingest_common as common

JsonObject = dict[str, Any]


def fetch_live() -> Any:
    """Stub for the live Fireflies GraphQL fetch.

    TODO(WS9): fetch transcripts via the Fireflies GraphQL API
    (https://api.fireflies.ai/graphql, FIREFLIES_API_KEY) and return the
    same payload shape the --input fixtures use. Remember the Fireflies
    feed mixes in personal recordings — purpose-check before ingesting.
    """
    raise NotImplementedError("fetch_live is a scaffold stub; use --input <fixture.json>")


def extract_people(payload: Any) -> list[JsonObject]:
    """Pull attendees out of one or more Fireflies transcript objects."""
    transcripts = payload if isinstance(payload, list) else [payload]
    people: list[JsonObject] = []
    for transcript in transcripts:
        if not isinstance(transcript, dict):
            continue
        title = transcript.get("title") or "Fireflies meeting"
        ref = transcript.get("id")
        attendees = (
            transcript.get("meeting_attendees")
            or transcript.get("attendees")
            or []
        )
        for attendee in attendees:
            if not isinstance(attendee, dict):
                continue
            people.append(
                {
                    "name": attendee.get("displayName") or attendee.get("name") or "",
                    "email": attendee.get("email") or "",
                    "summary": f"Attended '{title}' (Fireflies)",
                    "source_ref": f"fireflies:{ref}" if ref else "fireflies",
                }
            )
    return people


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ingest new people from a Fireflies payload (dry-run default)"
    )
    parser.add_argument("--input", required=True, help="JSON fixture of transcript(s)")
    parser.add_argument("--contacts-path", default=str(common.CONTACTS_PATH))
    parser.add_argument("--interactions-path", default=str(common.INTERACTIONS_PATH))
    parser.add_argument("--execute", action="store_true", help="Write; default is dry-run")
    args = parser.parse_args(argv)

    payload = common.load_fixture(args.input)
    summary = common.ingest_people(
        extract_people(payload),
        contacts_path=Path(args.contacts_path),
        interactions_path=Path(args.interactions_path),
        interaction_type="meeting",
        source_label="fireflies",
        dry_run=not args.execute,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
