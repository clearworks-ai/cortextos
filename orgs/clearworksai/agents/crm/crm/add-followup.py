#!/usr/bin/env python3
"""Append an owner-matched open follow-up to crm/followups.jsonl.

Owner-matched by design: `--contact-id` is the commitment's resolved owner (FR-003
owner_identity), NEVER contacts[0] — this replaces the retired abbey blanket-followup that
attached every meeting's followup to the first contact. Idempotent id (contact+due+reason+
source) so a re-run for the same commitment does not create a duplicate row.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent


def _followups_path() -> Path:
    # Env override lets tests point at a temp fixture; defaults to the live store.
    return Path(os.environ.get("CRM_FOLLOWUPS_PATH", CRM_DIR / "followups.jsonl"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Create an owner-matched CRM follow-up")
    parser.add_argument("--contact-id", required=True)
    parser.add_argument("--due-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--reason", required=True)
    parser.add_argument("--suggested-action", default="")
    parser.add_argument("--priority", default="normal")
    parser.add_argument("--source-ref", default="meeting-fanout")
    args = parser.parse_args()

    seed = f"{args.contact_id}|{args.due_date}|{args.reason}|{args.source_ref}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    followup_id = f"followup-{args.contact_id}-{args.due_date}-{digest}"

    path = _followups_path()
    # Idempotent: skip an identical existing row (same id) instead of appending a dupe.
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                if json.loads(line).get("id") == followup_id:
                    print(followup_id)
                    return 0
            except json.JSONDecodeError:
                continue

    record = {
        "id": followup_id,
        "contact_id": args.contact_id,
        "due_date": args.due_date,
        "priority": args.priority,
        "reason": args.reason,
        "suggested_action": args.suggested_action,
        "status": "open",
        "source_ref": args.source_ref,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
    print(followup_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
