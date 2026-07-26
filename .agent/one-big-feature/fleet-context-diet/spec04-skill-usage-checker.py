#!/usr/bin/env python3
"""
spec04-skill-usage-checker.py — Spec 04 CUT 1 audit
Scans all ~/.claude/projects/*.jsonl (mtime ≤7d) for skill invocations.
Outputs which skills in ~/.claude/skills/ had zero hits over 7 days.

Usage:
  python3 spec04-skill-usage-checker.py             # full scan
  python3 spec04-skill-usage-checker.py --hits       # show all skills WITH hits too

Protected list (never moved even if 0 hits):
  m2c1, goalify, graphify, context-save, context-restore, invoicing, branded-client-pdf,
  test-on-staging, all gws-*, all *-worker, all caveman*, usage-audit, adversarial-review,
  one-big-feature, deep-research, context-budget, last30days
"""

import os
import json
import sys
import re
from pathlib import Path
from datetime import datetime, timedelta

SKILLS_DIR = Path.home() / ".claude" / "skills"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
CUTOFF_DAYS = 7

PROTECTED = {
    "m2c1", "goalify", "graphify", "context-save", "context-restore",
    "invoicing", "branded-client-pdf", "test-on-staging",
    "usage-audit", "adversarial-review", "one-big-feature",
    "deep-research", "context-budget", "last30days",
    # any gws-* and *-worker matched by prefix/suffix below
}

def is_protected(name: str) -> bool:
    if name in PROTECTED:
        return True
    if name.startswith("gws-"):
        return True
    if name.endswith("-worker"):
        return True
    if name.startswith("caveman"):
        return True
    return False


def get_skill_names() -> list[str]:
    names = []
    for entry in SKILLS_DIR.iterdir():
        if entry.name.startswith("."):
            continue
        # Skip .md and .png flat files (cli reference files, etc.)
        if entry.is_file() and entry.suffix in (".md", ".png"):
            continue
        names.append(entry.name)
    return sorted(names)


def get_recent_transcripts(cutoff_days: int) -> list[Path]:
    cutoff = datetime.now().timestamp() - cutoff_days * 86400
    files = []
    for f in PROJECTS_DIR.rglob("*.jsonl"):
        try:
            if f.stat().st_mtime >= cutoff:
                files.append(f)
        except OSError:
            pass
    return files


def scan_transcripts_for_skills(transcripts: list[Path], skill_names: list[str]) -> dict[str, int]:
    """Returns dict of skill_name -> hit_count."""
    hits: dict[str, int] = {name: 0 for name in skill_names}
    name_set = set(skill_names)

    # Patterns to detect a skill being used:
    # 1. Skill tool call: {"type":"tool_use","name":"Skill","input":{"skill":"<name>"}}
    # 2. Slash command: "/name" or "/<name>" in user prompts
    # 3. SKILL.md read: file_path containing /.claude/skills/<name>/
    skill_pattern = re.compile(r'"skill"\s*:\s*"([^"]+)"')
    slash_pattern = re.compile(r'(?:^|[\s\n])/([a-zA-Z0-9_-]+)')
    skill_path_pattern = re.compile(r'\.claude/skills/([^/"]+)/')

    total_files = len(transcripts)
    for i, fpath in enumerate(transcripts):
        if i % 500 == 0:
            print(f"  Scanning {i}/{total_files}...", end="\r", file=sys.stderr)
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            for m in skill_pattern.finditer(content):
                name = m.group(1)
                if name in name_set:
                    hits[name] += 1

            for m in slash_pattern.finditer(content):
                name = m.group(1)
                if name in name_set:
                    hits[name] += 1

            for m in skill_path_pattern.finditer(content):
                name = m.group(1)
                if name in name_set:
                    hits[name] += 1

        except Exception:
            pass

    print(f"  Scanned {total_files} files.        ", file=sys.stderr)
    return hits


def main():
    show_hits = "--hits" in sys.argv

    print(f"Scanning {SKILLS_DIR} for installed skills...", file=sys.stderr)
    skill_names = get_skill_names()
    print(f"Found {len(skill_names)} skills.", file=sys.stderr)

    print(f"\nGathering transcripts (mtime ≤{CUTOFF_DAYS}d)...", file=sys.stderr)
    transcripts = get_recent_transcripts(CUTOFF_DAYS)
    print(f"Found {len(transcripts)} transcript files.", file=sys.stderr)

    print(f"\nScanning transcripts for skill usage...", file=sys.stderr)
    hits = scan_transcripts_for_skills(transcripts, skill_names)

    zero_unprotected = []
    zero_protected = []
    has_hits = []

    for name in skill_names:
        count = hits[name]
        if count == 0:
            if is_protected(name):
                zero_protected.append(name)
            else:
                zero_unprotected.append(name)
        else:
            has_hits.append((name, count))

    print("\n" + "="*60)
    print("SPEC-04 SKILL USAGE AUDIT RESULTS")
    print(f"Window: last {CUTOFF_DAYS} days  |  Transcripts scanned: {len(transcripts)}")
    print("="*60)

    print(f"\n[MOVE CANDIDATES] {len(zero_unprotected)} skills with 0 hits (unprotected):")
    for name in sorted(zero_unprotected):
        print(f"  MOVE  {name}")

    print(f"\n[PROTECTED - ZERO HITS] {len(zero_protected)} protected skills with 0 hits (DO NOT MOVE):")
    for name in sorted(zero_protected):
        print(f"  KEEP* {name}")

    if show_hits:
        print(f"\n[ACTIVE] {len(has_hits)} skills with hits:")
        for name, count in sorted(has_hits, key=lambda x: -x[1]):
            marker = "[PROTECTED]" if is_protected(name) else ""
            print(f"  KEEP  {name}  ({count} hits)  {marker}")

    print(f"\nSummary: {len(zero_unprotected)} to move, {len(zero_protected)} protected zeros, {len(has_hits)} active")

    # Machine-readable output
    result = {
        "scan_date": datetime.now().isoformat(),
        "cutoff_days": CUTOFF_DAYS,
        "transcripts_scanned": len(transcripts),
        "total_skills": len(skill_names),
        "move_candidates": sorted(zero_unprotected),
        "protected_zero_hits": sorted(zero_protected),
        "active_skills": sorted([n for n, _ in has_hits]),
        "hit_counts": {k: v for k, v in hits.items() if v > 0},
    }
    out_path = Path("/tmp/spec04-skill-usage-audit.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nMachine-readable output written to {out_path}")


if __name__ == "__main__":
    main()
