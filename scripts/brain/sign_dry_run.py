#!/usr/bin/env python3
"""Writes the d09-signed marker run_meeting.py --apply requires. Defense in
depth on top of the goalify-loop-level HALT check in the R2 goal file — never
inferred automatically; only invoked once a human sign-off is in hand."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from paths import DEFAULT_VAULT, safe_meeting_id
# Re-exports: run_meeting.py imports marker_path from here; tests import the
# noun/regex constants. The writer itself lives in sign_marker.py (FR-016,
# G-111) so sign_batch.py writes byte-identical markers through one seam.
from sign_marker import (  # noqa: F401
    FR012_NOUNS,
    PHASE3_FILE_RE,
    PHASE3_HEADER_RE,
    PHASE3_TOUCH_RE,
    PHASE3_WRITE_RE,
    _phase3_missing,
    marker_path,
    write_marker,
)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()  # G0a r1: the current main() uses a bare parser, no description
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
    rc, marker, message = write_marker(
        Path(args.vault), "fireflies", meeting_id, Path(args.dry_run_capture),
        signed_by=args.signed_by, signed_at=args.signed_at,
    )
    if rc != 0:
        print(message, file=sys.stderr)
        return rc
    if message:
        print(message, file=sys.stderr)
    print(f"signed: {marker}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
