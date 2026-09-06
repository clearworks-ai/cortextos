#!/usr/bin/env python3
"""FR-004 commitment fanout — deterministic (no-LLM) worker.

The daemon spawns this on `crm.meeting.completed`. It reads a meeting's already-extracted
commitments (from ff-extractor `--mode full --meeting-id <id>`, plus the FR-002 event payload
`ff-meeting-event-<safeId>.json` for meeting-level client/type context) and fans EACH commitment
to four sinks, every one gated by a per-commitmentId dedup so a re-run creates NO duplicates:

  1. bus create-task   — `cortextos bus create-task "<title>" --assignee <owner> [--needs-approval]`
                         (client-facing → ALSO `cortextos bus create-approval ... external-comms`)
  2. BRIEFS            — POST to $BRIEFS_INGEST_URL (header x-api-key: $TASKS_INGEST_TOKEN);
                         env missing → DEGRADED (log + skip, never crash)
  3. followup ROW      — `add-followup.py --contact-id <owner> --due-date <YYYY-MM-DD> --reason ...`
                         owner-matched (owner_identity), NOT contacts[0]
  4. Telegram          — ONE BATCHED message per MEETING (collected across commitments, sent once)

Dedup source-key := `commitment:<commitmentId>` via `cortextos bus event-dedup --source ...
--fire-once` (SURFACE = first sight → fan; SKIP = already surfaced → skip ALL four sinks).

This SUBSUMES the frank2 meeting-commitments-worker (BRIEFS POST) and replaces the abbey
blanket-followup (contacts[0]) with owner-matched followup rows. All external effects (bus,
subprocess, http, telegram) go through the injectable `Deps` seam so tests run with fakes.

owner_identity comes from FR-003 and is one of:
  * an attendee email (lowercased)         → assign the task to that email (bus resolves)
  * `NEEDS-OWNER:<slug>`                    → route to the triage owner (never silently dropped)

Every commitment carries a spec `commitmentId` (sha1) from FR-003.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

LOGGER = logging.getLogger("meeting-fanout")

CRM_DIR = Path(__file__).resolve().parent
ADD_FOLLOWUP = CRM_DIR / "add-followup.py"

# CRM_DIR = orgs/<org>/agents/crm/crm ; framework root = five parents up. The ff-extractor
# lives in the pa agent; the path holds in prod, in a worktree, and in staging. Overridable
# via FF_EXTRACTOR_PATH.
FW_ROOT = CRM_DIR.parents[4]
FF_EXTRACTOR_PATH = Path(
    os.environ.get(
        "FF_EXTRACTOR_PATH",
        str(FW_ROOT / "orgs" / "clearworksai" / "agents" / "pa" / "scripts" / "ff-extractor.py"),
    )
)

# Josh's Telegram chat.
DEFAULT_TELEGRAM_CHAT_ID = "6690120787"
# NEEDS-OWNER / unresolved owner → triage owner (never silently dropped).
TRIAGE_OWNER = os.environ.get("FANOUT_TRIAGE_OWNER", "pa")
# meeting types that make an outbound commitment client-facing (external-comms).
CLIENT_FACING_MEETING_TYPES = {"sales", "delivery"}


@dataclass
class Deps:
    """Injectable side-effect seams so tests run with fakes (no real bus/network)."""

    # Run ff-extractor `--mode full --meeting-id <id>`; returns parsed JSON dict.
    load_full: Callable[[str], dict[str, Any]]
    # `cortextos bus create-task <title> --assignee <owner> [--needs-approval]` → task id (str).
    create_task: Callable[..., str]
    # `cortextos bus create-approval <title> external-comms [context]` → approval id (str).
    create_approval: Callable[..., str]
    # POST to BRIEFS ingest; returns True on attempt (False = DEGRADED, env missing).
    post_briefs: Callable[[dict[str, Any]], bool]
    # `add-followup.py --contact-id <owner> --due-date <d> --reason <r>` → followup id (str).
    add_followup: Callable[..., str]
    # `cortextos bus send-telegram <chat_id> <message>` (batched, once per meeting).
    send_telegram: Callable[[str, str], None]
    # `cortextos bus event-dedup --source commitment:<id> --fire-once` → True if SURFACE.
    dedup_surface: Callable[[str], bool]
    # --strict variant: distinguishes a dedup command FAILURE ("FAIL") from an
    # already-surfaced commitment ("SKIP") or a first sight ("SURFACE"). None (default)
    # means --strict was not requested; fanout() then falls back to dedup_surface.
    dedup_surface_strict: Callable[[str], str] | None = None
    # CH-4: on a --retry-commitment cycle, look up whether a task already exists
    # for this commitmentId (an earlier create-task call may have durably
    # succeeded on the bus even though the command reported failure/timed out —
    # an "ambiguous failure"). Returns the existing task id, or "" if none is
    # found. None (default) means the lookup is unavailable; fanout() then
    # falls back to unconditionally re-creating, same as before this fix.
    # Finding 2: takes (meeting_id, commitment_id, commitment_text) — the
    # meeting_id is required for the exact `[commitment:<meeting_id>/<id>]`
    # match (a bare commitment_id substring match could attach an unrelated
    # task from a different meeting); commitment_text is an ambiguity
    # tie-break only, used when more than one bus task carries the marker.
    find_task_by_commitment: Callable[[str, str, str], str] | None = None


# ── commitment model ─────────────────────────────────────────────────────────


@dataclass
class Commitment:
    commitment_id: str
    text: str
    owner_identity: str
    owner_label: str
    direction: str
    deadline: str
    client_facing: bool


def _s(value: Any) -> str:
    return "" if value is None else str(value).strip()


def is_needs_owner(owner_identity: str) -> bool:
    return owner_identity.upper().startswith("NEEDS-OWNER")


def resolve_assignee(owner_identity: str) -> str:
    """Map an FR-003 owner_identity to a bus assignee.

    NEEDS-OWNER (or empty) → triage owner (pa), never silently dropped. An email/name
    identity is passed through as the assignee (bus resolveTaskOwner resolves it).
    """
    owner = _s(owner_identity)
    if not owner or is_needs_owner(owner):
        return TRIAGE_OWNER
    return owner


def followup_contact_id(owner_identity: str) -> str:
    """Contact id for the owner-matched followup ROW (owner_identity, never contacts[0])."""
    owner = _s(owner_identity)
    if not owner or is_needs_owner(owner):
        return TRIAGE_OWNER
    return owner


def meeting_is_client_facing(meeting_type: str, client: str) -> bool:
    return bool(_s(client)) or _s(meeting_type).lower() in CLIENT_FACING_MEETING_TYPES


def commitment_is_client_facing(direction: str, meeting_client_facing: bool) -> bool:
    # Only WE-committed (outbound) items are external comms we would send; inbound
    # (they committed to us) is FYI/tracking and never a client-facing send.
    return meeting_client_facing and _s(direction).lower() == "outbound"


def parse_commitments(
    meeting: dict[str, Any],
    *,
    meeting_client_facing: bool,
) -> list[Commitment]:
    """Extract the fanout commitment model from a ff-extractor full-mode meeting object."""
    out: list[Commitment] = []
    steps = meeting.get("next_steps")
    if not isinstance(steps, list):
        return out
    for step in steps:
        if not isinstance(step, dict):
            continue
        commitment_id = _s(step.get("commitmentId"))
        text = _s(step.get("text")) or _s(step.get("action"))
        if not commitment_id or not text:
            # A commitment with no stable id or no text cannot be safely deduped/fanned.
            LOGGER.warning("skipping commitment with missing commitmentId/text: %r", step)
            continue
        direction = _s(step.get("direction")) or "outbound"
        out.append(
            Commitment(
                commitment_id=commitment_id,
                text=text,
                owner_identity=_s(step.get("owner_identity")),
                owner_label=_s(step.get("owner_label")),
                direction=direction,
                deadline=_s(step.get("deadline")),
                client_facing=commitment_is_client_facing(direction, meeting_client_facing),
            )
        )
    return out


# ── meeting sourcing ─────────────────────────────────────────────────────────


def load_event_file(event_file: str | None) -> dict[str, Any]:
    """Read the FR-002 event payload (client / meeting_type context). Best-effort."""
    if not event_file:
        return {}
    path = Path(event_file)
    if not path.exists():
        LOGGER.warning("event file not found: %s", event_file)
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        LOGGER.warning("failed to read event file %s: %s", event_file, exc)
        return {}
    return parsed if isinstance(parsed, dict) else {}


def select_meeting(full_payload: dict[str, Any], meeting_id: str) -> dict[str, Any] | None:
    meetings = full_payload.get("meetings")
    if not isinstance(meetings, list):
        return None
    for meeting in meetings:
        if isinstance(meeting, dict) and _s(meeting.get("id")) == meeting_id:
            return meeting
    # ff-extractor was already filtered to this meeting; accept the sole meeting too.
    if len(meetings) == 1 and isinstance(meetings[0], dict):
        return meetings[0]
    return None


# ── batched Telegram message ─────────────────────────────────────────────────


def build_telegram_message(
    *,
    title: str,
    surfaced: list[Commitment],
) -> str:
    lines = [f"Meeting commitments — {title or 'Untitled Meeting'}", ""]
    lines.append(f"{len(surfaced)} new commitment(s) fanned to tasks:")
    for c in surfaced:
        owner = "triage" if (is_needs_owner(c.owner_identity) or not c.owner_identity) else c.owner_identity
        due = f" — due {c.deadline}" if c.deadline else ""
        flag = " [client-facing]" if c.client_facing else ""
        lines.append(f"- {c.text}{due} (owner: {owner}){flag}")
    return "\n".join(lines)


# ── core fanout ──────────────────────────────────────────────────────────────


@dataclass
class FanoutResult:
    meeting_id: str
    surfaced: list[Commitment] = field(default_factory=list)
    skipped: list[Commitment] = field(default_factory=list)
    tasks: list[str] = field(default_factory=list)
    task_map: list[tuple[str, str]] = field(default_factory=list)
    approvals: list[str] = field(default_factory=list)
    followups: list[str] = field(default_factory=list)
    briefs_attempted: int = 0
    briefs_degraded: int = 0
    telegram_sent: bool = False
    # --strict: commitment ids whose dedup command failed, or whose create_task returned
    # empty — distinct from `skipped` (already-surfaced). A checkpoint retries these via
    # --retry-commitment.
    failed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "meeting_id": self.meeting_id,
            "surfaced": [c.commitment_id for c in self.surfaced],
            "skipped": [c.commitment_id for c in self.skipped],
            "failed": self.failed,
            "tasks": self.tasks,
            "task_map": [{"commitmentId": cid, "taskId": tid} for cid, tid in self.task_map],
            "approvals": self.approvals,
            "followups": self.followups,
            "briefs_attempted": self.briefs_attempted,
            "briefs_degraded": self.briefs_degraded,
            "telegram_sent": self.telegram_sent,
        }


def fanout(
    *,
    meeting_id: str,
    event_file: str | None,
    deps: Deps,
    dry_run: bool = False,
    telegram_chat_id: str = DEFAULT_TELEGRAM_CHAT_ID,
    strict: bool = False,
    retry_commitments: frozenset[str] = frozenset(),
) -> FanoutResult:
    """Deterministically fan a meeting's commitments to the four sinks (dedup-gated)."""
    result = FanoutResult(meeting_id=meeting_id)

    event = load_event_file(event_file)
    full_payload = deps.load_full(meeting_id)
    meeting = select_meeting(full_payload, meeting_id)
    if meeting is None:
        LOGGER.info("no meeting/commitments for %s — zero fanout", meeting_id)
        return result

    title = _s(meeting.get("title")) or _s(event.get("title"))
    # Prefer the FR-002 event payload for client/type (authoritative), fall back to full mode.
    client = _s(event.get("client")) or _s(meeting.get("client_context"))
    meeting_type = _s(event.get("meeting_type")) or _s(meeting.get("meeting_type"))
    meeting_client_facing = meeting_is_client_facing(meeting_type, client)

    commitments = parse_commitments(meeting, meeting_client_facing=meeting_client_facing)
    if not commitments:
        LOGGER.info("zero commitments for %s — no tasks/rows, no telegram", meeting_id)
        return result

    for c in commitments:
        source_key = f"commitment:{c.commitment_id}"
        is_retry = c.commitment_id in retry_commitments
        if is_retry:
            pass  # explicit checkpoint retry — bypass the dedup check for this id
        elif strict and deps.dedup_surface_strict is not None:
            state = deps.dedup_surface_strict(source_key)
            if state == "SKIP":
                result.skipped.append(c)
                continue
            if state == "FAIL":
                # Dedup command itself failed — never masquerade as "already surfaced".
                result.failed.append(c.commitment_id)
                continue
        elif not deps.dedup_surface(source_key):
            # Already surfaced — skip ALL four sinks for this commitmentId.
            result.skipped.append(c)
            continue
        result.surfaced.append(c)
        if dry_run:
            continue

        assignee = resolve_assignee(c.owner_identity)

        # Sink 1: bus create-task (+ create-approval if client-facing).
        task_title = c.text if len(c.text) <= 120 else c.text[:117] + "..."
        # Finding 2: the lookup marker embeds BOTH the meeting id and the
        # commitmentId (`[commitment:<meeting_id>/<id>]`), distinct from the
        # bare `commitment:<id>` dedup source_key above — a lookup keyed on
        # commitment_id alone (the pre-fix marker) could substring-match an
        # unrelated task from a different meeting.
        task_marker = f"commitment:{meeting_id}/{c.commitment_id}"
        if c.owner_label:
            desc = (
                f"{c.owner_label} · From meeting fireflies:{meeting_id} · "
                f"{c.text} · due {c.deadline or 'none'} · [{task_marker}]"
            )
        else:
            desc = (
                f"From meeting {meeting_id}"
                + (f" · due {c.deadline}" if c.deadline else "")
                + f" · [{task_marker}]"
            )
        # CH-4: a --retry-commitment cycle may be retrying a commitment whose
        # earlier create-task call actually succeeded on the bus despite an
        # ambiguous command failure (empty/nonzero result). Check for an
        # existing task carrying this commitmentId before re-creating — the
        # `[commitment:<meeting_id>/<id>]` marker embedded in `desc` above is
        # what makes that existing task findable by description.
        existing_task_id = ""
        if is_retry and deps.find_task_by_commitment is not None:
            existing_task_id = deps.find_task_by_commitment(meeting_id, c.commitment_id, c.text) or ""
        if existing_task_id:
            task_id = existing_task_id
        else:
            task_id = deps.create_task(
                title=task_title,
                assignee=assignee,
                needs_approval=c.client_facing,
                desc=desc,
                due=c.deadline or None,
            )
        if task_id:
            result.tasks.append(task_id)
            result.task_map.append((c.commitment_id, task_id))
        elif strict:
            # create_task returned empty (command failed) — a strict run must not silently
            # treat this commitment as done; record it for --retry-commitment.
            result.failed.append(c.commitment_id)
            continue
        if c.client_facing:
            approval_id = deps.create_approval(
                title=f"Client-facing commitment: {task_title}",
                category="external-comms",
                context=f"Meeting {meeting_id} — owner {assignee}",
                client=client or None,
            )
            if approval_id:
                result.approvals.append(approval_id)

        # Sink 2: BRIEFS POST (DEGRADED if env missing — never crash).
        attempted = deps.post_briefs(
            {
                "id": c.commitment_id,
                "text": c.text,
                "owner": assignee,
                "owner_identity": c.owner_identity,
                "deadline": c.deadline,
                "direction": c.direction,
                "meeting_id": meeting_id,
                "sourceRef": f"{meeting_id} · {title}",
            }
        )
        if attempted:
            result.briefs_attempted += 1
        else:
            result.briefs_degraded += 1

        # Sink 3: owner-matched followup ROW (only when a concrete due date exists).
        if c.deadline:
            followup_id = deps.add_followup(
                contact_id=followup_contact_id(c.owner_identity),
                due_date=c.deadline,
                reason=c.text,
                source_ref=f"{meeting_id} · {title}",
            )
            if followup_id:
                result.followups.append(followup_id)

    # Sink 4: ONE batched Telegram per MEETING (only if something surfaced).
    if result.surfaced and not dry_run:
        message = build_telegram_message(title=title, surfaced=result.surfaced)
        deps.send_telegram(telegram_chat_id, message)
        result.telegram_sent = True

    return result


