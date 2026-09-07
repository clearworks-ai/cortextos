#!/usr/bin/env python3
"""FR-004: one adapter, per-consumer shapes. Deterministic. Exit 12 on bad owner_identity."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from paths import load_enabled_agents

try:
    from fetch_fireflies import _iso_from_fireflies_date
except Exception:  # pragma: no cover - defensive fallback if fetch_fireflies import fails

    def _iso_from_fireflies_date(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip().isdigit():
            return value
        try:
            ms = int(value)
        except (TypeError, ValueError):
            return value if isinstance(value, str) else None
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


OWNER_RE = re.compile(r"^[a-z0-9_-]+$")
JOSH_NAMES = {"josh", "josh weiss", "josh@clearworks.ai"}


def require_owner_identity(value: str) -> str:
    if not OWNER_RE.match(value or ""):
        print(f"owner_identity {value!r} fails ^[a-z0-9_-]+$", file=sys.stderr)
        raise SystemExit(12)
    return value


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


# CH-7 defense in depth: extract_meeting.validate_extraction rejects control
# characters/newlines outright, but a run of internal whitespace (multiple
# spaces/tabs) is still legal text and can visually fragment a rendered
# History/Open-Items line. Collapse it here, once, at the single place every
# consumer (writeback/recap/fanout payloads) is built from.
_WS_RUN_RE = re.compile(r"\s+")


def _collapse_ws(text: str) -> str:
    return _WS_RUN_RE.sub(" ", text).strip()


def _commitment_id(kind: str, source_id: str, text: str, ordinal: int) -> str:
    payload = f"{kind}:{source_id}|{_norm(text)}|{ordinal}"
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def _side(source: dict[str, Any], idx: int | None, owner_name: str) -> str:
    parts = source.get("participants") or []
    if isinstance(idx, int) and 0 <= idx < len(parts):
        side = parts[idx].get("side")
        if side == "ours":
            return "ours"
        return "theirs"
    if _norm(owner_name) in JOSH_NAMES:
        return "ours"
    return "theirs"


def _owner_identity(side: str, owner_name: str, enabled_agents: set[str] | None = None) -> tuple[str, str]:
    if side != "ours":
        ident = "pa-codex"
        return require_owner_identity(ident), f"owner: {owner_name or 'Unassigned'}"
    if _norm(owner_name) in JOSH_NAMES:
        return require_owner_identity("pa-codex"), "owner: Josh"
    # D-17: OURS owner equal (casefold) to an enabled fleet agent -> owner_identity
    # is that exact enabled name, not pa-codex.
    owner_cf = _norm(owner_name)
    for agent in enabled_agents or ():
        if _norm(agent) == owner_cf:
            return require_owner_identity(agent), f"owner: {owner_name}"
    return require_owner_identity("pa-codex"), f"owner: {owner_name or 'Josh'}"


def _deadline(deadline_iso: str | None, now: datetime) -> str | None:
    if not deadline_iso:
        return None
    try:
        day = datetime.strptime(deadline_iso[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    ceiling = now + timedelta(days=364)
    due = day.replace(hour=23, minute=59, second=59)
    if due < tomorrow or due > ceiling:
        return None
    return deadline_iso[:10]


def _emails(source: dict[str, Any], *, externals_only: bool) -> list[str]:
    out: list[str] = []
    for p in source.get("participants") or []:
        if not isinstance(p, dict):
            continue
        email = str(p.get("email") or "").strip()
        if not email or "@" not in email:
            continue
        if externals_only:
            if p.get("notetaker"):
                continue
            side = p.get("side")
            spoke = bool(p.get("spoke"))
            if not (side == "theirs" or (side == "unknown" and spoke)):
                continue
        out.append(email)
    return out


def adapt(source: dict[str, Any], validated: dict[str, Any], resolution: dict[str, Any], now: datetime) -> dict[str, Any]:
    src = source.get("source") or {}
    kind = str(src.get("kind") or "fireflies")
    source_id = str(src.get("id") or "")
    title = str(source.get("title") or "")
    date = str(source.get("occurred_at") or "")
    if date.isdigit() and len(date) in (10, 13):
        date = _iso_from_fireflies_date(date) or date
    parts = source.get("participants") or []
    enabled_agents = load_enabled_agents()
    counts: dict[str, int] = {}
    commitments_out = []
    ours_steps = []
    recap_steps = []
    open_items = []
    for c in validated.get("commitments") or []:
        if not isinstance(c, dict):
            continue
        text = _collapse_ws(str(c.get("text") or ""))
        key = _norm(text)
        ordinal = counts.get(key, 0)
        counts[key] = ordinal + 1
        cid = _commitment_id(kind, source_id, text, ordinal)
        idx = c.get("owner_participant")
        owner_name = _collapse_ws(str(c.get("owner_name") or ""))
        side = _side(source, idx if isinstance(idx, int) else None, owner_name)
        ident, label = _owner_identity(side, owner_name, enabled_agents)
        deadline = _deadline(c.get("deadline_iso") if isinstance(c.get("deadline_iso"), str) else None, now)
        commitments_out.append({"commitmentId": cid, "text": text, "side": side, "owner_identity": ident})
        recap_steps.append(
            {
                "text": text,
                "direction": "outbound" if side == "ours" else "inbound",
                "owner": owner_name or ident,
                "deadline": deadline,
            }
        )
        if side == "ours":
            ours_steps.append(
                {
                    "commitmentId": cid,
                    "text": text,
                    "direction": "internal",
                    "owner_identity": ident,
                    "owner_label": label,
                    "deadline": deadline,
                }
            )
        open_items.append(
            {
                "item": text,
                "owner": owner_name or ident,
                "deadline": deadline,
                "source": f"commitment:{cid}",
                "status": "open",
            }
        )
    attendee_names = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        attendee_names.append(str(p.get("email") or p.get("name") or "").strip())
    attendee_names = [a for a in attendee_names if a]
    recap_emails = _emails(source, externals_only=False)
    event_emails = _emails(source, externals_only=True)
    summary = validated.get("summary") or {}
    meeting_core = {
        "id": source_id,
        "source": {"kind": kind, "id": source_id},
        "title": title,
        "date": date,
        "organizer": next((p.get("email") or p.get("name") for p in parts if isinstance(p, dict)), ""),
        "attendees": attendee_names,
        "client_context": str((validated.get("classification") or {}).get("org_name") or ""),
        "summary": {
            "overview": summary.get("overview") if isinstance(summary, dict) else "",
            "bullets": summary.get("bullets") if isinstance(summary, dict) else [],
            "action_items": [c["text"] for c in commitments_out],
        },
        "decisions": [
            _collapse_ws(str(d.get("text") or "")) for d in (validated.get("decisions") or []) if isinstance(d, dict)
        ],
        "open_questions": [
            _collapse_ws(str(oq.get("text") or ""))
            for oq in (validated.get("open_questions") or [])
            if isinstance(oq, dict)
        ],
        "next_steps": recap_steps,
        "meeting_type": validated.get("meeting_type") or "delivery",
        "deal_state": validated.get("deal_state") or resolution.get("deal_state") or None,
        "commitment_ids": [c["commitmentId"] for c in commitments_out],
        "resolution": {
            "home_path": resolution.get("home_path"),
            "node": resolution.get("node"),
            "rule": resolution.get("rule"),
            "created": resolution.get("created"),
            "relationship": resolution.get("relationship"),
            "confidence": resolution.get("confidence"),
            "counterparty": resolution.get("counterparty_slug"),
        },
        "promotion": validated.get("proposed_delivery_state"),
        "open_items": open_items,
    }
    recap_meeting = dict(meeting_core)
    recap_meeting["attendees"] = recap_emails
    writeback = {"meetings": [meeting_core]}
    recap = {"meetings": [recap_meeting]}
    event = {
        "meeting_id": source_id,
        "client": str((validated.get("classification") or {}).get("org_name") or ""),
        # D-08: meeting_type is recorded in resolution.json + the meeting note only —
        # never in event.json. FR-004 fixes it to "delivery" so meeting-crm-sync
        # (which reads event.json) never mutates pipeline.json for this meeting.
        "meeting_type": "delivery",
        "attendees": event_emails,
        "commitmentIds": [c["commitmentId"] for c in commitments_out],
        "writeback_ok": False,
    }
    fanout = {"mode": "full", "meetings": [{**meeting_core, "next_steps": ours_steps}]}
    return {
        "writeback-payload.json": writeback,
        "recap-payload.json": recap,
        "event.json": event,
        "fanout-meeting.json": fanout,
    }


def _dump(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    args = p.parse_args(argv)
    source_dir = Path(args.source)
    try:
        source = json.loads((source_dir / "source.json").read_text(encoding="utf-8"))
        validated = json.loads((source_dir / "validated.json").read_text(encoding="utf-8"))
        resolution = json.loads((source_dir / "resolution.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        # FR-012 exit-code table: FR-004 (this script) failures exit 12.
        return 12
    now = datetime.now(timezone.utc)
    try:
        files = adapt(source, validated, resolution, now)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 12
    for name, obj in files.items():
        atomic_write(source_dir / name, _dump(obj))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
