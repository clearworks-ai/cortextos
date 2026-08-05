#!/usr/bin/env python3
"""Append (or fold decisions into) an interaction in the local CRM interaction log.

Idempotent on ``source_ref + contact_id``: a second call for the same meeting does not
create a duplicate row — it UPDATES the existing row's decisions/deal_state in place (via
an atomic temp-file rewrite that preserves every other line verbatim). This lets the
meeting-decision connector attach decisions to the one meeting interaction row that
already exists, rather than fragmenting the meeting's record across duplicate rows.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def _interactions_path() -> Path:
    # Env override lets tests point at a temp fixture; defaults to the live store.
    return Path(os.environ.get("CRM_INTERACTIONS_PATH", ROOT / "interactions.jsonl"))


def _atomic_write_lines(path: Path, lines: list[str]) -> None:
    """Rewrite the whole file atomically (temp in same dir + os.replace) so a crash
    mid-write can never truncate/corrupt interactions.jsonl."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".interactions-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for ln in lines:
                fh.write(ln if ln.endswith("\n") else ln + "\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contact-id", required=True)
    parser.add_argument("--type", required=True, choices=["email", "meeting", "call", "message", "social", "manual", "task"])
    # --summary was required historically; now optional so a decisions-only fold/update
    # (which never needs a fresh summary) can run. Existing callers still pass it.
    parser.add_argument("--summary", default=None)
    parser.add_argument("--source-ref", default=None)
    parser.add_argument("--sentiment", default="unknown", choices=["positive", "neutral", "negative", "unknown"])
    # Additive: repeatable --decision "<text>" (avoids JSON-in-argv quoting bugs). Default
    # [] so callers that never pass it are byte-for-byte unaffected.
    parser.add_argument("--decision", action="append", dest="decisions", default=None)
    # Free-text deal-state signal preserved on the row (the connector maps it to a real
    # sales stage only via a deterministic keyword dict — never a silent LLM-prose flip).
    parser.add_argument("--deal-state", default=None)
    args = parser.parse_args()

    decisions = args.decisions or []
    path = _interactions_path()

    # Update-in-place if a same source_ref+contact_id row already exists.
    if args.source_ref and path.exists():
        raw_lines: list[str] = []
        matched_idx: int | None = None
        matched_row: dict | None = None
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                stripped = line.rstrip("\n")
                idx = len(raw_lines)
                raw_lines.append(stripped)
                if matched_idx is not None or not stripped.strip():
                    continue
                try:
                    existing = json.loads(stripped)
                except json.JSONDecodeError:
                    continue  # preserve the malformed line verbatim; just don't match it
                if existing.get("source_ref") == args.source_ref and existing.get("contact_id") == args.contact_id:
                    matched_idx = idx
                    matched_row = existing

        if matched_idx is not None and matched_row is not None:
            new_deal_state = args.deal_state if args.deal_state is not None else matched_row.get("deal_state")
            if matched_row.get("decisions", []) == decisions and matched_row.get("deal_state") == new_deal_state:
                print(json.dumps({"skipped": "duplicate", "source_ref": args.source_ref, "contact_id": args.contact_id}))
                return 0
            matched_row["decisions"] = decisions
            matched_row["deal_state"] = new_deal_state
            raw_lines[matched_idx] = json.dumps(matched_row)
            _atomic_write_lines(path, raw_lines)
            print(json.dumps({"updated": "decisions", "source_ref": args.source_ref, "contact_id": args.contact_id}))
            return 0

    # No existing row for this meeting — append a new one.
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "contact_id": args.contact_id,
        "type": args.type,
        "summary": args.summary or "",
        "sentiment": args.sentiment,
        "commitments": [],
        "followups_created": [],
        "decisions": decisions,
        "deal_state": args.deal_state,
        "source_ref": args.source_ref,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
