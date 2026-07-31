from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
INTERACTIONS_PATH = Path(
    os.environ.get(
        "CRM_INTERACTIONS_INPUT",
        str(ROOT / "interactions.jsonl"),
    )
)
DEFAULT_OUTPUT_ROOT = Path.home() / "code" / "knowledge-sync" / "raw" / "resources" / "crm-interactions"
SAFE_STEM_RE = re.compile(r"[^A-Za-z0-9._-]+")
COMMITMENT_OWNER_RE = re.compile(r"^([A-Za-z][A-Za-z .'\-]{0,40}):\s+(.+)$")
OUR_SIDE_OWNERS = frozenset({"josh", "clearworks", "clearworks.ai"})
OPEN_ITEM_EMPTY_VALUE = "—"
DEAL_STATE_KEYWORDS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("closed won", "signed"), "closed-won"),
    (("closed lost", "passed on", "not moving forward"), "closed-lost"),
    (("proposal sent", "sent the proposal", "sent proposal"), "proposal"),
    (("on hold", "paused"), "on-hold"),
)


@dataclass(frozen=True)
class InteractionRecord:
    ts: str
    contact_id: str
    interaction_type: str
    summary: str
    sentiment: str
    commitments: tuple[str, ...]
    followups_created: tuple[str, ...]
    source_ref: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "InteractionRecord":
        ts = _optional_text(payload.get("ts")) or _optional_text(payload.get("timestamp"))
        if not ts:
            raise ValueError("missing required field 'ts'")
        contact_id = _required_text(payload, "contact_id")
        interaction_type = _required_text(payload, "type")
        summary = _required_text(payload, "summary")
        sentiment = _optional_text(payload.get("sentiment"), default="unknown")
        commitments = _string_tuple(payload.get("commitments"))
        followups_created = _string_tuple(payload.get("followups_created"))
        source_ref = _optional_text(payload.get("source_ref"), default="")
        return cls(
            ts=ts,
            contact_id=contact_id,
            interaction_type=interaction_type,
            summary=summary,
            sentiment=sentiment,
            commitments=commitments,
            followups_created=followups_created,
            source_ref=source_ref,
        )


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = _optional_text(payload.get(key))
    if not value:
        raise ValueError(f"missing required field '{key}'")
    return value


