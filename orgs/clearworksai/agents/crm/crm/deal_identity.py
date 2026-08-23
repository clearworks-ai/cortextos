"""Opportunity-level identity and mutation invariants for CRM engagements."""

from __future__ import annotations

from typing import Any


TERMINAL_STAGES = {"won", "closed_won", "lost", "closed_lost"}
OPEN_STAGES = {"lead", "qualified", "proposal_sent", "negotiation", "audit", "implementation", "active_client"}


def engagement_record_id(engagement: dict[str, Any]) -> str:
    """Return the stable deal ID; never derive identity from company or stage."""
    record_id = engagement.get("record_id")
    if isinstance(record_id, str) and record_id.strip():
        return record_id.strip()
    clearpath_id = engagement.get("clearpath_id")
    if isinstance(clearpath_id, int):
        return f"clearpath:engagement:{clearpath_id}"
    intake_id = engagement.get("intake_id")
    if isinstance(intake_id, str) and intake_id.strip():
        return f"intake:{intake_id.strip()}"
    raise ValueError("engagement requires a stable record_id, clearpath_id, or intake_id")


def ensure_record_ids(engagements: list[dict[str, Any]]) -> None:
    """Populate stable IDs where derivable and reject identity collisions."""
    seen: set[str] = set()
    for engagement in engagements:
        record_id = engagement_record_id(engagement)
        if record_id in seen:
            raise ValueError(f"duplicate engagement record_id: {record_id}")
        seen.add(record_id)
        engagement["record_id"] = record_id


def assert_stage_transition(current_stage: Any, next_stage: Any) -> None:
    """A closed deal is immutable; a new commercial motion needs a new record."""
    if current_stage in TERMINAL_STAGES and next_stage in OPEN_STAGES and next_stage != current_stage:
        raise ValueError(
            f"closed engagement cannot transition {current_stage}->{next_stage}; create a new deal record"
        )


def set_values(
    engagement: dict[str, Any], *, value_total: float | None, value_monthly: float | None
) -> None:
    """Store one-time and recurring commercial value independently."""
    engagement["value_total"] = value_total
    engagement["value_monthly"] = value_monthly
