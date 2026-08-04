#!/usr/bin/env python3
"""Booking-coordinator core for pa's proactive event-based Executive Assistant.

Backs the ``comms-check-worker`` (SCHEDULING-INTENT detection + no-show sweep)
and the ``booking-coordinator-worker`` (freebusy -> slot proposal draft). This is
the testable enforcement seam behind the prose SKILLs — same pattern as
``meeting_recap_draft.py`` backing meeting-recap-draft-worker.

DRAFTS ONLY. Nothing here sends email or creates a real calendar event. Slot
proposals are computed from ``gws calendar freebusy query`` output; the Gmail
draft is written via ``gws gmail +draft`` (never ``+send``); a tentative hold is
validated via ``gws calendar +insert --dry-run`` (validate only, never inserts).

Booking is 100% Google-Workspace-native: proposals offer concrete freebusy-backed
slots and the tracker row is closed by an inbound signal (calendar delta or Fireflies),
never by an external booking-page link or a poll here.

Subcommands (all print JSON to stdout, exit 0 on success):
  classify        stdin/--payload emails -> per-message intent bucket + tracker candidate rows
  propose         tracker row + freebusy JSON -> slot-proposal draft plan (drafts only)
  no-show-sweep   tracker -> rows whose call_time+45m elapsed with no close signal
  calendar-delta  new agenda snapshot + prior snapshot -> booked/moved/cancelled deltas
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
DEFAULT_TRACKER = AGENT_DIR / "state" / "booking-tracker.json"
NO_SHOW_MINUTES = 45
MAX_RECOVERY_TOUCHES = 2

# Valid Lane-B states (DESIGN-A §2). A row never leaves the tracker; it advances.
STATES = {
    "proposed",
    "booked",
    "reminded",
    "no-show-1",
    "no-show-2",
    "not-now",
    "done",
}

# Scheduling-intent phrasing → routes an inbound email to Lane B (booking).
# Kept deterministic and inspectable so the classifier can't drift; the SKILL
# prose only judges the residual ambiguous cases.
_SCHEDULING_PATTERNS = (
    r"\blet'?s (find|grab|set up|schedule|book)\b",
    r"\blet'?s (talk|chat|connect|meet)\b",
    r"\bfind a time\b",
    r"\bset up a (call|time|meeting|chat)\b",
    r"\bbook (a|the) (call|meeting|time)\b",
    r"\bschedule (a|the|some) (call|time|meeting|chat)\b",
    r"\bwhat times? (work|are you free)\b",
    r"\bwhen (are|would) you (free|available)\b",
    r"\bare you (free|available)\b",
    r"\bhop on a (call|quick call|zoom)\b",
    r"\bgrab (30|15|20|45|a few) min(ute)?s?\b",
    r"\breschedule\b",
    r"\bmove (our|the) (call|meeting)\b",
    r"\bpush (our|the) (call|meeting)\b",
    r"\bnew time\b",
    r"\byes,? (let'?s|i'?m interested|sounds good)\b",
)
_SCHEDULING_RE = re.compile("|".join(_SCHEDULING_PATTERNS), re.IGNORECASE)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_space(value: str) -> str:
    return " ".join(value.split()).strip()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_payload(args: argparse.Namespace) -> Any:
    if getattr(args, "payload", None):
        return load_json(Path(args.payload))
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def load_tracker(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("rows") if isinstance(data, dict) else data
    return rows if isinstance(rows, list) else []


def write_tracker_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    """Atomic write (repo convention: write temp in same dir, os.replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"rows": rows}, indent=2, sort_keys=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".booking-tracker.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# --------------------------------------------------------------------------- #
# classify — E1 (email) / E3 (transcript text). Detects SCHEDULING-INTENT.
# --------------------------------------------------------------------------- #

def detect_scheduling_intent(text: str) -> bool:
    return bool(_SCHEDULING_RE.search(text or ""))


def classify_emails(emails: Iterable[dict[str, Any]]) -> dict[str, Any]:
    scheduling: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    for email in emails:
        subject = str(email.get("subject", ""))
        snippet = str(email.get("snippet", email.get("body", "")))
        blob = f"{subject}\n{snippet}"
        row = {
            "id": email.get("id"),
            "from": email.get("from"),
            "subject": subject,
            "thread_id": email.get("threadId", email.get("thread_id")),
        }
        if detect_scheduling_intent(blob):
            row["bucket"] = "SCHEDULING-INTENT"
            scheduling.append(row)
        else:
            row["bucket"] = "OTHER"
            other.append(row)
    return {"scheduling_intent": scheduling, "other": other}