# ── production side-effect seams (subprocess / http) ─────────────────────────


def _run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        LOGGER.warning("command failed (%s): %s", proc.returncode, " ".join(cmd[:3]))
        return ""
    return proc.stdout.strip()


def prod_load_full(meeting_id: str) -> dict[str, Any]:
    out = _run(
        [
            sys.executable,
            str(FF_EXTRACTOR_PATH),
            "--mode",
            "full",
            "--meeting-id",
            meeting_id,
        ]
    )
    if not out:
        return {"mode": "full", "meetings": []}
    try:
        return json.loads(out)
    except ValueError:
        LOGGER.warning("ff-extractor full output was not JSON for %s", meeting_id)
        return {"mode": "full", "meetings": []}


def prod_create_task(
    *,
    title: str,
    assignee: str,
    needs_approval: bool = False,
    desc: str | None = None,
    due: str | None = None,
) -> str:
    cmd = ["cortextos", "bus", "create-task", title, "--assignee", assignee]
    if desc:
        cmd += ["--desc", desc]
    if due:
        cmd += ["--due", due]
    if needs_approval:
        cmd += ["--needs-approval"]
    return _run(cmd)


def prod_create_approval(
    *,
    title: str,
    category: str = "external-comms",
    context: str = "",
    client: str | None = None,
) -> str:
    cmd = ["cortextos", "bus", "create-approval", title, category]
    if context:
        cmd += [context]
    if client:
        cmd += ["--client", client]
    return _run(cmd)


