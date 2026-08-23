#!/usr/bin/env python3
"""Idempotently rewrite interaction contact aliases to canonical contact IDs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from add_interaction_import import atomic_write_lines
from contact_identity import load_contact_aliases, resolve_contact_id


CRM_DIR = Path(__file__).resolve().parent


def reconcile(path: Path, aliases_path: Path) -> dict[str, int]:
    aliases = load_contact_aliases(aliases_path)
    rows: list[dict] = []
    changed = 0
    deduped = 0
    seen: set[tuple[object, object]] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        old = row.get("contact_id")
        canonical = resolve_contact_id(old, aliases)
        if canonical != old:
            row["contact_id"] = canonical
            changed += 1
        key = (row.get("source_ref"), row.get("contact_id"))
        if key in seen:
            deduped += 1
            continue
        seen.add(key)
        rows.append(row)
    if changed or deduped:
        atomic_write_lines(path, [json.dumps(row) for row in rows])
    return {"changed": changed, "deduped": deduped, "rows": len(rows)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interactions-path", default=str(CRM_DIR / "interactions.jsonl"))
    parser.add_argument("--aliases-path", default=str(CRM_DIR / "contact-aliases.json"))
    args = parser.parse_args()
    print(json.dumps(reconcile(Path(args.interactions_path), Path(args.aliases_path))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
