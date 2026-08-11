#!/usr/bin/env python3
"""Extract high-confidence Josh commitments from recent Fireflies transcripts."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import tempfile
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable


LOGGER = logging.getLogger(__name__)
UTC = timezone.utc
SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
ORG_DIR = AGENT_DIR.parent.parent
KNOWLEDGE_DIR = ORG_DIR / "knowledge"
CLIENTS_DIR = KNOWLEDGE_DIR / "clients"
COMPANY_PATH = KNOWLEDGE_DIR / "company.md"
OFFER_PATH = KNOWLEDGE_DIR / "offer.md"
STATE_PATH = KNOWLEDGE_DIR / "STATE.md"
STATE_DIR = AGENT_DIR / "state"
DEFAULT_WATERMARK_PATH = STATE_DIR / "ff-extractor-watermark.json"
ZERO_YIELD_LEDGER_PATH = STATE_DIR / "ff-extractor-zero-yield.jsonl"
DEFAULT_TRANSCRIPT_LIMIT = 20
FIREFLIES_API_URL = "https://api.fireflies.ai/graphql"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
CLASSIFIER_MODEL = os.environ.get("FF_CLASSIFIER_MODEL", "anthropic/claude-haiku-4.5")
EXTRACTOR_MODEL = os.environ.get("FF_EXTRACTOR_MODEL", "anthropic/claude-sonnet-4.5")
CLASSIFIER_MAX_CHARS = 24000
EXTRACTOR_MAX_CHARS = 48000
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
    shorthand_bullet
    action_items
    keywords
  }
  transcript_url
  sentences {
    speaker_id
    speaker_name
    text
    raw_text
    start_time
    end_time
  }
"""
CLASSIFIER_PROMPT = """Analyze this meeting transcript for actionable commitments.

TRANSCRIPT:
{transcript}

Return a JSON object with exactly these fields:
{{
  "contacts_mentioned": ["Full Name"],
  "extractions": [
    {{
      "category": "action_item" | "decision" | "follow_up",
      "content": "Clear one-sentence description",
      "owner": "Person name if assigned (optional)"
    }}
  ],
  "is_casual": true | false
}}

Rules:
- is_casual=true for: greetings, definitions, general questions, factual answers, summaries with no commitments
- is_casual=false only when: specific action items, decisions made, or follow-ups committed to
- contacts_mentioned: only real people by name (not "the team", "everyone", "the client")
- Keep extractions specific and actionable — vague statements are not extractions
- Return valid JSON only, no markdown"""
ACTION_ITEMS_PROMPT = """Extract action items from this meeting transcript.
Identify every task, commitment, follow-up, or to-do mentioned. Be specific — "send the proposal" is better than "follow up."
Only include forward-looking work or business commitments that still need to be done AFTER the meeting ends. Exclude personal or social errands (e.g. saying goodbye, returning home, travel logistics), small talk, and anything that was already completed during the meeting itself.
Client context:
{client_context}
Only surface items material to an active Clearworks engagement; ignore unrelated personal or social chatter.

For each action item, ALL of the following must be true or the item must be dropped:
- An attributable owner — preferably a real person named in the transcript. First-person promises
  ("I", "I'll", "I'm going to") may be returned with that self-reference when the transcript's
  speaker label is the only reliable owner; never guess a different person's name. Generic plural
  owners such as "the team" remain insufficient unless the transcript contains an explicit promise.
- A CONCRETE due date or explicit near-term timeframe stated in the transcript (e.g. "by Friday,"
  "next week", "a day or so"). Preserve imprecise phrases verbatim in dueDate; never turn them into
  an exact calendar date. Vague or absent timing ("eventually," "at some point," unstated) means:
  drop it.
- Explicit commitment language — "I will," "I'll send," "let's do X by Y" — not hedged or
  speculative language ("could," "might," "worth considering," "an option would be to").
This bar applies REGARDLESS of whether client context is populated or empty, and regardless of
whether the other party is a prospect or an existing client — the test is always: is this a real,
specifically-owned, specifically-dated commitment, not whether the relationship is established.
Explicitly REJECT: descriptions of what a company/service offers in the abstract, self-referential
pitch or business-model narration (e.g. "the way my company works is...", "we typically do X for
clients"), hypothetical/illustrative examples, and casual personal self-disclosures (e.g. "I'll be
learning more about coding in the next few weeks") — these are context, never action items even if
phrased with future-tense or task-like structure.
No artificial limit on count. Zero acceptable if none found — that is the expected result for a
call with no real commitments.
IMPORTANT: Return ONLY a valid JSON array with objects using exactly these fields:
"action","owner","dueDate","status".
Example: [{{"action":"Send proposal to client","owner":"John","dueDate":"2026-02-20","status":"pending"}}]

TRANSCRIPT:
{transcript}"""
DECISIONS_PROMPT = """From this meeting transcript, extract two things a CRM needs but action items do not capture:

1. DECISIONS — concrete choices the parties AGREED and settled during the call (scope locked,
   approach chosen, price/terms accepted, a "yes/no" landed). A decision is a fact that should
   not be re-litigated later. It is NOT a task, NOT a follow-up, NOT a maybe. If nobody actually
   decided anything, return an empty list. Phrase each as a short past-tense statement of what was
   settled (e.g. "Agreed to a two-phase build starting with the audit").

2. DEAL_STATE — one short sentence describing any CHANGE in where this opportunity stands after the
   call: advanced a stage (e.g. discovery -> proposal, verbal -> signed), stalled, went cold, budget
   or timeline shifted, a blocker cleared or appeared. If the deal did not move, return an empty
   string. This is only about deal/relationship trajectory, never about tasks.

Only report what the transcript actually supports — never infer, never pad. Both empty is a valid
and common result for an internal or status-only call.

Return ONLY a valid JSON object with exactly these fields:
{{"decisions": ["..."], "deal_state": "..."}}
Example: {{"decisions": ["Agreed to fixed-scope pilot at $12k"], "deal_state": "Moved from proposal to verbal yes"}}
Empty example: {{"decisions": [], "deal_state": ""}}

Client context (for grounding only, do not copy verbatim):
{client_context}

TRANSCRIPT:
{transcript}"""
PUNCT_RE = re.compile(r"[^\w\s-]+", re.UNICODE)
SPACE_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9]+")
CONTROL_RE = re.compile(r"[\x00-\x1f]")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECTION_HEADING_RE = re.compile(r"^##\s+(.+)$")
WEEKDAY_TO_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
STOPWORDS = {
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "from",
    "i",
    "in",
    "it",
    "let",
    "me",
    "of",
    "on",
    "our",
    "the",
    "to",
    "we",
    "with",
    "you",
}
VAGUE_ACTION_PREFIXES = (
    "consider",
    "considering",
    "explore",
    "exploring",
    "figure out",
    "improve",
    "investigate",
    "look into",
    "think about",
    "work on",
)
# Personal learning chatter commonly arrives with future-tense language and a
# broad timeframe. Keep this deliberately narrow so a concrete work commitment
# such as "learn the Acme API by Friday" still survives.
CASUAL_LEARNING_ACTION_RE = re.compile(
    r"^(?:learn|learning|study|studying|read|reading|watch|watching|build|develop|practice)\b"
    r".*\b(?:coding|programming)\b",
    re.IGNORECASE,
)
IMPRECISE_TIMEFRAME_RE = re.compile(
    r"\b(?:in\s+)?(?:a|one)\s+(?:business\s+)?day\s+or\s+so\b"
    r"|\b(?:in|within)\s+(?:a\s+)?(?:couple|few)\s+(?:of\s+)?(?:days?|weeks?)\b"
    r"|\bnext\s+(?:few|couple(?:\s+of)?)\s+weeks?\b",
    re.IGNORECASE,
)
CASUAL_CONTEXT_TIMEFRAME_RE = re.compile(
    rf"(?:{IMPRECISE_TIMEFRAME_RE.pattern})|\b(?:soon|sometime|later)\b",
    re.IGNORECASE,
)
SUPPORT_TIMEFRAME_RE = re.compile(
    r"\b(?:today|tomorrow|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b"
    r"|\b(?:this|next)\s+week\b"
    r"|\b\d{4}-\d{2}-\d{2}\b",
    re.IGNORECASE,
)
# NOTE: legacy exclusion removed 2026-08-09 — this was a months-old "drop Marcos from a
# sales reminder" ask that had grown into a hard-no substring filter, which silently dropped
# Marcos Santa Ana (a real client) from ALL meeting writeback/extraction. Marcos is a client.
SUPPRESSED_NAMES = ()
# Owner strings that are not a concrete named person — never inbound-worthy.
GENERIC_OWNERS = {
    "", "unassigned", "team", "the team", "everyone", "client", "we", "they",
}
FIRST_PERSON_OWNER_RE = re.compile(
    r"^(?:i|me|myself|i\s+(?:ll|will|m|am)(?:\s+going\s+to)?|im(?:\s+going\s+to)?)$"
)
COLLECTIVE_OWNER_RE = re.compile(
    r"^we(?:\s+(?:ll|will|re|are)(?:\s+going\s+to)?)?$"
)
EXPLICIT_COMMITMENT_RE = re.compile(
    r"\b(?:i(?:['’]?ll|\s+will)|i(?:['’]?m|\s+am)\s+going\s+to"
    r"|we(?:['’]?ll|\s+will)|we(?:['’]?re|\s+are)\s+going\s+to|let\s+me|let['’]?s)\b",
    re.IGNORECASE,
)
COUNTERPARTY_RE = re.compile(
    r"\b(?:call|email|text|send|share|follow up with|ask|tell|schedule with|meet with)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})\b"
    r"|\b(?:to|with|for)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})\b"
    r"|\b([A-Z][A-Za-z0-9&.-]+)(?:'s|’s)\b"
)
MARKDOWN_TABLE_SEPARATOR = re.compile(r"^[\s:|-]+$")
PRIORITY_ORDER = ("P0", "P1", "P2", "P3")
PRIORITY_INDEX = {priority: index for index, priority in enumerate(PRIORITY_ORDER)}
FUZZY_DEDUP_THRESHOLD = 0.6
P0_CAP = 3
P1_CAP = 7
P0_DUE_WINDOW_DAYS = 3
P1_DUE_WINDOW_DAYS = 10
RELEVANCE_P0_MIN = 0.12
RELEVANCE_P1_MIN = 0.08
RELEVANCE_P1_PROMOTION = 0.45
RELEVANCE_P2_MIN = 0.2