def _optional_text(value: Any, *, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        text = value.strip()
        return text or default
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
    return str(value).strip() or default


def _string_tuple(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if not isinstance(value, list):
        raise ValueError("expected list value")

    items: list[str] = []
    for item in value:
        text = _optional_text(item)
        if text:
            items.append(text)
    return tuple(items)


def _safe_contact_stem(contact_id: str) -> str:
    normalized = SAFE_STEM_RE.sub("-", contact_id.strip()).strip("-._")
    return normalized or "unknown-contact"


def stable_hash(record: InteractionRecord) -> str:
    seed = f"{record.contact_id}|{record.source_ref}|{record.ts}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]


def note_path_for_record(record: InteractionRecord, output_root: Path) -> Path:
    return output_root / f"{_safe_contact_stem(record.contact_id)}__{stable_hash(record)}.md"


def render_note(record: InteractionRecord) -> str:
    lines = [
        "---",
        f"contact_id: {json.dumps(record.contact_id, ensure_ascii=True)}",
        f"type: {json.dumps(record.interaction_type, ensure_ascii=True)}",
        f"sentiment: {json.dumps(record.sentiment, ensure_ascii=True)}",
        f"ts: {json.dumps(record.ts, ensure_ascii=True)}",
        f"source_ref: {json.dumps(record.source_ref, ensure_ascii=True)}",
        "---",
        "",
        f"# CRM interaction for {record.contact_id}",
        "",
        _summary_paragraph(record),
        "",
        f"**Deal state:** {derive_deal_state(record)}",
    ]

    open_items_section = _render_open_items_section(record)
    if open_items_section:
        lines.extend(["", *open_items_section])

    return "\n".join(lines) + "\n"


def _summary_paragraph(record: InteractionRecord) -> str:
    source_sentence = ""
    if record.source_ref:
        source_sentence = f" Source reference: {record.source_ref}."

    return (
        f"On {record.ts}, {record.contact_id} had a {record.sentiment} "
        f"{record.interaction_type} interaction. {_ensure_sentence(record.summary)}{source_sentence}"
    )


def _ensure_sentence(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    if stripped[-1] in ".!?":
        return stripped
    return f"{stripped}."


def _render_open_items_section(record: InteractionRecord) -> list[str]:
    rows = [*_commitment_rows(record.commitments), *_followup_rows(record.followups_created)]
    if not rows:
        return []

    lines = [
        "## Open items",
        "",
        "| Item | Owner | Side | Deadline | Source | Status |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    lines.extend(
        f"| {_escape_table_cell(item)} | {_escape_table_cell(owner)} | {_escape_table_cell(side)} | "
        f"{_escape_table_cell(deadline)} | {_escape_table_cell(source)} | {_escape_table_cell(status)} |"
        for item, owner, side, deadline, source, status in rows
    )
    return lines


def _commitment_rows(commitments: tuple[str, ...]) -> list[tuple[str, str, str, str, str, str]]:
    rows: list[tuple[str, str, str, str, str, str]] = []
    for commitment in commitments:
        owner, item = _parse_commitment(commitment)
        rows.append((item, owner, _owner_side(owner), OPEN_ITEM_EMPTY_VALUE, "commitments", "open"))
    return rows


def _followup_rows(followups_created: tuple[str, ...]) -> list[tuple[str, str, str, str, str, str]]:
    return [
        (followup_id, "clearworks", "ours", OPEN_ITEM_EMPTY_VALUE, "followups_created", "created")
        for followup_id in followups_created
    ]


def _parse_commitment(commitment: str) -> tuple[str, str]:
    match = COMMITMENT_OWNER_RE.match(commitment)
    if match:
        return match.group(1), match.group(2)
    return "unknown", commitment


def _owner_side(owner: str) -> str:
    if owner == "unknown":
        return "unknown"
    if owner.lower() in OUR_SIDE_OWNERS:
        return "ours"
    return "theirs"


def _escape_table_cell(value: str) -> str:
    return re.sub(r"\s*[\r\n]+\s*", " ", value).replace("|", r"\|")


def derive_deal_state(record: InteractionRecord) -> str:
    summary = record.summary.lower()
    if any(_summary_contains_keyword(summary, keyword) for keyword in ("no change", "unchanged", "status quo")):
        return "unchanged"

    for keywords, state in DEAL_STATE_KEYWORDS:
        if any(_summary_contains_keyword(summary, keyword) for keyword in keywords):
            return f"unknown -> {state}"
    return "unknown"


def _summary_contains_keyword(summary: str, keyword: str) -> bool:
    pattern = r"\b" + re.escape(keyword).replace(r"\ ", r"\s+") + r"\b"
    return re.search(pattern, summary, flags=re.IGNORECASE) is not None


def transform_interactions(
    input_path: Path,
    output_root: Path,
    *,
    dry_run: bool = False,
    stderr: Any = sys.stderr,
) -> dict[str, Any]:
    output_root = output_root.expanduser()
    if not dry_run:
        output_root.mkdir(parents=True, exist_ok=True)

    summary = {
        "input_path": str(input_path),
        "output_root": str(output_root),
        "records_seen": 0,
        "valid_records": 0,
        "notes_written": 0,
        "notes_unchanged": 0,
        "skipped_lines": 0,
    }

    if not input_path.exists():
        raise FileNotFoundError(f"interactions file not found: {input_path}")

    with input_path.open("r", encoding="utf-8") as fh:
        for line_number, raw_line in enumerate(fh, start=1):
            line = raw_line.strip()
            if not line:
                continue

            summary["records_seen"] += 1
            try:
                payload = json.loads(line)
                if not isinstance(payload, dict):
                    raise ValueError("line is not a JSON object")
                record = InteractionRecord.from_payload(payload)
            except (json.JSONDecodeError, ValueError) as exc:
                summary["skipped_lines"] += 1
                print(f"Skipping line {line_number}: {exc}", file=stderr)
                continue

            summary["valid_records"] += 1
            note_path = note_path_for_record(record, output_root)
            rendered = render_note(record)

            existing = None
            if note_path.exists():
                existing = note_path.read_text(encoding="utf-8")
            if existing == rendered:
                summary["notes_unchanged"] += 1
                continue

            if not dry_run:
                note_path.write_text(rendered, encoding="utf-8")
            summary["notes_written"] += 1

    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render CRM interactions.jsonl records into deterministic markdown notes."
    )
    parser.add_argument("--input", type=Path, default=INTERACTIONS_PATH)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    summary = transform_interactions(
        args.input.expanduser(),
        args.output_root,
        dry_run=args.dry_run,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
