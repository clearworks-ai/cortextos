"""FR-006/FR-007/FR-008/FR-003/FR-009 projections (C6). Pure functions, no I/O, no
subprocess -- the SINGLE source for every preview AND every live write/send. Both
client_state_gmail's dry-run preview path and its do_* live-execution path call
these same functions and then only branch on whether to actually run the argv /
persist the text (G-PARITY-1). client_state_writes.py's do_* functions call the
plan_*_argv functions below to build argv rather than building their own, so there
is exactly one place an argv shape can drift."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from gmail_source import Message, normalise_date_iso
from observation_ledger import ObservationRow, Resolution
from writeback_email import HistoryEntry

# meeting_loop_watch.py's own Telegram chat id constant (duplicated here rather
# than imported, per C6, since meeting_loop_watch is FR-010 read-mostly and this
# module must not create a hard import-order dependency on it).
TELEGRAM_CHAT_ID = "6690120787"


def _history_date(date_iso: Any) -> tuple[str, bool]:
    """(YYYY-MM-DD, unparsed). gmail_source.normalise_date_iso is the ONE date
    parser, so this re-runs it rather than trusting a raw `[:10]` slice: an
    un-normalised RFC 2822 value reaching here used to become "Sun, 14 Se" and
    land in a History entry looking like a real date. Anything it cannot read
    falls back to today's UTC date AND reports itself, so the entry is dated
    plausibly and says so instead of carrying a malformed date silently."""
    normalised = normalise_date_iso(date_iso)
    if normalised:
        return normalised[:10], False
    return datetime.now(timezone.utc).date().isoformat(), True


def plan_history_entry(msg: Message, extraction: dict[str, Any], source_ref: str, revision_of: str | None) -> HistoryEntry:
    """G-HIST-1/G-PARITY-2: the ONE place a Gmail message + its extraction become
    a HistoryEntry -- both the dry-run diff preview and the live apply_history
    call build the entry through this function."""
    entry_date, date_unparsed = _history_date(msg.date_iso)
    summary = str(extraction.get("summary") or "")
    if date_unparsed:
        summary = (summary + " [date: unparsed]").strip()
    return HistoryEntry(
        date=entry_date,
        subject=msg.subject,
        source_ref=source_ref,
        summary=summary,
        decisions=[str(d.get("text") or "") for d in (extraction.get("decisions") or [])],
        open_questions=[str(q.get("text") or "") for q in (extraction.get("open_questions") or [])],
        revision_of=revision_of,
    )


def plan_upsert_contact_argv(crm_dir: Path, from_name: str, from_email: str) -> list[str]:
    """G-CRM-1: header-only facts -- ONLY the sender's From-header name+email,
    never message body content. Sender-only per FR-006/G0B-10: recipients are
    never auto-created through this function."""
    return [
        "python3", str(Path(crm_dir) / "upsert-contact.py"),
        # G-CRM-3: the display NAME, never a fallback to the address -- callers
        # must skip auto-create entirely when the From header carries no name.
        "--name", from_name,
        "--email", from_email,
        "--match-email",
        "--source-ref", "gmail:auto",
    ]


def plan_add_interaction_argv(crm_dir: Path, contact_id: str, msg: Message, extraction: dict[str, Any]) -> list[str]:
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


def plan_task_create_argv(plan: Any) -> list[str]:
    """`plan` is a client_state_writes.TaskPlan (title/owner/source_ref/dedup);
    typed loosely here to avoid a circular import (client_state_writes imports
    THIS module to build its argv)."""
    return [
        "cortextos", "bus", "create-task", plan.title,
        "--assignee", "human",
        "--type", "human",  # G-TASK-1
        "--desc", f"source {plan.source_ref}",
    ]


def plan_escalation(msg: Message, resolutions: list[Resolution]) -> str:
    """FR-003: the escalation text sent via
    `cortextos bus send-telegram <TELEGRAM_CHAT_ID> <text>` exactly once per
    (source_ref, content_digest) -- gating is `Ledger.escalated_for`, not a
    dedup key (no `clientstate:`-namespaced key is WRITTEN in v1; any key this
    system ever does write carries that prefix per FR-003)."""
    ambiguous = [r for r in resolutions if r.outcome == "escalated"]
    reasons = "; ".join(r.reason for r in ambiguous if r.reason) or "ambiguous entity binding"
    return (
        f"Client State: ambiguous Gmail message from {msg.from_name} <{msg.from_email}> "
        f"subject={msg.subject!r} ({reasons}) — gmail:{msg.id}"
    )


def escalation_source_key(source_ref: str, digest: str) -> str:
    """FR-003/FR-009 send-side dedup identity for ONE (source_ref, digest).

    The ledger record of an escalation is written only AFTER delivery is
    confirmed (G-ESC-3), which leaves one window the ledger cannot cover: a
    crash between a DELIVERED Telegram and the append. The bus's shared
    comms-event-dedup ledger closes it, because the send itself is gated on
    first-sight of this key.

    `<namespace>:<id>` per src/utils/event-dedup.ts SOURCE_KEY_PATTERN, whose id
    half may NOT contain a ':' -- so the source_ref's own colon is folded to
    '.'. The digest half is what makes an EDITED message a new alert.
    """
    return f"clientstate:{source_ref.replace(':', '.')}.{digest[:8]}"


def plan_escalation_argv(text: str, source_key: str) -> list[str]:
    """G-ESC-4: `--kind comms` makes the source key MANDATORY on the bus side --
    an invalid or missing key fails the send closed rather than falling back to
    byte-hash dedup, which a reworded alert would slip straight past."""
    return [
        "cortextos", "bus", "send-telegram", TELEGRAM_CHAT_ID, text,
        "--kind", "comms", "--source-key", source_key,
    ]


def message_outcome(resolutions: list[Resolution]) -> str:
    """The message-level outcome a preview block declares (G0B3-4): `filed` when
    anything was filed, else `escalated` when anything escalated, else
    `ignored`. It tells the G4 checker which per-field requirements apply —
    an ignored or escalated message legitimately has no extraction, CRM row,
    page diff, task line or grounding quote."""
    outcomes = {r.outcome for r in resolutions}
    if "filed" in outcomes or "partial" in outcomes:
        return "filed"
    if "escalated" in outcomes:
        return "escalated"
    return "ignored"


def _write_summary(row: ObservationRow) -> str:
    return str((row.extraction or {}).get("summary") or "")


def effective_writes(row: ObservationRow) -> list[str]:
    """The write tokens a digest should render for `row`. A simulated (dry-run)
    row carries `planned_writes` -- what the live run WOULD write -- while
    `writes` stays empty, so nothing downstream can mistake a preview for a
    completed effect (G0A2-2/G0B2-4)."""
    return list(row.planned_writes) if row.simulated else list(row.writes)


def plan_digest_line(row: ObservationRow) -> list[str]:
    """FR-009: per-write digest lines INCLUDING the extraction summary, used by
    client_state_digest.gmail_section AND by the dry-run's own digest preview.
    For a simulated row the PLANNED writes are rendered and every line is
    tagged `[simulated]`, so a dry-run digest reports its changes without ever
    claiming they were applied (G0B2-4)."""
    summary = _write_summary(row)
    tag = " [simulated]" if row.simulated else ""
    lines: list[str] = []
    for w in effective_writes(row):
        if w.startswith("crm:"):
            lines.append(f"- CRM: {w} ({row.source_ref}) — {summary}{tag}")
        elif w.startswith("task:"):
            title = w.split("|", 1)[1] if "|" in w else w
            lines.append(f"- Task created: {title} ({row.source_ref}){tag}")
        else:
            lines.append(f"- Page: {w} ({row.source_ref}) — {summary}{tag}")
    for s in row.suppressed:
        lines.append(
            f"- Task suppressed (tier {s['tier']}): {s['title']} matches {s['match']!r} ({row.source_ref}){tag}"
        )
    escalated = [r for r in row.resolutions if r.outcome == "escalated"]
    if escalated:
        # The ESCALATION REASON is carried here rather than a fixed phrase: this
        # is the one renderer of the escalation line (the daily digest used to
        # emit a second, differently-worded one just to keep the reason), so a
        # reader of either consumer sees WHY it escalated.
        reasons = "; ".join(r.reason for r in escalated if r.reason) or "ambiguous entity binding"
        lines.append(f"- Escalated: {row.source_ref} — {reasons}{tag}")
    if row.revision_of:
        lines.append(f"- Revision: {row.source_ref} supersedes {row.revision_of[:8]}{tag}")
    attempt = row.extraction_attempt or {}
    if attempt.get("frozen"):
        # G2r3-7: a frozen identity makes NO further automatic LLM calls, so the
        # only thing that moves it is a person. Silence here would be the
        # failure mode FR-009 exists to prevent.
        reason = str(attempt.get("last_error") or "").strip()
        lines.append(
            f"- extraction failed twice — manual re-run: {row.source_ref}"
            + (f" ({reason})" if reason else "") + tag
        )
    return lines


def plan_message_preview(
    msg: Message,
    resolutions: list[Resolution],
    extraction: dict[str, Any] | None,
    *,
    cached: bool,
    crm_lines: list[str],
    page_diffs: list[str],
    task_lines: list[str],
    escalation_text: str | None,
    digest_lines: list[str] | None = None,
) -> str:
    """G4 item 3: the per-message dry-run block carrying EVERY named field --
    source_ref, thread_id, sender (name + email), each resolution's full shape,
    the cached-or-fresh flag, extraction summary + every decision/commitment/
    open_question WITH its grounding quote + matches_open_item, CRM argv
    previews, page unified diff, task lines with dedup verdicts, escalation
    text, cost_usd + model_receipt, and the digest lines this row would
    contribute (C6's "digest preview" consumer, G0A2-10)."""
    lines = [
        f"=== source_ref=gmail:{msg.id} thread_id={msg.thread_id} ===",
        f"From: {msg.from_name} <{msg.from_email}>",
        f"Subject: {msg.subject}",
        # G0B3-4: the block declares its OWN outcome, so a checker can condition
        # its field requirements instead of demanding CRM/page/task/quote lines
        # from an ignored or escalated message that correctly produced none.
        f"outcome: {message_outcome(resolutions)}",
    ]
    for r in resolutions:
        lines.append(
            f"  resolution: slug={r.slug!r} kind={r.kind!r} method={r.method!r} "
            f"outcome={r.outcome!r} reason={r.reason!r} contact_id={r.contact_id!r} email={r.email!r}"
        )
    # G0B3-4: EVERY section is stated, present or not. An absent section is an
    # explicit marker, never a missing line -- "no CRM row" and "the preview
    # forgot the CRM row" must not look the same to a reader or to the checker.
    if extraction:
        lines.append(
            f"  extraction: cached={cached} cost_usd={extraction.get('cost_usd')} "
            f"model_receipt={extraction.get('model_receipt')}"
        )
        lines.append(f"  summary: {extraction.get('summary', '')}")
        items = 0
        for d in extraction.get("decisions") or []:
            items += 1
            lines.append(f"  decision: {d.get('text', '')} [quote: {d.get('quote', '')}]")
        for c in extraction.get("commitments") or []:
            items += 1
            lines.append(
                f"  commitment: {c.get('text', '')} owner={c.get('owner_name', '')} "
                f"matches_open_item={c.get('matches_open_item')} [quote: {c.get('quote', '')}]"
            )
        for q in extraction.get("open_questions") or []:
            items += 1
            lines.append(f"  open_question: {q.get('text', '')} [quote: {q.get('quote', '')}]")
        if items == 0:
            lines.append("  item: none [quote: none]")
    else:
        lines.append("  extraction: n/a")
        lines.append("  summary: n/a")
        lines.append("  item: none [quote: none]")
    lines.extend(crm_lines or ["  CRM: none"])
    lines.extend(page_diffs or ["  page: none"])
    lines.extend(task_lines or ["  task: none"])
    if escalation_text:
        lines.append(f"  escalation: {escalation_text}")
    else:
        lines.append("  escalation: none")
    for dl in digest_lines or ["- none"]:
        lines.append(f"  digest preview: {dl}")
    return "\n".join(lines)