def prod_add_followup(
    *,
    contact_id: str,
    due_date: str,
    reason: str,
    source_ref: str = "meeting-fanout",
) -> str:
    return _run(
        [
            sys.executable,
            str(ADD_FOLLOWUP),
            "--contact-id",
            contact_id,
            "--due-date",
            due_date,
            "--reason",
            reason,
            "--source-ref",
            source_ref,
        ]
    )


def prod_send_telegram(chat_id: str, message: str) -> None:
    _run(["cortextos", "bus", "send-telegram", chat_id, message])


def prod_dedup_surface(source_key: str) -> bool:
    # fire-once: a commitment is surfaced exactly once, ever (re-run → SKIP).
    out = _run(["cortextos", "bus", "event-dedup", "--source", source_key, "--fire-once"])
    return out.upper().startswith("SURFACE")


def prod_dedup_surface_strict(source_key: str) -> str:
    """--strict variant: distinguish a command FAILURE from an already-surfaced
    SKIP, so a broken dedup check never masquerades as 'already surfaced'."""
    proc = subprocess.run(
        ["cortextos", "bus", "event-dedup", "--source", source_key, "--fire-once"],
        capture_output=True,
        text=True,
    )
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or not out:
        return "FAIL"
    return "SURFACE" if out.upper().startswith("SURFACE") else "SKIP"


