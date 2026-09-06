#!/usr/bin/env python3
"""Meeting-writeback filing (extracted from the meeting-writeback-worker SKILL heredoc).

Files NEW meeting intelligence from `/tmp/ff-writeback.json` into
`knowledge/meetings/*.md` and writes it back into `knowledge/clients/*.md`,
appends the Fireflies meeting id to the ledger, and writes the FR-002
per-meeting event payload file `ff-meeting-event-<safeId>.json` that the daemon
on-worker-success hook consumes to emit `crm.meeting.completed` exactly once.

Behavior is byte-identical to the former SKILL heredoc, PLUS an FR-008 exclusive
per-client-file lock (fcntl.flock on a sibling `<client>.md.lock`) so two workers
filing the SAME client concurrently serialize their read-modify-write instead of
clobbering each other's History/Open-Items.

Inputs (unchanged from the heredoc):
  ORG_ROOT     env  — org root (knowledge/ lives under it)
  LEDGER_FILE  env  — ledger append path
  PAYLOAD_PATH      — /tmp/ff-writeback.json  (override via --payload)
  FF_MEETING_ID       env (optional) — webhook fast-path filter
  CTX_TMP             env (optional, default /tmp) — event-payload dir
  FF_EVENT_PAYLOAD_PATH env (optional) — override for the single FF_MEETING_ID event file

Output: the same result JSON on stdout (written_count / written_meetings /
created_client_count / created_clients / flags). Exit code is the WRITEBACK_RC
the SKILL reads.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

_BRAIN_DIR = Path(__file__).resolve().parents[5] / "scripts" / "brain"
if str(_BRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(_BRAIN_DIR))
from atomic import atomic_write  # noqa: E402
from writeback_render import (  # noqa: E402
    home_path_for,
    payload_has_resolution,
    planned_files,
    print_dry_run,
)


@contextlib.contextmanager
def client_file_lock(client_path: Path):
    """FR-008: exclusive advisory lock over one client file's read-modify-write.

    Locks a sibling `<client_path>.lock` with fcntl.flock(LOCK_EX). Advisory
    flock is process-wide on a single machine, so two writeback workers filing
    the SAME client serialize here (the second blocks until the first releases),
    which prevents the parse_client_sections -> write_text RMW race that would
    otherwise clobber a concurrently-written History entry. The lockfile itself
    is never the data file — it only carries the lock.
    """
    lock_path = client_path.with_name(client_path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_handle = open(lock_path, "w", encoding="utf-8")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        lock_handle.close()


def _paths(org_root: Path):
    knowledge_dir = org_root / "knowledge"
    meetings_dir = knowledge_dir / "meetings"
    clients_dir = knowledge_dir / "clients"
    template_path = clients_dir / "_template.md"
    return knowledge_dir, meetings_dir, clients_dir, template_path


def collapse_ws(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", collapse_ws(value).lower()).strip("-")
    return normalized or "client"


def strip_inbound_prefix(text: str) -> str:
    return re.sub(r"^\[inbound\]\s*[^:]+:\s*", "", collapse_ws(text))


def escape_cell(value: str) -> str:
    return collapse_ws(value).replace("|", "/")


def parse_context_client_name(client_context: str) -> str:
    match = re.search(r"client=([^.;]+)", client_context or "")
    return collapse_ws(match.group(1)) if match else ""


def client_name_from_file(path: Path) -> str:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith("# Client:"):
            return collapse_ws(raw_line.split(":", 1)[1])
    return collapse_ws(path.stem.replace("-", " ").title())


def is_internal_person(value: str) -> bool:
    lowered = collapse_ws(value).lower()
    return "josh weiss" in lowered or "josh@clearworks.ai" in lowered or "clearworks.ai" in lowered


def best_contact_line(meeting: dict[str, object]) -> str:
    candidates: list[str] = []
    organizer = collapse_ws(str(meeting.get("organizer") or ""))
    attendees = meeting.get("attendees") or []
    if organizer and not is_internal_person(organizer):
        candidates.append(organizer)
    if isinstance(attendees, list):
        for attendee in attendees:
            label = collapse_ws(str(attendee))
            if label and not is_internal_person(label):
                candidates.append(label)
    if candidates:
        return f"{candidates[0]} — unknown role — {candidates[0]}"
    return "Auto-created from meeting writeback — unknown role — unknown contact"


def seed_client_file(path: Path, client_name: str, meeting: dict[str, object], template_path: Path) -> None:
    if template_path.exists():
        body = template_path.read_text(encoding="utf-8")
    else:
        body = "\n".join(
            [
                "# Client: [Name]",
                "",
                "## Contacts",
                "",
                "- [Name] — [role] — [email/phone]",
                "",
                "## Current state",
                "",
                "TODO",
                "",
                "## What we're delivering",
                "",
                "TODO",
                "",
                "## Financials",
                "",
                "- Deal value: TODO",
                "- Status: TODO",
                "",
                "## History (dated, newest first)",
                "",
                "- YYYY-MM-DD — TODO",
                "",
                "## Open Items",
                "",
                "| Item | Owner | Deadline | Source | Status |",
                "|---|---|---|---|---|",
                "| | | | | |",
                "",
            ]
        )
    body = re.sub(r"^# Client:.*$", f"# Client: {client_name}", body, count=1, flags=re.MULTILINE)
    body = body.replace("- [Name] — [role] — [email/phone]", f"- {best_contact_line(meeting)}", 1)
    path.write_text(body.rstrip() + "\n", encoding="utf-8")


def parse_client_sections(
    path: Path, client_name: str, meeting: dict[str, object], template_path: Path
) -> tuple[str, dict[str, list[str]]]:
    if not path.exists():
        seed_client_file(path, client_name, meeting, template_path)
    lines = path.read_text(encoding="utf-8").splitlines()
    title = lines[0] if lines and lines[0].startswith("# Client:") else f"# Client: {client_name}"
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in lines[1:]:
        if raw_line.startswith("## "):
            current = raw_line[3:].strip()
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(raw_line)
    return title, sections


def clean_lines(lines: list[str], *, default: list[str]) -> list[str]:
    kept = [line.rstrip() for line in lines if line.strip()]
    return kept or default


def parse_existing_open_item_rows(lines: list[str]) -> list[str]:
    rows: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line.startswith("|"):
            continue
        if "Item | Owner | Deadline | Source | Status" in line:
            continue
        if set(line) <= {"|", "-", " "}:
            continue
        cells = [collapse_ws(cell) for cell in line.strip("|").split("|")]
        if not any(cells):
            continue
        rows.append("| " + " | ".join(escape_cell(cell) for cell in cells[:5]) + " |")
    return rows


def parse_date_iso(raw_date: str) -> str:
    text = collapse_ws(raw_date)
    if not text:
        return datetime.now(timezone.utc).date().isoformat()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return datetime.now(timezone.utc).date().isoformat()


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    kept: list[str] = []
    for value in values:
        cleaned = collapse_ws(value)
        if not cleaned:
            continue
        marker = cleaned.lower()
        if marker in seen:
            continue
        seen.add(marker)
        kept.append(cleaned)
    return kept


def guess_client_file(
    meeting: dict[str, object],
    existing_clients: dict[str, Path],
    clients_dir: Path,
    template_path: Path,
) -> tuple[Path, str, bool, str | None]:
    client_context = collapse_ws(str(meeting.get("client_context") or ""))
    context_name = parse_context_client_name(client_context)
    if context_name:
        slug = slugify(context_name)
        if slug in existing_clients:
            path = existing_clients[slug]
            return path, client_name_from_file(path), False, None

    haystack = slugify(
        " ".join(
            [
                collapse_ws(str(meeting.get("title") or "")),
                collapse_ws(str(meeting.get("organizer") or "")),
                *[collapse_ws(str(item)) for item in (meeting.get("attendees") or []) if item],
            ]
        )
    )
    best_slug = ""
    best_path: Path | None = None
    for slug, path in existing_clients.items():
        if slug and slug in haystack and len(slug) > len(best_slug):
            best_slug = slug
            best_path = path
    if best_path is not None:
        return best_path, client_name_from_file(best_path), False, None

    candidates: list[str] = []
    organizer = collapse_ws(str(meeting.get("organizer") or ""))
    if organizer and not is_internal_person(organizer):
        candidates.append(organizer)
    attendees = meeting.get("attendees") or []
    if isinstance(attendees, list):
        for attendee in attendees:
            label = collapse_ws(str(attendee))
            if label and not is_internal_person(label):
                candidates.append(label)
    guess = context_name
    if not guess and candidates:
        first = candidates[0]
        if "@" in first:
            domain = first.split("@", 1)[1].split(".", 1)[0]
            guess = collapse_ws(domain.replace("-", " ").title())
        else:
            guess = first
    guess = guess or "Unknown Client"
    path = clients_dir / f"{slugify(guess)}.md"
    created = not path.exists()
    if created:
        seed_client_file(path, guess, meeting, template_path)
        existing_clients[path.stem.lower()] = path
    return path, guess, created, (f"created client file for {guess}" if created else None)


def derive_topic(title: str, client_name: str) -> str:
    cleaned = collapse_ws(title) or "meeting"
    if client_name:
        cleaned = re.sub(re.escape(client_name), "", cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.strip(" -:|")
    return collapse_ws(cleaned) or collapse_ws(title) or "meeting"


def meeting_attendees_summary(meeting: dict[str, object]) -> str:
    attendees = meeting.get("attendees") or []
    values: list[str] = []
    organizer = collapse_ws(str(meeting.get("organizer") or ""))
    if organizer:
        values.append(organizer)
    if isinstance(attendees, list):
        values.extend(collapse_ws(str(attendee)) for attendee in attendees if attendee)
    return ", ".join(dedupe_preserve_order(values)) or "Unknown"


def build_outcomes(summary: dict[str, object]) -> list[str]:
    return dedupe_preserve_order(
        [
            collapse_ws(str(summary.get("overview") or "")),
            collapse_ws(str(summary.get("bullets") or "")),
            collapse_ws(str(summary.get("action_items") or "")),
        ]
    )


def build_decisions(meeting: dict[str, object]) -> list[str]:
    raw = meeting.get("decisions")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return dedupe_preserve_order([collapse_ws(str(item)) for item in raw if collapse_ws(str(item))])


def build_deal_state(meeting: dict[str, object]) -> str:
    return collapse_ws(str(meeting.get("deal_state") or ""))


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "", value.lower())[:40]


def _event_path_for(meeting_id: str, ff_meeting_id: str, ctx_tmp: str) -> Path:
    override = (os.environ.get("FF_EVENT_PAYLOAD_PATH") or "").strip()
    if override and ff_meeting_id and _safe_id(meeting_id) == _safe_id(ff_meeting_id):
        return Path(override)
    return Path(ctx_tmp) / f"ff-meeting-event-{_safe_id(meeting_id)}.json"


def process_writeback(
    payload: dict[str, object],
    *,
    org_root: Path,
    ledger_path: Path,
    ff_meeting_id: str = "",
    ctx_tmp: str = "/tmp",
) -> dict[str, object]:
    """File all meetings from the payload. Returns the result dict printed to stdout.

    Each client-file read-modify-write is guarded by client_file_lock (FR-008).
    """
    _, meetings_dir, clients_dir, template_path = _paths(org_root)
    meetings_dir.mkdir(parents=True, exist_ok=True)
    clients_dir.mkdir(parents=True, exist_ok=True)

    meetings = payload.get("meetings") or []
    if not isinstance(meetings, list):
        meetings = []

    existing_clients = {
        path.stem.lower(): path
        for path in clients_dir.glob("*.md")
        if path.name != "_template.md"
    }

    written_meetings: list[str] = []
    created_clients: list[str] = []
    flags: list[str] = []
    event_payloads: list[dict[str, object]] = []

    with ledger_path.open("a", encoding="utf-8") as ledger_handle:
        for meeting in meetings:
            if not isinstance(meeting, dict):
                continue
            meeting_id = collapse_ws(str(meeting.get("id") or ""))
            if not meeting_id:
                continue

            client_path, client_name, created_client, flag = guess_client_file(
                meeting, existing_clients, clients_dir, template_path
            )
            if created_client:
                created_clients.append(client_name)
            if flag:
                flags.append(flag)

            meeting_date = parse_date_iso(str(meeting.get("date") or ""))
            topic = derive_topic(str(meeting.get("title") or ""), client_name)
            meeting_filename = f"{meeting_date}-{slugify(client_name)}-{slugify(topic)}.md"
            meeting_path = meetings_dir / meeting_filename
            meeting_rel = f"knowledge/meetings/{meeting_filename}"

            summary = meeting.get("summary") or {}
            if not isinstance(summary, dict):
                summary = {}
            next_steps = meeting.get("next_steps") or []
            if not isinstance(next_steps, list):
                next_steps = []

            outcomes = build_outcomes(summary)
            decisions = build_decisions(meeting)
            deal_state = build_deal_state(meeting)
            action_rows: list[str] = []
            open_item_rows: list[str] = []
            for step in next_steps:
                if not isinstance(step, dict):
                    continue
                item_text = strip_inbound_prefix(str(step.get("text") or ""))
                if not item_text:
                    continue
                owner = collapse_ws(str(step.get("owner") or "")) or "NEEDS-OWNER"
                deadline = collapse_ws(str(step.get("deadline") or "")) or "NEEDS-DEADLINE"
                action_rows.append(f"| {escape_cell(item_text)} | {escape_cell(owner)} | {escape_cell(deadline)} |")
                open_item_rows.append(
                    f"| {escape_cell(item_text)} | {escape_cell(owner)} | {escape_cell(deadline)} | {escape_cell(meeting_rel)} | OPEN |"
                )

            meeting_lines = [
                f"# {meeting_date} · {client_name} · {topic}",
                "",
                f"**Attendees:** {meeting_attendees_summary(meeting)} | **Source:** fireflies:{meeting_id} | **Processed:** yes",
                "",
                "## Meeting",
                "",
                f"- Date: {meeting_date}",
                f"- Client: {client_name}",
                f"- Topic: {topic}",
            ]
            organizer = collapse_ws(str(meeting.get("organizer") or ""))
            if organizer:
                meeting_lines.append(f"- Organizer: {organizer}")
            meeting_lines.extend(["", "## Outcomes", ""])
            if outcomes:
                meeting_lines.extend(f"- {item}" for item in outcomes)
            else:
                meeting_lines.append("- none")
            meeting_lines.extend(["", "## Action Items", "", "| Task | Owner | Due |", "|---|---|---|"])
            if action_rows:
                meeting_lines.extend(action_rows)
            else:
                meeting_lines.append("| none | | |")
            meeting_lines.extend(["", "## Decisions", ""])
            if decisions:
                meeting_lines.extend(f"- {item}" for item in decisions)
            else:
                meeting_lines.append("- none")
            meeting_lines.extend(["", "## Deal-State Changes", ""])
            meeting_lines.append(f"- {deal_state}" if deal_state else "- no change")
            meeting_lines.append("")
            meeting_path.write_text("\n".join(meeting_lines), encoding="utf-8")

            # FR-008: serialize the client-file read-modify-write so two workers
            # filing the SAME client never clobber each other's History/Open-Items.
            with client_file_lock(client_path):
                title, sections = parse_client_sections(client_path, client_name, meeting, template_path)
                history_lines = [
                    line.rstrip()
                    for line in sections.get("History (dated, newest first)", [])
                    if line.strip() and line.strip() not in {"- YYYY-MM-DD — TODO", "- No dated meeting history surfaced yet"}
                ]
                history_block = [
                    f"- {meeting_date} — {topic} (meeting: {meeting_rel})",
                    f"  - Outcomes: {' ; '.join(outcomes) if outcomes else 'none'}",
                    f"  - Decisions: {' ; '.join(decisions) if decisions else 'none'}",
                    f"  - Deal-state: {deal_state if deal_state else 'no change'}",
                ]
                if meeting_rel not in "\n".join(history_lines):
                    history_lines = history_block + history_lines

                existing_rows = parse_existing_open_item_rows(sections.get("Open Items", []))
                all_open_rows = open_item_rows + existing_rows

                rebuilt = [
                    title if title.startswith("# Client:") else f"# Client: {client_name}",
                    "",
                    "## Contacts",
                    "",
                    *clean_lines(sections.get("Contacts", []), default=[f"- {best_contact_line(meeting)}"]),
                    "",
                    "## Current state",
                    "",
                    *clean_lines(sections.get("Current state", []), default=["TODO"]),
                    "",
                    "## What we're delivering",
                    "",
                    *clean_lines(sections.get("What we're delivering", []), default=["TODO"]),
                    "",
                    "## Financials",
                    "",
                    *clean_lines(sections.get("Financials", []), default=["- Deal value: TODO", "- Status: TODO"]),
                    "",
                    "## History (dated, newest first)",
                    "",
                    *(history_lines or ["- No dated meeting history surfaced yet"]),
                    "",
                    "## Open Items",
                    "",
                    "| Item | Owner | Deadline | Source | Status |",
                    "|---|---|---|---|---|",
                    *(all_open_rows or ["| | | | | |"]),
                    "",
                ]
                client_path.write_text("\n".join(rebuilt), encoding="utf-8")

            ledger_handle.write(f"{meeting_id} {int(datetime.now(timezone.utc).timestamp())}\n")
            written_meetings.append(meeting_rel)

            # FR-002: per-meeting event payload. Keyed by safeId(meeting_id) so concurrent
            # meetings never collide on a shared /tmp file (FR-008). The daemon on-worker-
            # success hook reads this file to emit crm.meeting.completed exactly once.
            event_meeting_type = collapse_ws(str(meeting.get("meeting_type") or "")) or "other"
            event_attendees = [
                collapse_ws(str(a))
                for a in (meeting.get("attendees") or [])
                if collapse_ws(str(a))
            ]
            # commitmentIds pass THROUGH — emit whatever ids are already present; else [].
            raw_commitment_ids = meeting.get("commitmentIds") or meeting.get("commitment_ids") or []
            if not isinstance(raw_commitment_ids, list):
                raw_commitment_ids = []
            event_commitment_ids = [collapse_ws(str(c)) for c in raw_commitment_ids if collapse_ws(str(c))]
            event_payloads.append(
                {
                    "meeting_id": meeting_id,
                    "meeting_type": event_meeting_type,
                    "attendees": event_attendees,
                    "client": client_name,
                    "commitmentIds": event_commitment_ids,
                    "writeback_ok": True,
                }
            )

    # FR-002: write the per-meeting event payload file(s) the daemon hook consumes.
    # Path derivation MUST match src/daemon/meeting-event-emit.ts + webhook-bridge safeId:
    #   safeId = re.sub(r'[^a-z0-9_-]','', meeting_id.lower())[:40]
    #   path   = FF_EVENT_PAYLOAD_PATH if set else f"{CTX_TMP or /tmp}/ff-meeting-event-{safeId}.json"
    for _event in event_payloads:
        _mid = _event.get("meeting_id") or ""
        if not _mid:
            continue
        # Webhook fast path: only the FF_MEETING_ID meeting; poll path: all written meetings.
        if ff_meeting_id and _safe_id(str(_mid)) != _safe_id(ff_meeting_id):
            continue
        _event_path_for(str(_mid), ff_meeting_id, ctx_tmp).write_text(json.dumps(_event), encoding="utf-8")

    return {
        "written_count": len(written_meetings),
        "written_meetings": written_meetings,
        "created_client_count": len(created_clients),
        "created_clients": created_clients,
        "flags": flags,
    }


def _load_ledger_ids(ledger_path: Path) -> set[str]:
    if not ledger_path.exists():
        return set()
    return {
        line.strip().split()[0]
        for line in ledger_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


def _append_ledger_atomic(ledger_path: Path, key: str) -> bool:
    """G0b C2-1 (D-15 spec line 58 / FR-005 line 192): every resolution-mode
    write is temp + os.replace — including the ledger append, which was a
    bare `open(..., "a")` in the round-2 draft. `atomic_write` is already
    imported above (used for the home/note writes); reused here rather than
    a separate 6-line helper since it's confirmed importable from this
    file's location.

    G2-P1-4: the read-modify-write (read existing -> append -> atomic_write)
    was not serialized, so two concurrent applies could each read the same
    "existing" snapshot and the second write would drop the first's key.
    Reuse client_file_lock (FR-008) on a `<ledger>.lock` sibling path so
    concurrent appenders serialize here exactly like the client-file RMW.

    G3-P2 (review 2026-09-05): `apply_resolution`'s key-presence check used to
    happen entirely OUTSIDE this lock, against a `ledger_ids` set loaded once
    before its loop — so two concurrent `apply_resolution` calls (e.g. two
    writeback workers, each with their own process-local `ledger_ids`
    snapshot) filing the SAME source could both see the key absent and both
    reach this function, producing a duplicate ledger row. The presence check
    is now re-verified INSIDE the lock (the sole authoritative check) and
    this returns False without writing when the key is already present, so
    the caller must honor the return value instead of trusting its own
    pre-loaded `ledger_ids` membership test."""
    with client_file_lock(ledger_path):
        existing = ledger_path.read_text(encoding="utf-8") if ledger_path.exists() else ""
        current_ids = {line.strip().split()[0] for line in existing.splitlines() if line.strip()}
        if key in current_ids:
            return False
        if existing and not existing.endswith("\n"):
            existing += "\n"
        atomic_write(ledger_path, (existing + f"{key}\n").encode("utf-8"))
        return True


def apply_resolution(payload: dict, *, org_root: Path, ledger_path: Path) -> dict:
    """FR-005 --apply: write every planned file atomically, idempotent on
    [source: <kind>:<id>]. Raises SystemExit(7) on a genuine create-conflict
    (resolution.created is set but the target page already exists and does not
    carry our marker — see Task 3)."""
    meetings = payload.get("meetings") or []
    written: list[str] = []
    skipped: list[str] = []
    created: list[str] = []
    ledger_ids = _load_ledger_ids(ledger_path)
    for meeting in meetings:
        if not isinstance(meeting, dict):
            continue
        mid = str(meeting.get("id") or "")
        # G0b C2-2 (D-16 spec line 59 / FR-005 line 192): writeback is
        # source-agnostic — the idempotency key comes from the payload's own
        # source{kind,id} (adapt_meeting.py emits it, Task 6), never a
        # hardcoded "fireflies:" literal. Fail loud (not a silently wrong
        # key) if a resolution-mode payload is missing it — every payload
        # apply_resolution() receives has gone through the R2 adapter, which
        # always sets this field.
        src = meeting.get("source") or {}
        if not isinstance(src, dict) or not src.get("kind") or not src.get("id"):
            print(f"apply_resolution: meeting {mid!r} missing source.kind/source.id (D-16)", file=sys.stderr)
            raise SystemExit(1)
        key = f"{src['kind']}:{src['id']}"
        res = meeting.get("resolution") or {}
        is_create = bool(isinstance(res, dict) and res.get("created"))
        marker = f"[source: {key}]"
        # G2-P1-2: home_path is derivable WITHOUT reading the file (home_path_for
        # does no I/O), so it's safe to compute here to name the lock. The actual
        # read + render (planned_files) and the create-conflict check MUST happen
        # INSIDE the lock — otherwise two meetings resolving to the same home page
        # can each read stale content before either writes, and the second write
        # clobbers the first's freshly-appended History/Open-Items.
        home_path = home_path_for(org_root, meeting)
        with client_file_lock(home_path):
            planned = planned_files(org_root, meeting)
            home_path, old_home, new_home = planned[0]
            note_path, old_note, new_note = planned[1]
            if is_create and old_home and marker not in old_home:
                raise SystemExit(7)
            if marker in old_home:
                skipped.append(str(home_path))
            else:
                atomic_write(home_path, new_home.encode("utf-8"))
                written.append(str(home_path))
                if is_create:
                    created.append(str(home_path))
        if old_note:
            skipped.append(str(note_path))
        else:
            atomic_write(note_path, new_note.encode("utf-8"))
            written.append(str(note_path))
        if key in ledger_ids:
            skipped.append(f"ledger:{key}")
        else:
            # G3-P2: _append_ledger_atomic re-checks presence inside its own
            # lock and returns False (no write) if a concurrent caller filed
            # this key first -- honor that instead of assuming our stale
            # pre-loop `ledger_ids` membership test is still accurate.
            if _append_ledger_atomic(ledger_path, key):
                written.append(f"ledger:{key}")
            else:
                skipped.append(f"ledger:{key}")
            ledger_ids.add(key)
    return {"written": written, "created": created, "skipped": skipped}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="File meeting intelligence into knowledge/meetings + knowledge/clients")
    parser.add_argument("--payload", default="/tmp/ff-writeback.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    org_root = Path(os.environ["ORG_ROOT"])
    ledger_path = Path(os.environ["LEDGER_FILE"])
    ff_meeting_id = collapse_ws(os.environ.get("FF_MEETING_ID") or "")
    ctx_tmp = (os.environ.get("CTX_TMP") or "/tmp").strip() or "/tmp"

    payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))

    if args.apply:
        if payload_has_resolution(payload):
            try:
                result = apply_resolution(payload, org_root=org_root, ledger_path=ledger_path)
            except SystemExit as exc:
                return int(exc.code) if isinstance(exc.code, int) else 7
            print(json.dumps(result))
            return 0
        print("R1: --apply refused for legacy (no-resolution) payloads until R2 wiring", file=sys.stderr)
        return 64
    if args.dry_run:
        print_dry_run(org_root, payload)
        return 0
    if payload_has_resolution(payload):
        print("R1: resolution payload requires --dry-run (or R2 --apply)", file=sys.stderr)
        return 64

    result = process_writeback(
        payload,
        org_root=org_root,
        ledger_path=ledger_path,
        ff_meeting_id=ff_meeting_id,
        ctx_tmp=ctx_tmp,
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