Urlopen = Callable[..., Any]


@dataclass(frozen=True)
class ExtractedItem:
    action: str
    owner: str
    due_date: str
    status: str


@dataclass(frozen=True)
class RefinedCommitment:
    id: str
    text: str
    source: str
    source_ref: str
    direction: str
    action_text: str = ""
    owner: str = ""
    deadline: str = ""
    source_quote: str = ""
    priority: str = "P3"
    relevance_score: float = 0.0


def now_utc_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def collapse_ws(value: str) -> str:
    return SPACE_RE.sub(" ", value).strip()


def strip_markdown_prefix(value: str) -> str:
    stripped = value.strip()
    stripped = re.sub(r"^[-*]\s+", "", stripped)
    stripped = re.sub(r"^\d+\.\s+", "", stripped)
    return collapse_ws(stripped)


def normalize_action(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    normalized = PUNCT_RE.sub(" ", normalized.lower())
    normalized = collapse_ws(normalized)
    return normalized


def action_hash(value: str) -> str:
    return hashlib.sha256(normalize_action(value).encode("utf-8")).hexdigest()[:12]


def commitment_id(meeting_id: str, action: str) -> str:
    return f"ff_{meeting_id}_{action_hash(action)}"


def directional_commitment_id(meeting_id: str, action: str, direction: str) -> str:
    if direction == "inbound":
        return f"ffin_{meeting_id}_{action_hash(action)}"
    return commitment_id(meeting_id, action)


def normalize_json_text(value: str) -> str:
    return CONTROL_RE.sub("", value.replace("```json", "").replace("```", "")).strip()


def parse_json_payload(value: str) -> Any:
    cleaned = normalize_json_text(value)
    return json.loads(cleaned)


def parse_extracted_items(value: str) -> list[ExtractedItem]:
    payload = parse_json_payload(value)
    if not isinstance(payload, list):
        raise ValueError("extractor response was not a JSON array")
    items: list[ExtractedItem] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        action = collapse_ws(str(item.get("action") or ""))
        owner = collapse_ws(str(item.get("owner") or ""))
        due_date = collapse_ws(str(item.get("dueDate") or ""))
        status = collapse_ws(str(item.get("status") or "pending")) or "pending"
        if action:
            items.append(ExtractedItem(action=action, owner=owner, due_date=due_date, status=status))
    return items


def build_transcript_text(sentences: Iterable[dict[str, Any]], *, limit: int) -> str:
    lines: list[str] = []
    size = 0
    for sentence in sentences:
        speaker = collapse_ws(str(sentence.get("speaker_name") or "Unknown"))
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if not text:
            continue
        line = f"{speaker}: {text}"
        size += len(line) + 1
        if size > limit:
            break
        lines.append(line)
    return "\n".join(lines)


def markdown_sections(path: Path) -> dict[str, list[str]]:
    if not path.exists():
        return {}
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        match = SECTION_HEADING_RE.match(raw_line)
        if match:
            current = normalize_action(match.group(1))
            sections[current] = []
            continue
        if current is not None:
            sections[current].append(raw_line.rstrip())
    return sections


def first_meaningful_line(path: Path) -> str:
    if not path.exists():
        return ""
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.lstrip().startswith("#"):
            continue
        line = strip_markdown_prefix(raw_line)
        if not line or normalize_action(line).startswith("todo"):
            continue
        return line
    return ""


def first_section_line(path: Path, section_name: str) -> str:
    for raw_line in markdown_sections(path).get(normalize_action(section_name), []):
        line = strip_markdown_prefix(raw_line)
        if line and not normalize_action(line).startswith("todo"):
            return line
    return ""


def markdown_key_value(lines: list[str], key: str) -> str:
    target = normalize_action(key)
    for raw_line in lines:
        line = strip_markdown_prefix(raw_line)
        if ":" not in line:
            continue
        label, value = line.split(":", 1)
        if normalize_action(label) == target:
            return collapse_ws(value)
    return ""


def markdown_open_items(lines: list[str]) -> list[str]:
    items: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line.startswith("|"):
            continue
        cells = [collapse_ws(cell) for cell in line.strip("|").split("|")]
        if not cells:
            continue
        if all(MARKDOWN_TABLE_SEPARATOR.fullmatch(cell or "-") for cell in cells):
            continue
        if normalize_action(cells[0]) == "item":
            continue
        item_text = cells[0]
        if item_text:
            items.append(item_text)
    return items


def clearworks_identity_context() -> str:
    company_line = first_meaningful_line(COMPANY_PATH)
    company_one_liner = ""
    if COMPANY_PATH.exists():
        for raw_line in COMPANY_PATH.read_text(encoding="utf-8").splitlines():
            line = strip_markdown_prefix(raw_line)
            if line.lower().startswith("one-line:"):
                company_one_liner = collapse_ws(line.split(":", 1)[1])
                break
    offer_line = first_section_line(OFFER_PATH, "ICP / who we say yes to") or first_section_line(
        OFFER_PATH, "What we sell"
    )
    state_line = first_section_line(STATE_PATH, "Active work") or first_section_line(
        STATE_PATH, "Next priorities"
    )
    parts = [
        company_one_liner or company_line or "Clearworks is an AI ops and consulting firm.",
        offer_line,
        state_line,
    ]
    return collapse_ws(" ".join(part for part in parts if part))[:420]


def client_name_from_path(path: Path) -> str:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith("# Client:"):
            return collapse_ws(raw_line.split(":", 1)[1])
    return collapse_ws(path.stem.replace("-", " ").title())


def client_context_records(clients_dir: Path = CLIENTS_DIR) -> list[dict[str, Any]]:
    if not clients_dir.exists():
        return []
    identity = clearworks_identity_context()
    records: list[dict[str, Any]] = []
    for path in sorted(clients_dir.glob("*.md")):
        if path.name == "_template.md":
            continue
        sections = markdown_sections(path)
        contacts_lines = sections.get("contacts", [])
        current_state_lines = sections.get("current state", [])
        delivery_lines = sections.get("what we re delivering", [])
        client_name = client_name_from_path(path)
        names: set[str] = {normalize_action(client_name)}
        emails: set[str] = set()
        for raw_line in contacts_lines:
            line = strip_markdown_prefix(raw_line)
            if not line:
                continue
            emails.update(match.lower() for match in EMAIL_RE.findall(line))
            head = re.split(r"\s+[—-]\s+", line, maxsplit=1)[0]
            if head:
                names.add(normalize_action(head))
        stage = markdown_key_value(current_state_lines, "Deal stage") or "unknown"
        status = markdown_key_value(current_state_lines, "CRM status") or "unknown"
        next_action = markdown_key_value(current_state_lines, "Next action")
        engagement = markdown_key_value(delivery_lines, "Engagement") or "unknown"
        service_type = markdown_key_value(delivery_lines, "Service type")
        relationship_context = markdown_key_value(delivery_lines, "Relationship context")
        open_items = markdown_open_items(sections.get("open items", []))
        detail_parts = [
            f"This meeting's attendees map to client={client_name}.",
            f"Deal stage={stage}.",
            f"CRM status={status}.",
            f"Engagement={engagement}.",
        ]
        if service_type:
            detail_parts.append(f"Service={service_type}.")
        if relationship_context:
            detail_parts.append(f"Relationship={relationship_context}.")
        if next_action:
            detail_parts.append(f"Open next action: {next_action}.")
        relevance_fragments = [client_name, engagement, service_type, relationship_context, next_action]
        records.append(
            {
                "path": path,
                "client_name": client_name,
                "client_name_normalized": normalize_action(client_name),
                "names": names,
                "emails": emails,
                "context": collapse_ws(f"{identity} {' '.join(detail_parts)}"),
                "open_items": open_items,
                "relevance_fragments": tuple(fragment for fragment in relevance_fragments if fragment),
            }
        )
    return records


def transcript_emails(transcript: dict[str, Any]) -> set[str]:
    emails: set[str] = set()
    organizer = collapse_ws(str(transcript.get("organizer_email") or ""))
    if organizer:
        emails.add(organizer.lower())
    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        for participant in participants:
            for match in EMAIL_RE.findall(str(participant)):
                emails.add(match.lower())
    return emails


def transcript_identity_haystack(transcript: dict[str, Any]) -> str:
    parts = [str(transcript.get("title") or "")]
    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        parts.extend(str(participant) for participant in participants)
    parts.append(str(transcript.get("organizer_email") or ""))
    speakers = transcript.get("speakers") or []
    if isinstance(speakers, list):
        parts.extend(str(speaker.get("name") or "") for speaker in speakers if isinstance(speaker, dict))
    return normalize_action(" ".join(parts))


def matched_client_context_record_for_transcript(
    transcript: dict[str, Any],
    *,
    clients_dir: Path = CLIENTS_DIR,
) -> dict[str, Any] | None:
    haystack = transcript_identity_haystack(transcript)
    emails = transcript_emails(transcript)
    best_score = 0
    best_record: dict[str, Any] | None = None
    for record in client_context_records(clients_dir):
        score = 0
        email_hits = emails & record["emails"]
        if email_hits:
            score += 10 * len(email_hits)
        if record["client_name_normalized"] and record["client_name_normalized"] in haystack:
            score += 2
        for name in record["names"]:
            if len(name) < 4:
                continue
            if name in haystack:
                score += 3
        if score > best_score:
            best_score = score
            best_record = record
    return best_record if best_score >= 3 else None


def client_context_for_transcript(
    transcript: dict[str, Any],
    *,
    clients_dir: Path = CLIENTS_DIR,
) -> str:
    record = matched_client_context_record_for_transcript(transcript, clients_dir=clients_dir)
    if record is None:
        return ""
    return str(record.get("context") or "")


def parse_transcript_datetime(raw_value: Any) -> datetime | None:
    if isinstance(raw_value, (int, float)):
        timestamp = float(raw_value)
        if timestamp > 1_000_000_000_000:
            timestamp = timestamp / 1000.0
        return datetime.fromtimestamp(timestamp, UTC)
    if isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return None
        if text.isdigit():
            return parse_transcript_datetime(int(text))
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            return None
    return None


def transcript_sort_key(transcript: dict[str, Any]) -> tuple[datetime, str]:
    ts = parse_transcript_datetime(transcript.get("date")) or datetime.fromtimestamp(0, UTC)
    return ts, str(transcript.get("id") or "")


def load_watermark(path: Path) -> tuple[datetime | None, str | None]:
    if not path.exists():
        return None, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    timestamp = parse_transcript_datetime(payload.get("timestamp"))
    meeting_id = payload.get("meeting_id")
    return timestamp, str(meeting_id) if isinstance(meeting_id, str) and meeting_id else None


def save_watermark(path: Path, transcript: dict[str, Any]) -> None:
    timestamp = parse_transcript_datetime(transcript.get("date"))
    if timestamp is None:
        return
    payload = {
        "timestamp": timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "meeting_id": str(transcript.get("id") or ""),
        "updated_at": now_utc_iso(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


DROP_REASONS = ("empty_text", "casual", "zero_extracted", "all_refined_out")


def empty_drop_reason_counts() -> dict[str, int]:
    return {reason: 0 for reason in DROP_REASONS}


def single_drop_reason_counts(reason: str) -> dict[str, int]:
    counts = empty_drop_reason_counts()
    if reason in counts:
        counts[reason] = 1
    return counts


def append_zero_yield_row(path: Path, transcript: dict[str, Any], drop_reason: str) -> None:
    payload = {
        "meeting_id": str(transcript.get("id") or ""),
        "meeting_date": collapse_ws(str(transcript.get("date") or "")),
        "title": collapse_ws(str(transcript.get("title") or "")),
        "timestamp": now_utc_iso(),
        "drop_reason": drop_reason,
        "drop_reason_counts": single_drop_reason_counts(drop_reason),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True))
        handle.write("\n")


def is_newer_than_watermark(
    transcript: dict[str, Any],
    watermark_timestamp: datetime | None,
    watermark_meeting_id: str | None,
) -> bool:
    if watermark_timestamp is None:
        return True
    ts, meeting_id = transcript_sort_key(transcript)
    if ts > watermark_timestamp:
        return True
    if ts < watermark_timestamp:
        return False
    if watermark_meeting_id is None:
        return True
    return meeting_id > watermark_meeting_id


def select_recent_transcripts(
    transcripts: list[dict[str, Any]],
    watermark_timestamp: datetime | None,
    watermark_meeting_id: str | None,
    *,
    limit: int,
) -> list[dict[str, Any]]:
    ordered = sorted(transcripts, key=transcript_sort_key)
    fresh = [
        transcript
        for transcript in ordered
        if is_newer_than_watermark(transcript, watermark_timestamp, watermark_meeting_id)
    ]
    return fresh[:limit]


def fireflies_graphql(
    api_key: str,
    query: str,
    variables: dict[str, Any],
    *,
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any]:
    request = urllib.request.Request(
        FIREFLIES_API_URL,
        data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {api_key}")
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Fireflies response was not an object")
    errors = payload.get("errors")
    if errors:
        raise ValueError(f"Fireflies GraphQL error: {errors}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Fireflies response missing data")
    return data


def fetch_recent_transcripts(
    api_key: str,
    *,
    limit: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    query = f"query($limit: Int, $skip: Int) {{ transcripts(limit: $limit, skip: $skip) {{ {TRANSCRIPT_FIELDS} }} }}"
    data = fireflies_graphql(api_key, query, {"limit": max(limit, 20), "skip": 0}, urlopen=urlopen)
    transcripts = data.get("transcripts")
    if not isinstance(transcripts, list):
        return []
    return [item for item in transcripts if isinstance(item, dict)]


def extract_provider_error_message(raw_body: str) -> str:
    text = collapse_ws(raw_body)
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except ValueError:
        return text
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = collapse_ws(str(error.get("message") or error.get("code") or ""))
            if message:
                return message
        if isinstance(error, str):
            return collapse_ws(error)
        message = collapse_ws(str(payload.get("message") or ""))
        if message:
            return message
    return text


def read_http_error_body(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read()
    except OSError:
        return ""
    return raw.decode("utf-8", errors="replace")


def normalize_openrouter_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, str):
                texts.append(item)
                continue
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    texts.append(text)
        combined = "\n".join(texts).strip()
        if combined:
            return combined
    raise ValueError("OpenRouter response missing choices[0].message.content")


def openrouter_request(
    api_key: str,
    *,
    model: str,
    prompt: str,
    max_tokens: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> str:
    body = {"model": model, "max_tokens": max_tokens, "temperature": 0, "messages": [{"role": "user", "content": prompt}]}
    request = urllib.request.Request(
        OPENROUTER_API_URL,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = extract_provider_error_message(read_http_error_body(exc))
        detail = f": {body_text}" if body_text else ""
        raise RuntimeError(f"OpenRouter HTTP {exc.code}{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenRouter request failed: {exc.reason}") from exc
    if not isinstance(payload, dict):
        raise ValueError("OpenRouter response was not an object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("OpenRouter response missing choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ValueError("OpenRouter response missing choices[0].message")
    return normalize_openrouter_content(message.get("content"))


def is_casual_transcript(
    transcript_text: str,
    *,
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> bool:
    response_text = openrouter_request(
        openrouter_api_key,
        model=CLASSIFIER_MODEL,
        prompt=CLASSIFIER_PROMPT.format(transcript=transcript_text),
        max_tokens=1024,
        urlopen=urlopen,
    )
    payload = parse_json_payload(response_text)
    if not isinstance(payload, dict):
        raise ValueError("classifier response was not a JSON object")
    return bool(payload.get("is_casual"))


def extract_action_items(
    transcript_text: str,
    *,
    client_context: str = "",
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[ExtractedItem]:
    response_text = openrouter_request(
        openrouter_api_key,
        model=EXTRACTOR_MODEL,
        prompt=ACTION_ITEMS_PROMPT.format(
            transcript=transcript_text,
            client_context=client_context or "",
        ),
        max_tokens=2400,
        urlopen=urlopen,
    )
    return parse_extracted_items(response_text)


def extract_decisions_and_deal_state(
    transcript_text: str,
    *,
    client_context: str = "",
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> tuple[list[str], str]:
    """Return (decisions, deal_state) — the two extractions the writeback hardcoded as none."""
    response_text = openrouter_request(
        openrouter_api_key,
        model=EXTRACTOR_MODEL,
        prompt=DECISIONS_PROMPT.format(
            transcript=transcript_text,
            client_context=client_context or "",
        ),
        max_tokens=1200,
        urlopen=urlopen,
    )
    return parse_decisions_payload(response_text)


def parse_decisions_payload(value: str) -> tuple[list[str], str]:
    try:
        payload = parse_json_payload(value)
    except (json.JSONDecodeError, ValueError):
        return [], ""
    if not isinstance(payload, dict):
        return [], ""
    raw_decisions = payload.get("decisions")
    decisions: list[str] = []
    if isinstance(raw_decisions, list):
        for item in raw_decisions:
            text = collapse_ws(str(item or ""))
            if text:
                decisions.append(text)
    elif isinstance(raw_decisions, str):
        text = collapse_ws(raw_decisions)
        if text:
            decisions.append(text)
    deal_state = collapse_ws(str(payload.get("deal_state") or ""))
    return decisions, deal_state


def normalized_tokens(value: str) -> set[str]:
    return {token for token in TOKEN_RE.findall(normalize_action(value)) if token and token not in STOPWORDS}


def title_similarity(left: str, right: str) -> float:
    left_normalized = normalize_action(left)
    right_normalized = normalize_action(right)
    if not left_normalized or not right_normalized:
        return 0.0
    return SequenceMatcher(None, left_normalized, right_normalized).ratio()


def keyword_overlap(left: str, right: str) -> float:
    left_tokens = normalized_tokens(left)
    right_tokens = normalized_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def fuzzy_similarity(left: str, right: str) -> float:
    return (0.7 * title_similarity(left, right)) + (0.3 * keyword_overlap(left, right))


def is_josh_owner(owner: str) -> bool:
    normalized = normalize_action(owner)
    return normalized in {"josh", "josh weiss"}


def is_first_person_owner(owner: str) -> bool:
    return FIRST_PERSON_OWNER_RE.fullmatch(normalize_action(owner)) is not None


def is_generic_owner(owner: str) -> bool:
    normalized = normalize_action(owner)
    return (
        normalized in GENERIC_OWNERS
        or FIRST_PERSON_OWNER_RE.fullmatch(normalized) is not None
        or COLLECTIVE_OWNER_RE.fullmatch(normalized) is not None
    )


def infer_first_person_speaker(
    transcript: dict[str, Any],
    action: str,
    due_date: str = "",
) -> str | None:
    """Resolve a self-referential owner from its explicit promise sentence."""
    sentences = transcript.get("sentences")
    if not isinstance(sentences, list):
        return None
    action_tokens = normalized_tokens(action)
    if not action_tokens:
        return None
    due_tokens = normalized_tokens(due_date)
    best_name: str | None = None
    best_score: tuple[float, int, int] | None = None
    tied_speakers: set[str] = set()
    for index, sentence in enumerate(sentences):
        if not isinstance(sentence, dict):
            continue
        speaker = collapse_ws(str(sentence.get("speaker_name") or ""))
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if not speaker or not text or EXPLICIT_COMMITMENT_RE.search(text) is None:
            continue
        sentence_tokens = normalized_tokens(text)
        action_overlap = len(action_tokens & sentence_tokens)
        if action_overlap == 0:
            continue
        due_overlap = len(due_tokens & sentence_tokens)
        # Speaker attribution must remain ambiguous when otherwise-equal
        # evidence appears under multiple speakers.  Sentence order is only a
        # tiebreaker for selecting one best sentence, never for declaring a
        # unique owner.
        score = (action_overlap / len(action_tokens), due_overlap, action_overlap)
        if best_score is None or score > best_score:
            best_score = score
            best_name = speaker
            tied_speakers = {speaker}
        elif score == best_score:
            tied_speakers.add(speaker)
    return best_name if len(tied_speakers) == 1 else None


def extract_josh_sentences(transcript: dict[str, Any]) -> list[str]:
    sentences = transcript.get("sentences")
    if not isinstance(sentences, list):
        return []
    collected: list[str] = []
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        speaker = normalize_action(str(sentence.get("speaker_name") or ""))
        if "josh" not in speaker:
            continue
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if text:
            collected.append(text)
    return collected


def extract_all_sentences(transcript: dict[str, Any]) -> list[str]:
    sentences = transcript.get("sentences")
    if not isinstance(sentences, list):
        return []
    collected: list[str] = []
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        text = collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if text:
            collected.append(text)
    return collected


def best_support_sentence(action: str, josh_sentences: list[str]) -> str | None:
    action_tokens = normalized_tokens(action)
    if not action_tokens:
        return None
    best_text: str | None = None
    best_score = 0
    for sentence in josh_sentences:
        score = len(action_tokens & normalized_tokens(sentence))
        if score > best_score:
            best_score = score
            best_text = sentence
    if best_score < 2:
        return None
    return best_text


def resolve_due_date(raw_due: str, meeting_day: date) -> str | None:
    due = collapse_ws(raw_due)
    if not due:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
        return due
    lowered = due.lower()
    if lowered == "today":
        return meeting_day.isoformat()
    if lowered == "tomorrow":
        return (meeting_day + timedelta(days=1)).isoformat()
    next_match = re.fullmatch(r"next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)", lowered)
    if next_match:
        target = WEEKDAY_TO_INDEX[next_match.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        delta = 7 if delta == 0 else delta
        return (meeting_day + timedelta(days=delta)).isoformat()
    weekday_match = re.fullmatch(r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday)", lowered)
    if weekday_match:
        target = WEEKDAY_TO_INDEX[weekday_match.group(1)]
        delta = (target - meeting_day.weekday()) % 7
        return (meeting_day + timedelta(days=delta)).isoformat()
    return None


def has_imprecise_timeframe(value: str) -> bool:
    return IMPRECISE_TIMEFRAME_RE.search(collapse_ws(value)) is not None


def source_has_explicit_timeframe(source_quote: str) -> bool:
    source = collapse_ws(source_quote)
    return bool(source and (IMPRECISE_TIMEFRAME_RE.search(source) or SUPPORT_TIMEFRAME_RE.search(source)))


def source_matches_timeframe(raw_due: str, meeting_day: date, source_quote: str) -> bool:
    """Check that the model's due phrase has evidence in the supporting sentence."""
    source = collapse_ws(source_quote)
    due = collapse_ws(raw_due)
    if not source or not due:
        return False
    if has_imprecise_timeframe(due):
        return has_imprecise_timeframe(source)

    source_normalized = normalize_action(source)
    due_normalized = normalize_action(due)
    if due_normalized in source_normalized:
        return True
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
        return False

    for phrase in (
        "today",
        "tomorrow",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "next monday",
        "next tuesday",
        "next wednesday",
        "next thursday",
        "next friday",
        "next saturday",
        "next sunday",
    ):
        if re.search(rf"\b{re.escape(phrase)}\b", source_normalized) and resolve_due_date(
            phrase,
            meeting_day,
        ) == due:
            return True
    return False


def has_explicit_timeframe(raw_due: str, meeting_day: date, source_quote: str = "") -> bool:
    if raw_due and source_quote:
        return source_matches_timeframe(raw_due, meeting_day, source_quote)
    return (
        resolve_due_date(raw_due, meeting_day) is not None
        or has_imprecise_timeframe(raw_due)
        or source_has_explicit_timeframe(source_quote)
    )


def has_unsupported_imprecise_due(raw_due: str, meeting_day: date, source_quote: str) -> bool:
    return bool(raw_due and has_imprecise_timeframe(raw_due) and not source_matches_timeframe(
        raw_due,
        meeting_day,
        source_quote,
    ))


def resolve_grounded_due_date(raw_due: str, meeting_day: date, source_quote: str = "") -> str | None:
    """Resolve exact dates, but never sharpen an imprecise source phrase."""
    if raw_due and source_quote and source_has_explicit_timeframe(source_quote):
        if not source_matches_timeframe(raw_due, meeting_day, source_quote):
            return None
    if has_imprecise_timeframe(raw_due):
        return None
    return resolve_due_date(raw_due, meeting_day)


def is_casual_self_disclosure(action: str, due: str, source_quote: str = "") -> bool:
    """Reject narrow personal-learning chatter without swallowing real work."""
    if CASUAL_LEARNING_ACTION_RE.search(normalize_action(action)) is None:
        return False
    return CASUAL_CONTEXT_TIMEFRAME_RE.search(collapse_ws(f"{due} {source_quote}")) is not None


def has_concrete_action(action: str) -> bool:
    normalized = normalize_action(action)
    if not normalized:
        return False
    return not any(normalized.startswith(prefix) for prefix in VAGUE_ACTION_PREFIXES)


HANDLED_DUE_MARKERS = (
    "this meeting",
    "during meeting",
    "during the meeting",
    "in meeting",
    "in the meeting",
    "completed verbally",
    "completed",
    "actioned",
    "already done",
    "immediate",
)


def is_already_handled(raw_due: str) -> bool:
    normalized = normalize_action(raw_due)
    if not normalized:
        return False
    return any(marker in normalized for marker in HANDLED_DUE_MARKERS)


def extract_counterparty(text: str) -> str | None:
    for match in COUNTERPARTY_RE.finditer(text):
        candidate = collapse_ws(match.group(1) or match.group(2) or match.group(3) or "")
        if candidate:
            return candidate
    return None


def is_suppressed(owner: str, action: str, counterparty: str | None) -> bool:
    haystacks = [normalize_action(owner), normalize_action(action)]
    if counterparty:
        haystacks.append(normalize_action(counterparty))
    return any(name in haystack for haystack in haystacks for name in SUPPRESSED_NAMES)


def meeting_day_from_transcript(transcript: dict[str, Any]) -> date:
    ts = parse_transcript_datetime(transcript.get("date"))
    if ts is None:
        return datetime.now().astimezone().date()
    return ts.astimezone().date()


def build_commitment_text(action: str, due: str | None) -> str:
    if due:
        return f"{action} (due {due})"
    return action


def deadline_distance_days(deadline: str, meeting_day: date) -> int | None:
    if not deadline:
        return None
    try:
        return (date.fromisoformat(deadline) - meeting_day).days
    except ValueError:
        return None


def relevance_score_for_commitment(action_text: str, client_record: dict[str, Any] | None) -> float:
    if client_record is None:
        return 0.0
    fragments = [collapse_ws(str(fragment)) for fragment in client_record.get("relevance_fragments", ()) if fragment]
    if not fragments:
        context = collapse_ws(str(client_record.get("context") or ""))
        if context:
            fragments = [context]
    if not fragments:
        return 0.0
    return max(fuzzy_similarity(action_text, fragment) for fragment in fragments)


def priority_for_commitment(
    *,
    action_text: str,
    deadline: str,
    meeting_day: date,
    client_record: dict[str, Any] | None,
) -> tuple[str, float]:
    relevance_score = relevance_score_for_commitment(action_text, client_record)
    due_distance = deadline_distance_days(deadline, meeting_day)
    has_context = client_record is not None and bool(client_record.get("context"))
    if due_distance is not None and due_distance <= P0_DUE_WINDOW_DAYS and (not has_context or relevance_score >= RELEVANCE_P0_MIN):
        return "P0", relevance_score
    if (
        due_distance is not None
        and due_distance <= P1_DUE_WINDOW_DAYS
        and (not has_context or relevance_score >= RELEVANCE_P1_MIN)
    ) or relevance_score >= RELEVANCE_P1_PROMOTION:
        return "P1", relevance_score
    if due_distance is not None or relevance_score >= RELEVANCE_P2_MIN:
        return "P2", relevance_score
    return "P3", relevance_score


def scored_commitment(
    commitment: RefinedCommitment,
    *,
    meeting_day: date,
    client_record: dict[str, Any] | None,
) -> RefinedCommitment:
    priority, relevance_score = priority_for_commitment(
        action_text=commitment.action_text or commitment.text,
        deadline=commitment.deadline,
        meeting_day=meeting_day,
        client_record=client_record,
    )
    return replace(commitment, priority=priority, relevance_score=round(relevance_score, 4))


def priority_group_sort_key(commitment: RefinedCommitment, meeting_day: date) -> tuple[float, int, str, str]:
    due_distance = deadline_distance_days(commitment.deadline, meeting_day)
    due_sort = due_distance if due_distance is not None else 999_999
    text_sort = normalize_action(commitment.action_text or commitment.text)
    return (-commitment.relevance_score, due_sort, text_sort, commitment.id)


def tie_break_key(commitment: RefinedCommitment, meeting_day: date) -> tuple[float, int]:
    due_distance = deadline_distance_days(commitment.deadline, meeting_day)
    due_sort = due_distance if due_distance is not None else 999_999
    return (round(commitment.relevance_score, 4), due_sort)


def deduped_commitments(
    commitments: list[RefinedCommitment],
    *,
    backlog_items: list[str],
    meeting_day: date,
) -> list[RefinedCommitment]:
    kept: list[RefinedCommitment] = []
    comparison_corpus = list(backlog_items)
    ordered = sorted(
        commitments,
        key=lambda commitment: (
            PRIORITY_INDEX.get(commitment.priority, len(PRIORITY_ORDER)),
            priority_group_sort_key(commitment, meeting_day),
        ),
    )
    for commitment in ordered:
        candidate_text = commitment.action_text or commitment.text
        if any(fuzzy_similarity(candidate_text, existing) >= FUZZY_DEDUP_THRESHOLD for existing in comparison_corpus):
            continue
        kept.append(commitment)
        comparison_corpus.append(candidate_text)
    return kept


def apply_priority_cap(
    commitments: list[RefinedCommitment],
    *,
    cap: int,
    meeting_day: date,
) -> tuple[list[RefinedCommitment], list[RefinedCommitment]]:
    if len(commitments) <= cap:
        ordered = sorted(commitments, key=lambda commitment: priority_group_sort_key(commitment, meeting_day))
        return ordered, []
    ordered = sorted(commitments, key=lambda commitment: priority_group_sort_key(commitment, meeting_day))
    cutoff_key = tie_break_key(ordered[cap - 1], meeting_day)
    if tie_break_key(ordered[cap], meeting_day) == cutoff_key:
        keep: list[RefinedCommitment] = []
        split_at = 0
        for index, commitment in enumerate(ordered):
            if tie_break_key(commitment, meeting_day) == cutoff_key:
                split_at = index
                break
            keep.append(commitment)
        else:
            split_at = len(ordered)
        return keep, ordered[split_at:]
    return ordered[:cap], ordered[cap:]


def enforce_priority_caps(commitments: list[RefinedCommitment], *, meeting_day: date) -> list[RefinedCommitment]:
    buckets = {priority: [] for priority in PRIORITY_ORDER}
    for commitment in commitments:
        buckets.setdefault(commitment.priority, []).append(commitment)

    kept_p0, demoted_p0 = apply_priority_cap(buckets["P0"], cap=P0_CAP, meeting_day=meeting_day)
    p1_pool = buckets["P1"] + [replace(commitment, priority="P1") for commitment in demoted_p0]
    kept_p1, demoted_p1 = apply_priority_cap(p1_pool, cap=P1_CAP, meeting_day=meeting_day)
    p2_pool = buckets["P2"] + [replace(commitment, priority="P2") for commitment in demoted_p1]
    kept_p2 = sorted(p2_pool, key=lambda commitment: priority_group_sort_key(commitment, meeting_day))
    kept_p3 = sorted(buckets["P3"], key=lambda commitment: priority_group_sort_key(commitment, meeting_day))
    return kept_p0 + kept_p1 + kept_p2 + kept_p3


def refine_outbound_item(
    item: ExtractedItem,
    *,
    meeting_id: str,
    meeting_day: date,
    josh_sentences: list[str],
    source_ref: str,
) -> RefinedCommitment | None:
    if not has_concrete_action(item.action):
        return None
    if is_already_handled(item.due_date):
        return None
    support = best_support_sentence(item.action, josh_sentences)
    if is_casual_self_disclosure(item.action, item.due_date, support or ""):
        return None
    if has_unsupported_imprecise_due(item.due_date, meeting_day, support or ""):
        return None
    due = resolve_grounded_due_date(item.due_date, meeting_day, support or "")
    counterparty = extract_counterparty(item.action) or (
        extract_counterparty(support) if support else None
    )
    if due is None and counterparty is None and not (
        # A source-backed timeframe may be imprecise, or the model may have
        # sharpened it into an unsupported exact date. Keep the commitment but
        # leave deadline blank in either case; only unsupported vague phrases
        # are rejected above.
        source_has_explicit_timeframe(support or "")
        or has_explicit_timeframe(item.due_date, meeting_day, support or "")
    ):
        return None
    if is_suppressed(item.owner, item.action, counterparty):
        return None
    return RefinedCommitment(
        id=commitment_id(meeting_id, item.action),
        text=build_commitment_text(item.action, due),
        source="ff",
        source_ref=source_ref,
        direction="outbound",
        action_text=item.action,
        owner="Josh",
        deadline=due or "",
        source_quote=support or "",
    )


def refine_inbound_item(
    item: ExtractedItem,
    *,
    meeting_id: str,
    meeting_day: date,
    source_ref: str,
    all_sentences: list[str] | None = None,
) -> RefinedCommitment | None:
    # Conservative inbound gate (client → Josh): concrete named owner only.
    if is_generic_owner(item.owner):
        return None
    if not has_concrete_action(item.action):
        return None
    if is_already_handled(item.due_date):
        return None
    quote = best_support_sentence(item.action, all_sentences or []) or ""
    if is_casual_self_disclosure(item.action, item.due_date, quote):
        return None
    if has_unsupported_imprecise_due(item.due_date, meeting_day, quote):
        return None
    due = resolve_grounded_due_date(item.due_date, meeting_day, quote)
    counterparty = extract_counterparty(item.action)
    josh_tied = (
        "josh" in normalized_tokens(item.action)
        or (counterparty is not None and "josh" in normalize_action(counterparty))
        or source_has_explicit_timeframe(quote)
        or has_explicit_timeframe(item.due_date, meeting_day, quote)
    )
    if not josh_tied:
        return None
    if is_suppressed(item.owner, item.action, counterparty):
        return None
    return RefinedCommitment(
        id=directional_commitment_id(meeting_id, item.action, "inbound"),
        text=build_commitment_text(f"[inbound] {item.owner}: {item.action}", due),
        source="ff-inbound",
        source_ref=source_ref,
        direction="inbound",
        action_text=item.action,
        owner=item.owner,
        deadline=due or "",
        source_quote=quote,
    )


def refine_generic_owner_item(
    item: ExtractedItem,
    *,
    meeting_id: str,
    meeting_day: date,
    all_sentences: list[str],
    source_ref: str,
) -> RefinedCommitment | None:
    """Keep only transcript-grounded generic-owner promises for later assignment."""
    if not is_generic_owner(item.owner):
        return None
    if not has_concrete_action(item.action) or is_already_handled(item.due_date):
        return None
    support = best_support_sentence(item.action, all_sentences)
    if support is None or EXPLICIT_COMMITMENT_RE.search(support) is None:
        return None
    if not source_has_explicit_timeframe(support):
        return None
    if item.due_date and not source_matches_timeframe(item.due_date, meeting_day, support):
        return None
    if is_casual_self_disclosure(item.action, item.due_date, support):
        return None
    due = resolve_grounded_due_date(item.due_date, meeting_day, support)
    counterparty = extract_counterparty(item.action) or extract_counterparty(support)
    if is_suppressed(item.owner, item.action, counterparty):
        return None
    return RefinedCommitment(
        id=commitment_id(meeting_id, item.action),
        text=build_commitment_text(item.action, due),
        source="ff",
        source_ref=source_ref,
        direction="unassigned",
        action_text=item.action,
        owner="NEEDS-OWNER",
        deadline=due or "",
        source_quote=support,
    )


def refine_items(
    transcript: dict[str, Any],
    extracted_items: list[ExtractedItem],
    *,
    client_record: dict[str, Any] | None = None,
) -> list[RefinedCommitment]:
    meeting_id = str(transcript.get("id") or "")
    title = collapse_ws(str(transcript.get("title") or "Untitled Meeting"))
    if not meeting_id:
        return []
    josh_sentences = extract_josh_sentences(transcript)
    all_sentences = extract_all_sentences(transcript)
    meeting_day = meeting_day_from_transcript(transcript)
    source_ref = f"{meeting_id} · {title}"
    commitments: list[RefinedCommitment] = []
    seen_ids: set[str] = set()

    for item in extracted_items:
        effective_item = item
        inferred_speaker: str | None = None
        if is_first_person_owner(item.owner):
            speaker = infer_first_person_speaker(transcript, item.action, item.due_date)
            if speaker:
                effective_item = replace(item, owner=speaker)
                inferred_speaker = speaker
        if is_josh_owner(effective_item.owner):
            commitment = refine_outbound_item(
                effective_item,
                meeting_id=meeting_id,
                meeting_day=meeting_day,
                josh_sentences=josh_sentences,
                source_ref=source_ref,
            )
        elif is_generic_owner(effective_item.owner):
            commitment = refine_generic_owner_item(
                effective_item,
                meeting_id=meeting_id,
                meeting_day=meeting_day,
                all_sentences=all_sentences,
                source_ref=source_ref,
            )
        else:
            inbound_sentences = all_sentences
            if inferred_speaker:
                raw_sentences = transcript.get("sentences")
                if isinstance(raw_sentences, list):
                    inbound_sentences = [
                        collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
                        for sentence in raw_sentences
                        if isinstance(sentence, dict)
                        and collapse_ws(str(sentence.get("speaker_name") or "")) == inferred_speaker
                        and collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
                    ]
            commitment = refine_inbound_item(
                effective_item,
                meeting_id=meeting_id,
                meeting_day=meeting_day,
                source_ref=source_ref,
                all_sentences=inbound_sentences,
            )
        if commitment is None or commitment.id in seen_ids:
            continue
        seen_ids.add(commitment.id)
        commitments.append(commitment)

    scored = [
        scored_commitment(commitment, meeting_day=meeting_day, client_record=client_record) for commitment in commitments
    ]
    backlog_items = list(client_record.get("open_items", [])) if client_record is not None else []
    return enforce_priority_caps(
        deduped_commitments(scored, backlog_items=backlog_items, meeting_day=meeting_day),
        meeting_day=meeting_day,
    )


def commitment_entries(
    commitments: list[RefinedCommitment],
    *,
    enriched: bool,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for item in commitments:
        entry: dict[str, Any] = {
            "id": item.id,
            "text": item.text,
            "direction": item.direction,
            "source": item.source,
            "sourceRef": item.source_ref,
        }
        if enriched:
            entry["owner"] = item.owner
            entry["deadline"] = item.deadline
            entry["sourceQuote"] = item.source_quote
            entry["priority"] = item.priority
            entry["relevanceScore"] = item.relevance_score
        entries.append(entry)
    return entries


def commitment_payload_entries(commitments: list[RefinedCommitment]) -> list[dict[str, str]]:
    return commitment_entries(commitments, enriched=False)


def post_commitments(
    *,
    ingest_url: str,
    ingest_token: str,
    commitments: list[RefinedCommitment],
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any]:
    request = urllib.request.Request(
        ingest_url,
        data=json.dumps({"commitments": commitment_payload_entries(commitments)}).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("x-api-key", ingest_token)
    with urlopen(request, timeout=30) as response:
        status = getattr(response, "status", 200)
        payload = json.loads(response.read().decode("utf-8"))
    if status != 200:
        raise ValueError(f"ingest endpoint returned {status}")
    if not isinstance(payload, dict):
        raise ValueError("ingest endpoint response was not an object")
    return payload


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"missing required env: {name}")
    return value


def extract_commitments_for_transcript(
    transcript: dict[str, Any],
    *,
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> tuple[list[RefinedCommitment], str | None]:
    transcript_text = build_transcript_text(transcript.get("sentences", []), limit=CLASSIFIER_MAX_CHARS)
    if not transcript_text:
        return [], "empty_text"

    if is_casual_transcript(transcript_text, openrouter_api_key=openrouter_api_key, urlopen=urlopen):
        return [], "casual"

    client_record = matched_client_context_record_for_transcript(transcript)
    client_context = str(client_record.get("context") or "") if client_record is not None else ""
    extraction_text = build_transcript_text(transcript.get("sentences", []), limit=EXTRACTOR_MAX_CHARS)
    extracted = extract_action_items(
        extraction_text,
        client_context=client_context,
        openrouter_api_key=openrouter_api_key,
        urlopen=urlopen,
    )
    if not extracted:
        return [], "zero_extracted"

    commitments = refine_items(transcript, extracted, client_record=client_record)
    if not commitments:
        return [], "all_refined_out"
    return commitments, None


def execute(
    *,
    limit: int,
    dry_run: bool,
    meeting_id: str = "",
    watermark_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    try:
        return run(
            limit=limit,
            dry_run=dry_run,
            meeting_id=meeting_id,
            watermark_path=watermark_path,
            urlopen=urlopen,
        )
    except (RuntimeError, ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        reason = collapse_ws(str(exc)) or exc.__class__.__name__
        LOGGER.error("ff-extractor failed: %s", reason)
        print(json.dumps({"error": reason, "items": [], "dry_run": dry_run, **empty_drop_reason_counts()}))
        return 1


def run(
    *,
    limit: int,
    dry_run: bool,
    meeting_id: str = "",
    watermark_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    fireflies_api_key = require_env("FIREFLIES_API_KEY")
    openrouter_api_key = require_env("OPENROUTER_API_KEY")
    # Ingest env is only required on the actual POST path. The SKILL's DEGRADED
    # fallback deliberately invokes --dry-run precisely when these are missing,
    # so dry-run must not fail on them.
    ingest_url = ""
    ingest_token = ""
    if not dry_run:
        ingest_url = require_env("BRIEFS_INGEST_URL")
        ingest_token = require_env("TASKS_INGEST_TOKEN")

    watermark_timestamp, watermark_meeting_id = load_watermark(watermark_path)
    recent = fetch_recent_transcripts(fireflies_api_key, limit=limit, urlopen=urlopen)
    if meeting_id:
        fresh = [t for t in recent if str(t.get("id") or "") == meeting_id]
    else:
        fresh = select_recent_transcripts(recent, watermark_timestamp, watermark_meeting_id, limit=limit)
    if not fresh:
        print(
            json.dumps(
                {
                    "meetings": 0,
                    "commitments": 0,
                    "posted": False,
                    "dry_run": dry_run,
                    "items": [],
                    **empty_drop_reason_counts(),
                }
            )
        )
        return 0

    all_commitments: list[RefinedCommitment] = []
    processed: list[dict[str, Any]] = []
    zero_yield_transcripts: list[tuple[dict[str, Any], str]] = []
    drop_reason_counts = empty_drop_reason_counts()
    for transcript in fresh:
        commitments, drop_reason = extract_commitments_for_transcript(
            transcript,
            openrouter_api_key=openrouter_api_key,
            urlopen=urlopen,
        )
        all_commitments.extend(commitments)
        if drop_reason is not None:
            drop_reason_counts[drop_reason] += 1
            zero_yield_transcripts.append((transcript, drop_reason))
        processed.append(transcript)

    items = commitment_entries(all_commitments, enriched=True)
    payload = {"commitments": commitment_payload_entries(all_commitments)}
    if dry_run:
        print(json.dumps({"dry_run": True, "items": items, "payload": payload, **drop_reason_counts}, indent=2))
        return 0

    if payload["commitments"]:
        result = post_commitments(
            ingest_url=ingest_url,
            ingest_token=ingest_token,
            commitments=all_commitments,
            urlopen=urlopen,
        )
        print(
            json.dumps(
                {
                    "meetings": len(processed),
                    "commitments": len(all_commitments),
                    "posted": True,
                    "result": result,
                    "items": items,
                    **drop_reason_counts,
                }
            )
        )
    else:
        print(
            json.dumps(
                {
                    "meetings": len(processed),
                    "commitments": 0,
                    "posted": False,
                    "noop": True,
                    "items": items,
                    **drop_reason_counts,
                }
            )
        )

    for transcript, drop_reason in zero_yield_transcripts:
        append_zero_yield_row(ZERO_YIELD_LEDGER_PATH, transcript, drop_reason)

    if not meeting_id:
        newest = max(processed, key=transcript_sort_key)
        save_watermark(watermark_path, newest)
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract Fireflies commitments into the briefs tasks board")
    parser.add_argument("--dry-run", action="store_true", help="Print the would-be ingest payload without POSTing")
    parser.add_argument("--limit", type=int, default=DEFAULT_TRANSCRIPT_LIMIT)
    parser.add_argument("--watermark-path", default=str(DEFAULT_WATERMARK_PATH))
    parser.add_argument("--recap", action="store_true", help="Emit recap JSON (summary + gated next steps); no POST, no watermark")
    parser.add_argument("--recap-ledger", default=str(STATE_DIR / "meeting-recap-drafts-surfaced.txt"))
    parser.add_argument(
        "--full-ledger",
        default="",
        help="Full mode only: path to ledger of already-filed meeting ids (skip + count skipped_ledger)",
    )
    parser.add_argument(
        "--mode",
        choices=["commitments", "recap", "full"],
        default=None,
        help="Mode: commitments (default), recap, or full (no watermark/POST)",
    )
    parser.add_argument(
        "--meeting-id",
        default="",
        help="Filter to one Fireflies transcript id in commitments or full mode",
    )
    return parser.parse_args(argv)


def execute_recap(
    *,
    limit: int,
    ledger_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    try:
        return run_recap(limit=limit, ledger_path=ledger_path, urlopen=urlopen)
    except (RuntimeError, ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        reason = collapse_ws(str(exc)) or exc.__class__.__name__
        LOGGER.error("ff-extractor recap failed: %s", reason)
        print(json.dumps({"error": reason, "recap": True, "meetings": []}))
        return 1


def load_recap_ledger(path: Path) -> set[str]:
    if not path.exists():
        return set()
    ledger_ids = set()
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                # First whitespace-delimited token is the meeting id
                parts = line.split()
                if parts:
                    ledger_ids.add(parts[0])
    return ledger_ids


def load_ledger(path: Path) -> set[str]:
    """Alias of load_recap_ledger — shared ledger format (id as first token)."""
    return load_recap_ledger(path)


def is_suppressed_meeting(transcript: dict[str, Any]) -> bool:
    suppressed_normalized = [normalize_action(name) for name in SUPPRESSED_NAMES]
    haystacks = [
        collapse_ws(str(transcript.get("title") or "")),
        collapse_ws(str(transcript.get("organizer_email") or "")),
    ]
    # Add participants defensively
    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        for p in participants:
            haystacks.append(collapse_ws(str(p)))
    else:
        haystacks.append(collapse_ws(str(participants)))
    
    for haystack in haystacks:
        haystack_normalized = normalize_action(haystack)
        for name in suppressed_normalized:
            if name in haystack_normalized:
                return True
    return False


def build_recap_meeting(
    transcript: dict[str, Any],
    *,
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any] | None:
    meeting_id = str(transcript.get("id") or "")
    if not meeting_id:
        return None
    
    # Build transcript text for classifier
    sentences = transcript.get("sentences") or []
    if not isinstance(sentences, list):
        sentences = []
    
    transcript_text = build_transcript_text(sentences, limit=CLASSIFIER_MAX_CHARS)
    if not transcript_text:
        return None
    
    # Check if casual
    if is_casual_transcript(transcript_text, openrouter_api_key=openrouter_api_key, urlopen=urlopen):
        return None
    
    # Extract action items for next steps
    client_record = matched_client_context_record_for_transcript(transcript)
    client_context = str(client_record.get("context") or "") if client_record is not None else ""
    extractor_text = build_transcript_text(sentences, limit=EXTRACTOR_MAX_CHARS)
    extracted = extract_action_items(
        extractor_text,
        client_context=client_context,
        openrouter_api_key=openrouter_api_key,
        urlopen=urlopen,
    )

    # Decisions + deal-state: the two extractions the writeback used to hardcode as
    # "none" / "no change". Carry them forward in the full-mode payload.
    decisions, deal_state = extract_decisions_and_deal_state(
        extractor_text,
        client_context=client_context,
        openrouter_api_key=openrouter_api_key,
        urlopen=urlopen,
    )

    # Build participants list defensively
    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        attendees = [collapse_ws(str(p)) for p in participants if p]
    else:
        attendees = []
    attendee_names = {attendee.lower() for attendee in attendees if attendee}
    speakers = transcript.get("speakers") or []
    if isinstance(speakers, list):
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            speaker_name = collapse_ws(str(speaker.get("name") or ""))
            if not speaker_name:
                continue
            speaker_name_lower = speaker_name.lower()
            if speaker_name_lower in attendee_names:
                continue
            attendees.append(speaker_name)
            attendee_names.add(speaker_name_lower)
    
    # Build summary defensively
    summary = transcript.get("summary") or {}
    if not isinstance(summary, dict):
        summary = {}
    
    # Parse date
    date_str = transcript.get("date") or ""
    if date_str:
        try:
            parsed_date = parse_transcript_datetime(date_str)
            date_iso = parsed_date.isoformat() if parsed_date.tzinfo else parsed_date.isoformat() + "Z"
        except (ValueError, AttributeError):
            date_iso = ""
    else:
        date_iso = ""
    
    return {
        "id": meeting_id,
        "title": collapse_ws(str(transcript.get("title") or "Untitled Meeting")),
        "date": date_iso,
        "organizer": collapse_ws(str(transcript.get("organizer_email") or "")),
        "attendees": attendees,
        "summary": {
            "overview": collapse_ws(str(summary.get("overview") or "")),
            "bullets": collapse_ws(str(summary.get("shorthand_bullet") or "")),
            "action_items": collapse_ws(str(summary.get("action_items") or "")),
        },
        "client_context": client_context,
        "decisions": decisions,
        "deal_state": deal_state,
        "next_steps": commitment_entries(refine_items(transcript, extracted, client_record=client_record), enriched=True),
    }


def run_recap(
    *,
    limit: int,
    ledger_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    fireflies_api_key = require_env("FIREFLIES_API_KEY")
    openrouter_api_key = require_env("OPENROUTER_API_KEY")
    
    ledger_ids = load_recap_ledger(ledger_path)
    recent = fetch_recent_transcripts(fireflies_api_key, limit=limit, urlopen=urlopen)
    
    # Order newest-first
    recent_sorted = sorted(recent, key=transcript_sort_key, reverse=True)
    
    meetings = []
    skipped_ledger = 0
    skipped_suppressed = 0
    skipped_casual = 0
    
    for transcript in recent_sorted:
        meeting_id = str(transcript.get("id") or "")
        if not meeting_id:
            continue
        
        if meeting_id in ledger_ids:
            skipped_ledger += 1
            continue
        
        if is_suppressed_meeting(transcript):
            skipped_suppressed += 1
            continue
        
        recap_meeting = build_recap_meeting(
            transcript,
            openrouter_api_key=openrouter_api_key,
            urlopen=urlopen,
        )
        if recap_meeting is None:
            skipped_casual += 1
            continue
        
        meetings.append(recap_meeting)
        if len(meetings) >= limit:
            break
    
    print(json.dumps({
        "recap": True,
        "meetings": meetings,
        "skipped_ledger": skipped_ledger,
        "skipped_casual": skipped_casual,
        "skipped_suppressed": skipped_suppressed,
    }))
    return 0


def execute_full(
    *,
    limit: int,
    meeting_id: str,
    full_ledger_path: Path | None = None,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    try:
        return run_full(limit=limit, meeting_id=meeting_id, full_ledger_path=full_ledger_path, urlopen=urlopen)
    except (RuntimeError, ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        reason = collapse_ws(str(exc)) or exc.__class__.__name__
        LOGGER.error("ff-extractor full failed: %s", reason)
        print(json.dumps({"error": reason, "mode": "full", "meetings": []}))
        return 1


def run_full(
    *,
    limit: int,
    meeting_id: str,
    full_ledger_path: Path | None = None,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    fireflies_api_key = require_env("FIREFLIES_API_KEY")
    openrouter_api_key = require_env("OPENROUTER_API_KEY")

    ledger_ids = load_ledger(full_ledger_path) if full_ledger_path else set()
    recent = fetch_recent_transcripts(fireflies_api_key, limit=limit, urlopen=urlopen)
    recent_sorted = sorted(recent, key=transcript_sort_key, reverse=True)

    if meeting_id:
        recent_sorted = [t for t in recent_sorted if str(t.get("id") or "") == meeting_id]

    meetings: list[dict[str, Any]] = []
    skipped_ledger = 0
    skipped_suppressed = 0
    skipped_casual = 0

    for transcript in recent_sorted:
        tid = str(transcript.get("id") or "")
        if not tid:
            continue

        if tid in ledger_ids:
            skipped_ledger += 1
            continue

        if is_suppressed_meeting(transcript):
            skipped_suppressed += 1
            continue

        recap_meeting = build_recap_meeting(
            transcript,
            openrouter_api_key=openrouter_api_key,
            urlopen=urlopen,
        )
        if recap_meeting is None:
            skipped_casual += 1
            continue

        meetings.append(recap_meeting)
        if not meeting_id and len(meetings) >= limit:
            break

    print(json.dumps({
        "mode": "full",
        "meetings": meetings,
        "skipped_ledger": skipped_ledger,
        "skipped_casual": skipped_casual,
        "skipped_suppressed": skipped_suppressed,
    }))
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)
    mode = args.mode or ("recap" if args.recap else "commitments")
    if args.mode and args.recap:
        recap_from_flag = "recap"
        if args.mode != recap_from_flag:
            print(
                f"ERROR: --mode {args.mode} conflicts with --recap",
                file=__import__("sys").stderr,
            )
            return 2
    if mode == "recap":
        return execute_recap(
            limit=max(1, args.limit),
            ledger_path=Path(args.recap_ledger),
        )
    if mode == "full":
        return execute_full(
            limit=max(1, args.limit),
            meeting_id=str(args.meeting_id or ""),
            full_ledger_path=Path(args.full_ledger) if args.full_ledger else None,
        )
    return execute(
        limit=max(1, args.limit),
        dry_run=args.dry_run,
        meeting_id=str(args.meeting_id or ""),
        watermark_path=Path(args.watermark_path),
    )


if __name__ == "__main__":
    raise SystemExit(main())
