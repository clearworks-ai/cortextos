#!/usr/bin/env python3
"""Pre-meeting brief — deterministic, script-based, owned by pa-codex.

Josh stopped getting these "a long time ago". The investigation on 2026-09-13 found
THREE stacked silent causes, any one of which alone was fatal:

  1. The cron carried an `enabled` key that is not in cron-migration's allowlist, so
     the entry was refused before conversion — no error anywhere.
  2. Cron migration runs ONCE PER AGENT EVER (`isMigrated` short-circuit), so entries
     added to config.json afterwards never reach crons.json regardless.
  3. It fed `gws calendar +agenda`, whose JSON carries NO attendees. The scan splits
     internal vs external BY ATTENDEE EMAIL, so it could only ever return zero
     candidates. The briefs likely never worked at all.

So this does not revive the old cron, and deliberately does not spawn an LLM worker to
read a SKILL (the same fragile shape that left the meeting lane silently dead until it
was replaced by run_meeting.py). It is a script: calendar -> scan -> render -> Telegram.

  python3 pre_meeting_brief.py [--dry-run] [--min-lead 30] [--max-lead 75]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path("/Users/joshweiss/code/cortextos")
PA_STATE = REPO / "orgs/clearworksai/agents/pa-codex/state"
SURFACED = PA_STATE / "pre-meeting-brief-surfaced.txt"
CLAIMS = PA_STATE / "pre-meeting-brief-claims"
SKIP_FILE = PA_STATE / "pre-meeting-brief-skip.txt"
CRM_DIR = REPO / "orgs/clearworksai/agents/crm-codex/crm"
ORG_BRAIN = Path("/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/org-brain")
TELEGRAM_CHAT_ID = "6690120787"
TELEGRAM_AGENT_DIR = REPO / "orgs/clearworksai/agents/pa-codex"
CALENDAR = "josh@clearworks.ai"


def _run(argv: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def fetch_events(hours_ahead: int = 6) -> list[dict]:
    """Calendar events WITH attendees.

    `+agenda` omits attendees entirely, which is cause (3) above. `events list` with
    explicit params returns them, and `singleEvents` expands recurrences so a weekly
    meeting has a distinct id per occurrence (the dedup key).
    """
    now = datetime.now(timezone.utc)
    params = json.dumps({
        "calendarId": CALENDAR,
        "timeMin": now.isoformat().replace("+00:00", "Z"),
        "timeMax": (now + timedelta(hours=hours_ahead)).isoformat().replace("+00:00", "Z"),
        "singleEvents": True,
        "orderBy": "startTime",
    })
    result = _run(["gws", "calendar", "events", "list", "--params", params, "--format", "json"])
    if result.returncode != 0:
        print(f"calendar fetch failed rc={result.returncode}: {result.stderr[:200]}", file=sys.stderr)
        return []
    try:
        items = json.loads(result.stdout).get("items") or []
    except ValueError as exc:
        print(f"calendar output unparseable: {exc}", file=sys.stderr)
        return []

    events = []
    for item in items:
        start, end = item.get("start") or {}, item.get("end") or {}
        events.append({
            "id": item.get("id"),
            "summary": item.get("summary"),
            "start": start.get("dateTime") or start.get("date"),
            "end": end.get("dateTime") or end.get("date"),
            "location": item.get("location") or "",
            "calendar": CALENDAR,
            "attendees": [a.get("email") for a in (item.get("attendees") or []) if a.get("email")],
        })
    return events


def load_skips() -> list[str]:
    """Title substrings Josh never wants briefed.

    An external attendee is NOT proof a meeting needs prep: "Build Different Recording
    Sesh" has bijeoma@allsafeit.com on it and is Josh's PODCAST with a friend. Inferring
    podcast-vs-client from attendees will keep being wrong in both directions, so this
    is a file Josh edits instead.
    """
    if not SKIP_FILE.is_file():
        return []
    return [
        line.strip().lower()
        for line in SKIP_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def scan(events: list[dict], min_lead: int, max_lead: int) -> list[dict]:
    events_path = Path("/tmp/pmb-events.json")
    events_path.write_text(json.dumps({"count": len(events), "events": events}))
    result = _run([
        "cortextos", "bus", "meeting-brief-scan",
        "--events-file", str(events_path),
        "--min-lead", str(min_lead), "--max-lead", str(max_lead),
        "--crm-dir", str(CRM_DIR),
        "--state-file", str(SURFACED), "--claims-dir", str(CLAIMS),
        "--json",
    ])
    if result.returncode != 0:
        print(f"scan failed rc={result.returncode}: {result.stderr[:200]}", file=sys.stderr)
        return []
    try:
        return json.loads(result.stdout).get("candidates") or []
    except ValueError:
        return []


def client_state(slug: str) -> str:
    """Last History bullet from the org-brain page, if there is one."""
    for folder in ("clients", "orgs"):
        page = ORG_BRAIN / folder / f"{slug}.md"
        if not page.is_file():
            continue
        history = [ln.strip() for ln in page.read_text(encoding="utf-8").splitlines()
                   if ln.strip().startswith("- 20")]
        if history:
            return history[0][:300]
    return ""


def render(candidate: dict) -> str:
    start = str(candidate.get("startIso") or "")[:16].replace("T", " ")
    lines = [f"📋 {candidate.get('title') or 'Untitled'} — {start}", ""]

    external = candidate.get("externalAttendees") or []
    lines.append(f"With: {', '.join(external) or 'unknown'}")

    crm = candidate.get("crm") or {}
    matches = crm.get("matches") or []
    if matches:
        lines.append("")
        lines.append("Who they are:")
        seen = set()
        for m in matches:
            key = (m.get("name"), m.get("company"))
            if key in seen:
                continue
            seen.add(key)
            company = f" · {m['company']}" if m.get("company") else ""
            lines.append(f"- {m.get('name') or m.get('email')}{company}")

    engagements = crm.get("engagements") or []
    if engagements:
        lines.append("")
        lines.append("Engagement:")
        for e in engagements[:3]:
            org = e.get("clientOrg") or "?"
            stage = e.get("stage") or e.get("dealState") or ""
            lines.append(f"- {org}{' · ' + stage if stage else ''}")
            state = client_state(str(org).lower().replace(" ", "-"))
            if state:
                lines.append(f"  last: {state}")

    lines.append("")
    lines.append("(pre-meeting brief · pa-codex)")
    return "\n".join(lines)


def send_telegram(text: str) -> bool:
    env = dict(os.environ)
    env["CTX_AGENT_DIR"] = str(TELEGRAM_AGENT_DIR)
    try:
        result = subprocess.run(
            ["cortextos", "bus", "send-telegram", TELEGRAM_CHAT_ID, text],
            capture_output=True, text=True, timeout=60, env=env,
        )
        if result.returncode != 0:
            print(f"telegram rc={result.returncode}: {result.stderr[:200]}", file=sys.stderr)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"telegram failed: {exc}", file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--min-lead", type=int, default=30)
    parser.add_argument("--max-lead", type=int, default=75)
    args = parser.parse_args()

    PA_STATE.mkdir(parents=True, exist_ok=True)
    CLAIMS.mkdir(parents=True, exist_ok=True)

    candidates = scan(fetch_events(), args.min_lead, args.max_lead)
    skips = load_skips()
    sent = 0

    for candidate in candidates:
        title = str(candidate.get("title") or "").lower()
        if any(s in title for s in skips):
            print(f"skip (skip-list): {candidate.get('title')}")
            continue

        event_id = str(candidate.get("eventId") or "")
        body = render(candidate)
        if args.dry_run:
            print(body)
            print("-" * 40)
            continue

        # Claim BEFORE the send so two runs cannot double-brief; mark AFTER a
        # successful send so a failure retries on the next tick.
        claim = _run(["cortextos", "bus", "meeting-brief-claim", event_id, "--claims-dir", str(CLAIMS)])
        if claim.returncode != 0:
            print(f"already claimed: {candidate.get('title')}")
            continue
        if send_telegram(body):
            _run(["cortextos", "bus", "meeting-brief-mark", event_id, "--state-file", str(SURFACED)])
            sent += 1
        else:
            _run(["cortextos", "bus", "meeting-brief-release", event_id, "--claims-dir", str(CLAIMS)])

    print(f"candidates={len(candidates)} sent={sent}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
