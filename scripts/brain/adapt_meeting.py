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

OWNER_RE = re.compile(r"^[a-z0-9_-]+$")
JOSH_NAMES = {"josh", "josh weiss", "josh@clearworks.ai"}


def require_owner_identity(value: str) -> str:
    if not OWNER_RE.match(value or ""):
        print(f"owner_identity {value!r} fails ^[a-z0-9_-]+$", file=sys.stderr)
        raise SystemExit(12)
    return value


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


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


def _owner_identity(side: str, owner_name: str) -> tuple[str, str]:
    if side != "ours":
        ident = "pa-codex"
        return require_owner_identity(ident), f"owner: {owner_name or 'Unassigned'}"
    if _norm(owner_name) in JOSH_NAMES:
        return require_owner_identity("pa-codex"), "owner: Josh"
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
    parts = source.get("participants") or []
    counts: dict[str, int] = {}
    commitments_out = []
    ours_steps = []
    recap_steps = []
    open_items = []
    for c in validated.get("commitments") or []:
        if not isinstance(c, dict):
            continue
        text = str(c.get("text") or "")
        key = _norm(text)
        ordinal = counts.get(key, 0)
        counts[key] = ordinal + 1
        cid = _commitment_id(kind, source_id, text, ordinal)
        idx = c.get("owner_participant")
        owner_name = str(c.get("owner_name") or "")
        side = _side(source, idx if isinstance(idx, int) else None, owner_name)
        ident, label = _owner_identity(side, owner_name)
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
        "decisions": [d.get("text") for d in (validated.get("decisions") or []) if isinstance(d, dict)],
        "next_steps": recap_steps,
        "meeting_type": validated.get("meeting_type") or "delivery",
        "commitment_ids": [c["commitmentId"] for c in commitments_out],
        "resolution": {
            "home_path": resolution.get("home_path"),
            "node": resolution.get("node"),
            "rule": resolution.get("rule"),
            "created": resolution.get("created"),
            "relationship": resolution.get("relationship"),
            "confidence": resolution.get("confidence"),
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
        return 12 if False else 1
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
