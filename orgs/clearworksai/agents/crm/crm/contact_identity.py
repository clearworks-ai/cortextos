"""Canonical contact-ID resolution for ingestion and relationship association."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


CRM_DIR = Path(__file__).resolve().parent
CONTACT_ALIASES_PATH = CRM_DIR / "contact-aliases.json"


def load_contact_aliases(path: Path = CONTACT_ALIASES_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("contact alias file must contain an object")
    aliases: dict[str, str] = {}
    for alias, canonical in payload.items():
        if not isinstance(alias, str) or not alias.strip() or not isinstance(canonical, str) or not canonical.strip():
            raise ValueError("contact aliases must be non-empty string pairs")
        aliases[alias.strip()] = canonical.strip()
    return aliases


def resolve_contact_id(contact_id: Any, aliases: dict[str, str]) -> str:
    """Resolve configured aliases; unknown IDs remain unchanged and explicit."""
    if not isinstance(contact_id, str) or not contact_id.strip():
        raise ValueError("contact_id must be a non-empty string")
    current = contact_id.strip()
    visited: set[str] = set()
    while current in aliases:
        if current in visited:
            raise ValueError(f"contact alias cycle detected at {current}")
        visited.add(current)
        current = aliases[current]
    return current


def validate_alias_targets(aliases: dict[str, str], canonical_ids: set[str]) -> None:
    for alias in aliases:
        target = resolve_contact_id(alias, aliases)
        if target not in canonical_ids:
            raise ValueError(f"contact alias {alias} targets unknown canonical contact {target}")
