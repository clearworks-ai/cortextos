#!/usr/bin/env python3
"""FR-015 backfill lister + batch runner (spec v1.13, D-19/D-20/D-22).

  backfill.py --source fireflies list [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  backfill.py --source fireflies --batch <batch_id> dry-run [--max-usd 150]
  backfill.py --source fireflies --batch <batch_id> apply

Writes only under <vault>/raw/media/transcripts/_backfill/<batch_id>/ and the
per-meeting envelope/_state dirs; every org-brain write flows through
run_meeting.py. Batch state is batch-progress.json keyed "<kind>:<id>" with
separate `dry_run` / `apply` objects (G-110); per-meeting progress.json is
never written here."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import progress
from atomic import atomic_write
from fetch_fireflies import _load_api_key as load_api_key
from fetch_fireflies import list_transcripts  # module attribute: test seam
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, safe_meeting_id

SOURCES = ("fireflies",)  # R5 (FR-017) generalizes to fetch_<kind>.py dispatch
# Batch ids are produced by _batch_id(); anything else is refused before it touches a path (G0b-11).
BATCH_ID_RE = re.compile(r"^[a-z][a-z0-9]{0,15}-\d{8}T\d{6}Z$")
DEFAULT_MAX_USD = 150.0


def batch_root(vault: Path) -> Path:
    return Path(vault) / "raw/media/transcripts/_backfill"


def batch_dir(vault: Path, batch_id: str) -> Path:
    return batch_root(vault) / batch_id


def _batch_id(kind: str) -> str:
    return f"{kind}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_from_epoch_ms(value: Any) -> str | None:
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def _applied(vault: Path, kind: str, meeting_id: str) -> bool:
    path = progress.receipt_path(vault, kind, meeting_id)
    if not path.is_file():
        return False
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(doc, dict) and bool(doc.get("vault_sha"))


def build_manifest(rows: list[dict[str, Any]], *, vault: Path, kind: str, since: str | None, until: str | None) -> list[dict[str, Any]]:
    """API rows → manifest rows. An id that fails `safe_meeting_id` (traversal-shaped
    or otherwise unsafe) is dropped and counted in `build_manifest.invalid` — it must
    never reach a `_state`/envelope/sample path (G0b r2 N2). A row with a missing or
    unparseable `date` is dropped and counted in `build_manifest.skipped_no_date`
    (task-6 review finding 1) rather than vanishing silently. A repeated id (skip/limit
    paging can return the same transcript twice across pages) keeps only the first
    occurrence and is counted in `build_manifest.duplicates` (finding 3)."""
    out: list[dict[str, Any]] = []
    invalid = 0
    skipped_no_date = 0
    duplicates = 0
    seen: set[str] = set()
    for r in rows:
        mid = safe_meeting_id(str(r.get("id") or ""))
        if not mid or mid != str(r.get("id")):
            invalid += 1
            continue
        row_id = str(r["id"])
        if row_id in seen:
            duplicates += 1
            continue
        seen.add(row_id)
        occurred_at = _iso_from_epoch_ms(r.get("date"))
        if occurred_at is None:
            skipped_no_date += 1
            continue
        day = occurred_at[:10]
        if since and day < since:
            continue
        if until and day > until:
            continue
        duration = r.get("duration")
        participants = r.get("participants") or []
        out.append({
            "kind": kind,
            "id": row_id,
            "title": str(r.get("title") or ""),
            "occurred_at": occurred_at,
            "duration_s": int(round(float(duration) * 60)) if isinstance(duration, (int, float)) else None,
            "participant_count": len(participants) if isinstance(participants, list) else 0,
            "already_applied": _applied(vault, kind, row_id),
        })
    out.sort(key=lambda row: (row["occurred_at"], row["id"]))
    build_manifest.invalid = invalid  # type: ignore[attr-defined]
    build_manifest.skipped_no_date = skipped_no_date  # type: ignore[attr-defined]
    build_manifest.duplicates = duplicates  # type: ignore[attr-defined]
    return out


def _write_json(path: Path, doc: Any) -> None:
    atomic_write(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def cmd_list(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    api_key = load_api_key(Path(args.repo_root))
    if not api_key:
        print("missing FIREFLIES_API_KEY", file=sys.stderr)
        return 2
    rows = list_transcripts(api_key, throttle_s=args.rate)
    manifest_rows = build_manifest(rows, vault=vault, kind=args.source, since=args.since, until=args.until)
    batch_id = _batch_id(args.source)
    doc = {"batch_id": batch_id, "kind": args.source, "created_at": _now(),
           "since": args.since, "until": args.until, "rows": manifest_rows}
    _write_json(batch_dir(vault, batch_id) / "manifest.json", doc)
    applied = sum(1 for r in manifest_rows if r["already_applied"])
    print(f"manifest: {len(manifest_rows)} total, {applied} already applied, {len(manifest_rows) - applied} pending")
    if getattr(build_manifest, "invalid", 0):
        print(f"invalid ids skipped: {build_manifest.invalid}", file=sys.stderr)
    if getattr(build_manifest, "skipped_no_date", 0):
        print(f"rows skipped (no date): {build_manifest.skipped_no_date}", file=sys.stderr)
    if getattr(build_manifest, "duplicates", 0):
        print(f"duplicate ids skipped: {build_manifest.duplicates}", file=sys.stderr)
    print(f"batch: {batch_id}")
    return 0


_DATE_ARG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_arg(value: str) -> str:
    """argparse `type=` for --since/--until (task-6 review finding 2): reject anything
    that is not a real, strictly zero-padded YYYY-MM-DD date before it reaches the
    lexical day-string compare in `build_manifest`, or before it is recorded verbatim
    in the manifest. `datetime.strptime` alone accepts non-zero-padded values like
    "2025-9-2" (`%m`/`%d` are lenient), which would corrupt the lexical compare, so the
    regex enforces the exact shape and strptime enforces a real calendar date.
    Argparse turns `ArgumentTypeError` into a usage message on stderr and
    `SystemExit(2)`."""
    if not _DATE_ARG_RE.match(value):
        raise argparse.ArgumentTypeError(f"invalid date {value!r} (expected YYYY-MM-DD)")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid date {value!r} (expected YYYY-MM-DD)") from exc
    return value


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="FR-015 backfill lister + batch runner")
    p.add_argument("--source", default="fireflies")
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--batch")
    p.add_argument("--rate", type=float, default=2.0, help="seconds between list pages (A-08)")
    sub = p.add_subparsers(dest="command", required=True)
    s_list = sub.add_parser("list")
    s_list.add_argument("--since", type=_date_arg)
    s_list.add_argument("--until", type=_date_arg)
    s_dry = sub.add_parser("dry-run")
    s_dry.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD)
    sub.add_parser("apply")
    args = p.parse_args(argv)

    if args.source not in SOURCES:
        print(f"unsupported --source {args.source!r} (R4 supports: {', '.join(SOURCES)})", file=sys.stderr)
        return 64
    if args.command == "list":
        return cmd_list(args)
    if not args.batch:
        print(f"{args.command} requires --batch <batch_id>", file=sys.stderr)
        return 64
    if not BATCH_ID_RE.match(args.batch):
        print(f"invalid --batch {args.batch!r} (expected <kind>-YYYYMMDDTHHMMSSZ)", file=sys.stderr)
        return 64
    if args.command == "dry-run":
        return cmd_dry_run(args)
    return cmd_apply(args)


def cmd_dry_run(args: argparse.Namespace) -> int:  # Task 7
    raise NotImplementedError


def cmd_apply(args: argparse.Namespace) -> int:  # Task 10
    raise NotImplementedError


if __name__ == "__main__":
    raise SystemExit(main())
