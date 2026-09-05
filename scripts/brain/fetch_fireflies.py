#!/usr/bin/env python3
"""FR-001: fetch one Fireflies transcript into a durable source envelope. No LLM."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from envparse import parse_env_file
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir, secrets_path

FETCHER_VERSION = "fetch_fireflies/1"
GRAPHQL_URL = "https://api.fireflies.ai/graphql"
NOTETAKER_NAMES = {"fireflies", "fireflies.ai notetaker", "otter", "read.ai", "fathom"}
NOTETAKER_DOMAINS = {"fireflies.ai", "otter.ai", "read.ai", "fathom.video"}
OURS_DOMAINS = {"clearworks.ai"}
OURS_NAMES = {"josh", "josh weiss", "josh@clearworks.ai"}

QUERY = """
query Transcript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    duration
    organizer_email
    participants
    meeting_attendees { displayName email }
    sentences { index speaker_name text start_time }
    summary { overview action_items keywords bullet_gist short_summary }
  }
}
"""


def _canonical_bytes(obj: dict[str, Any]) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _load_api_key(repo_root: Path) -> str:
    env_key = (os.environ.get("FIREFLIES_API_KEY") or "").strip()
    if env_key:
        return env_key
    path = secrets_path(repo_root)
    if not path.is_file():
        return ""
    return (parse_env_file(path).get("FIREFLIES_API_KEY") or "").strip()


def _is_notetaker(name: str, email: str) -> bool:
    if name.strip().lower() in NOTETAKER_NAMES:
        return True
    domain = email.split("@")[-1].lower() if "@" in email else ""
    return domain in NOTETAKER_DOMAINS


def _side(name: str, email: str, notetaker: bool) -> str:
    if notetaker:
        return "unknown"
    domain = email.split("@")[-1].lower() if "@" in email else ""
    if domain in OURS_DOMAINS or name.strip().lower() in OURS_NAMES or email.lower() in OURS_NAMES:
        return "ours"
    if email and domain and domain not in OURS_DOMAINS:
        return "theirs"
    return "unknown"


def envelope_from_transcript(tr: dict[str, Any]) -> dict[str, Any]:
    attendees = tr.get("meeting_attendees") or []
    if not isinstance(attendees, list):
        attendees = []
    sentences = tr.get("sentences") or []
    if not isinstance(sentences, list):
        sentences = []
    speakers_spoken = {str(s.get("speaker_name") or "").strip() for s in sentences if isinstance(s, dict)}
    participants: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for att in attendees:
        if not isinstance(att, dict):
            continue
        name = str(att.get("displayName") or "").strip()
        email = str(att.get("email") or "").strip()
        key = email.lower() or name.lower()
        if not key or key in seen_keys:
            continue
        seen_keys.add(key)
        note = _is_notetaker(name, email)
        participants.append(
            {
                "name": name or None,
                "email": email or None,
                "handle": None,
                "side": _side(name, email, note),
                "spoke": name in speakers_spoken,
                "notetaker": note,
            }
        )
    for speaker in speakers_spoken:
        if not speaker:
            continue
        if speaker.lower() in seen_keys:
            continue
        if any((p.get("name") or "").lower() == speaker.lower() for p in participants):
            continue
        seen_keys.add(speaker.lower())
        note = _is_notetaker(speaker, "")
        participants.append(
            {
                "name": speaker,
                "email": None,
                "handle": None,
                "side": _side(speaker, "", note),
                "spoke": True,
                "notetaker": note,
            }
        )
    summary = tr.get("summary") or {}
    if not isinstance(summary, dict):
        summary = {}
    native = {
        "overview": summary.get("overview") or None,
        "action_items": summary.get("action_items") or None,
        "keywords": summary.get("keywords") or None,
        "bullet_gist": summary.get("bullet_gist") or None,
        "short_summary": summary.get("short_summary") or None,
    }
    text_units = []
    for s in sentences:
        if not isinstance(s, dict):
            continue
        text_units.append(
            {
                "i": s.get("index"),
                "speaker": s.get("speaker_name"),
                "text": s.get("text"),
                "ts": s.get("start_time"),
            }
        )
    return {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": str(tr.get("id") or "")},
        "title": tr.get("title"),
        "occurred_at": tr.get("date"),
        "duration_s": tr.get("duration"),
        "participants": participants,
        "text_units": text_units,
        "native_summary": native,
    }


def _post_graphql(api_key: str, meeting_id: str) -> dict[str, Any]:
    body = json.dumps({"query": QUERY, "variables": {"id": meeting_id}}).encode()
    req = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    return json.loads(raw.decode())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fetch one Fireflies transcript into a source envelope")
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--allow-short", action="store_true")
    p.add_argument("--refetch", action="store_true")
    args = p.parse_args(argv)

    meeting_id = args.meeting_id.strip()
    if meeting_id.startswith("fireflies:"):
        meeting_id = meeting_id.split(":", 1)[1]
    if not meeting_id:
        print("need --meeting-id", file=sys.stderr)
        return 64

    vault = Path(args.vault)
    dest_dir = envelope_dir(vault, "fireflies", meeting_id)
    source_path = dest_dir / "source.json"
    sha_path = dest_dir / "source.sha256"
    meta_path = dest_dir / "meta.json"

    if source_path.exists() and not args.refetch:
        raw = source_path.read_bytes()
        print(hashlib.sha256(raw).hexdigest())
        return 0

    api_key = _load_api_key(Path(args.repo_root))
    if not api_key:
        print("missing FIREFLIES_API_KEY", file=sys.stderr)
        return 2

    try:
        payload = _post_graphql(api_key, meeting_id)
    except Exception as exc:
        print(f"fetch failed: {exc}", file=sys.stderr)
        return 2

    errors = payload.get("errors") or []
    if errors:
        msg = errors[0].get("message") if isinstance(errors[0], dict) else str(errors[0])
        print(msg or "graphql error", file=sys.stderr)
        return 2
    tr = (payload.get("data") or {}).get("transcript") if isinstance(payload.get("data"), dict) else None
    if not isinstance(tr, dict):
        print("no transcript", file=sys.stderr)
        return 2

    sentences = tr.get("sentences") or []
    n = len(sentences) if isinstance(sentences, list) else 0
    if (n < 20 or tr.get("duration") is None) and not args.allow_short:
        print(f"not-ready: sentences={n}", file=sys.stderr)
        return 2

    envelope = envelope_from_transcript(tr)
    raw = _canonical_bytes(envelope)
    new_sha = hashlib.sha256(raw).hexdigest()
    old_sha = ""
    if source_path.exists() and args.refetch:
        old_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()

    atomic_write(source_path, raw)
    atomic_write(sha_path, (new_sha + "\n").encode())
    meta = {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fetcher": FETCHER_VERSION,
    }
    atomic_write(meta_path, json.dumps(meta, sort_keys=True, indent=2).encode() + b"\n")

    if old_sha:
        print(f"{old_sha} -> {new_sha}")
    else:
        print(new_sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
