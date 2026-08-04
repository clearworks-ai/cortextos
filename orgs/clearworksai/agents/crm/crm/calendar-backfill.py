#!/usr/bin/env python3
"""Calendar backfill — heartbeat-piggyback for external-attendee calendar events.

Pulls events in [now-4h, now+14d] from josh@clearworks.ai's calendar via
`gws calendar events list`, filters to events with at least one external attendee,
upserts each external attendee as a contact, and logs a single meeting interaction
per event on the primary external attendee with source-ref `calendar:<event_id>`.

Dedupe: existing `calendar:<event_id>` source-refs in interactions.jsonl are skipped.
Idempotent — re-runs are no-ops for already-logged events.

Why this exists: the dedicated calendar-ingest cron in config.json (`0 */4 * * *`)
never fires due to the daemon-side step-value parsing bug. The heartbeat cron
runs this script every 4h as the durable workaround. See
crm/calendar-ingest-rca-and-fix-spec.md for the RCA.
"""
from __future__ import annotations
import json, re, subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

CRM = Path(__file__).resolve().parent
INTERACTIONS = CRM / "interactions.jsonl"

JOSH_DOMAINS = {"clearworks.ai", "logictcg.com"}
JOSH_EMAILS = {"josh@clearworks.ai", "josh@logictcg.com", "weissjosh0@gmail.com"}

# Scheduling-system / noise patterns that aren't real CRM meetings
NOISE_SUMMARY_PATTERNS = [
    r"(?i)\bcanceled:",
    r"(?i)\bwebinar\b",
    r"(?i)\bskool\b",
    r"(?i)\bluma\b",
    r"(?i)\bappointment booked\b",
    r"(?i)\bbooked by\b",
    r"(?i)flag day",
]
NOISE_ATTENDEE_DOMAINS = {
    "calendar-notification.google.com",
    "group.calendar.google.com",
    "import.calendar.google.com",
    "resource.calendar.google.com",
    "skool.com",
    "lu.ma",
}

def slugify(s: str) -> str:
    s = re.sub(r"[^\w\s-]", "", (s or "").lower())
    s = re.sub(r"\s+", "-", s).strip("-")
    return s or "unknown"

def domain_of(email: str) -> str:
    return (email or "").lower().split("@", 1)[-1] if "@" in (email or "") else ""

def is_internal(email: str) -> bool:
    return domain_of(email) in JOSH_DOMAINS

def is_noise_summary(summary: str) -> bool:
    if not summary: return False
    return any(re.search(p, summary) for p in NOISE_SUMMARY_PATTERNS)

def load_seen_event_ids() -> set[str]:
    seen = set()
    if not INTERACTIONS.exists(): return seen
    for line in INTERACTIONS.read_text().splitlines():
        line = line.strip()
        if not line: continue
        try:
            sr = json.loads(line).get("source_ref") or ""
            if sr.startswith("calendar:"):
                seen.add(sr.split(":", 1)[1])
        except Exception: pass
    return seen

def gws_list_events() -> list[dict]:
    now = datetime.now(timezone.utc)
    t_min = (now - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_max = (now + timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = json.dumps({
        "calendarId": "josh@clearworks.ai",
        "timeMin": t_min, "timeMax": t_max,
        "singleEvents": True, "maxResults": 100, "orderBy": "startTime",
    })
    r = subprocess.run(["gws", "calendar", "events", "list",
                        "--params", params, "--format", "json"],
                       capture_output=True, text=True, timeout=60)
    # gws sometimes emits a Model Armor warning before the JSON; find the first { line.
    out = r.stdout
    brace = out.find("{")
    if brace > 0: out = out[brace:]
    try:
        return (json.loads(out).get("items") or [])
    except Exception:
        return []

def primary_external(attendees: list[dict]) -> tuple[str, str] | None:
    """Return (email, displayName) of the first non-internal, non-noise, non-Josh attendee."""
    for a in attendees:
        em = (a.get("email") or "").lower()
        if not em or "@" not in em: continue
        if em in JOSH_EMAILS: continue
        if is_internal(em): continue
        if domain_of(em) in NOISE_ATTENDEE_DOMAINS: continue
        if (a.get("self") is True): continue
        if (a.get("resource") is True): continue
        return (em, a.get("displayName") or em.split("@")[0])
    return None

def run_helper(script: str, args: list[str]) -> bool:
    r = subprocess.run(["python3", str(CRM / script)] + args,
                       capture_output=True, text=True, cwd=str(CRM))
    if r.returncode != 0:
        # Don't crash — log to stderr but continue with other events
        print(f"helper-err {script}: {r.stderr[:200]}")
    return r.returncode == 0

def main() -> int:
    seen = load_seen_event_ids()
    events = gws_list_events()
    stats = {
        "events_pulled": len(events), "logged": 0,
        "skip_already": 0, "skip_no_attendees": 0,
        "skip_no_external": 0, "skip_noise_summary": 0,
        "new_contacts": 0,
    }
    # We can't precisely count new contacts (upsert returns just the id), so we
    # approximate by tracking how many unique external attendee emails we've
    # touched that weren't in contacts.json before this run.
    contacts_path = CRM / "contacts.json"
    pre_emails = set()
    if contacts_path.exists():
        try:
            data = json.loads(contacts_path.read_text())
            for c in data.get("contacts", []):
                for e in (c.get("emails") or []):
                    if e: pre_emails.add(e.strip().lower())
        except Exception: pass

    for ev in events:
        event_id = ev.get("id")
        if not event_id: continue
        if event_id in seen:
            stats["skip_already"] += 1; continue
        summary = ev.get("summary") or "(untitled)"
        if is_noise_summary(summary):
            stats["skip_noise_summary"] += 1; continue
        attendees = ev.get("attendees") or []
        if not attendees:
            stats["skip_no_attendees"] += 1; continue
        prim = primary_external(attendees)
        if not prim:
            stats["skip_no_external"] += 1; continue

        prim_email, prim_name = prim
        contact_id = slugify(prim_name) or slugify(prim_email.split("@")[0])

        # Upsert all external attendees (in case multiple are useful)
        for a in attendees:
            em = (a.get("email") or "").lower()
            if not em or "@" not in em: continue
            if em in JOSH_EMAILS: continue
            if is_internal(em): continue
            if domain_of(em) in NOISE_ATTENDEE_DOMAINS: continue
            if a.get("self") or a.get("resource"): continue
            run_helper("upsert-contact.py", [
                "--match-email",
                "--name", a.get("displayName") or em.split("@")[0],
                "--type", "person", "--email", em,
                "--tag", "calendar-attendee",
                "--source-ref", f"calendar:{event_id}",
            ])
            if em not in pre_emails:
                stats["new_contacts"] += 1
                pre_emails.add(em)

        # Log a single interaction on the primary external attendee
        start = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date") or ""
        attendee_list = ", ".join(sorted({
            (a.get("email") or "").lower() for a in attendees
            if (a.get("email") and "@" in a.get("email") and
                not is_internal(a.get("email","").lower()) and
                a.get("email","").lower() not in JOSH_EMAILS and
                domain_of(a.get("email","").lower()) not in NOISE_ATTENDEE_DOMAINS)
        }))
        summary_text = f"[CAL] {summary} | {start[:25]} | external attendees: {attendee_list}"[:600]
        ok = run_helper("add-interaction.py", [
            "--contact-id", contact_id,
            "--type", "meeting",
            "--summary", summary_text,
            "--source-ref", f"calendar:{event_id}",
            "--sentiment", "neutral",
        ])
        if ok:
            stats["logged"] += 1
            seen.add(event_id)

    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