def prod_find_task_by_commitment(meeting_id: str, commitment_id: str, expected_text: str = "") -> str:
    """CH-4: before a --retry-commitment cycle re-creates a task, check whether
    an earlier (ambiguous-failure) create-task call already landed on the bus —
    avoids duplicating a task when the create command itself failed/timed out
    but the write succeeded. Filters `cortextos bus list-tasks --json` on the
    `[commitment:<meeting_id>/<id>]` marker embedded in each task's
    description (see the Sink-1 `desc` construction in fanout()).

    Finding 2: matching on a bare commitment_id substring (the pre-fix
    behavior) could attach a wholly unrelated task whose description merely
    contained the same id — e.g. from a different meeting. The regex below
    anchors on the exact `meeting_id/commitment_id` pair. If more than one
    bus task carries that exact pair (should not happen on a healthy bus,
    but it is an external system), prefer the one whose title equals the
    commitment's text; otherwise fall back to the newest (`created_at`) and
    log the ambiguity to stderr rather than silently guessing."""
    out = _run(["cortextos", "bus", "list-tasks", "--json"])
    if not out:
        return ""
    try:
        tasks = json.loads(out)
    except ValueError:
        LOGGER.warning("list-tasks output was not JSON — cannot find existing task")
        return ""
    if not isinstance(tasks, list):
        return ""
    pattern = re.compile(r"\[commitment:" + re.escape(meeting_id) + "/" + re.escape(commitment_id) + r"\]")
    candidates = [
        task for task in tasks
        if isinstance(task, dict) and pattern.search(str(task.get("desc") or task.get("description") or ""))
    ]
    if not candidates:
        return ""
    if len(candidates) == 1:
        return str(candidates[0].get("id") or "")
    exact = [t for t in candidates if str(t.get("title") or "") == expected_text]
    if len(exact) == 1:
        LOGGER.warning(
            "ambiguous commitment lookup for %s/%s: %d candidates, title match wins",
            meeting_id, commitment_id, len(candidates),
        )
        return str(exact[0].get("id") or "")
    newest = sorted(candidates, key=lambda t: str(t.get("created_at") or t.get("createdAt") or ""))[-1]
    LOGGER.warning(
        "ambiguous commitment lookup for %s/%s: %d candidates, using newest",
        meeting_id, commitment_id, len(candidates),
    )
    return str(newest.get("id") or "")


