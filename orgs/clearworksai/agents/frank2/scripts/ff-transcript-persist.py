#!/usr/bin/env python3
"""Persist full Fireflies transcripts into the git-tracked knowledge store."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
ORG_DIR = AGENT_DIR.parent.parent
STATE_DIR = AGENT_DIR / "state"
DEFAULT_LEDGER_PATH = STATE_DIR / "ff-transcript-persist-ledger.txt"
DEFAULT_TRANSCRIPTS_DIR = ORG_DIR / "knowledge" / "transcripts"
DEFAULT_LIMIT = 20
FF_EXTRACTOR_PATH = SCRIPT_PATH.with_name("ff-extractor.py")

Urlopen = Callable[..., Any]


def load_ff_extractor() -> Any:
    spec = importlib.util.spec_from_file_location("ff_extractor_for_transcript_persist", FF_EXTRACTOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load ff-extractor.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


FF = load_ff_extractor()


def transcript_date(transcript: dict[str, Any]) -> str:
    timestamp = FF.parse_transcript_datetime(transcript.get("date"))
    if timestamp is None:
        return "1970-01-01"
    return timestamp.date().isoformat()


def transcript_filename(transcript: dict[str, Any]) -> str:
    meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
    if not meeting_id:
        raise ValueError("transcript missing id")
    return f"{transcript_date(transcript)}-{meeting_id}.md"


def transcript_rel_path(transcript: dict[str, Any]) -> str:
    return f"knowledge/transcripts/{transcript_filename(transcript)}"


def yaml_scalar(value: str) -> str:
    return json.dumps(FF.collapse_ws(value), ensure_ascii=False)


def summary_description(transcript: dict[str, Any]) -> str:
    summary = transcript.get("summary") or {}
    if not isinstance(summary, dict):
        return ""
    return FF.collapse_ws(str(summary.get("overview") or ""))[:200]


def transcript_attendees(transcript: dict[str, Any]) -> str:
    participants = transcript.get("participants") or []
    if isinstance(participants, list):
        values = [FF.collapse_ws(str(participant)) for participant in participants]
    else:
        values = [FF.collapse_ws(str(participants))]
    values = [value for value in values if value]
    return ", ".join(values)


def transcript_duration_minutes(transcript: dict[str, Any]) -> str:
    raw_value = transcript.get("duration")
    if raw_value in (None, ""):
        return ""
    try:
        numeric = float(raw_value)
    except (TypeError, ValueError):
        return ""
    if numeric > 600:
        numeric = numeric / 60.0
    return str(max(0, int(round(numeric))))


def transcript_lines(transcript: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    sentences = transcript.get("sentences") or []
    if not isinstance(sentences, list):
        return lines
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        speaker = FF.collapse_ws(str(sentence.get("speaker_name") or "Unknown"))
        text = FF.collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if not text:
            continue
        lines.append(f"{speaker}: {text}")
    return lines


def build_transcript_markdown(transcript: dict[str, Any]) -> str:
    meeting_date = transcript_date(transcript)
    meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
    title = FF.collapse_ws(str(transcript.get("title") or "Untitled Meeting"))
    organizer = FF.collapse_ws(str(transcript.get("organizer_email") or ""))
    attendees = transcript_attendees(transcript)
    transcript_url = FF.collapse_ws(str(transcript.get("transcript_url") or ""))
    duration_min = transcript_duration_minutes(transcript)
    lines = transcript_lines(transcript)
    description = summary_description(transcript)

    frontmatter = [
        "---",
        f"title: {yaml_scalar(title)}",
        f"description: {yaml_scalar(description)}",
        f"meeting_id: {yaml_scalar(meeting_id)}",
        f"date: {yaml_scalar(meeting_date)}",
        f"organizer: {yaml_scalar(organizer)}",
        f"attendees: {yaml_scalar(attendees)}",
        "source: fireflies",
        "doc_kind: transcript",
        f"duration_min: {yaml_scalar(duration_min)}",
        "---",
        "",
    ]
    body = [
        f"# {meeting_date} · {title} — full transcript",
        "",
        "## Meeting",
        "",
        f"- Meeting ID: {meeting_id}",
        f"- Date: {meeting_date}",
        f"- Organizer: {organizer}",
        f"- Attendees: {attendees}",
        f"- Fireflies: {transcript_url}",
        "",
        "## Transcript",
        "",
        *lines,
        "",
    ]
    return "\n".join(frontmatter + body)


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def append_ledger(ledger_path: Path, meeting_id: str) -> None:
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ledger_path, "a", encoding="utf-8") as handle:
        handle.write(f"{meeting_id} {int(datetime.now(FF.UTC).timestamp())}\n")


def fetch_transcripts_page(
    api_key: str,
    *,
    limit: int,
    skip: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    query = f"query($limit: Int, $skip: Int) {{ transcripts(limit: $limit, skip: $skip) {{ {FF.TRANSCRIPT_FIELDS} }} }}"
    data = FF.fireflies_graphql(api_key, query, {"limit": limit, "skip": skip}, urlopen=urlopen)
    transcripts = data.get("transcripts")
    if not isinstance(transcripts, list):
        return []
    return [item for item in transcripts if isinstance(item, dict)]


def fetch_backfill_transcripts(
    api_key: str,
    *,
    page_size: int,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    skip = 0
    collected: list[dict[str, Any]] = []
    while True:
        batch = fetch_transcripts_page(api_key, limit=page_size, skip=skip, urlopen=urlopen)
        if not batch:
            break
        collected.extend(batch)
        if len(batch) < page_size:
            break
        skip += page_size
    return collected


def select_transcripts(
    api_key: str,
    *,
    limit: int,
    meeting_id: str,
    backfill: bool,
    urlopen: Urlopen = urllib.request.urlopen,
) -> list[dict[str, Any]]:
    if backfill:
        transcripts = fetch_backfill_transcripts(api_key, page_size=max(limit, DEFAULT_LIMIT), urlopen=urlopen)
    else:
        transcripts = FF.fetch_recent_transcripts(api_key, limit=limit, urlopen=urlopen)
    ordered = sorted(transcripts, key=FF.transcript_sort_key)
    if meeting_id:
        ordered = [transcript for transcript in ordered if str(transcript.get("id") or "") == meeting_id]
    if backfill:
        return ordered
    return ordered[:limit]


def persist_one(
    transcript: dict[str, Any],
    *,
    transcripts_dir: Path,
    ledger_ids: set[str],
    ledger_path: Path,
    dry_run: bool,
) -> tuple[str, str | None, list[str] | None]:
    meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
    if not meeting_id:
        return "empty", None, None
    if meeting_id in ledger_ids:
        return "skipped_ledger", transcript_rel_path(transcript), None
    if FF.is_suppressed_meeting(transcript):
        return "empty", None, None
    content = build_transcript_markdown(transcript)
    lines = transcript_lines(transcript)
    if not lines:
        return "empty", None, None

    relative_path = transcript_rel_path(transcript)
    target_path = transcripts_dir / transcript_filename(transcript)
    preview = content.splitlines()[:12]
    if dry_run:
        return "persisted", relative_path, preview

    atomic_write(target_path, content)
    append_ledger(ledger_path, meeting_id)
    ledger_ids.add(meeting_id)
    return "persisted", relative_path, None


def run_persist(
    *,
    dry_run: bool,
    limit: int,
    meeting_id: str,
    backfill: bool,
    ledger_path: Path,
    transcripts_dir: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    api_key = FF.require_env("FIREFLIES_API_KEY")
    ledger_ids = FF.load_ledger(ledger_path)
    transcripts = select_transcripts(
        api_key,
        limit=limit,
        meeting_id=meeting_id,
        backfill=backfill,
        urlopen=urlopen,
    )

    persisted = 0
    skipped_ledger = 0
    empty = 0
    files: list[str] = []
    previews: dict[str, list[str]] = {}
    for transcript in transcripts:
        status, relative_path, preview = persist_one(
            transcript,
            transcripts_dir=transcripts_dir,
            ledger_ids=ledger_ids,
            ledger_path=ledger_path,
            dry_run=dry_run,
        )
        if status == "persisted":
            persisted += 1
        elif status == "skipped_ledger":
            skipped_ledger += 1
        else:
            empty += 1
        if relative_path:
            files.append(relative_path)
        if preview is not None and relative_path:
            previews[relative_path] = preview

    payload: dict[str, Any] = {
        "persisted": persisted,
        "skipped_ledger": skipped_ledger,
        "empty": empty,
        "files": files,
        "dry_run": dry_run,
    }
    if dry_run and previews:
        payload["previews"] = previews
    print(json.dumps(payload, indent=2 if dry_run else None))
    return 0


def execute(
    *,
    dry_run: bool,
    limit: int,
    meeting_id: str,
    backfill: bool,
    ledger_path: Path,
    transcripts_dir: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    try:
        return run_persist(
            dry_run=dry_run,
            limit=limit,
            meeting_id=meeting_id,
            backfill=backfill,
            ledger_path=ledger_path,
            transcripts_dir=transcripts_dir,
            urlopen=urlopen,
        )
    except (RuntimeError, ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        reason = FF.collapse_ws(str(exc)) or exc.__class__.__name__
        FF.LOGGER.error("ff-transcript-persist failed: %s", reason)
        print(json.dumps({"error": reason, "persisted": 0, "skipped_ledger": 0, "empty": 0, "files": [], "dry_run": dry_run}))
        return 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persist full Fireflies transcripts to the knowledge store")
    parser.add_argument("--dry-run", action="store_true", help="Print would-be file paths and previews without writing")
    parser.add_argument("--meeting-id", default="", help="Persist a single Fireflies meeting id when present in the fetched window")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Max recent transcripts to consider")
    parser.add_argument("--backfill", action="store_true", help="Walk the full Fireflies history via paged GraphQL requests")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER_PATH), help="Path to the idempotency ledger")
    parser.add_argument("--transcripts-dir", default=str(DEFAULT_TRANSCRIPTS_DIR), help="Output directory for transcript markdown files")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    return execute(
        dry_run=bool(args.dry_run),
        limit=max(1, int(args.limit)),
        meeting_id=str(args.meeting_id or ""),
        backfill=bool(args.backfill),
        ledger_path=Path(args.ledger),
        transcripts_dir=Path(args.transcripts_dir),
    )


if __name__ == "__main__":
    raise SystemExit(main())
