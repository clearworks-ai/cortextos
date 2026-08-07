#!/usr/bin/env python3
"""Update a pipeline engagement, appending to stage_history on stage transitions.

This is the canonical writer for crm/pipeline.json mutations. Use this instead
of editing pipeline.json directly so stage drift is auditable.

Usage:
  upsert-engagement.py --clearpath-id 12 --stage proposal_sent --source-ref "fireflies:..." --note "Sent SOW"
  upsert-engagement.py --clearpath-id 12 --last-signal-at "2026-05-21T12:00:00Z"
  upsert-engagement.py --clearpath-id 12 --status active

Stage transitions append to stage_history. No-op if the new stage matches current.
All other fields update in place; pass them only when you want to change them.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
PIPELINE_PATH = CRM_DIR / "pipeline.json"

KNOWN_STAGES = {
    "lead", "qualified", "proposal_sent", "negotiation", "audit", "implementation",
    "won", "active_client", "dormant", "closed_won", "closed_lost", "lost",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert a pipeline engagement (stage_history aware)")
    parser.add_argument("--clearpath-id", type=int, required=True)
    parser.add_argument("--stage", choices=sorted(KNOWN_STAGES))
    parser.add_argument("--status")
    parser.add_argument("--last-signal-at")
    parser.add_argument("--primary-contact-id")
    parser.add_argument("--note", default="")
    parser.add_argument("--source-ref", default="manual")
    parser.add_argument(
        "--crm-authoritative",
        action="store_true",
        help="Mark this engagement CRM-authoritative so sync-board.py will not overwrite its stage from the dashboard board.",
    )
    args = parser.parse_args()

    data = json.loads(PIPELINE_PATH.read_text())
    engs = data.get("engagements", [])
    eng = next((e for e in engs if e.get("clearpath_id") == args.clearpath_id), None)
    if eng is None:
        print(json.dumps({"error": "not_found", "clearpath_id": args.clearpath_id}))
        return 1

    changes = []

    if args.stage and args.stage != eng.get("stage"):
        from_stage = eng.get("stage")
        eng.setdefault("stage_history", []).append({
            "from": from_stage,
            "to": args.stage,
            "at": now_iso(),
            "source_ref": args.source_ref,
            "note": args.note,
        })
        eng["stage"] = args.stage
        eng["stage_changed_at"] = now_iso()
        changes.append(f"stage:{from_stage}->{args.stage}")

    if args.status and args.status != eng.get("status"):
        changes.append(f"status:{eng.get('status')}->{args.status}")
        eng["status"] = args.status

    if args.last_signal_at:
        eng["last_signal_at"] = args.last_signal_at
        changes.append("last_signal_at")

    if args.crm_authoritative and eng.get("crm_authoritative") is not True:
        eng["crm_authoritative"] = True
        changes.append("crm_authoritative:true")

    if args.primary_contact_id and args.primary_contact_id != eng.get("primary_contact_id"):
        changes.append(f"primary_contact:{eng.get('primary_contact_id')}->{args.primary_contact_id}")
        eng["primary_contact_id"] = args.primary_contact_id
        contact_ids = eng.setdefault("contact_ids", [])
        if args.primary_contact_id not in contact_ids:
            contact_ids.insert(0, args.primary_contact_id)

    if not changes:
        print(json.dumps({"clearpath_id": args.clearpath_id, "changes": [], "noop": True}))
        return 0

    PIPELINE_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"clearpath_id": args.clearpath_id, "changes": changes}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
