#!/usr/bin/env python3
"""Writes the d09-signed marker run_meeting.py --apply requires. Defense in
depth on top of the goalify-loop-level HALT check in the R2 goal file — never
inferred automatically; only invoked once a human sign-off is in hand."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from atomic import atomic_write
from paths import DEFAULT_VAULT, safe_meeting_id

# FR-012 line ~324's five dry-run nouns: resolution reason (home=), page
# diff (the unified-diff "--- a/" marker writeback_render.unified_diff
# produces), quotes kept/dropped, task list, draft subject. G0a F-12.
FR012_NOUNS = ("home=", "--- a/", "quotes kept", "tasks:", "subject:")


def marker_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return Path(vault) / "raw/media/transcripts/_state" / f"{kind}-{meeting_id}" / "d09-signed.json"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--signed-by", required=True)
    p.add_argument("--signed-at", required=True)
    p.add_argument("--dry-run-capture", required=True)
    args = p.parse_args(argv)

    meeting_id = safe_meeting_id(args.meeting_id)
    if not meeting_id:
        print("need --meeting-id", file=sys.stderr)
        return 64
    capture = Path(args.dry_run_capture)
    if not capture.is_file():
        print(f"dry-run capture not found: {capture}", file=sys.stderr)
        return 1
    text = capture.read_text(encoding="utf-8")
    missing = [n for n in FR012_NOUNS if n not in text]
    if missing:
        print(f"dry-run capture missing nouns: {missing}", file=sys.stderr)
        return 1
    marker = marker_path(Path(args.vault), "fireflies", meeting_id)
    # CH-1/S-2: D-09's `--apply` gate must validate more than "the marker
    # file exists" — capture_path + capture_sha256 let progress.py's
    # validate_sign_marker() prove the signed capture is the exact bytes a
    # human reviewed, not just a same-named stand-in.
    doc = {
        "meeting_id": meeting_id,
        "signed_by": args.signed_by,
        "signed_at": args.signed_at,
        "capture": str(capture),
        "capture_path": str(capture),
        "capture_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    atomic_write(marker, json.dumps(doc, sort_keys=True).encode("utf-8"))
    print(f"signed: {marker}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
