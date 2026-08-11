#!/usr/bin/env python3
"""FR-007 CRM-sync consumer — deterministic (no LLM) meeting → CRM writer.

The daemon spawns this on ``crm.meeting.completed`` (source-key
``meeting-crmsync:<meeting_id>``). Given a processed meeting it:

  1. Sources the meeting: the FR-002 event payload
     ``ff-meeting-event-<safeId>.json`` (meeting_id, meeting_type, attendees[],
     client, commitmentIds[]) for identity/type/attendees, and the ff-extractor
     ``--mode full`` payload for decisions / deal_state / sentiment (deal_state is
     NOT in the event payload). Missing sources are logged and skipped — never
     fabricated.
  2. Upserts a contact per EXTERNAL attendee via ``upsert-contact.py`` (moves the
     upsert that lived in ``fireflies-ingest.py:upsert_contacts``).
  3. Appends ONE ``type=meeting`` interaction per contact to ``interactions.jsonl``
     via ``add-interaction.py``, dual-attached to the contact(s) AND (via
     ``deal_state`` / stage) any matching deal. Idempotent by the
     ``fireflies:<meeting_id>`` source-ref: a re-run appends nothing new
     (add-interaction dedups on source_ref + contact_id).
  4. Deal-stage SALES-ONLY: IF ``meeting_type == sales`` AND the extracted
     ``deal_state`` deterministically maps to a real pipeline stage AND a matching
     engagement exists → drives ``upsert-engagement.py`` (writes ``pipeline.json``).
     IF ``meeting_type != sales`` → NEVER touches pipeline.json (the stage-writer is
     not even constructed).

All subprocess execution goes through the module-level ``_run`` seam so tests can
assert the produced commands without touching live CRM files. Contact/pipeline
LOOKUPS honour ``CRM_CONTACTS_PATH`` / ``CRM_PIPELINE_PATH`` (temp fixtures in tests).

Usage:
  meeting-crm-sync.py --meeting-id <fireflies_id>
  meeting-crm-sync.py --event-file /path/to/ff-meeting-event-<safeId>.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


CRM = Path(__file__).resolve().parent
UPSERT_CONTACT = CRM / "upsert-contact.py"
ADD_INTERACTION = CRM / "add-interaction.py"
UPSERT_ENGAGEMENT = CRM / "upsert-engagement.py"
FF_EXTRACTOR = CRM.parent.parent / "pa" / "scripts" / "ff-extractor.py"

SLUGIFY_RE = re.compile(r"[^a-z0-9]+")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Clearworks-internal domains: attendees on these are our side, not CRM contacts.
INTERNAL_DOMAINS = {"clearworks.ai", "clearworksai.com"}

# Deterministic deal_state -> KNOWN_STAGES map (case-insensitive substring). Ordered:
# first matching group wins. Mirrors ingest-meeting-decisions.py so a stage flip only
# happens on an explicit mapped phrase — an LLM sentence never silently moves a deal.
# Every target MUST be a member of upsert-engagement.py's KNOWN_STAGES.
DEAL_STATE_STAGE_MAP: list[tuple[tuple[str, ...], str]] = [
    (("closed lost", "closed_lost", "went lost", "we lost", "they passed", "passed on"), "closed_lost"),
    (("signed", "verbal yes", "closed won", "closed_won", "deal won"), "won"),
    (("proposal sent", "sent the proposal", "sow sent", "sent the sow"), "proposal_sent"),
    (("negotiat",), "negotiation"),
    (("qualified",), "qualified"),
    (("went cold", "stalled", "dormant"), "dormant"),
]


def _log(msg: str) -> None:
    print(f"[meeting-crm-sync] {msg}", file=sys.stderr)


def slugify(value: str) -> str:
    slug = SLUGIFY_RE.sub("-", (value or "").strip().lower()).strip("-")
    return slug or "contact"


def _is_email(value: str) -> bool:
    return bool(EMAIL_RE.match((value or "").strip()))


def _email_domain(email: str) -> str:
    return (email or "").split("@")[-1].strip().lower()


def _contacts_path() -> Path:
    return Path(os.environ.get("CRM_CONTACTS_PATH", CRM / "contacts.json"))


def _pipeline_path() -> Path:
    return Path(os.environ.get("CRM_PIPELINE_PATH", CRM / "pipeline.json"))


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _run(argv: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    """Single subprocess seam — tests monkeypatch this to capture argv without executing."""
    return subprocess.run(argv, capture_output=True, text=True, env=env, cwd=str(CRM))


# --------------------------------------------------------------------------- sourcing


def _safe_meeting_id(meeting_id: str) -> str:
    """Match src/daemon/meeting-event-emit.ts safeMeetingId() so we can locate the payload."""
    return re.sub(r"[^a-z0-9_-]", "", (meeting_id or "").lower())[:40]


def event_payload_path(meeting_id: str) -> Path:
    """Locate the FR-002 event payload the writeback SKILL wrote for this meeting.

    Honours FF_EVENT_PAYLOAD_PATH (explicit override, matches the daemon), else
    ``${CTX_TMP:-/tmp}/ff-meeting-event-<safeId>.json``.
    """
    override = os.environ.get("FF_EVENT_PAYLOAD_PATH")
    if override:
        return Path(override)
    tmp = os.environ.get("CTX_TMP") or "/tmp"
    return Path(tmp) / f"ff-meeting-event-{_safe_meeting_id(meeting_id)}.json"


def load_event_payload(*, meeting_id: str | None, event_file: str | None) -> dict:
    """Return the parsed ff-meeting-event payload, or {} if unavailable (logged)."""
    path = Path(event_file) if event_file else (event_payload_path(meeting_id) if meeting_id else None)
    if path is None or not path.exists():
        _log(f"event payload not found (path={path}); continuing without it")
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _log(f"event payload unreadable at {path}: {exc}; continuing without it")
        return {}
    return payload if isinstance(payload, dict) else {}


def load_full_meeting(meeting_id: str) -> dict:
    """Run ff-extractor --mode full for this meeting; return the per-meeting dict or {}.

    ff-extractor needs live API keys and network — a failure is logged and the sync
    proceeds with whatever the event payload supplied (deal_state simply absent).
    """
    if not meeting_id:
        return {}
    try:
        res = _run(
            ["python3", str(FF_EXTRACTOR), "--mode", "full", "--meeting-id", meeting_id],
            env=os.environ.copy(),
        )
    except OSError as exc:
        _log(f"ff-extractor could not be spawned: {exc}; deal_state unavailable")
        return {}
    if res.returncode != 0:
        _log(f"ff-extractor rc={res.returncode}: {(res.stderr or '').strip()}; deal_state unavailable")
        return {}
    try:
        payload = json.loads(res.stdout or "{}")
    except json.JSONDecodeError as exc:
        _log(f"ff-extractor stdout not JSON: {exc}; deal_state unavailable")
        return {}
    for m in payload.get("meetings", []) or []:
        if str(m.get("id") or m.get("meeting_id") or "") == meeting_id:
            return m
    # Single-meeting runs return exactly one meeting; fall back to it if id filtering missed.
    meetings = payload.get("meetings", []) or []
    return meetings[0] if len(meetings) == 1 else {}


# --------------------------------------------------------------------------- attendees


def external_attendees(event_payload: dict, full_meeting: dict) -> list[dict]:
    """Return [{name, email}] for EXTERNAL attendees.

    The event payload's ``attendees`` is a flat list of strings (emails and/or
    speaker names — see meeting-event-emit.ts). ff-extractor's attendees are the same
    shape. We union both, keep only external people, and de-dup by identity.
    """
    raw: list[str] = []
    for src in (event_payload, full_meeting):
        vals = src.get("attendees") or []
        if isinstance(vals, list):
            raw.extend(str(v).strip() for v in vals if v)

    people: list[dict] = []
    seen: set[str] = set()
    for entry in raw:
        if _is_email(entry):
            if _email_domain(entry) in INTERNAL_DOMAINS:
                continue  # our side — not a CRM contact
            key = entry.lower()
            if key in seen:
                continue
            seen.add(key)
            people.append({"name": "", "email": entry})
        else:
            key = f"name:{entry.lower()}"
            if key in seen:
                continue
            seen.add(key)
            people.append({"name": entry, "email": ""})
    return people


def _name_from_email(email: str) -> str:
    local = (email or "").split("@")[0]
    parts = re.split(r"[._-]+", local)
    return " ".join(p.capitalize() for p in parts if p) or email


# --------------------------------------------------------------------------- writes


def upsert_contacts(attendees: list[dict], source_ref: str) -> list[str]:
    """Reuse upsert-contact.py per external attendee (matches fireflies-ingest args).

    Returns the list of resulting contact ids (deduped, order-preserving). A single
    failed upsert is logged and skipped — it never aborts the rest of the sync.
    """
    contact_ids: list[str] = []
    seen: set[str] = set()
    for att in attendees:
        name = att.get("name") or (_name_from_email(att["email"]) if att.get("email") else "")
        if not name:
            continue
        argv = [
            "python3", str(UPSERT_CONTACT),
            "--id", slugify(name or att.get("email", "")),
            "--name", name,
            "--type", "person",
            "--tag", "fireflies-attendee",
            "--source-ref", source_ref,
        ]
        if att.get("email"):
            argv += ["--email", att["email"], "--match-email"]
        res = _run(argv, env=os.environ.copy())
        if res.returncode != 0:
            _log(f"upsert-contact failed for {name!r} rc={res.returncode}: {(res.stderr or '').strip()}")
            continue
        cid = (res.stdout or "").strip().splitlines()[-1].strip() if res.stdout else ""
        if not cid or cid in seen:
            continue
        seen.add(cid)
        contact_ids.append(cid)
    return contact_ids


def append_interactions(
    contact_ids: list[str], source_ref: str, summary: str, sentiment: str, deal_state: str | None
) -> list[str]:
    """Append ONE type=meeting interaction per contact (idempotent by source_ref+contact_id).

    add-interaction.py owns the dedup: same source_ref+contact_id updates in place (never a
    dup row), so a re-run of this whole worker appends nothing new. deal_state is preserved
    as free text on the row regardless of meeting_type (universal interaction logging).
    """
    logged: list[str] = []
    for cid in contact_ids:
        argv = [
            "python3", str(ADD_INTERACTION),
            "--contact-id", cid,
            "--type", "meeting",
            "--source-ref", source_ref,
            "--sentiment", sentiment,
        ]
        if summary:
            argv += ["--summary", summary]
        if deal_state:
            argv += ["--deal-state", deal_state]
        res = _run(argv, env=os.environ.copy())
        if res.returncode != 0:
            _log(f"add-interaction failed for {cid} rc={res.returncode}: {(res.stderr or '').strip()}")
            continue
        logged.append(cid)
    return logged


def map_deal_state_to_stage(deal_state: str | None) -> str | None:
    """Return a KNOWN_STAGES value if deal_state deterministically maps, else None."""
    if not deal_state:
        return None
    t = deal_state.lower()
    for keywords, stage in DEAL_STATE_STAGE_MAP:
        if any(k in t for k in keywords):
            return stage
    return None


def find_matching_engagement(contact_ids: list[str]) -> dict | None:
    """Match a contact to a pipeline engagement (primary_contact_id or contact_ids)."""
    wanted = set(contact_ids)
    if not wanted:
        return None
    for eng in _load_json(_pipeline_path()).get("engagements", []) or []:
        cids = set(eng.get("contact_ids") or [])
        if eng.get("primary_contact_id") in wanted or (cids & wanted):
            return eng
    return None


def engagement_selector(eng: dict) -> list[str] | None:
    """upsert-engagement selector args for an engagement.

    Prefer the canonical --clearpath-id; fall back to --engagement-name for
    name-only (locally-created) engagements whose clearpath_id is still null,
    so a SALES meeting's deal-stage write is NOT silently dropped (FR-007).
    Returns None when neither a usable clearpath_id nor a name is present.
    """
    cid = eng.get("clearpath_id")
    if cid is not None:
        try:
            return ["--clearpath-id", str(int(cid))]
        except (TypeError, ValueError):
            pass
    name = str(eng.get("name") or "").strip()
    if name:
        return ["--engagement-name", name]
    return None


def sync_deal_stage(
    meeting_type: str, deal_state: str | None, contact_ids: list[str], source_ref: str
) -> dict:
    """SALES-ONLY deal-stage persistence. Returns an action record for the summary.

    Constructs and runs upsert-engagement.py ONLY when meeting_type == sales AND the
    deal_state maps to a real stage AND a matching engagement exists. For any non-sales
    meeting this returns immediately WITHOUT touching pipeline.json.
    """
    if meeting_type != "sales":
        return {"deal_stage": "skipped", "reason": "not_sales", "meeting_type": meeting_type}
    if not deal_state:
        return {"deal_stage": "skipped", "reason": "no_deal_state"}

    mapped_stage = map_deal_state_to_stage(deal_state)
    if not mapped_stage:
        return {"deal_stage": "skipped", "reason": "deal_state_unmapped_preserved_as_text"}

    eng = find_matching_engagement(contact_ids)
    if eng is None:
        return {"deal_stage": "skipped", "reason": "no_engagement_for_contact", "mapped_stage": mapped_stage}
    selector = engagement_selector(eng)
    if selector is None:
        return {"deal_stage": "skipped", "reason": "engagement_unaddressable", "mapped_stage": mapped_stage}

    argv = [
        "python3", str(UPSERT_ENGAGEMENT),
        *selector,
        "--stage", mapped_stage,
        "--source-ref", source_ref,
        "--note", deal_state,
    ]
    eng_ref = eng.get("clearpath_id") if eng.get("clearpath_id") is not None else eng.get("name")
    res = _run(argv, env=os.environ.copy())
    if res.returncode != 0:
        _log(f"upsert-engagement failed rc={res.returncode}: {(res.stderr or '').strip()}")
        return {"deal_stage": "error", "engagement": eng_ref, "mapped_stage": mapped_stage}
    return {
        "deal_stage": "written",
        "engagement": eng_ref,
        "mapped_stage": mapped_stage,
        "result": (res.stdout or "").strip(),
    }


# --------------------------------------------------------------------------- orchestration


def build_summary_text(event_payload: dict, full_meeting: dict, meeting_id: str) -> str:
    """A compact deterministic interaction summary (no LLM prose invention)."""
    title = str(full_meeting.get("title") or event_payload.get("client") or "").strip()
    overview = ""
    fm_summary = full_meeting.get("summary")
    if isinstance(fm_summary, dict):
        overview = str(fm_summary.get("overview") or "").strip()
    parts = [p for p in (title, overview) if p]
    base = " — ".join(parts) if parts else "Meeting processed"
    return f"{base} (fireflies:{meeting_id})"


def process(
    *, meeting_id: str | None, event_file: str | None, dry_run: bool = False
) -> dict:
    event_payload = load_event_payload(meeting_id=meeting_id, event_file=event_file)

    # Resolve the canonical meeting_id (event payload wins if the caller passed a file).
    resolved_id = str(event_payload.get("meeting_id") or meeting_id or "").strip()
    if not resolved_id:
        _log("no meeting_id available from --meeting-id or the event payload; nothing to sync")
        return {"worker": "meeting-crm-sync", "error": "no_meeting_id"}

    full_meeting = load_full_meeting(resolved_id)

    meeting_type = str(event_payload.get("meeting_type") or full_meeting.get("meeting_type") or "other").strip().lower()
    deal_state = (full_meeting.get("deal_state") or "").strip() or None
    sentiment = str(full_meeting.get("sentiment") or "neutral").strip().lower()
    if sentiment not in {"positive", "neutral", "negative", "unknown"}:
        sentiment = "neutral"

    source_ref = f"fireflies:{resolved_id}"
    attendees = external_attendees(event_payload, full_meeting)
    summary_text = build_summary_text(event_payload, full_meeting, resolved_id)

    result: dict = {
        "worker": "meeting-crm-sync",
        "meeting_id": resolved_id,
        "meeting_type": meeting_type,
        "source_ref": source_ref,
        "deal_state": deal_state,
        "external_attendees": len(attendees),
    }

    if dry_run:
        result["dry_run"] = True
        result["would_upsert"] = [a.get("email") or a.get("name") for a in attendees]
        result["stage_gate"] = (
            "sales+mapped" if (meeting_type == "sales" and map_deal_state_to_stage(deal_state)) else "no-stage"
        )
        return result

    if not attendees:
        _log(f"no external attendees for meeting {resolved_id}; no contacts/interactions written")
        result["contacts"] = []
        result["interactions"] = []
        result.update(sync_deal_stage(meeting_type, deal_state, [], source_ref))
        return result

    contact_ids = upsert_contacts(attendees, source_ref)
    result["contacts"] = contact_ids

    result["interactions"] = append_interactions(
        contact_ids, source_ref, summary_text, sentiment, deal_state
    )

    # Deal-stage: sales-only. Never touches pipeline.json for non-sales meetings.
    result.update(sync_deal_stage(meeting_type, deal_state, contact_ids, source_ref))

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="FR-007 meeting → CRM sync consumer")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--meeting-id", help="Fireflies meeting id (locates the event payload + drives ff-extractor)")
    src.add_argument("--event-file", help="Path to an ff-meeting-event-<safeId>.json payload (fallback)")
    parser.add_argument("--dry-run", action="store_true", help="Plan the writes without executing them")
    args = parser.parse_args()

    summary = process(meeting_id=args.meeting_id, event_file=args.event_file, dry_run=args.dry_run)
    print(json.dumps(summary, indent=2))
    return 0 if "error" not in summary else 1


if __name__ == "__main__":
    raise SystemExit(main())
