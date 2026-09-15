#!/usr/bin/env python3
"""FR-006 7-day coverage diff: enumerate every interaction row the OLD Gmail
ingest path (comms-backfill.py) wrote inside the window that the NEW
client-state-gmail path did not, grouped by exclusion class, for a human to
rule on before the piggyback line in crm-codex's cron prompt is removed.
Unit-tested on fixtures only - this plan never runs it against live data.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
BRAIN_DIR = REPO_ROOT / "scripts" / "brain"
if str(BRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(BRAIN_DIR))

FROM_TOKEN_RE = re.compile(r"-from:(\S+)")
SUBJECT_TOKEN_RE = re.compile(r'-subject:"([^"]+)"')


def exclusion_tokens(exclusion_query: str) -> tuple[list[str], list[str]]:
    """Split EXCLUSION_QUERY into (from_tokens, subject_tokens), lowercased,
    stripped of the leading '-from:'/'-subject:' and any surrounding quotes."""
    from_tokens = [t.strip('"').lower() for t in FROM_TOKEN_RE.findall(exclusion_query)]
    subject_tokens = [t.lower() for t in SUBJECT_TOKEN_RE.findall(exclusion_query)]
    return from_tokens, subject_tokens


def parse_subject(summary: str) -> str:
    """comms-backfill.py writes 'SENT: <subject> | <snippet>' or
    'RECEIVED: <subject> | <snippet>'; extract the subject portion."""
    for prefix in ("SENT: ", "RECEIVED: "):
        if summary.startswith(prefix):
            rest = summary[len(prefix):]
            return rest.split(" | ", 1)[0]
    return summary


class InputError(Exception):
    """G0B3-7: an input this report cannot read. FR-006 makes the report the
    prerequisite for DELETING the old ingest path, so a missing or unreadable
    source must never be reported as 'zero coverage losses' — it must fail
    closed with the cause, exit 2."""


def load_jsonl(path: Path) -> list[dict]:
    """Every line must parse. A missing file, an unreadable one, or a malformed
    line is an InputError — never an empty list (G0B3-7)."""
    if not path.exists():
        raise InputError(f"--old-interactions not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputError(f"--old-interactions unreadable: {path}: {exc}") from exc
    rows: list[dict] = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise InputError(f"--old-interactions line {n} is not JSON: {exc}") from exc
        if not isinstance(row, dict):
            raise InputError(f"--old-interactions line {n} is not a JSON object")
        rows.append(row)
    return rows


def load_contacts_by_id(crm_dir: Path) -> dict:
    contacts_path = crm_dir / "contacts.json"
    if not contacts_path.exists():
        raise InputError(f"--crm-dir has no contacts.json: {contacts_path}")  # G0B3-7
    try:
        data = json.loads(contacts_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"contacts.json unreadable or malformed: {contacts_path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("contacts"), list):
        raise InputError(f"contacts.json has no 'contacts' list: {contacts_path}")
    out: dict = {}
    for c in data.get("contacts", []):
        out[c.get("id")] = c
    return out


def primary_email(contact: dict | None) -> str:
    if not contact:
        return ""
    emails = contact.get("emails") or []
    return (emails[0] if emails else "").lower()


def confirmed_crm_keys(ledger) -> set[tuple[str, str]]:
    """G0B2-12 / decision (j): the keys the NEW path is PROVEN to have covered
    -- (source_ref, contact_id) for every REAL `crm:<contact_id>` write token,
    read across the ledger's FULL history (a message can be filed partially
    across several runs).

    Deliberately NOT `Ledger.distinct_refs()`: that set contains every
    OBSERVED ref, including the ones the new path ignored, escalated, or only
    filed for SOME of a multiparty message's contacts. Those are exactly the
    coverage losses FR-006 exists to enumerate, and treating them as covered
    is how a rollout silently drops mail. Simulated (dry-run) rows write
    nothing, so their `planned_writes` never count as coverage."""
    keys: set[tuple[str, str]] = set()
    for row in ledger.all_rows():  # full history, not just the latest row per ref
        if getattr(row, "simulated", False):
            continue
        for write in row.writes:
            if write.startswith("crm:"):
                keys.add((row.source_ref, write.split(":", 1)[1]))
    return keys


def old_path_rows(rows: list[dict], since: str, confirmed: set[tuple[str, str]]) -> list[dict]:
    """Every in-window old-path interaction whose (source_ref, contact_id) the
    new path did NOT confirm a CRM write for."""
    out = []
    for row in rows:
        source_ref = row.get("source_ref") or ""
        ts = row.get("ts") or ""
        if not source_ref.startswith("gmail:"):
            continue
        if ts < since:
            continue
        if (source_ref, str(row.get("contact_id") or "")) in confirmed:
            continue
        out.append(row)
    return out


def classify(row: dict, from_tokens: list[str], subject_tokens: list[str],
             contacts_by_id: dict, resolver) -> str:
    summary = row.get("summary") or ""
    if summary.startswith("SENT:"):
        return "sent-mail"
    email = primary_email(contacts_by_id.get(row.get("contact_id")))
    subject = parse_subject(summary).lower()
    if email and any(tok in email for tok in from_tokens):
        return "automated-sender"
    if subject and any(tok in subject for tok in subject_tokens):
        return "automated-sender"
    if resolver is not None:
        if not email:
            return "unknown-entity"
        resolution = resolver.resolve_address(email)
        if not getattr(resolution, "slug", ""):
            return "unknown-entity"
        return "other"
    return "unclassified"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FR-006 old-path vs new-path Gmail coverage diff")
    parser.add_argument("--old-interactions", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--since", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--vault", type=Path, default=None)
    parser.add_argument("--crm-dir", type=Path, default=None)
    args = parser.parse_args(argv)

    import observation_ledger  # noqa: E402
    import gmail_source  # noqa: E402

    ledger_path = args.state_dir / "observations.jsonl"
    if not ledger_path.exists():
        raise InputError(f"--state-dir has no observations.jsonl: {ledger_path}")  # G0B3-7
    ledger = observation_ledger.Ledger(ledger_path)
    try:
        confirmed = confirmed_crm_keys(ledger)
    except (OSError, ValueError) as exc:
        raise InputError(f"observations.jsonl unreadable or malformed: {ledger_path}: {exc}") from exc

    from_tokens, subject_tokens = exclusion_tokens(gmail_source.EXCLUSION_QUERY)
    contacts_by_id = load_contacts_by_id(args.crm_dir) if args.crm_dir else {}

    resolver = None
    if args.vault is not None and args.crm_dir is not None:
        import resolve_email  # noqa: E402
        from resolve_meeting import load_closed_sets  # noqa: E402
        closed = load_closed_sets(args.vault)
        resolver = resolve_email.EmailResolver(closed, list(contacts_by_id.values()))

    rows = load_jsonl(args.old_interactions)
    candidates = old_path_rows(rows, args.since, confirmed)

    classes: dict[str, list[dict]] = {}
    for row in candidates:
        cls = classify(row, from_tokens, subject_tokens, contacts_by_id, resolver)
        classes.setdefault(cls, []).append(row)

    doc = {
        "since": args.since,
        "total_old_rows": len(candidates),
        "confirmed_new_crm_keys": len(confirmed),
        "classes": classes,
        "counts": {k: len(v) for k, v in classes.items()},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(doc["counts"], sort_keys=True))
    return 0


def cli(argv: list[str] | None = None) -> int:
    """Wraps main() so an unreadable input is exit 2 with the cause on stderr —
    never a clean report that falsely certifies zero coverage losses."""
    try:
        return main(argv)
    except InputError as exc:
        print(f"coverage-diff: FATAL - {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
