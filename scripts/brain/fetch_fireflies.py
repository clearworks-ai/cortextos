#!/usr/bin/env python3
"""FR-001: fetch one Fireflies transcript into a durable source envelope. No LLM."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from envparse import parse_env_file
from paths import (
    DEFAULT_REPO_ROOT,
    DEFAULT_VAULT,
    envelope_dir,
    load_enabled_agents,
    safe_meeting_id,
    secrets_path,
)
from progress import _state_dir

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

# FR-015 lister (spec G-81/G-82): `date` is epoch-ms, `duration` is float
# MINUTES, `participants` is a list of email strings; `limit` max 50.
LIST_QUERY = """query Transcripts($limit: Int!, $skip: Int!) {
  transcripts(limit: $limit, skip: $skip) { id title date duration participants }
}"""
LIST_PAGE_SIZE = 50
# FR-015: 429 / 5xx → wait 1 s, 2 s, 4 s (max 3 retries) before giving up.
RETRY_DELAYS_S = (1, 2, 4)
_sleep = time.sleep  # test seam


class FirefliesListError(RuntimeError):
    """The transcripts list query returned a GraphQL `errors` payload."""


FETCH_ERROR_CLASSES = ("auth", "rate_limit", "not_ready", "server", "network")
_AUTH_WORDS = re.compile(r"auth|token|unauthori|forbidden|api key", re.IGNORECASE)


def fetch_error_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return _state_dir(Path(vault), kind, meeting_id) / "fetch-error.json"


def write_fetch_error(vault: Path, kind: str, meeting_id: str, cls: str, *, status: int | None = None, message: str = "") -> Path:
    """FR-017 adapter contract (G-109): every exit-2 path leaves a classified
    error so backfill.py can stop a batch on `auth` without parsing stderr."""
    assert cls in FETCH_ERROR_CLASSES, cls
    path = fetch_error_path(vault, kind, meeting_id)
    doc = {"class": cls, "status": status, "message": message[:500],
           "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    atomic_write(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    return path


def clear_fetch_error(vault: Path, kind: str, meeting_id: str) -> None:
    path = fetch_error_path(vault, kind, meeting_id)
    if path.exists():
        path.unlink()


def classify_exception(exc: BaseException) -> tuple[str, int | None]:
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return "auth", exc.code
        if exc.code == 429:
            return "rate_limit", exc.code
        return "server", exc.code
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError, OSError)):
        return "network", None
    return "server", None


def classify_graphql_message(message: str) -> str:
    return "auth" if _AUTH_WORDS.search(message or "") else "server"


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


def _iso_from_fireflies_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip().isdigit():
        return value
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return value if isinstance(value, str) else None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def _is_notetaker(name: str, email: str) -> bool:
    if name.strip().lower() in NOTETAKER_NAMES:
        return True
    domain = email.split("@")[-1].lower() if "@" in email else ""
    return domain in NOTETAKER_DOMAINS


def _side(name: str, email: str, notetaker: bool, enabled_agents_cf: set[str] | None = None) -> str:
    if notetaker:
        return "unknown"
    domain = email.split("@")[-1].lower() if "@" in email else ""
    if domain in OURS_DOMAINS or name.strip().lower() in OURS_NAMES or email.lower() in OURS_NAMES:
        return "ours"
    # D-17: name equal (casefold) to an enabled fleet agent -> ours.
    if enabled_agents_cf and name.strip().casefold() in enabled_agents_cf:
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
    # F-4: iterate speakers in first-appearance order over `sentences` (stable),
    # never via set iteration — set order depends on hash-seed randomization and
    # differs across processes, which shifted envelope sha + commitment ordinals
    # on --refetch. `speakers_spoken_order` preserves first-seen order for the
    # speaker-only-participant loop below; `speakers_spoken_cf` remains a set,
    # used only for membership tests (order-independent).
    speakers_spoken_order: list[str] = []
    seen_spoken_cf: set[str] = set()
    for s in sentences:
        if not isinstance(s, dict):
            continue
        name = str(s.get("speaker_name") or "").strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen_spoken_cf:
            continue
        seen_spoken_cf.add(key)
        speakers_spoken_order.append(name)
    speakers_spoken_cf = seen_spoken_cf
    enabled_agents_cf = {a.casefold() for a in load_enabled_agents()}
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
                "side": _side(name, email, note, enabled_agents_cf),
                "spoke": name.strip().casefold() in speakers_spoken_cf,
                "notetaker": note,
            }
        )
    for speaker in speakers_spoken_order:
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
                "side": _side(speaker, "", note, enabled_agents_cf),
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
        "occurred_at": _iso_from_fireflies_date(tr.get("date")),
        "duration_s": tr.get("duration"),
        "participants": participants,
        "text_units": text_units,
        "native_summary": native,
    }


def _retryable(exc: BaseException) -> bool:
    return isinstance(exc, urllib.error.HTTPError) and (exc.code == 429 or exc.code >= 500)


def _post_query(api_key: str, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    for attempt in range(len(RETRY_DELAYS_S) + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
            return json.loads(raw.decode())
        except urllib.error.HTTPError as exc:
            if not _retryable(exc) or attempt == len(RETRY_DELAYS_S):
                raise
            _sleep(RETRY_DELAYS_S[attempt])
    raise AssertionError("unreachable")


def _post_graphql(api_key: str, meeting_id: str) -> dict[str, Any]:
    return _post_query(api_key, QUERY, {"id": meeting_id})


def list_transcripts(api_key: str, *, page_size: int = LIST_PAGE_SIZE, throttle_s: float = 2.0) -> list[dict[str, Any]]:
    """Page `transcripts(limit, skip)` until a short page; returns raw rows in
    API order. Sleeps `throttle_s` between pages (A-08 default 1 req / 2 s)."""
    rows: list[dict[str, Any]] = []
    skip = 0
    while True:
        payload = _post_query(api_key, LIST_QUERY, {"limit": page_size, "skip": skip})
        errors = payload.get("errors") or []
        if errors:
            first = errors[0]
            raise FirefliesListError(first.get("message") if isinstance(first, dict) else str(first))
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        page = data.get("transcripts") or []
        rows.extend(r for r in page if isinstance(r, dict) and r.get("id"))
        if len(page) < page_size:
            return rows
        skip += page_size
        _sleep(throttle_s)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fetch one Fireflies transcript into a source envelope")
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--allow-short", action="store_true")
    p.add_argument("--refetch", action="store_true")
    args = p.parse_args(argv)

    meeting_id = safe_meeting_id(args.meeting_id)
    if not meeting_id:
        print("invalid meeting id", file=sys.stderr)
        return 64

    vault = Path(args.vault)
    dest_dir = envelope_dir(vault, "fireflies", meeting_id)
    source_path = dest_dir / "source.json"
    sha_path = dest_dir / "source.sha256"
    meta_path = dest_dir / "meta.json"

    # F18 (CH-17): existence of source.json alone is not proof of a coherent
    # envelope — a crash between writing source.json and meta.json/source.sha256
    # (each written atomically but not as one transaction) must fall through
    # to a fresh fetch, which rewrites all three, rather than short-circuit
    # on a partial envelope forever.
    if source_path.exists() and sha_path.exists() and meta_path.exists() and not args.refetch:
        raw = source_path.read_bytes()
        clear_fetch_error(vault, "fireflies", meeting_id)
        print(hashlib.sha256(raw).hexdigest())
        return 0

    def _fail(cls: str, message: str, status: int | None = None) -> int:
        print(message, file=sys.stderr)
        write_fetch_error(vault, "fireflies", meeting_id, cls, status=status, message=message)
        return 2

    api_key = _load_api_key(Path(args.repo_root))
    if not api_key:
        return _fail("auth", "missing FIREFLIES_API_KEY")

    try:
        payload = _post_graphql(api_key, meeting_id)
    except Exception as exc:  # classified below; never re-raised (exit 2 contract)
        cls, status = classify_exception(exc)
        return _fail(cls, f"fetch failed: {exc}", status)

    errors = payload.get("errors") or []
    if errors:
        msg = errors[0].get("message") if isinstance(errors[0], dict) else str(errors[0])
        return _fail(classify_graphql_message(msg or ""), msg or "graphql error")
    tr = (payload.get("data") or {}).get("transcript") if isinstance(payload.get("data"), dict) else None
    if not isinstance(tr, dict):
        return _fail("not_ready", "no transcript")

    sentences = tr.get("sentences") or []
    n = len(sentences) if isinstance(sentences, list) else 0
    if (n < 20 or tr.get("duration") is None) and not args.allow_short:
        return _fail("not_ready", f"not-ready: sentences={n}")

    clear_fetch_error(vault, "fireflies", meeting_id)

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
