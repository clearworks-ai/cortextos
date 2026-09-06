#!/usr/bin/env python3
"""Writes the d09-signed marker run_meeting.py --apply requires. Defense in
depth on top of the goalify-loop-level HALT check in the R2 goal file — never
inferred automatically; only invoked once a human sign-off is in hand."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from atomic import atomic_write
from paths import DEFAULT_VAULT, envelope_dir, safe_meeting_id

# FR-012 line ~324's five dry-run nouns: resolution reason (home=), page
# diff (the unified-diff "--- a/" marker writeback_render.unified_diff
# produces), quotes kept/dropped, task list, draft subject. G0a F-12.
FR012_NOUNS = ("home=", "--- a/", "quotes kept", "tasks:", "subject:")

# G0a F-9 ruling: phase 3's three new writers (rollup region, status
# artifact, filed digest) predate FR-012 line 324's noun list. A capture
# taken before this release's dry-run extension existed cannot contain
# these — that is the exact stale-marker case this field exists to catch.
#
# CH-6: substring containment alone let an R2-era capture whose page diff or
# meeting text merely *mentions* "would-touch:" etc. (as prose, inside a
# diff hunk, or mid-line) forge the phase-3 signal. `_run_dry` now emits a
# structured `phase3-preview: v1` header line immediately before the
# phase-3 preview block, with every preview line anchored at column 0 —
# require BOTH that exact header line and at least one real anchored
# would-* line, via re.MULTILINE so `^`/`$` bind to line boundaries rather
# than the whole capture.
PHASE3_HEADER_RE = re.compile(r"^phase3-preview: v1$", re.MULTILINE)
# Finding 1 (P1, review 2026-09-06): the single combined regex above let a
# capture truncated right after "would-touch:" (never reaching the status
# writer's would-write: or the filed-log's would-file:) pass as fully
# reviewed — ANY one anchored noun was enough. Each of the three phase-3
# writers now needs its OWN evidence line: at least one would-touch: (the
# rollup writer — client region and/or STATE.md), at least one
# would-write: (the status writer — "would-write: skip: ..." counts, since
# _run_dry always normalizes an empty status writer into that form), and
# EXACTLY one would-file: (the filed-log writer, always emitted once).
PHASE3_TOUCH_RE = re.compile(r"^would-touch: ", re.MULTILINE)
PHASE3_WRITE_RE = re.compile(r"^would-write: ", re.MULTILINE)
PHASE3_FILE_RE = re.compile(r"^would-file: ", re.MULTILINE)


def _phase3_missing(text: str) -> list[str]:
    """Returns the list of phase-3 writer(s) missing evidence in `text`, or
    an empty list when the capture fully evidences all three. Also enforces
    that the capture ends with the would-file: block (trailing whitespace
    only) — content appended after it is the same truncation/tampering
    signal as content missing before it."""
    missing: list[str] = []
    if not PHASE3_HEADER_RE.search(text):
        missing.append("phase3-preview: v1 header")
    if not PHASE3_TOUCH_RE.search(text):
        missing.append("would-touch:")
    if not PHASE3_WRITE_RE.search(text):
        missing.append("would-write:")
    file_lines = PHASE3_FILE_RE.findall(text)
    if len(file_lines) != 1:
        missing.append("would-file: (exactly one)")
    stripped = text.rstrip()
    last_line = stripped.rsplit("\n", 1)[-1] if stripped else ""
    if not last_line.startswith("would-file: "):
        missing.append("would-file: (must end capture)")
    return missing


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
    phase3_missing = _phase3_missing(text)
    phase3_ok = not phase3_missing
    if phase3_missing:
        print(f"phase-3 preview incomplete: missing {phase3_missing}", file=sys.stderr)
    marker = marker_path(Path(args.vault), "fireflies", meeting_id)
    envelope = marker.parent
    # Finding 4c: progress.validate_sign_marker() now requires capture_path
    # to resolve INSIDE this envelope directory — a human almost always
    # hands --dry-run-capture a path elsewhere (a scratch/tmp file from
    # piping run_meeting.py --dry-run). Copy the exact reviewed bytes into
    # <envelope>/dry-run.txt (atomic) so the marker's capture_path is always
    # satisfiable, without changing what was actually reviewed — the sha256
    # below is computed from `text`, read before this copy, so it matches
    # either location.
    try:
        capture.resolve().relative_to(envelope.resolve())
        capture_for_marker = capture
    except ValueError:
        capture_for_marker = envelope / "dry-run.txt"
        atomic_write(capture_for_marker, text.encode("utf-8"))
    # D-09 review finding 1: the marker above only proves a human reviewed
    # SOME capture — `--apply` then re-runs fetch/resolve/adapt and could
    # write different content if the underlying source changed after
    # review. Bind the sign-off to the exact data it was reviewed against:
    # the data envelope's (raw/media/transcripts/<kind>/<meeting_id>/, NOT
    # this marker's own _state/ directory) `source.sha256` at sign time, and
    # `extraction.json`'s own `inputSha` field. progress.validate_sign_marker
    # (called a second time by run_meeting.py, right after its fetch step)
    # compares both against the envelope's CURRENT values. Best-effort: a
    # sign-off performed before any dry-run ever populated the envelope (no
    # source.sha256/extraction.json yet) records null for the missing
    # piece(s) — validate_sign_marker's envelope-bound check then correctly
    # refuses it as "missing from sign marker" rather than fabricating a
    # match.
    data_dir = envelope_dir(Path(args.vault), "fireflies", meeting_id)
    source_sha_path = data_dir / "source.sha256"
    source_sha256 = None
    if source_sha_path.is_file():
        source_sha256 = source_sha_path.read_text(encoding="utf-8").strip() or None
    extraction_input_sha = None
    extraction_path = data_dir / "extraction.json"
    if extraction_path.is_file():
        try:
            extraction_doc = json.loads(extraction_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            extraction_doc = {}
        if isinstance(extraction_doc, dict):
            value = extraction_doc.get("inputSha")
            extraction_input_sha = value if isinstance(value, str) and value.strip() else None

    # CH-1/S-2: D-09's `--apply` gate must validate more than "the marker
    # file exists" — capture_path + capture_sha256 let progress.py's
    # validate_sign_marker() prove the signed capture is the exact bytes a
    # human reviewed, not just a same-named stand-in.
    doc = {
        "meeting_id": meeting_id,
        "signed_by": args.signed_by,
        "signed_at": args.signed_at,
        "capture": str(capture),
        "capture_path": str(capture_for_marker),
        "capture_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "phase3_capture_sha256": (
            hashlib.sha256(text.encode("utf-8")).hexdigest() if phase3_ok else None
        ),
        "source_sha256": source_sha256,
        "extraction_input_sha": extraction_input_sha,
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    atomic_write(marker, json.dumps(doc, sort_keys=True).encode("utf-8"))
    print(f"signed: {marker}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
