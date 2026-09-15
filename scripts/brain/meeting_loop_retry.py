#!/usr/bin/env python3
"""Retry sweep for the live meeting loop.

An envelope dir under raw/media/transcripts/fireflies/<id> proves only that FETCH
happened. The receipt (raw/media/transcripts/_state/fireflies-<id>/receipt.json) is
written last. A run that died after fetch — extract refused by the model backend
("Credit balance is too low" on 2026-09-14), a crashed worker, a killed PTY — leaves
the envelope and no receipt, and the webhook never fires again for that meeting.

This sweep re-runs `run_meeting.py --apply` for every recent envelope with no receipt
and no fetch-error, in occurrence order, one at a time. 2026-09-15: it ALSO fetches
and applies every transcript Fireflies lists within the window that has NO envelope at
all — that day both of Josh's meetings reached the bridge, spawned PTY workers, and the
workers produced nothing (banner-only logs), so there was no envelope for this sweep to
key on. The Fireflies listing is read-only; a listing failure never blocks the envelope
retries (warned, then skipped). run_meeting is checkpointed
(progress.json) so a retry resumes where the previous run stopped and never repeats a
landed write. Exit 0 when nothing was pending or every retry succeeded; 1 otherwise.

  python3 meeting_loop_retry.py [--days N] [--dry-run] [--repo-root R] [--vault V]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fetch_fireflies  # noqa: E402
import paths as brain_paths  # noqa: E402
import progress  # noqa: E402


def pending_envelopes(vault: Path, days: int, now: datetime | None = None) -> list[str]:
    """Meeting ids fetched within `days` whose receipt is missing and that carry no
    fetch-error (a fetch-error is the fetcher's own terminal verdict, not a retry)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    envelopes = vault / "raw/media/transcripts/fireflies"
    if not envelopes.is_dir():
        return []
    out: list[tuple[float, str]] = []
    for d in envelopes.iterdir():
        if not d.is_dir() or d.name.startswith("_"):
            continue
        source = d / "source.json"
        if not source.exists():
            continue
        mtime = datetime.fromtimestamp(source.stat().st_mtime, timezone.utc)
        if mtime < cutoff:
            continue
        if progress.receipt_path(vault, "fireflies", d.name).exists():
            continue
        if (vault / "raw/media/transcripts/_state" / f"fireflies-{d.name}" / "fetch-error.json").exists():
            continue
        out.append((mtime.timestamp(), d.name))
    return [mid for _, mid in sorted(out)]


def _occurred(row: dict) -> datetime | None:
    iso = fetch_fireflies._iso_from_fireflies_date(row.get("date") or row.get("dateString") or row.get("created"))
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def pending_transcripts(vault: Path, days: int, list_rows, now: datetime | None = None) -> list[str]:
    """Transcripts Fireflies lists within `days` that have NO envelope dir (the webhook
    lane never fetched them) and no fetch-error. `list_rows` returns the Fireflies
    listing (dicts with `id` + `date`); injected so tests never touch the API."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    envelopes = vault / "raw/media/transcripts/fireflies"
    have = {p.name for p in envelopes.iterdir() if p.is_dir()} if envelopes.is_dir() else set()
    out: list[tuple[float, str]] = []
    for row in list_rows():
        mid = str(row.get("id") or "")
        if not mid or mid in have:
            continue
        occurred = _occurred(row)
        if occurred is None or occurred < cutoff:
            continue
        if (vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "fetch-error.json").exists():
            continue
        out.append((occurred.timestamp(), mid))
    return [mid for _, mid in sorted(out)]


def default_lister(repo_root: Path):
    def _list():
        return fetch_fireflies.list_transcripts(fetch_fireflies._load_api_key(repo_root))
    return _list


def retry_one(mid: str, repo_root: Path, vault: Path, *, dry_run: bool) -> tuple[int, str]:
    cmd = [
        sys.executable, str(HERE / "run_meeting.py"),
        "--meeting-id", f"fireflies:{mid}",
        "--dry-run" if dry_run else "--apply",
        "--repo-root", str(repo_root), "--vault", str(vault),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=900)
    tail = (proc.stderr.strip().splitlines() or proc.stdout.strip().splitlines() or [""])[-1]
    return proc.returncode, tail[:200]


_LISTER = None  # tests inject a fake Fireflies lister here


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=3)
    p.add_argument("--dry-run", action="store_true", help="re-run each pending meeting in --dry-run mode")
    p.add_argument("--repo-root", default=str(brain_paths.DEFAULT_REPO_ROOT))
    p.add_argument("--vault", default=str(brain_paths.DEFAULT_VAULT))
    p.add_argument("--no-fetch-missing", action="store_true",
                   help="envelope retries only; do not list Fireflies for envelope-less transcripts")
    args = p.parse_args(argv)
    vault, repo_root = Path(args.vault), Path(args.repo_root)
    pending = pending_envelopes(vault, args.days)
    missing: list[str] = []
    listing_error = None
    if not args.no_fetch_missing:
        try:
            missing = [m for m in pending_transcripts(vault, args.days, _LISTER or default_lister(repo_root)) if m not in pending]
        except Exception as exc:  # noqa: BLE001 -- a listing failure must never block the envelope retries
            listing_error = f"{type(exc).__name__}: {exc}"[:200]
            print(f"warning: fireflies listing failed, envelope retries only :: {listing_error}", file=sys.stderr)
    pending = pending + missing
    if not pending:
        print(json.dumps({"pending": 0, "missing": 0, "retried": [], "ok": True, "listing_error": listing_error}))
        return 0
    results = []
    for mid in pending:
        rc, tail = retry_one(mid, repo_root, vault, dry_run=args.dry_run)
        results.append({"meeting_id": mid, "rc": rc, "last_line": tail})
        print(f"retry fireflies:{mid} rc={rc} :: {tail}")
    ok = all(r["rc"] == 0 for r in results)
    print(json.dumps({"pending": len(pending), "missing": len(missing), "retried": results, "ok": ok, "listing_error": listing_error}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
