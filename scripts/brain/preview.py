"""Pure preview functions for --dry-run and the --apply pre-write preview
(Josh, 2026-09-05 D-09 review). No I/O, no subprocess: every input is
already-materialized JSON from FR-004's adapter output, so these previews are
truthful without invoking meeting-crm-sync.py or meeting-fanout.py."""
from __future__ import annotations

from typing import Any

RECAP_TO = "josh@clearworks.ai"


def recap_recipients(_payload: dict[str, Any]) -> dict[str, list[str]]:
    """FR-008 always drafts to Josh; no --to/--cc override exists yet (spec §11)."""
    return {"to": [RECAP_TO], "cc": []}


def crm_interaction_preview(
    event: dict[str, Any], validated: dict[str, Any], resolution: dict[str, Any]
) -> list[dict[str, Any]]:
    attendees = event.get("attendees") or []
    if not isinstance(attendees, list):
        attendees = []
    summary = validated.get("summary") or {}
    overview = str(summary.get("overview") or "") if isinstance(summary, dict) else ""
    deal_state = validated.get("deal_state") or resolution.get("deal_state") or None
    source_ref = f"fireflies:{event.get('meeting_id') or ''}"
    rows: list[dict[str, Any]] = []
    for email in attendees:
        email = str(email).strip()
        if not email:
            continue
        rows.append(
            {
                "contact": email,
                "type": "meeting",
                "source_ref": source_ref,
                "sentiment": "neutral",
                "summary": overview or "Meeting processed",
                "deal_state": deal_state,
            }
        )
    return rows


def bus_task_preview(
    fanout: dict[str, Any], created_ids: set[str], *, meeting_id: str
) -> list[dict[str, Any]]:
    meetings = fanout.get("meetings") or []
    rows: list[dict[str, Any]] = []
    for meeting in meetings:
        if not isinstance(meeting, dict):
            continue
        for step in meeting.get("next_steps") or []:
            if not isinstance(step, dict):
                continue
            cid = str(step.get("commitmentId") or "")
            if cid and cid in created_ids:
                continue
            text = str(step.get("text") or "").strip()
            if not text:
                continue
            owner_identity = str(step.get("owner_identity") or "")
            owner_label = str(step.get("owner_label") or f"owner: {owner_identity or 'Unassigned'}")
            due = step.get("deadline") or None
            title = text if len(text) <= 120 else text[:117] + "..."
            description = (
                f"{owner_label} · From meeting fireflies:{meeting_id} · {text} · due {due or 'none'}"
            )
            rows.append(
                {
                    "commitmentId": cid,
                    "title": title,
                    "owner_identity": owner_identity,
                    "owner_label": owner_label,
                    "due": due,
                    "description": description,
                }
            )
    return rows
