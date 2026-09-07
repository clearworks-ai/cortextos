#!/usr/bin/env python3
"""Shared D-09 sign-marker writer (FR-016, spec G-111).

Extracted verbatim from sign_dry_run.py so the per-meeting human sign-off
(sign_dry_run.py) and the per-batch D-20 sign-off (sign_batch.py) write
byte-identical markers through one seam. progress.validate_sign_marker and
progress.validate_phase3_capture are unchanged consumers."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from paths import envelope_dir

# FR-012 line ~324's five dry-run nouns (G0a F-12).
FR012_NOUNS = ("home=", "--- a/", "quotes kept", "tasks:", "subject:")

PHASE3_HEADER_RE = re.compile(r"^phase3-preview: v1$", re.MULTILINE)
PHASE3_TOUCH_RE = re.compile(r"^would-touch: ", re.MULTILINE)
PHASE3_WRITE_RE = re.compile(r"^would-write: ", re.MULTILINE)
PHASE3_FILE_RE = re.compile(r"^would-file: ", re.MULTILINE)


def _phase3_missing(text: str) -> list[str]:
    """Phase-3 writer evidence missing from `text` (empty = complete). Also
    requires the capture to END with the would-file: block."""
    missing: list[str] = []
    if not PHASE3_HEADER_RE.search(text):
        missing.append("phase3-preview: v1 header")
    if not PHASE3_TOUCH_RE.search(text):
        missing.append("would-touch:")
    if not PHASE3_WRITE_RE.search(text):
        missing.append("would-write:")
    if len(PHASE3_FILE_RE.findall(text)) != 1:
        missing.append("would-file: (exactly one)")
    tail = [line for line in text.splitlines() if line.strip()]
    if not tail or not tail[-1].startswith("would-file: "):
        missing.append("would-file: (must end capture)")
    return missing


def marker_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return Path(vault) / "raw/media/transcripts/_state" / f"{kind}-{meeting_id}" / "d09-signed.json"


def check_capture(text: str) -> tuple[list[str], list[str]]:
    """(missing FR-012 nouns, missing phase-3 evidence)."""
    return [n for n in FR012_NOUNS if n not in text], _phase3_missing(text)


def write_marker(
    vault: Path, kind: str, meeting_id: str, capture: Path, *,
    signed_by: str, signed_at: str, extra: dict[str, Any] | None = None,
) -> tuple[int, Path | None, str]:
    """Returns (rc, marker path or None, message). rc 1 = refused, nothing
    written; rc 0 = written, message is "" or the phase-3 warning."""
    capture = Path(capture)
    if not capture.is_file():
        return 1, None, f"dry-run capture not found: {capture}"
    text = capture.read_text(encoding="utf-8")
    missing, phase3_missing = check_capture(text)
    if missing:
        return 1, None, f"dry-run capture missing nouns: {missing}"
    phase3_ok = not phase3_missing
    warning = f"phase-3 preview incomplete: missing {phase3_missing}" if phase3_missing else ""

    marker = marker_path(Path(vault), kind, meeting_id)
    envelope = marker.parent
    # Finding 4c: capture_path must resolve INSIDE the marker's own envelope
    # dir — copy the exact reviewed bytes there when it does not.
    try:
        capture.resolve().relative_to(envelope.resolve())
        capture_for_marker = capture
    except ValueError:
        capture_for_marker = envelope / "dry-run.txt"
        atomic_write(capture_for_marker, text.encode("utf-8"))

    # D-09 review finding 1: bind the sign-off to the data it reviewed.
    data_dir = envelope_dir(Path(vault), kind, meeting_id)
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

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    doc: dict[str, Any] = {
        "meeting_id": meeting_id,
        "signed_by": signed_by,
        "signed_at": signed_at,
        "capture": str(capture),
        "capture_path": str(capture_for_marker),
        "capture_sha256": digest,
        "phase3_capture_sha256": digest if phase3_ok else None,
        "source_sha256": source_sha256,
        "extraction_input_sha": extraction_input_sha,
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if extra:
        doc.update(extra)
    atomic_write(marker, json.dumps(doc, sort_keys=True).encode("utf-8"))
    return 0, marker, warning
