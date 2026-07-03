#!/usr/bin/env python3
"""SCAFFOLD: Omi people → new CRM people (WS9).

Passive source: Omi conversations/memories reference people. Genuinely new
people become contacts (via upsert_contact, minting a canonical
crm_entity_id); known people are skipped. Omi people often have no email,
so dedup falls back to alias/name matching. One 'manual' interaction line
is appended per created contact, in the exact add-interaction.py shape.

Fixture-driven and --dry-run by default. fetch_live() is a stub — this
scaffold never touches the Omi API.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import _ingest_common as common

JsonObject = dict[str, Any]


def fetch_live() -> Any:
    """Stub for the live Omi fetch.

    TODO(WS9): fetch people via the Omi MCP/API (get_people /
    get_conversations) and return the same payload shape the --input
    fixtures use.
    """
    raise NotImplementedError("fetch_live is a scaffold stub; use --input <fixture.json>")


def extract_people(payload: Any) -> list[JsonObject]:
    """Pull people out of an Omi payload ({'people': [...]} or a list)."""
    if isinstance(payload, dict):
        entries = payload.get("people") or []
    elif isinstance(payload, list):
        entries = payload
    else:
        entries = []
    people: list[JsonObject] = []
    for entry in entries:
        if isinstance(entry, str):
            entry = {"name": entry}
        if not isinstance(entry, dict):
            continue
        ref = entry.get("id")
        people.append(
            {
                "name": entry.get("name") or "",
                "email": entry.get("email") or "",
                "summary": entry.get("context") or "Mentioned in Omi conversations",
                "source_ref": f"omi:{ref}" if ref else "omi",
            }
        )
    return people


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ingest new people from an Omi payload (dry-run default)"
    )
    parser.add_argument("--input", required=True, help="JSON fixture of Omi people")
    parser.add_argument("--contacts-path", default=str(common.CONTACTS_PATH))
    parser.add_argument("--interactions-path", default=str(common.INTERACTIONS_PATH))
    parser.add_argument("--execute", action="store_true", help="Write; default is dry-run")
    args = parser.parse_args(argv)

    payload = common.load_fixture(args.input)
    summary = common.ingest_people(
        extract_people(payload),
        contacts_path=Path(args.contacts_path),
        interactions_path=Path(args.interactions_path),
        interaction_type="manual",
        source_label="omi",
        dry_run=not args.execute,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
