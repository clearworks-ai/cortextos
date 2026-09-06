#!/usr/bin/env python3
"""repair_crm_nameonly_contacts.py

Removes name-only, email-less contacts that a brain R2 live-apply run
mistakenly upserted into a CRM agent's contacts.json for a single meeting,
plus the interaction rows it appended for those contacts in
interactions.jsonl.

Background: on 2026-09-06T06:01:19Z, live-applying meeting
fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA upserted two email-less contacts
(`ivette-ramos`, `joseph-chang`) that duplicate real contacts already
present under different ids/names, and appended one interaction row per
contact for that meeting. This script reverses exactly that damage and
nothing else.

Guardrails — a named contact is removed ONLY if ALL of the following hold:
  - its id/slug is in --contacts
  - its `emails` list is exactly [] (empty)
  - its `source_refs` list is exactly [f"fireflies:{meeting_id}"] — i.e. the
    contact has no other provenance referencing it

If any named contact fails this guard (not found, has emails, or has other
source_refs), the script REFUSES entirely: exit code 2, no files touched.

Interaction rows are removed ONLY if BOTH hold:
  - row["contact_id"] is in --contacts
  - the row references the given meeting id (source_ref names it)

Default mode is DRY-RUN: prints exactly what would change, writes nothing.
Pass --apply to perform the change. On --apply, both files are backed up
next to their originals as `<name>.bak-<UTC-ISO-stamp>` before being
rewritten atomically (temp file + os.replace, matching brain/atomic.py).

Byte-preservation (R-1, FINAL-fable-round2.json): the producers
(add-interaction.py, upsert-contact.py) do NOT write `ensure_ascii=False`.
Re-serialising every row/record with different JSON options than the
producer used would rewrite hundreds of unrelated lines/records byte-for-
byte (still JSON-equal, but it defeats a line-diff review and silently
changes the on-disk convention). So this script never re-dumps retained
content:

  - interactions.jsonl: retained lines are spliced verbatim from the
    original file bytes (original line endings preserved exactly);
    only the matched rows' lines are dropped.
  - contacts.json: the file's own `ensure_ascii` (detected from whether any
    non-ASCII byte is present in the raw file) and `indent` (detected from
    the raw text's own layout) are reproduced; key order is preserved
    automatically because `json.load` keeps each object's on-disk field
    order. Before writing, every RETAINED contact's fresh serialisation is
    asserted byte-identical to its original on-disk text (self-check). If
    the format can't be confidently detected, or the self-check fails for
    any retained contact, the script REFUSES: exit code 3, no files
    touched.

The script is idempotent: once the two contacts and their interaction rows
are gone, a second run finds nothing left to remove and exits 0 as a no-op
(dry-run or --apply).

Usage:
    python3 repair_crm_nameonly_contacts.py \\
        --crm-dir /path/to/crm/crm \\
        --meeting-id 01M1MW2GAZ1DQ0C6PG3KJ557JA \\
        --contacts ivette-ramos,joseph-chang
        [--apply]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atomic import atomic_write  # noqa: E402


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def load_contacts(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("contacts"), list):
        raise ValueError(f"unexpected contacts.json shape at {path}: expected {{'contacts': [...]}}")
    return data


def load_interaction_lines(path: Path) -> list[str]:
    """Return the file's lines WITH their original line endings exactly as
    stored on disk (no newline translation) — the byte-preserving splice
    source for retained rows. ``newline=""`` disables Python's universal
    newline translation so each line keeps its literal on-disk terminator."""
    with path.open("r", encoding="utf-8", newline="") as f:
        return f.readlines()


def parse_interaction_line(raw_line: str) -> dict[str, Any] | None:
    """Parse one on-disk line (its own trailing newline stripped first).
    Returns None for a blank/whitespace-only line (never a removal
    candidate, but its raw text is still preserved on output)."""
    stripped = raw_line.rstrip("\r\n")
    if not stripped.strip():
        return None
    return json.loads(stripped)


def check_guard(contact: dict[str, Any], meeting_id: str) -> tuple[bool, str]:
    emails = contact.get("emails")
    if emails != []:
        return False, f"emails not empty: {emails!r}"
    expected_refs = [f"fireflies:{meeting_id}"]
    source_refs = contact.get("source_refs")
    if source_refs != expected_refs:
        return False, f"source_refs != {expected_refs!r} (got {source_refs!r})"
    return True, ""


def row_references_meeting(row: dict[str, Any], meeting_id: str) -> bool:
    needle = f"fireflies:{meeting_id}"
    source_ref = row.get("source_ref")
    if source_ref == needle:
        return True
    if isinstance(source_ref, str) and meeting_id in source_ref:
        return True
    return False


# --- contacts.json byte-preserving re-serialisation -------------------------

def detect_ensure_ascii(raw_bytes: bytes) -> bool:
    """The producer (upsert-contact.py:288) doesn't pass ensure_ascii, so it
    defaults to True (\\uXXXX-escaped). Detect from the file itself rather
    than assuming: any raw non-ASCII byte on disk means the file was written
    with ensure_ascii=False; otherwise assume the (default) True."""
    return not any(b >= 0x80 for b in raw_bytes)


def detect_indent(raw_text: str) -> int | None:
    """Detect the pretty-print indent width from the file's own top-level
    layout (`{\\n<spaces>"key"`). Returns None for compact (no-indent) JSON."""
    m = re.match(r'^\{\r?\n( +)"', raw_text)
    if not m:
        return None
    return len(m.group(1))


def contacts_array_element_spans(raw_text: str, key: str) -> list[tuple[int, int]]:
    """Locate the raw-text (start, end) span of every element of the JSON
    array at top-level key ``key``, in file order — used to pull each
    retained contact's exact original on-disk text for the self-check."""
    key_pat = f'"{key}"'
    key_idx = raw_text.index(key_pat)
    colon_idx = raw_text.index(":", key_idx + len(key_pat))
    bracket_idx = raw_text.index("[", colon_idx)
    decoder = json.JSONDecoder()
    idx = bracket_idx + 1
    n = len(raw_text)
    spans: list[tuple[int, int]] = []
    while True:
        while idx < n and raw_text[idx] in " \t\r\n,":
            idx += 1
        if idx >= n:
            raise ValueError(f"unterminated array while scanning contacts.json for key {key!r}")
        if raw_text[idx] == "]":
            break
        _, end = decoder.raw_decode(raw_text, idx)
        spans.append((idx, end))
        idx = end
    return spans


