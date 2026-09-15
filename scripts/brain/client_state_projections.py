"""FR-006/FR-007/FR-008/FR-003/FR-009 projections (C6) -- Task 12's minimal slice.
Pure functions, no I/O, no subprocess. Task 15 gives the WHOLE file again with
plan_history_entry/plan_escalation/plan_digest_line/plan_message_preview added."""
from __future__ import annotations

from pathlib import Path
from typing import Any


def plan_upsert_contact_argv(crm_dir: Path, from_name: str, from_email: str) -> list[str]:
    """G-CRM-1: header-only facts -- ONLY the sender's From-header name+email,
    never message body content. Sender-only per FR-006/G0B-10: recipients are
    never auto-created through this function."""
    return [
        "python3", str(Path(crm_dir) / "upsert-contact.py"),
        "--name", from_name or from_email,
        "--email", from_email,
        "--match-email",
        "--source-ref", "gmail:auto",
    ]


def plan_add_interaction_argv(crm_dir: Path, contact_id: str, msg: Any, extraction: dict[str, Any]) -> list[str]:
    argv = [
        "python3", str(Path(crm_dir) / "add-interaction.py"),
        "--contact-id", contact_id,
        "--type", "email",
        "--summary", str(extraction.get("summary") or ""),
        "--source-ref", f"gmail:{msg.id}",
    ]
    for decision in extraction.get("decisions") or []:
        text = str(decision.get("text") or "")
        if text:
            argv.extend(["--decision", text])
    return argv
def plan_task_create_argv(plan) -> list[str]:
    """`plan` is a client_state_writes.TaskPlan (title/owner/source_ref/dedup);
    typed loosely here to avoid a circular import (client_state_writes imports
    THIS module to build its argv)."""
    return [
        "cortextos", "bus", "create-task", plan.title,
        "--assignee", "human",
        "--type", "human",
        "--desc", f"source {plan.source_ref}",
    ]
