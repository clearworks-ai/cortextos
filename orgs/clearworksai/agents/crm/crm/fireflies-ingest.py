#!/usr/bin/env python3
"""Fireflies ingest helper with deterministic CRM writes.

Usage:
  fireflies-ingest.py                   # print NEW (unseen) transcripts in window as JSON
  fireflies-ingest.py --apply          # ingest every NEW transcript in window
  fireflies-ingest.py --meeting-id ID  # ingest one transcript immediately
  fireflies-ingest.py --mark ID        # mark a transcript ID as ingested, then exit
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


CRM_DIR = Path(__file__).resolve().parent
SEEN_PATH = CRM_DIR / "ingested-transcripts.txt"
MEETINGS_DIR = CRM_DIR / "meetings"
API_URL = "https://api.fireflies.ai/graphql"
DEFAULT_LOOKBACK_S = 8100  # 2h15m: 2h cadence + 15m overlap
INTERNAL_DOMAINS = {"clearworks.ai", "logictcg.com"}
INTERNAL_EMAILS = {"josh@clearworks.ai", "josh@logictcg.com", "weissjosh0@gmail.com"}
WEEKDAY_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
ACTION_SPLIT_RE = re.compile(r"(?:\r?\n|[;•])")
NUMBERED_PREFIX_RE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s*")
DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
SLUG_RE = re.compile(r"[^a-z0-9]+")

TRANSCRIPT_FIELDS = """
  id
  title
  date
  duration
  organizer_email
  participants
  speakers {
    id
    name
  }
  summary {
    overview
    short_summary
    action_items
    keywords
    bullet_gist
  }
  transcript_url
  sentences {
    speaker_name
    text
    start_time
  }