def scheduling_rows_to_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn SCHEDULING-INTENT emails into fresh `proposed` tracker candidate rows."""
    candidates = []
    for row in rows:
        candidates.append(
            {
                "prospect": row.get("from"),
                "thread_id": row.get("thread_id"),
                "state": "proposed",
                "call_time": None,
                "next_action": "propose-slots",
                "next_action_due": _now().isoformat(),
                "source_email_id": row.get("id"),
                "recovery_touches": 0,
            }
        )
    return candidates


# --------------------------------------------------------------------------- #
# propose — Lane B new-booking. freebusy -> 2-3 concrete slots -> draft plan.
# DRAFTS ONLY: emits the draft body + the exact `gws gmail +draft` argv the
# worker must run. Never emits a send command.
# --------------------------------------------------------------------------- #

def _parse_iso(value: str) -> datetime:
    v = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(v)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def busy_intervals(freebusy: dict[str, Any]) -> list[tuple[datetime, datetime]]:
    """Extract busy blocks from `gws calendar freebusy query` JSON."""
    intervals: list[tuple[datetime, datetime]] = []
    cals = freebusy.get("calendars", {}) if isinstance(freebusy, dict) else {}
    for cal in cals.values():
        for block in cal.get("busy", []) if isinstance(cal, dict) else []:
            try:
                intervals.append((_parse_iso(block["start"]), _parse_iso(block["end"])))
            except (KeyError, ValueError):
                continue
    intervals.sort()
    return intervals


def free_slots(
    freebusy: dict[str, Any],
    *,
    window_start: datetime,
    window_end: datetime,
    duration_min: int = 30,
    day_start_hour: int = 9,
    day_end_hour: int = 17,
    max_slots: int = 3,
    step_min: int = 30,
) -> list[dict[str, str]]:
    """Compute concrete open slots inside working hours that miss every busy block.

    Never proposes a slot overlapping a known-busy interval — kills the
    both-timezones back-and-forth failure class (DESIGN-A §4).
    """
    busy = busy_intervals(freebusy)
    slots: list[dict[str, str]] = []
    cursor = window_start
    step = timedelta(minutes=step_min)
    dur = timedelta(minutes=duration_min)
    while cursor + dur <= window_end and len(slots) < max_slots:
        hour = cursor.hour
        if day_start_hour <= hour and (cursor + dur).hour <= day_end_hour and cursor.weekday() < 5:
            slot_end = cursor + dur
            if not any(s < slot_end and cursor < e for (s, e) in busy):
                slots.append({"start": cursor.isoformat(), "end": slot_end.isoformat()})
                cursor += dur
                continue
        cursor += step
    return slots


def _fmt_slot(iso_start: str, tz_label: str) -> str:
    dt = _parse_iso(iso_start)
    return f"{dt.strftime('%a %b %-d, %-I:%M %p')} {tz_label}"


def propose_plan(
    row: dict[str, Any],
    freebusy: dict[str, Any],
    *,
    window_start: datetime,
    window_end: datetime,
    tz_label: str = "PT",
    voice: str = "",
) -> dict[str, Any]:
    """Build a drafts-only slot-proposal plan for one `proposed` row."""
    slots = free_slots(freebusy, window_start=window_start, window_end=window_end)
    if not slots:
        return {"action": "no-slots", "prospect": row.get("prospect"), "draft": None, "send": False}

    slot_lines = "\n".join(f"  • {_fmt_slot(s['start'], tz_label)}" for s in slots)
    body = (
        f"Great — happy to grab time.\n\n"
        f"A few that work on my end:\n{slot_lines}\n\n"
        f"Reply with whichever's easiest and I'll send an invite."
    )
    to = row.get("prospect")
    thread = row.get("thread_id")
    # Exact drafts-only argv the worker runs verbatim. `+draft` on the DWD shim
    # has no send path; there is intentionally no `+send` variant emitted.
    draft_argv = ["gws", "gmail", "+draft", "--to", str(to), "--body", body]
    if thread:
        draft_argv += ["--thread-id", str(thread)]
    return {
        "action": "propose-slots",
        "prospect": to,
        "slots": slots,
        "draft": {"to": to, "thread_id": thread, "body": body},
        "draft_argv": draft_argv,
        "send": False,  # invariant: this worker never sends
        # tentative hold is *validated* only, never inserted:
        "hold_validate_argv": [
            "gws", "calendar", "+insert", "--dry-run",
            "--summary", f"[TENTATIVE] Call w/ {to}",
            "--start", slots[0]["start"], "--end", slots[0]["end"],
        ],
    }


# --------------------------------------------------------------------------- #
# no-show-sweep — E5. booked rows past call_time+45m with no close signal.
# --------------------------------------------------------------------------- #

def no_show_candidates(rows: list[dict[str, Any]], now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or _now()
    out = []
    for row in rows:
        if row.get("state") != "booked":
            continue
        call = row.get("call_time")
        if not call:
            continue
        try:
            call_dt = _parse_iso(call)
        except ValueError:
            continue
        if now >= call_dt + timedelta(minutes=NO_SHOW_MINUTES) and not row.get("closed_by"):
            touches = int(row.get("recovery_touches", 0))
            if touches >= MAX_RECOVERY_TOUCHES:
                out.append({**row, "next_state": "not-now", "action": "stop-recovery"})
            else:
                out.append(
                    {
                        **row,
                        "next_state": f"no-show-{touches + 1}",
                        "action": "recovery-draft",
                    }
                )
    return out


# --------------------------------------------------------------------------- #
# calendar-delta — E2. Diff new agenda snapshot vs prior snapshot.
# --------------------------------------------------------------------------- #

def _index_events(events: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    idx = {}
    for ev in events:
        eid = ev.get("id") or ev.get("eventId")
        if eid:
            idx[str(eid)] = ev
    return idx


def calendar_deltas(new_events: list[dict[str, Any]], prior_events: list[dict[str, Any]]) -> dict[str, list]:
    new_idx = _index_events(new_events)
    old_idx = _index_events(prior_events)
    booked, moved, cancelled = [], [], []
    for eid, ev in new_idx.items():
        if eid not in old_idx:
            booked.append(ev)
        elif ev.get("start") != old_idx[eid].get("start"):
            moved.append({"id": eid, "from": old_idx[eid].get("start"), "to": ev.get("start")})
    for eid, ev in old_idx.items():
        if eid not in new_idx:
            cancelled.append(ev)
    return {"booked": booked, "moved": moved, "cancelled": cancelled}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _cmd_classify(args: argparse.Namespace) -> int:
    payload = read_payload(args)
    emails = payload.get("emails", payload) if isinstance(payload, dict) else payload
    if not isinstance(emails, list):
        emails = []
    result = classify_emails(emails)
    result["candidates"] = scheduling_rows_to_candidates(result["scheduling_intent"])
    print(json.dumps(result))
    return 0


def _cmd_propose(args: argparse.Namespace) -> int:
    row = load_json(Path(args.row))
    freebusy = load_json(Path(args.freebusy))
    ws = _parse_iso(args.window_start) if args.window_start else _now()
    we = _parse_iso(args.window_end) if args.window_end else ws + timedelta(days=4)
    plan = propose_plan(row, freebusy, window_start=ws, window_end=we, tz_label=args.tz, voice="")
    print(json.dumps(plan))
    return 0


def _cmd_no_show(args: argparse.Namespace) -> int:
    rows = load_tracker(Path(args.tracker))
    print(json.dumps({"candidates": no_show_candidates(rows)}))
    return 0


def _cmd_calendar_delta(args: argparse.Namespace) -> int:
    new_events = load_json(Path(args.new))
    prior = load_json(Path(args.prior)) if args.prior and Path(args.prior).exists() else []
    if isinstance(new_events, dict):
        new_events = new_events.get("events", [])
    if isinstance(prior, dict):
        prior = prior.get("events", [])
    print(json.dumps(calendar_deltas(new_events, prior)))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Booking-coordinator core for pa's proactive EA (drafts only)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_c = sub.add_parser("classify", help="detect SCHEDULING-INTENT in emails")
    p_c.add_argument("--payload")
    p_c.set_defaults(func=_cmd_classify)

    p_p = sub.add_parser("propose", help="freebusy -> slot-proposal draft plan (drafts only)")
    p_p.add_argument("--row", required=True)
    p_p.add_argument("--freebusy", required=True)
    p_p.add_argument("--window-start")
    p_p.add_argument("--window-end")
    p_p.add_argument("--tz", default="PT")
    p_p.set_defaults(func=_cmd_propose)

    p_n = sub.add_parser("no-show-sweep", help="booked rows past call_time+45m with no close")
    p_n.add_argument("--tracker", default=str(DEFAULT_TRACKER))
    p_n.set_defaults(func=_cmd_no_show)

    p_d = sub.add_parser("calendar-delta", help="diff agenda snapshots -> booked/moved/cancelled")
    p_d.add_argument("--new", required=True)
    p_d.add_argument("--prior")
    p_d.set_defaults(func=_cmd_calendar_delta)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
