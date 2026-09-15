#!/usr/bin/env python3
"""Retry sweep for the live meeting loop.

An envelope dir under raw/media/transcripts/fireflies/<id> proves only that FETCH
happened. The receipt (raw/media/transcripts/_state/fireflies-<id>/receipt.json) is
written last. A run that died after fetch — extract refused by the model backend
("Credit balance is too low" on 2026-09-14), a crashed worker, a killed PTY — leaves
the envelope and no receipt, and the webhook never fires again for that meeting.

This sweep re-runs `run_meeting.py --apply` for every recent envelope with no receipt
and no fetch-error, in occurrence order, one at a time. run_meeting is checkpointed
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


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=3)
    p.add_argument("--dry-run", action="store_true", help="re-run each pending meeting in --dry-run mode")
    p.add_argument("--repo-root", default=str(brain_paths.DEFAULT_REPO_ROOT))
    p.add_argument("--vault", default=str(brain_paths.DEFAULT_VAULT))
    args = p.parse_args(argv)
    vault, repo_root = Path(args.vault), Path(args.repo_root)
    pending = pending_envelopes(vault, args.days)
    if not pending:
        print(json.dumps({"pending": 0, "retried": [], "ok": True}))
        return 0
    results = []
    for mid in pending:
        rc, tail = retry_one(mid, repo_root, vault, dry_run=args.dry_run)
        results.append({"meeting_id": mid, "rc": rc, "last_line": tail})
        print(f"retry fireflies:{mid} rc={rc} :: {tail}")
    ok = all(r["rc"] == 0 for r in results)
    print(json.dumps({"pending": len(pending), "retried": results, "ok": ok}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
