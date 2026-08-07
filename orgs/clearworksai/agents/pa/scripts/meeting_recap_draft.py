#!/usr/bin/env python3
"""Plan and execute meeting recap drafting with a simple trust ladder."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
ORG_DIR = AGENT_DIR.parent.parent
DEFAULT_VOICE_PATH = ORG_DIR / "knowledge" / "voice.md"
DEFAULT_VIP_PATH = ORG_DIR / "knowledge" / "vip-clients.txt"
CLEARWORKS_DOMAINS = {"clearworks.ai"}
SUPPRESSED_NAMES = ("marcos santa ana",)
JOSH_SELF_EMAILS = {"josh@clearworks.ai", "weissjosh0@gmail.com"}
JOSH_SELF_NAMES = {"josh", "josh weiss"}
RunResult = subprocess.CompletedProcess[str]
Runner = Callable[[Sequence[str]], RunResult]


def normalize_space(value: str) -> str:
    return " ".join(value.split()).strip()


def normalize_text(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9@.\s-]+", " ", value.lower())
    return normalize_space(cleaned)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_ledger(path: Path) -> set[str]:
    if not path.exists():
        return set()
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line:
            seen.add(line.split()[0])
    return seen


def append_ledger(path: Path, meeting_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{meeting_id} {int(datetime.now(timezone.utc).timestamp())}\n")


def load_voice_guidance(path: Path) -> str:
    if not path.exists():
        return ""
    meaningful: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("TODO"):
            continue
        meaningful.append(line)
    return " ".join(meaningful[:3]).strip()


def load_vip_list(path: Path) -> set[str]:
    if not path.exists():
        return set()
    entries: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entries.add(normalize_text(line))
    return entries


def attendee_emails(meeting: dict[str, Any]) -> list[str]:
    emails: list[str] = []
    organizer = normalize_space(str(meeting.get("organizer") or ""))
    if organizer:
        emails.append(organizer)
    for attendee in meeting.get("attendees") or []:
        value = normalize_space(str(attendee))
        if value:
            emails.append(value)
    return emails


def attendee_first_names(meeting: dict[str, Any]) -> list[str]:
    organizer = normalize_space(str(meeting.get("organizer") or "")).lower()
    names: list[str] = []
    for attendee in meeting.get("attendees") or []:
        value = normalize_space(str(attendee))
        lowered = value.lower()
        if not value or lowered in JOSH_SELF_EMAILS or lowered in JOSH_SELF_NAMES or lowered == organizer:
            continue
        local = value.split("@", 1)[0] if "@" in value else value
        first = re.split(r"[._+\s-]", local)[0]
        if first:
            names.append(first.title())
    return names


def build_salutation(meeting: dict[str, Any]) -> str:
    names = attendee_first_names(meeting)
    return f"Hi {', '.join(names)}," if names else "Hi,"


def fireflies_link(meeting: dict[str, Any]) -> str:
    meeting_id = normalize_space(str(meeting.get("id") or ""))
    return f"https://app.fireflies.ai/view/{meeting_id}" if meeting_id else ""


def has_external_attendees(meeting: dict[str, Any]) -> bool:
    for email in attendee_emails(meeting):
        if "@" not in email:
            continue
        domain = email.split("@", 1)[1].lower()
        if domain not in CLEARWORKS_DOMAINS:
            return True
    return False


def recap_confidence(meeting: dict[str, Any]) -> float:
    summary = meeting.get("summary") or {}
    score = 0.0
    if any(normalize_space(str(summary.get(key) or "")) for key in ("overview", "bullets", "action_items")):
        score += 0.35
    if meeting.get("next_steps"):
        score += 0.35
    if not has_external_attendees(meeting):
        score += 0.2
    if not normalize_space(str(meeting.get("client_context") or "")):
        score += 0.2
    return min(score, 1.0)


def is_suppressed_meeting(meeting: dict[str, Any]) -> bool:
    haystack = normalize_text(
        " ".join(
            [
                str(meeting.get("title") or ""),
                str(meeting.get("client_context") or ""),
                " ".join(str(item) for item in attendee_emails(meeting)),
            ]
        )
    )
    return any(name in haystack for name in SUPPRESSED_NAMES)


def matches_vip(meeting: dict[str, Any], vip_list: set[str]) -> bool:
    if not vip_list:
        return False
    haystack = normalize_text(
        " ".join(
            [
                str(meeting.get("title") or ""),
                str(meeting.get("client_context") or ""),
                " ".join(str(item) for item in attendee_emails(meeting)),
            ]
        )
    )
    return any(vip in haystack for vip in vip_list)


def determine_trust_tier(meeting: dict[str, Any], vip_list: set[str]) -> tuple[str, float, str]:
    confidence = recap_confidence(meeting)
    if matches_vip(meeting, vip_list):
        return "L3", confidence, "vip-list"
    if has_external_attendees(meeting) or normalize_space(str(meeting.get("client_context") or "")):
        return "L1", confidence, "client-facing-default"
    if confidence > 0.9:
        return "L2", confidence, "internal-high-confidence"
    return "L1", confidence, "default-low-confidence"


def build_subject(meeting: dict[str, Any]) -> str:
    date_value = normalize_space(str(meeting.get("date") or ""))[:10] or "undated"
    title = normalize_space(str(meeting.get("title") or "Untitled Meeting")) or "Untitled Meeting"
    return f"Recap: {title} — {date_value}"


def build_discussion_bullets(meeting: dict[str, Any]) -> list[str]:
    # Fireflies' overview/bullets fields arrive as one markdown-formatted string
    # ("- **Topic:** detail - **Topic2:** detail...", sometimes emoji + (mm:ss)
    # timestamp prefixed). Split on the bold markers into real per-topic bullets
    # instead of surfacing the raw markdown blob verbatim.
    summary = meeting.get("summary") or {}
    raw = normalize_space(str(summary.get("overview") or summary.get("bullets") or ""))
    if not raw or "**" not in raw:
        return []
    bullets: list[str] = []
    for header, rest in re.findall(r"\*\*([^*]+?)\*\*\s*([^*]*)", raw):
        header = header.strip().rstrip(":").strip()
        rest = re.sub(r"^\(\s*\d{1,2}:\d{2}[^)]*\)\s*", "", rest.strip())
        rest = re.sub(r"\s*-\s*$", "", rest).strip()
        if header and rest:
            bullets.append(f"- {header}: {rest}")
        elif header:
            bullets.append(f"- {header}")
    return bullets


def build_summary_paragraph(meeting: dict[str, Any], voice_guidance: str) -> str:
    bullets = build_discussion_bullets(meeting)
    if bullets:
        opener = "Here’s the quick recap:" if voice_guidance else "Recap:"
        return opener + "\n" + "\n".join(bullets)
    summary = meeting.get("summary") or {}
    base = (
        normalize_space(str(summary.get("overview") or ""))
        or normalize_space(str(summary.get("bullets") or ""))
        or normalize_space(str(summary.get("action_items") or ""))
    )
    if not base:
        attendees = ", ".join(attendee_emails(meeting)) or "the attendees"
        base = f"Captured the main discussion points from {normalize_space(str(meeting.get('title') or 'this meeting'))} with {attendees}."
    opener = "Here’s the quick recap." if voice_guidance else "Recap."
    return f"{opener} {base}".strip()


def build_next_steps(meeting: dict[str, Any]) -> str:
    next_steps = meeting.get("next_steps") or []
    if not next_steps:
        return "Next steps:\n1. none captured."
    lines = ["Next steps:"]
    for idx, step in enumerate(next_steps, start=1):
        direction = normalize_space(str(step.get("direction") or ""))
        owner = normalize_space(str(step.get("owner") or "Unassigned")) or "Unassigned"
        text = normalize_space(str(step.get("text") or ""))
        if direction == "inbound":
            line = f"{idx}. {owner}: {text}"
        else:
            line = f"{idx}. Josh: {text}"
        lines.append(line)
    return "\n".join(lines)


def build_body(meeting: dict[str, Any], voice_guidance: str) -> str:
    # client_context is internal CRM analysis prose (relationship/psychographic/deal-stage
    # signals) used elsewhere for confidence scoring, suppression, and VIP/trust-tier
    # matching — it must never be surfaced in the client-facing draft body itself.
    parts: list[str] = []
    source_ref = normalize_space(str(meeting.get("sourceRef") or meeting.get("id") or ""))
    link = fireflies_link(meeting)
    parts.append(build_salutation(meeting))
    if link:
        parts.append(f"Meeting recording/transcript: {link}")
    parts.append(build_summary_paragraph(meeting, voice_guidance))
    parts.append(build_next_steps(meeting))
    parts.append(f"— drafted automatically from the Fireflies transcript ({source_ref}); review before sending.")
    return "\n\n".join(parts)


def run_gmail_draft(subject: str, body: str, runner: Runner) -> RunResult:
    return runner(
        [
            "gws",
            "gmail",
            "+draft",
            "--to",
            "josh@clearworks.ai",
            "--subject",
            subject,
            "--body",
            body,
        ]
    )


def default_runner(args: Sequence[str]) -> RunResult:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def process_meetings(
    meetings: list[dict[str, Any]],
    *,
    ledger_path: Path,
    voice_guidance: str,
    vip_list: set[str],
    runner: Runner = default_runner,
) -> dict[str, Any]:
    ledger_ids = load_ledger(ledger_path)
    summary: dict[str, Any] = {
        "drafts_created": 0,
        "auto_filed": 0,
        "skipped_ledger": 0,
        "skipped_suppressed": 0,
        "draft_failures": [],
        "planned": [],
    }

    for meeting in meetings:
        meeting_id = normalize_space(str(meeting.get("id") or ""))
        if not meeting_id:
            continue
        if meeting_id in ledger_ids:
            summary["skipped_ledger"] += 1
            continue
        if is_suppressed_meeting(meeting):
            summary["skipped_suppressed"] += 1
            continue

        tier, confidence, reason = determine_trust_tier(meeting, vip_list)
        subject = build_subject(meeting)
        body = build_body(meeting, voice_guidance)
        summary["planned"].append(
            {
                "meeting_id": meeting_id,
                "tier": tier,
                "confidence": round(confidence, 2),
                "reason": reason,
                "subject": subject,
            }
        )

        if tier == "L2":
            append_ledger(ledger_path, meeting_id)
            summary["auto_filed"] += 1
            ledger_ids.add(meeting_id)
            continue

        result = run_gmail_draft(subject, body, runner)
        if result.returncode == 0:
            append_ledger(ledger_path, meeting_id)
            summary["drafts_created"] += 1
            ledger_ids.add(meeting_id)
            continue
        summary["draft_failures"].append(
            {
                "meeting_id": meeting_id,
                "returncode": result.returncode,
                "stderr": normalize_space(result.stderr or ""),
            }
        )

    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Draft meeting recap emails with a basic trust ladder")
    parser.add_argument("--payload", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--voice", default=str(DEFAULT_VOICE_PATH))
    parser.add_argument("--vip-list", default=str(DEFAULT_VIP_PATH))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = load_json(Path(args.payload))
    meetings = payload.get("meetings") if isinstance(payload, dict) else None
    if not isinstance(meetings, list):
        print(json.dumps({"error": "payload missing meetings array"}))
        return 1

    summary = process_meetings(
        meetings,
        ledger_path=Path(args.ledger),
        voice_guidance=load_voice_guidance(Path(args.voice)),
        vip_list=load_vip_list(Path(args.vip_list)),
    )
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