"""


class IngestStepError(RuntimeError):
    def __init__(
        self,
        transcript_id: str,
        step: str,
        message: str,
        partial_writes: dict[str, Any],
    ) -> None:
        super().__init__(message)
        self.transcript_id = transcript_id
        self.step = step
        self.partial_writes = partial_writes


def _load_dotenv_fallback() -> None:
    """Populate os.environ from the agent-root .env for keys not already set.

    The daemon only injects Telegram-related env vars into the spawned cron
    process, not arbitrary .env keys — so scripts that need a secret like
    FIREFLIES_API_KEY must load it themselves rather than assume shell-level
    sourcing happened upstream.
    """
    env_path = CRM_DIR.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        _load_dotenv_fallback()
        value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"missing required env: {name}")
    return value


def collapse_ws(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def slugify(value: str) -> str:
    return SLUG_RE.sub("-", collapse_ws(value).lower()).strip("-") or "meeting"


def normalize_email(value: str) -> str:
    return collapse_ws(value).lower()


def is_internal_email(email: str) -> bool:
    normalized = normalize_email(email)
    if normalized in INTERNAL_EMAILS:
        return True
    domain = normalized.split("@", 1)[-1] if "@" in normalized else ""
    return domain in INTERNAL_DOMAINS


def is_internal_name(name: str) -> bool:
    lowered = collapse_ws(name).lower()
    return lowered in {"josh weiss", "josh"} or "clearworks" in lowered


def guess_name_from_email(email: str) -> str:
    local = normalize_email(email).split("@", 1)[0]
    local = re.sub(r"[._-]+", " ", local)
    return collapse_ws(local).title() or normalize_email(email)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_transcript_datetime(raw_value: Any) -> dt.datetime:
    if isinstance(raw_value, (int, float)):
        timestamp = float(raw_value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000.0
        return dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc)
    if isinstance(raw_value, str):
        value = raw_value.strip()
        if not value:
            raise ValueError("empty transcript date")
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    raise ValueError(f"unsupported transcript date: {raw_value!r}")


def load_seen() -> set[str]:
    if not SEEN_PATH.exists():
        return set()
    seen = set()
    for line in SEEN_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            seen.add(line.split()[0])
    return seen


def mark_seen(tid: str, note: str = "") -> None:
    today = now_utc().date().isoformat()
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SEEN_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{tid}  {note}  {today}\n".rstrip() + "\n")


def fireflies_query(query: str) -> dict[str, Any]:
    payload = json.dumps({"query": query})
    proc = subprocess.run(
        [
            "curl",
            "-s",
            "-X",
            "POST",
            API_URL,
            "-H",
            f"Authorization: Bearer {require_env('FIREFLIES_API_KEY')}",
            "-H",
            "Content-Type: application/json",
            "-d",
            payload,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl failed rc={proc.returncode}: {proc.stderr[:200]}")
    data = json.loads(proc.stdout)
    if (data.get("errors") or []) and not data.get("data"):
        raise RuntimeError(f"Fireflies GraphQL error: {data['errors']}")
    return data


def list_new(lookback_s: int) -> list[dict[str, Any]]:
    now = now_utc()
    frm = now - dt.timedelta(seconds=lookback_s)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    query = (
        f'query {{ transcripts(fromDate: "{iso(frm)}", toDate: "{iso(now)}") '
        f'{{ id title date duration }} }}'
    )
    data = fireflies_query(query)
    rows = (data.get("data") or {}).get("transcripts") or []
    seen = load_seen()
    return [row for row in rows if row.get("id") not in seen]


def fetch_transcript(transcript_id: str) -> dict[str, Any]:
    query = f'query {{ transcript(id: "{transcript_id}") {{ {TRANSCRIPT_FIELDS} }} }}'
    data = fireflies_query(query)
    transcript = (data.get("data") or {}).get("transcript")
    if not isinstance(transcript, dict):
        raise RuntimeError(f"transcript {transcript_id} not found")
    return transcript


def collect_external_attendees(transcript: dict[str, Any]) -> list[dict[str, str]]:
    attendees: list[dict[str, str]] = []
    seen_keys: set[str] = set()

    def add_attendee(*, name: str = "", email: str = "") -> None:
        normalized_email = normalize_email(email)
        normalized_name = collapse_ws(name or guess_name_from_email(normalized_email))
        if normalized_email and is_internal_email(normalized_email):
            return
        if not normalized_email and is_internal_name(normalized_name):
            return

        if normalized_email:
            for attendee in attendees:
                if attendee.get("email") == normalized_email:
                    if normalized_name and len(normalized_name) > len(attendee.get("name", "")):
                        attendee["name"] = normalized_name
                    return
        if normalized_name:
            first_name = normalized_name.lower().split(" ", 1)[0]
            for attendee in attendees:
                existing_email = attendee.get("email", "")
                if existing_email and guess_name_from_email(existing_email).lower() == first_name:
                    if normalized_name and len(normalized_name) > len(attendee.get("name", "")):
                        attendee["name"] = normalized_name
                    return

        key = normalized_email or normalized_name.lower()
        if not key or key in seen_keys:
            return
        seen_keys.add(key)
        attendees.append({"name": normalized_name, "email": normalized_email})

    organizer_email = normalize_email(transcript.get("organizer_email") or "")
    if organizer_email and not is_internal_email(organizer_email):
        add_attendee(email=organizer_email)

    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        for participant in participants:
            if isinstance(participant, dict):
                add_attendee(
                    name=collapse_ws(participant.get("name") or participant.get("displayName") or ""),
                    email=collapse_ws(participant.get("email") or ""),
                )
                continue
            raw = collapse_ws(participant)
            if not raw:
                continue
            if "@" in raw:
                add_attendee(email=raw)
            else:
                add_attendee(name=raw)

    speakers = transcript.get("speakers") or []
    if isinstance(speakers, list):
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            add_attendee(name=collapse_ws(speaker.get("name") or ""))

    return attendees


def split_action_items(raw_value: Any) -> list[str]:
    if isinstance(raw_value, list):
        raw_parts = [collapse_ws(item) for item in raw_value]
    else:
        text = str(raw_value or "")
        raw_parts = ACTION_SPLIT_RE.split(text) if text else []

    items: list[str] = []
    seen: set[str] = set()
    for part in raw_parts:
        collapsed = collapse_ws(part)
        # Fireflies sometimes emits owner-only Markdown headings between action
        # groups (for example ``**Josh Weiss**``). They are labels, not tasks.
        if re.fullmatch(r"\*{1,2}[^*]{1,80}\*{1,2}", collapsed):
            continue
        item = NUMBERED_PREFIX_RE.sub("", collapsed).strip()
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    return items


def resolve_due_date(action_text: str, meeting_dt: dt.datetime) -> str:
    iso_match = DATE_RE.search(action_text)
    if iso_match:
        return iso_match.group(1)

    lowered = action_text.lower()
    meeting_day = meeting_dt.date()
    if "today" in lowered:
        return meeting_day.isoformat()
    if "tomorrow" in lowered:
        return (meeting_day + dt.timedelta(days=1)).isoformat()
    if "next week" in lowered:
        return (meeting_day + dt.timedelta(days=7)).isoformat()

    next_weekday = re.search(
        r"\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lowered,
    )
    if next_weekday:
        target = WEEKDAY_INDEX[next_weekday.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        delta = 7 if delta == 0 else delta
        return (meeting_day + dt.timedelta(days=delta)).isoformat()

    weekday = re.search(
        r"\b(?:by\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lowered,
    )
    if weekday:
        target = WEEKDAY_INDEX[weekday.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        return (meeting_day + dt.timedelta(days=delta)).isoformat()

    return (meeting_day + dt.timedelta(days=7)).isoformat()


def followup_priority(action_text: str) -> str:
    lowered = action_text.lower()
    if any(token in lowered for token in ("today", "tomorrow", "asap", "urgent")):
        return "high"
    return "normal"


def meeting_file_path(transcript: dict[str, Any], primary_contact: dict[str, str]) -> Path:
    meeting_dt = parse_transcript_datetime(transcript.get("date"))
    date_slug = meeting_dt.date().isoformat()
    contact_slug = slugify(primary_contact.get("name") or primary_contact.get("email") or "contact")
    title_slug = slugify(collapse_ws(transcript.get("title") or "untitled-meeting"))[:48]
    base_name = f"{date_slug}-{contact_slug}-{title_slug}".strip("-")
    path = MEETINGS_DIR / f"{base_name}.md"
    transcript_id = collapse_ws(transcript.get("id") or "")
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if transcript_id and transcript_id in existing:
            return path
        return MEETINGS_DIR / f"{base_name}-{slugify(transcript_id)[:8]}.md"
    return path


def render_interaction_summary(transcript: dict[str, Any], meeting_path: Path) -> str:
    title = collapse_ws(transcript.get("title") or "Untitled meeting")
    summary = transcript.get("summary") or {}
    if not isinstance(summary, dict):
        summary = {}
    overview = collapse_ws(
        summary.get("overview")
        or summary.get("short_summary")
        or summary.get("bullet_gist")
        or ""
    )
    duration = transcript.get("duration")
    duration_label = ""
    if isinstance(duration, (int, float)) and duration:
        duration_label = f" ({int(duration)} min)"
    line = f"{title}{duration_label}. {overview or 'Meeting captured in Fireflies.'} Recap: meetings/{meeting_path.name}"
    return collapse_ws(line)[:600]


def render_meeting_markdown(
    transcript: dict[str, Any],
    attendees: list[dict[str, str]],
    followups: list[dict[str, str]],
    meeting_path: Path,
) -> str:
    meeting_dt = parse_transcript_datetime(transcript.get("date"))
    title = collapse_ws(transcript.get("title") or "Untitled meeting")
    summary = transcript.get("summary") or {}
    if not isinstance(summary, dict):
        summary = {}
    overview = collapse_ws(summary.get("overview") or summary.get("short_summary") or "")
    action_items = split_action_items(summary.get("action_items"))
    if not action_items:
        action_items = [item["reason"] for item in followups]

    lines = [
        f"# {title}",
        "",
        f"**Date:** {meeting_dt.date().isoformat()}",
        f"**Fireflies ID:** `{collapse_ws(transcript.get('id') or '')}`",
    ]
    duration = transcript.get("duration")
    if isinstance(duration, (int, float)) and duration:
        lines.append(f"**Duration:** {int(duration)} min")

    attendee_bits = []
    for attendee in attendees:
        if attendee.get("email"):
            attendee_bits.append(f"{attendee['name']} ({attendee['email']})")
        else:
            attendee_bits.append(attendee["name"])
    if attendee_bits:
        lines.append(f"**Attendees:** {', '.join(attendee_bits)}")

    transcript_url = collapse_ws(transcript.get("transcript_url") or "")
    if transcript_url:
        lines.append(f"**Transcript:** {transcript_url}")

    lines.extend(["", "## Short summary", "", overview or "_No summary captured._", "", "## Action items", ""])
    for item in action_items:
        lines.append(f"- {item}")

    lines.extend(["", "## Followups created", ""])
    for followup in followups:
        lines.append(
            f"- `{followup['id']}` (due {followup['due_date']}) — {followup['reason']}"
        )

    lines.extend(
        [
            "",
            "## Source",
            "",
            f"Generated deterministically by `crm/fireflies-ingest.py` from Fireflies transcript `{collapse_ws(transcript.get('id') or '')}`.",
        ]
    )
    return "\n".join(lines).strip() + "\n"


def run_helper(script: str, args: list[str]) -> str:
    result = subprocess.run(
        ["python3", str(CRM_DIR / script), *args],
        capture_output=True,
        text=True,
        cwd=str(CRM_DIR),
    )
    if result.returncode != 0:
        detail = collapse_ws(result.stderr or result.stdout or f"{script} failed")
        raise RuntimeError(f"{script} rc={result.returncode}: {detail}")
    return result.stdout.strip()


def upsert_contacts(attendees: list[dict[str, str]], source_ref: str) -> list[dict[str, str]]:
    contacts: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for attendee in attendees:
        args = [
            "--id",
            slugify(attendee["name"] or attendee["email"]),
            "--name",
            attendee["name"] or guess_name_from_email(attendee["email"]),
            "--type",
            "person",
            "--tag",
            "fireflies-attendee",
            "--source-ref",
            source_ref,
        ]
        if attendee.get("email"):
            args.extend(["--email", attendee["email"], "--match-email"])
        contact_id = collapse_ws(run_helper("upsert-contact.py", args))
        if not contact_id or contact_id in seen_ids:
            continue
        seen_ids.add(contact_id)
        contacts.append(
            {
                "id": contact_id,
                "name": attendee["name"] or guess_name_from_email(attendee["email"]),
                "email": attendee.get("email", ""),
            }
        )
    if not contacts:
        raise RuntimeError("no attendee produced a contact id")
    return contacts


def write_meeting_file(
    transcript: dict[str, Any],
    attendees: list[dict[str, str]],
    followups: list[dict[str, str]],
    meeting_path: Path,
) -> str:
    MEETINGS_DIR.mkdir(parents=True, exist_ok=True)
    meeting_path.write_text(
        render_meeting_markdown(transcript, attendees, followups, meeting_path),
        encoding="utf-8",
    )
    return f"meetings/{meeting_path.name}"


def ingest_transcript(transcript: dict[str, Any]) -> dict[str, Any]:
    transcript_id = collapse_ws(transcript.get("id") or "")
    source_ref = f"fireflies:{transcript_id}"
    partial_writes: dict[str, Any] = {
        "contacts_upserted": [],
        "interaction_logged": False,
        "followups_created": [],
        "meeting_file": None,
    }

    attendees = collect_external_attendees(transcript)
    if not attendees:
        raise IngestStepError(
            transcript_id,
            "upsert_contact",
            "no external attendees discovered for transcript",
            partial_writes,
        )

    try:
        contacts = upsert_contacts(attendees, source_ref)
        partial_writes["contacts_upserted"] = [contact["id"] for contact in contacts]
    except Exception as exc:
        raise IngestStepError(transcript_id, "upsert_contact", str(exc), partial_writes) from exc

    primary_contact = contacts[0]
    meeting_path = meeting_file_path(transcript, primary_contact)

    try:
        run_helper(
            "add-interaction.py",
            [
                "--contact-id",
                primary_contact["id"],
                "--type",
                "meeting",
                "--summary",
                render_interaction_summary(transcript, meeting_path),
                "--source-ref",
                source_ref,
                "--sentiment",
                "neutral",
            ],
        )
        partial_writes["interaction_logged"] = True
    except Exception as exc:
        raise IngestStepError(transcript_id, "add_interaction", str(exc), partial_writes) from exc

    # Blanket followup generation retired (the abbey bug): owner-matched followup
    # rows are now produced by the new chain's FR-004 fanout (meeting-fanout.py),
    # not by this ingest path. ``ingest_transcript`` no longer creates followups.
    followups: list[dict[str, str]] = []

    try:
        partial_writes["meeting_file"] = write_meeting_file(transcript, attendees, followups, meeting_path)
    except Exception as exc:
        raise IngestStepError(transcript_id, "write_meeting_file", str(exc), partial_writes) from exc

    return {
        "transcript_id": transcript_id,
        "primary_contact_id": primary_contact["id"],
        "contacts_upserted": partial_writes["contacts_upserted"],
        "interaction_logged": True,
        "followups_created": partial_writes["followups_created"],
        "meeting_file": partial_writes["meeting_file"],
    }


def run_ingest(transcripts: list[dict[str, Any]]) -> tuple[int, dict[str, Any]]:
    processed: list[dict[str, Any]] = []
    for transcript in transcripts:
        try:
            result = ingest_transcript(transcript)
        except IngestStepError as exc:
            return 1, {
                "ok": False,
                "processed": processed,
                "failed_transcript": exc.transcript_id,
                "failed_step": exc.step,
                "error": str(exc),
                "partial_writes": exc.partial_writes,
            }

        processed.append(result)
        mark_seen(result["transcript_id"], Path(result["meeting_file"]).name)

    return 0, {"ok": True, "processed": processed, "count": len(processed)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Fireflies ingest — overlap + deterministic CRM writes")
    parser.add_argument(
        "--lookback",
        type=int,
        default=DEFAULT_LOOKBACK_S,
        help="lookback window in seconds (default 8100 = 2h15m)",
    )
    parser.add_argument("--apply", action="store_true", help="ingest every unseen transcript in the lookback window")
    parser.add_argument("--meeting-id", help="ingest one Fireflies transcript id immediately")
    parser.add_argument("--mark", help="mark a transcript ID as ingested, then exit")
    parser.add_argument("--note", default="", help="optional note to store with --mark")
    args = parser.parse_args()

    if args.mark:
        mark_seen(args.mark, args.note)
        print(f"marked {args.mark}")
        return 0

    try:
        if args.meeting_id:
            exit_code, payload = run_ingest([fetch_transcript(args.meeting_id)])
            print(json.dumps(payload, indent=2, sort_keys=True))
            return exit_code

        if args.apply:
            new = list_new(args.lookback)
            transcripts = [fetch_transcript(str(row["id"])) for row in new if row.get("id")]
            exit_code, payload = run_ingest(transcripts)
            print(json.dumps(payload, indent=2, sort_keys=True))
            return exit_code

        new = list_new(args.lookback)
        print(json.dumps({"new": new, "count": len(new)}, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": collapse_ws(str(exc)) or exc.__class__.__name__}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
