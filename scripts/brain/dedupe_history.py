#!/usr/bin/env python3
"""Remove old-era duplicate History entries from org-brain pages.

Two pipeline eras filed the same meetings: the pre-brain lane wrote History entries
with `(meeting: knowledge/meetings/<name>.md)` paths and NO `[source:]` ref; the
brain lane writes `[source: fireflies:<id>]` entries. 19 meetings across 12 pages
ended up with both (found 2026-09-14 by the roast council's Operator seat — MSIA
was the visible case).

Rule: an OLD entry (no [source:] ref) is a duplicate of a NEW entry (has a ref) on
the same page when the dates match and the titles are >0.75 similar. The NEW entry
is canonical. Any old sub-bullet not near-identical (>0.8) to a new one is carried
into the new entry before the old block is removed — four of the nineteen carried
content the new entry lacked, so a blind delete loses real notes.

Also collapses blank lines BETWEEN consecutive `- CRM org name:` rows (formatting
noise from patch insertions; harmless to the line-based parser, ugly to humans).

  python3 dedupe_history.py --vault <path> [--dry-run]
"""
from __future__ import annotations

import argparse
import difflib
import re
from pathlib import Path

ORG_BRAIN = "raw/areas/clearworks/org-brain"
ENTRY_RE = re.compile(r"^- (20\d\d-\d\d-\d\d) — (.+?)(?: \(meeting:|$)")


def parse_entries(lines: list[str]) -> list[dict]:
    entries = []
    for i, line in enumerate(lines):
        match = ENTRY_RE.match(line.strip())
        if not match:
            continue
        j = i + 1
        while j < len(lines) and (lines[j].startswith("  ") or lines[j].strip() == ""):
            if lines[j].strip() == "" and j + 1 < len(lines) and not lines[j + 1].startswith("  "):
                break
            j += 1
        entries.append({
            "start": i, "end": j,
            "date": match.group(1),
            "title": match.group(2).strip().lower(),
            "has_ref": "[source:" in line,
            "bullets": [lines[k].strip() for k in range(i + 1, j) if lines[k].strip().startswith("-")],
        })
    return entries


def dedupe_page(text: str) -> tuple[str, int, int]:
    """Returns (new_text, entries_removed, bullets_carried)."""
    lines = text.splitlines()
    entries = parse_entries(lines)
    to_remove: list[dict] = []
    carries: dict[int, list[str]] = {}

    for old in entries:
        if old["has_ref"]:
            continue
        for new in entries:
            if not new["has_ref"] or new["date"] != old["date"]:
                continue
            if difflib.SequenceMatcher(None, old["title"], new["title"]).ratio() <= 0.75:
                continue
            unique = [
                b for b in old["bullets"]
                if all(difflib.SequenceMatcher(None, b.lower(), nb.lower()).ratio() < 0.8
                       for nb in new["bullets"])
            ]
            if unique:
                carries.setdefault(new["end"], []).extend(
                    f"  - (carried from earlier filing) {b.lstrip('- ')}" for b in unique
                )
            to_remove.append(old)
            break

    if not to_remove:
        new_lines = lines
    else:
        drop = set()
        for entry in to_remove:
            drop.update(range(entry["start"], entry["end"]))
        new_lines = []
        for i, line in enumerate(lines):
            if i in carries:
                new_lines.extend(carries[i])
            if i not in drop:
                new_lines.append(line)
        # a carry targeting end-of-file
        for i in sorted(carries):
            if i >= len(lines):
                new_lines.extend(carries[i])

    text2 = "\n".join(new_lines) + ("\n" if text.endswith("\n") else "")
    # collapse blank lines between consecutive CRM name rows
    before = None
    while before != text2:
        before = text2
        text2 = re.sub(r"(- CRM org name: [^\n]+)\n\n+(- CRM org name:)", r"\1\n\2", text2)
    carried_total = sum(len(v) for v in carries.values())
    return text2, len(to_remove), carried_total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    brain = Path(args.vault) / ORG_BRAIN

    total_removed = total_carried = pages_touched = 0
    for folder in ("clients", "orgs"):
        for page in sorted((brain / folder).glob("*.md")):
            if page.stem.startswith("_"):
                continue
            text = page.read_text(encoding="utf-8")
            new_text, removed, carried = dedupe_page(text)
            if new_text != text:
                pages_touched += 1
                total_removed += removed
                total_carried += carried
                print(f"{folder}/{page.name}: -{removed} old-era entries, +{carried} carried bullets"
                      + (", formatting" if removed == 0 else ""))
                if not args.dry_run:
                    page.write_text(new_text, encoding="utf-8")
    print(f"\npages touched: {pages_touched} · entries removed: {total_removed} · bullets carried: {total_carried}"
          + (" (DRY RUN)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