def reindent_embedded_dump(obj: Any, indent: int | None, ensure_ascii: bool, extra_levels: int = 2) -> str:
    """Serialise ``obj`` the same way json.dumps(..., indent=indent) would
    render it if it were embedded ``extra_levels`` deeper than top-level
    (contacts.json's array elements sit at depth 2: top object -> "contacts"
    array -> element). json.dumps indents every line by ``depth * indent``
    spaces, so shifting the base depth by a constant is equivalent to
    prefixing every line but the first (whose leading spaces come from the
    enclosing array's own rendering, not this object's dump) with a constant
    number of spaces."""
    if indent is None:
        return json.dumps(obj, ensure_ascii=ensure_ascii)
    text = json.dumps(obj, indent=indent, ensure_ascii=ensure_ascii)
    if extra_levels <= 0:
        return text
    prefix = " " * (indent * extra_levels)
    lines = text.split("\n")
    shifted = [lines[0]] + [(prefix + ln if ln else ln) for ln in lines[1:]]
    return "\n".join(shifted)


def verify_contacts_byte_preservation(
    raw_text: str,
    contacts: list[dict[str, Any]],
    target_ids: list[str],
    indent: int | None,
    ensure_ascii: bool,
) -> tuple[bool, str]:
    """Self-check (before any write): every contact NOT being removed must
    re-serialise to exactly the text it already has on disk under the
    detected (indent, ensure_ascii) options. Returns (ok, reason)."""
    spans = contacts_array_element_spans(raw_text, "contacts")
    if len(spans) != len(contacts):
        return False, (
            f"contacts array element count mismatch: parsed {len(contacts)} "
            f"vs {len(spans)} text spans"
        )
    for i, contact in enumerate(contacts):
        if contact.get("id") in target_ids:
            continue  # being removed; nothing to preserve
        start, end = spans[i]
        original_text = raw_text[start:end]
        reproduced = reindent_embedded_dump(contact, indent, ensure_ascii)
        if reproduced != original_text:
            return False, f"contact id={contact.get('id')!r} (index {i}) would not serialise byte-identically"
    return True, ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Remove name-only, email-less contacts (and their interaction rows) "
        "mistakenly upserted for one meeting. Dry-run by default.",
    )
    ap.add_argument("--crm-dir", required=True, help="Directory containing contacts.json and interactions.jsonl")
    ap.add_argument("--meeting-id", required=True, help="Fireflies meeting id, e.g. 01M1MW2GAZ1DQ0C6PG3KJ557JA")
    ap.add_argument(
        "--contacts",
        required=True,
        help="Comma-separated contact ids/slugs to remove, e.g. ivette-ramos,joseph-chang",
    )
    ap.add_argument("--apply", action="store_true", help="Write changes. Default is dry-run (no writes).")
    args = ap.parse_args(argv)

    crm_dir = Path(args.crm_dir)
    contacts_path = crm_dir / "contacts.json"
    interactions_path = crm_dir / "interactions.jsonl"
    meeting_id = args.meeting_id
    target_ids = [s.strip() for s in args.contacts.split(",") if s.strip()]

    if not target_ids:
        print("ERROR: --contacts produced an empty list", file=sys.stderr)
        return 2
    if not contacts_path.is_file():
        print(f"ERROR: not found: {contacts_path}", file=sys.stderr)
        return 2
    if not interactions_path.is_file():
        print(f"ERROR: not found: {interactions_path}", file=sys.stderr)
        return 2

    contacts_raw_bytes = contacts_path.read_bytes()
    contacts_raw_text = contacts_raw_bytes.decode("utf-8")
    contacts_data = load_contacts(contacts_path)
    contacts = contacts_data["contacts"]

    interaction_raw_lines = load_interaction_lines(interactions_path)
    interaction_rows = [parse_interaction_line(rl) for rl in interaction_raw_lines]

    before_contact_count = len(contacts)
    before_interaction_count = sum(1 for r in interaction_rows if r is not None)

    found_contacts: dict[str, dict[str, Any]] = {}
    for c in contacts:
        cid = c.get("id")
        if cid in target_ids:
            found_contacts[cid] = c

    # --- Guard: every named contact must pass, or refuse entirely ---
    failures: list[str] = []
    already_absent: list[str] = []
    for cid in target_ids:
        if cid not in found_contacts:
            already_absent.append(cid)
            continue
        ok, reason = check_guard(found_contacts[cid], meeting_id)
        if not ok:
            failures.append(f"{cid}: guard failed ({reason})")

    if failures:
        print("REFUSING: guard check failed for one or more named contacts:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        print("No files were modified.", file=sys.stderr)
        return 2

    # --- Compute removals (contacts already absent = idempotent no-op for them) ---
    removed_contacts = [found_contacts[cid] for cid in target_ids if cid in found_contacts]
    kept_contacts = [c for c in contacts if c.get("id") not in target_ids]

    removed_rows: list[dict[str, Any]] = []
    kept_raw_lines: list[str] = []
    for raw, row in zip(interaction_raw_lines, interaction_rows):
        if row is not None and row.get("contact_id") in target_ids and row_references_meeting(row, meeting_id):
            removed_rows.append(row)
        else:
            kept_raw_lines.append(raw)

    after_contact_count = len(kept_contacts)
    after_interaction_count = before_interaction_count - len(removed_rows)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"=== repair_crm_nameonly_contacts.py [{mode}] ===")
    print(f"crm-dir:     {crm_dir}")
    print(f"meeting-id:  {meeting_id}")
    print(f"targets:     {target_ids}")
    if already_absent:
        print(f"already absent from contacts.json (idempotent no-op): {already_absent}")
    print()
    print(f"contacts.json:      {before_contact_count} -> {after_contact_count} (removing {len(removed_contacts)})")
    print(
        f"interactions.jsonl: {before_interaction_count} -> {after_interaction_count} "
        f"(removing {len(removed_rows)})"
    )
    print()
    print("Removed contacts:")
    print(json.dumps(removed_contacts, indent=2, ensure_ascii=False))
    print()
    print("Removed interaction rows:")
    print(json.dumps(removed_rows, indent=2, ensure_ascii=False))

    if not removed_contacts and not removed_rows:
        print()
        print("Nothing to remove — already clean (idempotent). No files modified.")
        return 0

    if not args.apply:
        print()
        print("Dry-run only; no files modified. Re-run with --apply to write changes.")
        return 0

    # --- Detect contacts.json's on-disk serialisation format, and refuse
    # rather than guess if we can't confidently reproduce it (R-1). ---
    ensure_ascii = detect_ensure_ascii(contacts_raw_bytes)
    indent = detect_indent(contacts_raw_text)

    ok, reason = verify_contacts_byte_preservation(contacts_raw_text, contacts, target_ids, indent, ensure_ascii)
    if not ok:
        print(
            f"REFUSING: contacts.json self-check failed — {reason}. "
            "Cannot guarantee retained contacts would serialise byte-identically. "
            "No files were modified.",
            file=sys.stderr,
        )
        return 3

    # --- Backups (written before any mutation) ---
    stamp = utc_stamp()
    contacts_backup = contacts_path.with_name(contacts_path.name + f".bak-{stamp}")
    interactions_backup = interactions_path.with_name(interactions_path.name + f".bak-{stamp}")

    atomic_write(contacts_backup, contacts_raw_bytes)
    atomic_write(interactions_backup, "".join(interaction_raw_lines).encode("utf-8"))

    # --- Write updated files atomically ---
    new_contacts_data = dict(contacts_data)
    new_contacts_data["contacts"] = kept_contacts
    contacts_bytes = (json.dumps(new_contacts_data, indent=indent, ensure_ascii=ensure_ascii) + "\n").encode("utf-8")
    atomic_write(contacts_path, contacts_bytes)

    interactions_bytes = "".join(kept_raw_lines).encode("utf-8")
    atomic_write(interactions_path, interactions_bytes)

    print()
    print(f"Backups written: {contacts_backup.name}, {interactions_backup.name}")
    print("Apply complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
