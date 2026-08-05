#!/usr/bin/env python3
"""Persist ff-extractor ``--mode full`` decisions + deal_state into the CRM.

This is the write path ff-extractor.py's run_full() never got: run_full() already computes
`decisions` and `deal_state` per meeting but only print()s them. This connector consumes
that payload and drives the two existing idempotent writers:

  - decisions  -> add-interaction.py  (folds onto the meeting's ONE interaction row)
  - deal_state -> upsert-engagement.py, but ONLY when the free text maps to a real sales
                  stage via a deterministic keyword dict (never a silent LLM-prose flip).
                  Unmapped deal_state is preserved as text on the interaction row.

ff-extractor.py and upsert-engagement.py are NOT modified — this orchestrates them via
subprocess. All subprocess execution goes through the module-level ``_run`` seam so tests
can assert the produced commands without touching live interactions.jsonl / pipeline.json.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

CRM = Path(__file__).resolve().parent
ADD_INTERACTION = CRM / "add-interaction.py"
UPSERT_ENGAGEMENT = CRM / "upsert-engagement.py"
FF_EXTRACTOR = CRM.parent.parent / "pa" / "scripts" / "ff-extractor.py"


def _contacts_path() -> Path:
    return Path(os.environ.get("CRM_CONTACTS_PATH", CRM / "contacts.json"))


def _pipeline_path() -> Path:
    return Path(os.environ.get("CRM_PIPELINE_PATH", CRM / "pipeline.json"))


# Deterministic deal_state -> KNOWN_STAGES map (case-insensitive substring). Ordered:
# first matching group wins. Every target MUST be a member of upsert-engagement.py's
# KNOWN_STAGES. NO fuzzy/LLM mapping — an LLM sentence never flips a stage unless it
# contains an explicit mapped phrase; anything else is preserved as text only.
DEAL_STATE_STAGE_MAP: list[tuple[tuple[str, ...], str]] = [
    (("closed lost", "closed_lost", "went lost", "we lost", "they passed", "passed on"), "closed_lost"),
    (("signed", "verbal yes", "closed won", "closed_won", "deal won"), "won"),
    (("proposal sent", "sent the proposal", "sow sent", "sent the sow"), "proposal_sent"),
    (("negotiat",), "negotiation"),
    (("qualified",), "qualified"),
    (("went cold", "stalled", "dormant"), "dormant"),
]


def map_deal_state_to_stage(deal_state: str | None) -> str | None:
    """Return a KNOWN_STAGES value if deal_state deterministically maps, else None."""
    if not deal_state:
        return None
    t = deal_state.lower()
    for keywords, stage in DEAL_STATE_STAGE_MAP:
        if any(k in t for k in keywords):
            return stage
    return None


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _meeting_emails(meeting: dict) -> list[str]:
    out: list[str] = []
    for att in meeting.get("attendees", []) or []:
        em = att.get("email") if isinstance(att, dict) else att
        if em:
            out.append(str(em).strip().lower())
    org = meeting.get("organizer")
    if isinstance(org, dict):
        org = org.get("email")
    if org:
        out.append(str(org).strip().lower())
    return out


def resolve_contact_id(meeting: dict) -> str | None:
    """Prefer an explicit contact_id on the meeting; else match an attendee/organizer email
    to a contact in contacts.json (same email-match semantics the contact store uses). No
    guessed/fuzzy matching — return None if nothing resolves (caller skips + warns)."""
    if meeting.get("contact_id"):
        return meeting["contact_id"]
    emails = set(_meeting_emails(meeting))
    if not emails:
        return None
    contacts = _load(_contacts_path()).get("contacts", [])
    for c in contacts:
        cem = {str(e).strip().lower() for e in (c.get("emails") or [])}
        if emails & cem:
            return c.get("id")
    return None


def find_engagement_clearpath_id(contact_id: str) -> int | None:
    engs = _load(_pipeline_path()).get("engagements", [])
    for e in engs:
        if e.get("primary_contact_id") == contact_id or contact_id in (e.get("contact_ids") or []):
            cid = e.get("clearpath_id")
            return int(cid) if cid is not None else None
    return None


def _run(argv: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    """Single subprocess seam — tests monkeypatch this to capture argv without executing."""
    return subprocess.run(argv, capture_output=True, text=True, env=env, cwd=str(CRM))


def process_payload(payload: dict, *, dry_run: bool = False) -> dict:
    actions: list[dict] = []
    for meeting in payload.get("meetings", []) or []:
        meeting_id = meeting.get("meeting_id") or meeting.get("id")
        decisions = [d for d in (meeting.get("decisions") or []) if d]
        deal_state = meeting.get("deal_state") or None
        if not decisions and not deal_state:
            continue

        contact_id = resolve_contact_id(meeting)
        if not contact_id:
            actions.append({"meeting_id": meeting_id, "skipped": "unresolved_contact"})
            print(f"[warn] no contact resolved for meeting {meeting_id}; skipping writes", file=sys.stderr)
            continue

        source_ref = f"fireflies:{meeting_id}"
        add_argv = [
            "python3", str(ADD_INTERACTION),
            "--contact-id", contact_id,
            "--type", "meeting",
            "--source-ref", source_ref,
            "--sentiment", meeting.get("sentiment") or "unknown",
        ]
        for d in decisions:
            add_argv += ["--decision", d]
        if deal_state:
            add_argv += ["--deal-state", deal_state]

        mapped_stage = map_deal_state_to_stage(deal_state)
        clearpath_id = find_engagement_clearpath_id(contact_id) if mapped_stage else None

        upsert_argv: list[str] | None = None
        if mapped_stage and clearpath_id is not None:
            upsert_argv = [
                "python3", str(UPSERT_ENGAGEMENT),
                "--clearpath-id", str(clearpath_id),
                "--stage", mapped_stage,
                "--source-ref", source_ref,
                "--note", deal_state,
            ]

        action = {
            "meeting_id": meeting_id,
            "contact_id": contact_id,
            "add_interaction_argv": add_argv,
            "decisions": decisions,
            "deal_state": deal_state,
            "mapped_stage": mapped_stage,
            "upsert_engagement_argv": upsert_argv,
        }
        if mapped_stage and clearpath_id is None:
            action["stage_note"] = "mapped_but_no_engagement_for_contact"
        elif deal_state and not mapped_stage:
            action["stage_note"] = "deal_state_unmapped_preserved_as_text"

        if not dry_run:
            add_res = _run(add_argv, env=os.environ.copy())
            action["add_interaction_result"] = (add_res.stdout or "").strip()
            if upsert_argv is not None:
                up_res = _run(upsert_argv, env=os.environ.copy())
                action["upsert_engagement_result"] = (up_res.stdout or "").strip()

        actions.append(action)

    return {"connector": "ingest-meeting-decisions", "actions": actions}


def _read_payload(args: argparse.Namespace) -> dict:
    if args.stdin:
        return json.loads(sys.stdin.read())
    # --meeting-id: run ff-extractor --mode full for that meeting and parse its stdout.
    res = subprocess.run(
        ["python3", str(FF_EXTRACTOR), "--mode", "full", "--meeting-id", args.meeting_id],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        raise SystemExit(f"ff-extractor failed: {res.stderr.strip()}")
    return json.loads(res.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description="Persist ff-extractor decisions + deal_state into the CRM")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--stdin", action="store_true", help="read a captured ff --mode full payload from stdin")
    src.add_argument("--meeting-id", help="run ff-extractor --mode full for this meeting id")
    parser.add_argument("--dry-run", action="store_true", help="plan the writer calls without executing them")
    args = parser.parse_args()

    payload = _read_payload(args)
    summary = process_payload(payload, dry_run=args.dry_run)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
