#!/usr/bin/env python3
"""Update a pipeline engagement, appending to stage_history on stage transitions.

This is the canonical writer for crm/pipeline.json mutations. Use this instead
of editing pipeline.json directly so stage drift is auditable.

Usage:
  upsert-engagement.py --clearpath-id 12 --stage proposal_sent --source-ref "fireflies:..." --note "Sent SOW"
  upsert-engagement.py --clearpath-id 12 --last-signal-at "2026-05-21T12:00:00Z"
  upsert-engagement.py --clearpath-id 12 --dossier "meetings/2026-05-21-person-dossier.md" --open-commitment "Send scope"
  upsert-engagement.py --engagement-name "Telegram-created engagement" --dossier "meetings/...-dossier.md"
  upsert-engagement.py --clearpath-id 12 --status active

Stage transitions append to stage_history. No-op if the new stage matches current.
All other fields update in place; pass them only when you want to change them.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


CRM_DIR = Path(__file__).resolve().parent
PIPELINE_PATH = Path(os.environ.get("CRM_PIPELINE_PATH", CRM_DIR / "pipeline.json"))

KNOWN_STAGES = {
    "lead", "qualified", "proposal_sent", "negotiation", "audit", "implementation",
    "won", "active_client", "dormant", "closed_won", "closed_lost", "lost",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert a pipeline engagement (stage_history aware)")
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--clearpath-id", type=int)
    selector.add_argument("--engagement-name", help="Match a locally-created engagement by exact name when clearpath_id is null")
    parser.add_argument("--stage", choices=sorted(KNOWN_STAGES))
    parser.add_argument("--status")
    parser.add_argument("--last-signal-at")
    parser.add_argument("--primary-contact-id")
    parser.add_argument("--dossier", help="Canonical CRM-relative dossier reference")
    parser.add_argument("--next-action")
    parser.add_argument("--open-commitment", action="append", default=[], help="Open commitment; may be supplied more than once")
    parser.add_argument("--misclassified", action="store_true", help="Flag only when evidence contradicts the current stage")
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
    if args.clearpath_id is not None:
        eng = next((e for e in engs if e.get("clearpath_id") == args.clearpath_id), None)
    else:
        matches = [e for e in engs if e.get("name") == args.engagement_name]
        eng = matches[0] if len(matches) == 1 else None
    if eng is None:
        print(json.dumps({"error": "not_found_or_ambiguous", "clearpath_id": args.clearpath_id, "engagement_name": args.engagement_name}))
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

    if args.dossier and eng.get("_dossier") != args.dossier:
        eng["_dossier"] = args.dossier
        changes.append("_dossier")

    if args.next_action is not None and eng.get("next_action") != args.next_action:
        eng["next_action"] = args.next_action
        changes.append("next_action")

    if args.open_commitment:
        existing = eng.get("_open_commitments", [])
        if not isinstance(existing, list):
            existing = [str(existing)]
        merged = list(dict.fromkeys([*existing, *args.open_commitment]))
        if merged != eng.get("_open_commitments"):
            eng["_open_commitments"] = merged
            changes.append("_open_commitments")

    if args.misclassified and eng.get("_misclassified") is not True:
        eng["_misclassified"] = True
        changes.append("_misclassified:true")

    if not changes:
        print(json.dumps({"clearpath_id": eng.get("clearpath_id"), "name": eng.get("name"), "changes": [], "noop": True}))
        return 0

    PIPELINE_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"clearpath_id": eng.get("clearpath_id"), "name": eng.get("name"), "changes": changes}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