def prod_post_briefs(commitment: dict[str, Any]) -> bool:
    """POST one commitment to $BRIEFS_INGEST_URL (x-api-key: $TASKS_INGEST_TOKEN).

    Matches the frank2 meeting-commitments-worker ingest contract: JSON body
    {"commitments": [ {...} ]} with server-side dedup by deterministic id. Missing env
    → DEGRADED: log + return False (skip BRIEFS), never crash.
    """
    ingest_url = os.environ.get("BRIEFS_INGEST_URL", "").strip()
    ingest_token = os.environ.get("TASKS_INGEST_TOKEN", "").strip()
    if not ingest_url or not ingest_token:
        LOGGER.warning(
            "BRIEFS DEGRADED: BRIEFS_INGEST_URL/TASKS_INGEST_TOKEN missing — skipping BRIEFS POST"
        )
        return False
    body = json.dumps({"commitments": [commitment]}).encode("utf-8")
    request = urllib.request.Request(ingest_url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("x-api-key", ingest_token)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            getattr(response, "status", 200)
    except Exception as exc:  # noqa: BLE001 — BRIEFS is best-effort; never crash fanout.
        LOGGER.warning("BRIEFS POST failed (non-fatal): %s", exc)
    return True


def production_deps() -> Deps:
    return Deps(
        load_full=prod_load_full,
        create_task=prod_create_task,
        create_approval=prod_create_approval,
        post_briefs=prod_post_briefs,
        add_followup=prod_add_followup,
        send_telegram=prod_send_telegram,
        dedup_surface=prod_dedup_surface,
        dedup_surface_strict=None,
        find_task_by_commitment=prod_find_task_by_commitment,
    )


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FR-004 commitment fanout worker")
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument(
        "--event-file",
        default=None,
        help="FR-002 event payload ff-meeting-event-<safeId>.json (client/type context)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Dedup-record + report which commitments would fan, but fire no sinks",
    )
    parser.add_argument(
        "--telegram-chat-id",
        default=DEFAULT_TELEGRAM_CHAT_ID,
    )
    parser.add_argument(
        "--full-file",
        default=None,
        help="FR-010 --full-file: read this fanout-meeting.json instead of spawning ff-extractor",
    )
    parser.add_argument("--no-telegram", action="store_true", help="No-op the Telegram sink")
    parser.add_argument("--no-followups", action="store_true", help="No-op the followup-row sink")
    parser.add_argument(
        "--retry-commitment",
        action="append",
        default=[],
        help="Commitment id to retry, bypassing the dedup check (repeatable)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Distinguish a dedup command FAILURE from an already-surfaced SKIP; "
        "exit 8 with `pending: <id>` (stderr) per failure",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    deps = production_deps()
    if args.full_file:
        full_path = Path(args.full_file)
        deps.load_full = lambda _mid, _p=full_path: json.loads(_p.read_text(encoding="utf-8"))
    if args.no_telegram:
        deps.send_telegram = lambda chat_id, message: None
    if args.no_followups:
        deps.add_followup = lambda **kw: ""
    if args.strict:
        deps.dedup_surface_strict = prod_dedup_surface_strict
    result = fanout(
        meeting_id=args.meeting_id,
        event_file=args.event_file,
        deps=deps,
        dry_run=args.dry_run,
        telegram_chat_id=args.telegram_chat_id,
        strict=args.strict,
        retry_commitments=frozenset(args.retry_commitment),
    )
    print(json.dumps(result.as_dict(), indent=2))
    if args.strict and result.failed:
        # G0a F-1: `pending: <id>` lines must never land on stdout — the orchestrator's
        # stdout-is-JSON-only parsing seam (Task 9) treats stdout as exactly one JSON
        # document. Print to stderr instead.
        for cid in result.failed:
            print(f"pending: {cid}", file=sys.stderr)
        return 8
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
