#!/usr/bin/env python3
"""Capture durable prose knowledge notes from recent Fireflies transcripts."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
ORG_DIR = AGENT_DIR.parent.parent
STATE_DIR = AGENT_DIR / "state"
DEFAULT_LIMIT = 20
DEFAULT_WATERMARK_PATH = STATE_DIR / "knowledge-capture-watermark.json"
DEFAULT_TRANSCRIPT_STORE = ORG_DIR / "knowledge" / "transcripts"
CAPTURE_DIR = Path.home() / "code" / "knowledge-sync" / "raw" / "inbox" / "knowledge"
FF_EXTRACTOR_PATH = SCRIPT_PATH.with_name("ff-extractor.py")
TOPIC_RE = re.compile(r"[^a-z0-9]+")

Urlopen = Callable[..., Any]


def load_ff_extractor() -> Any:
    spec = importlib.util.spec_from_file_location("ff_extractor_for_knowledge_capture", FF_EXTRACTOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load ff-extractor.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


FF = load_ff_extractor()


NOTE_PROMPT = """You synthesize durable knowledge notes from meeting transcripts.

Return valid JSON only with exactly these fields:
{{
  "topic": "short topic phrase",
  "summary": "3-6 sentence prose summary",
  "keyTakeaways": ["takeaway 1", "takeaway 2"],
  "openQuestions": ["question 1"],
  "relatedCandidates": ["candidate link 1"]
}}

Rules:
- Use only facts present in the transcript/context.
- Summary must be readable prose, not bullet fragments.
- Do not invent relationships or wiki links.
- If there are no open questions, return ["none"].
- relatedCandidates should be plain text slugs or titles, not wiki markup.

Client context:
{client_context}

