# Meeting Writeback Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to file NEW meeting intelligence into `knowledge/meetings/*.md` and write it back to `knowledge/clients/*.md`. Complete it and stop.

DO NOT:
- Read bootstrap files
- Update heartbeat
- Write to daily memory
- Send Telegram
- Emit kb-dream payloads or guess a kb verdict

DO:
- Run the exact bash blocks below in order
- Stay SILENT-OK on empty
- Output DONE when complete

This worker intentionally stops after file writeback. `kb-dream` emission stays manual only.

---

## Step 1 — Task + ledger setup (Bash)

```bash
TASK_ID=$(cortextos bus create-task "Cron: meeting-writeback" --desc "File new meeting intelligence into knowledge/meetings and knowledge/clients" --assignee "${CTX_PARENT_AGENT:-pa}" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
LEDGER_FILE='/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/state/ff-full-writeback-surfaced.txt'
mkdir -p "$(dirname "$LEDGER_FILE")"
[[ -f "$LEDGER_FILE" ]] || touch "$LEDGER_FILE"
echo "ledger=$(wc -l < "$LEDGER_FILE")"
```

---

## Step 2 — Run the extractor in full mode (Bash)

Working directory MUST be the pa agent dir so `scripts/` and `state/` resolve correctly.

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/.env 2>/dev/null
source /Users/joshweiss/code/cortextos/orgs/clearworksai/secrets.env 2>/dev/null
set +a

if [[ -n "${FF_MEETING_ID:-}" ]]; then
  python3 scripts/ff-extractor.py --mode full --meeting-id "$FF_MEETING_ID" --limit 1 --full-ledger state/ff-full-writeback-surfaced.txt > /tmp/ff-writeback.json
else
  python3 scripts/ff-extractor.py --mode full --limit 20 --full-ledger state/ff-full-writeback-surfaced.txt > /tmp/ff-writeback.json
fi
EXTRACTOR_RC=$?
echo "extractor_rc=$EXTRACTOR_RC"
```

If `EXTRACTOR_RC` is nonzero, skip straight to Step 4. No Telegram, no ledger writes.

---

## Step 3 — File meetings + client writeback (Bash)

For each meeting in `/tmp/ff-writeback.json`:
- File it under `knowledge/meetings/YYYY-MM-DD-[client]-[topic].md`
- Use the exact header schema: `**Attendees:** | **Source:** | **Processed:**`
- Prepend the exact History entry schema to the matched client file
- Append exact Open Items rows (`| Item | Owner | Deadline | Source | Status |`)
- `Owner` fallback = `NEEDS-OWNER`
- `Deadline` fallback = `NEEDS-DEADLINE`
- Append the Fireflies meeting id to the ledger ONLY after both writes succeed for that meeting

```bash
python3 - <<'PY' > /tmp/ff-writeback-result.json
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/Users/joshweiss/code/cortextos/orgs/clearworksai")
KNOWLEDGE_DIR = ROOT / "knowledge"
MEETINGS_DIR = KNOWLEDGE_DIR / "meetings"
CLIENTS_DIR = KNOWLEDGE_DIR / "clients"
TEMPLATE_PATH = CLIENTS_DIR / "_template.md"
PAYLOAD_PATH = Path("/tmp/ff-writeback.json")
LEDGER_PATH = Path("/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/state/ff-full-writeback-surfaced.txt")

MEETINGS_DIR.mkdir(parents=True, exist_ok=True)
CLIENTS_DIR.mkdir(parents=True, exist_ok=True)


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


def seed_client_file(path: Path, client_name: str, meeting: dict[str, object]) -> None:
    if TEMPLATE_PATH.exists():
        body = TEMPLATE_PATH.read_text(encoding="utf-8")
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


def parse_client_sections(path: Path, client_name: str, meeting: dict[str, object]) -> tuple[str, dict[str, list[str]]]:
    if not path.exists():
        seed_client_file(path, client_name, meeting)
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


def guess_client_file(meeting: dict[str, object], existing_clients: dict[str, Path]) -> tuple[Path, str, bool, str | None]:
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
    path = CLIENTS_DIR / f"{slugify(guess)}.md"
    created = not path.exists()
    if created:
        seed_client_file(path, guess, meeting)
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


payload = json.loads(PAYLOAD_PATH.read_text(encoding="utf-8"))
meetings = payload.get("meetings") or []
if not isinstance(meetings, list):
    meetings = []

existing_clients = {
    path.stem.lower(): path
    for path in CLIENTS_DIR.glob("*.md")
    if path.name != "_template.md"
}

written_meetings: list[str] = []
created_clients: list[str] = []
flags: list[str] = []

with LEDGER_PATH.open("a", encoding="utf-8") as ledger_handle:
    for meeting in meetings:
        if not isinstance(meeting, dict):
            continue
        meeting_id = collapse_ws(str(meeting.get("id") or ""))
        if not meeting_id:
            continue

        client_path, client_name, created_client, flag = guess_client_file(meeting, existing_clients)
        if created_client:
            created_clients.append(client_name)
        if flag:
            flags.append(flag)

        meeting_date = parse_date_iso(str(meeting.get("date") or ""))
        topic = derive_topic(str(meeting.get("title") or ""), client_name)
        meeting_filename = f"{meeting_date}-{slugify(client_name)}-{slugify(topic)}.md"
        meeting_path = MEETINGS_DIR / meeting_filename
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

        title, sections = parse_client_sections(client_path, client_name, meeting)
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

print(
    json.dumps(
        {
            "written_count": len(written_meetings),
            "written_meetings": written_meetings,
            "created_client_count": len(created_clients),
            "created_clients": created_clients,
            "flags": flags,
        }
    )
)
PY
WRITEBACK_RC=$?
echo "writeback_rc=$WRITEBACK_RC"
```

If `WRITEBACK_RC` is nonzero, skip straight to Step 4.

When this worker was launched for a Fireflies webhook (`FF_MEETING_ID` is set), notify CRM only after the writeback block reports a successful meeting write. The event is the handoff for deterministic CRM persistence, not a substitute for the meeting/client file writes:

```bash
if [[ -n "${FF_MEETING_ID:-}" && "$WRITEBACK_RC" -eq 0 ]]; then
  cortextos bus send-message crm normal "EVENT crm.meeting.completed — {\"meeting_id\":\"$FF_MEETING_ID\"}"
fi
```

---

## Step 4 — Complete and exit (Bash)

```bash
RESULT="Meeting writeback checked"
if [[ -f /tmp/ff-writeback-result.json ]]; then
  RESULT=$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/ff-writeback-result.json").read_text(encoding="utf-8"))
print(
    "Meeting writeback checked: "
    f"written={payload.get('written_count', 0)} "
    f"created_clients={payload.get('created_client_count', 0)}"
)
PY
)
fi
cortextos bus complete-task $TASK_ID --result "$RESULT" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"meeting-writeback","agent":"pa"}' 2>/dev/null
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
