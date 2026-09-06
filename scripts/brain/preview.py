"""Pure preview functions for --dry-run and the --apply pre-write preview
(Josh, 2026-09-05 D-09 review). No I/O, no subprocess: every input is
already-materialized JSON from FR-004's adapter output, so these previews are
truthful without invoking meeting-crm-sync.py or meeting-fanout.py."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

RECAP_TO = "josh@clearworks.ai"

_CODE_ROOT = Path(__file__).resolve().parent.parent.parent
_CRM_SYNC_PATH = _CODE_ROOT / "orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py"


def _load_crm_sync_module():
    """importlib load of meeting-crm-sync.py (hyphenated filename, can't
    `import`) so the CRM-row preview shares the EXACT SAME attendee
    derivation (``crm_attendees``) and meeting-selection (``_select_meeting``)
    the real apply path uses — F-1 FINAL review
    (docs/pipeline/run-artifacts/brain-source-to-state-r2/FINAL-fable.json):
    the --full-file apply path previously unioned in bare NAME strings
    (FR-004 fills those for email-less speakers) and wrote 8 interaction
    rows where this preview showed 6. Same importlib pattern
    test_preview.py's meeting-fanout parity test already uses."""
    spec = importlib.util.spec_from_file_location("brain_meeting_crm_sync", _CRM_SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_crm_sync = _load_crm_sync_module()
crm_attendees = _crm_sync.crm_attendees
_select_meeting = _crm_sync._select_meeting


def recap_recipients(_payload: dict[str, Any]) -> dict[str, list[str]]:
    """FR-008 always drafts to Josh; no --to/--cc override exists yet (spec §11)."""
    return {"to": [RECAP_TO], "cc": []}


def crm_interaction_preview(
    event: dict[str, Any],
    validated: dict[str, Any],
    resolution: dict[str, Any],
    fanout: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Preview the exact CRM interaction rows the apply path will write.

    ``fanout`` (the parsed ``fanout-meeting.json`` payload, when available) is
    passed through to ``crm_attendees`` as the full-file fallback source —
    same precedence rule the apply path uses (event.json authoritative,
    fanout-meeting.json fallback only when event.json carries no attendees).
    Omitting it (legacy 3-arg call) previews from event.json alone, which is
    already email-only and externals-only.
    """
    meeting_id = str(event.get("meeting_id") or "")
    full_meeting: dict[str, Any] = {}
    if fanout:
        meetings = fanout.get("meetings")
        full_meeting = _select_meeting(meetings if isinstance(meetings, list) else [], meeting_id)
    attendees = crm_attendees(event, full_meeting)
    summary = validated.get("summary") or {}
    overview = str(summary.get("overview") or "") if isinstance(summary, dict) else ""
    deal_state = validated.get("deal_state") or resolution.get("deal_state") or None
    source_ref = f"fireflies:{meeting_id}"
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


def _fanout_task_description(*, owner_label: str, meeting_id: str, text: str, due: str | None, commitment_id: str) -> str:
    """Byte-for-byte mirror of meeting-fanout.py's `fanout()` inline
    desc-building block (CRM_DIR/meeting-fanout.py, the loop over
    `parse_commitments(...)`, ~lines 339-352). Not extracted to a shared,
    importable function there — meeting-fanout.py is read-only for this fix
    (D-09 review scope) and the block is embedded inside a loop that also
    performs dedup/create_task side effects, so it cannot be called
    directly without executing those. Replicated here instead; parity is
    pinned by test_preview.py's importlib-based comparison against the real
    meeting-fanout.py module, which fails if this ever drifts from the
    original block."""
    task_marker = f"commitment:{meeting_id}/{commitment_id}"
    if owner_label:
        return (
            f"{owner_label} · From meeting fireflies:{meeting_id} · "
            f"{text} · due {due or 'none'} · [{task_marker}]"
        )
    return (
        f"From meeting {meeting_id}"
        + (f" · due {due}" if due else "")
        + f" · [{task_marker}]"
    )


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
            # Finding 2 (D-09 review): meeting-fanout.py's own Commitment.text
            # is `_s(step.get("text")) or _s(step.get("action"))` — falls
            # back to `action` when `text` is missing/empty. Preview must use
            # the exact same text fanout would title/describe the task with.
            text = str(step.get("text") or "").strip() or str(step.get("action") or "").strip()
            if not text:
                continue
            owner_identity = str(step.get("owner_identity") or "").strip()
            # Finding 2: never synthesize an owner_label — fanout's Commitment
            # .owner_label is `_s(step.get("owner_label"))` (empty string when
            # absent), and the desc-building block branches on that emptiness
            # to a DIFFERENT format (no "owner: Unassigned" text at all). A
            # synthesized fallback here would make the signed dry-run preview
            # describe a task fanout would never actually create.
            owner_label = str(step.get("owner_label") or "").strip()
            due = str(step.get("deadline") or "").strip() or None
            title = text if len(text) <= 120 else text[:117] + "..."
            description = _fanout_task_description(
                owner_label=owner_label, meeting_id=meeting_id, text=text, due=due, commitment_id=cid,
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