Transcript:
{transcript}
"""


def meeting_date(transcript: dict[str, Any]) -> str:
    timestamp = FF.parse_transcript_datetime(transcript.get("date"))
    if timestamp is None:
        return "1970-01-01"
    return timestamp.date().isoformat()


def slugify(value: str) -> str:
    normalized = FF.normalize_action(value)
    slug = TOPIC_RE.sub("-", normalized).strip("-")
    return slug or "note"


def derive_topic(transcript: dict[str, Any], client_name: str) -> str:
    title = FF.collapse_ws(str(transcript.get("title") or "Meeting"))
    lowered_client = FF.normalize_action(client_name)
    lowered_title = FF.normalize_action(title)
    if lowered_client and lowered_client in lowered_title:
        cleaned = title
        for fragment in [client_name, f"{client_name} -", f"{client_name}:", f"{client_name} ·"]:
            cleaned = cleaned.replace(fragment, "")
        title = FF.collapse_ws(cleaned)
    return title or "Meeting"


def transcript_store_path(meeting_id: str, transcripts_dir: Path) -> Path | None:
    matches = sorted(transcripts_dir.glob(f"*-{meeting_id}.md"))
    if matches:
        return matches[0]
    return None


def transcript_text_lines(transcript: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    sentences = transcript.get("sentences") or []
    if not isinstance(sentences, list):
        return lines
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        speaker = FF.collapse_ws(str(sentence.get("speaker_name") or "Unknown"))
        text = FF.collapse_ws(str(sentence.get("text") or sentence.get("raw_text") or ""))
        if text:
            lines.append(f"{speaker}: {text}")
    return lines


def transcript_source_text(transcript: dict[str, Any], transcripts_dir: Path) -> str:
    meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
    if meeting_id:
        stored_path = transcript_store_path(meeting_id, transcripts_dir)
        if stored_path is not None and stored_path.exists():
            return stored_path.read_text(encoding="utf-8")
    return "\n".join(transcript_text_lines(transcript))


def find_existing_source(meeting_id: str, capture_dir: Path) -> Path | None:
    target = f"source: fireflies:{meeting_id}"
    quoted_target = f'source: "fireflies:{meeting_id}"'
    for path in sorted(capture_dir.glob("*.md")):
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if target in body or quoted_target in body:
            return path
    return None


def valid_related_links(client_record: dict[str, Any] | None, capture_payload: dict[str, Any]) -> list[str]:
    related: list[str] = []
    if client_record is not None:
        client_path = client_record.get("path")
        if isinstance(client_path, Path) and client_path.exists():
            related.append(f"[[{client_path.stem}]]")

    base = Path.home() / "code" / "knowledge-sync"
    for candidate in capture_payload.get("relatedCandidates") or []:
        if not isinstance(candidate, str):
            continue
        slug = slugify(candidate)
        for root in (base / "wiki", base / "raw"):
            try:
                match = next(root.rglob(f"{slug}.md"))
            except (StopIteration, OSError):
                continue
            related.append(f"[[{match.stem}]]")
            break
    deduped: list[str] = []
    for item in related:
        if item not in deduped:
            deduped.append(item)
    return deduped


def synthesize_note_payload(
    transcript: dict[str, Any],
    *,
    transcript_text: str,
    client_context: str,
    openrouter_api_key: str,
    urlopen: Urlopen = urllib.request.urlopen,
) -> dict[str, Any]:
    response_text = FF.openrouter_request(
        openrouter_api_key,
        model=FF.EXTRACTOR_MODEL,
        prompt=NOTE_PROMPT.format(client_context=client_context or "none", transcript=transcript_text),
        max_tokens=1600,
        urlopen=urlopen,
    )
    payload = FF.parse_json_payload(response_text)
    if not isinstance(payload, dict):
        raise ValueError("capture response was not a JSON object")
    summary = FF.collapse_ws(str(payload.get("summary") or ""))
    topic = FF.collapse_ws(str(payload.get("topic") or ""))
    key_takeaways = [FF.collapse_ws(str(item)) for item in payload.get("keyTakeaways") or [] if FF.collapse_ws(str(item))]
    open_questions = [FF.collapse_ws(str(item)) for item in payload.get("openQuestions") or [] if FF.collapse_ws(str(item))]
    related_candidates = [
        FF.collapse_ws(str(item)) for item in payload.get("relatedCandidates") or [] if FF.collapse_ws(str(item))
    ]
    return {
        "topic": topic or derive_topic(transcript, "Unfiled"),
        "summary": summary,
        "keyTakeaways": key_takeaways,
        "openQuestions": open_questions or ["none"],
        "relatedCandidates": related_candidates,
    }


def yaml_scalar(value: str) -> str:
    return json.dumps(FF.collapse_ws(value), ensure_ascii=False)


def render_note(
    transcript: dict[str, Any],
    *,
    client_record: dict[str, Any] | None,
    capture_payload: dict[str, Any],
) -> tuple[str, str]:
    client_name = "Unfiled"
    client_slug = "unfiled"
    if client_record is not None:
        client_name = FF.collapse_ws(str(client_record.get("client_name") or client_name)) or client_name
        client_path = client_record.get("path")
        if isinstance(client_path, Path):
            client_slug = client_path.stem
    topic = FF.collapse_ws(str(capture_payload.get("topic") or derive_topic(transcript, client_name))) or "Meeting"
    topic_slug = slugify(topic)
    date_text = meeting_date(transcript)
    meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
    title = f"{client_name} — {topic}"
    related = valid_related_links(client_record, capture_payload) or ["none"]
    filename = f"{date_text}-{client_slug}-{topic_slug}.md"

    lines = [
        "---",
        f"title: {yaml_scalar(title)}",
        f"date: {yaml_scalar(date_text)}",
        f"source: {yaml_scalar(f'fireflies:{meeting_id}')}",
        f"client: {yaml_scalar(client_slug)}",
        "type: knowledge-capture",
        f"captured_at: {yaml_scalar(FF.now_utc_iso())}",
        "---",
        "",
        f"# {title}",
        "",
        "## Summary",
        str(capture_payload.get("summary") or "none"),
        "",
        "## Key Takeaways",
    ]
    takeaways = capture_payload.get("keyTakeaways") or []
    if takeaways:
        lines.extend(f"- {item}" for item in takeaways)
    else:
        lines.append("- none")
    lines.extend(["", "## Open Questions / Unknowns"])
    questions = capture_payload.get("openQuestions") or []
    if questions:
        lines.extend(f"- {item}" for item in questions)
    else:
        lines.append("- none")
    lines.extend(["", "## Related"])
    lines.extend(f"- {item}" for item in related)
    lines.append("")
    return filename, "\n".join(lines)


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


def load_override_since(raw_value: str) -> tuple[Any, Any]:
    parsed = FF.parse_transcript_datetime(raw_value)
    if parsed is None:
        raise ValueError(f"invalid --since value: {raw_value}")
    return parsed, None


def run_capture(
    *,
    dry_run: bool,
    limit: int,
    since: str,
    transcripts_dir: Path,
    capture_dir: Path,
    watermark_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    fireflies_api_key = FF.require_env("FIREFLIES_API_KEY")
    openrouter_api_key = FF.require_env("OPENROUTER_API_KEY")

    if since:
        watermark_timestamp, watermark_meeting_id = load_override_since(since)
    else:
        watermark_timestamp, watermark_meeting_id = FF.load_watermark(watermark_path)

    recent = FF.fetch_recent_transcripts(fireflies_api_key, limit=limit, urlopen=urlopen)
    fresh = FF.select_recent_transcripts(recent, watermark_timestamp, watermark_meeting_id, limit=limit)

    notes: list[dict[str, Any]] = []
    written = 0
    skipped = 0
    casual = 0
    processed: list[dict[str, Any]] = []
    for transcript in fresh:
        meeting_id = FF.collapse_ws(str(transcript.get("id") or ""))
        if not meeting_id:
            skipped += 1
            continue
        classifier_text = FF.build_transcript_text(transcript.get("sentences", []), limit=FF.CLASSIFIER_MAX_CHARS)
        if not classifier_text:
            skipped += 1
            continue
        if FF.is_casual_transcript(classifier_text, openrouter_api_key=openrouter_api_key, urlopen=urlopen):
            casual += 1
            processed.append(transcript)
            continue
        if find_existing_source(meeting_id, capture_dir) is not None:
            skipped += 1
            processed.append(transcript)
            continue

        client_record = FF.matched_client_context_record_for_transcript(transcript)
        client_context = str(client_record.get("context") or "") if client_record is not None else ""
        transcript_text = transcript_source_text(transcript, transcripts_dir)
        capture_payload = synthesize_note_payload(
            transcript,
            transcript_text=transcript_text,
            client_context=client_context,
            openrouter_api_key=openrouter_api_key,
            urlopen=urlopen,
        )
        filename, body = render_note(transcript, client_record=client_record, capture_payload=capture_payload)
        note_path = capture_dir / filename
        payload = {
            "source": f"fireflies:{meeting_id}",
            "path": str(note_path),
            "title": filename,
            "body": body,
        }
        notes.append(payload)
        if not dry_run:
            capture_dir.mkdir(parents=True, exist_ok=True)
            atomic_write(note_path, body)
            written += 1
        processed.append(transcript)

    if not dry_run and processed:
        newest = max(processed, key=FF.transcript_sort_key)
        FF.save_watermark(watermark_path, newest)

    print(
        json.dumps(
            {
                "dry_run": dry_run,
                "written": written,
                "skipped": skipped,
                "casual": casual,
                "notes": notes,
            },
            indent=2 if dry_run else None,
        )
    )
    return 0


def execute(
    *,
    dry_run: bool,
    limit: int,
    since: str,
    transcripts_dir: Path,
    capture_dir: Path,
    watermark_path: Path,
    urlopen: Urlopen = urllib.request.urlopen,
) -> int:
    try:
        return run_capture(
            dry_run=dry_run,
            limit=limit,
            since=since,
            transcripts_dir=transcripts_dir,
            capture_dir=capture_dir,
            watermark_path=watermark_path,
            urlopen=urlopen,
        )
    except (RuntimeError, ValueError, urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as exc:
        reason = FF.collapse_ws(str(exc)) or exc.__class__.__name__
        FF.LOGGER.error("knowledge-capture failed: %s", reason)
        print(json.dumps({"error": reason, "dry_run": dry_run, "written": 0, "skipped": 0, "casual": 0, "notes": []}))
        return 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture durable knowledge notes from Fireflies transcripts")
    parser.add_argument("--source", default="fireflies", choices=["fireflies"])
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--since", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--transcript-store", default=str(DEFAULT_TRANSCRIPT_STORE))
    parser.add_argument("--capture-dir", default=str(CAPTURE_DIR))
    parser.add_argument("--watermark-path", default=str(DEFAULT_WATERMARK_PATH))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    return execute(
        dry_run=bool(args.dry_run),
        limit=max(1, int(args.limit)),
        since=str(args.since or ""),
        transcripts_dir=Path(args.transcript_store),
        capture_dir=Path(args.capture_dir),
        watermark_path=Path(args.watermark_path),
    )


if __name__ == "__main__":
    raise SystemExit(main())
