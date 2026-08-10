#!/usr/bin/env python3
"""
P1.2 mirror tool — bulk mirror of agent deliverables/ into knowledge-sync.

Three subcommands:
- plan: walk deliverables roots, apply dirmap.json rules, emit manifest
- mirror: dry-run by default, --execute to write with provenance
- verify: check manifest vs live state and per-pair diffs

Stdlib-only Python 3. Reuses P1.0 CONTENT_TYPE_MAPPING from file_output.py.
"""

import argparse
import filecmp
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

# Import from P1.0 file_output.py
try:
    from file_output import CONTENT_TYPE_MAPPING
except ImportError:
    # Fallback if running standalone without file_output.py in same dir
    KNOWLEDGE_SYNC_BASE = os.path.expanduser("~/code/knowledge-sync/")
    CONTENT_TYPE_MAPPING = {
        "client": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/areas/clearworks/"),
        "people": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/people/"),
        "org": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/organizations/"),
        "sop": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/resources/reference/clearworks/"),
        "diagram": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/areas/clearworks/diagrams/"),
        "session": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/sessions/"),
        "media": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/media/"),
    }

# Hardcode mmrag SUPPORTED_EXTS from knowledge-base/scripts/mmrag.py:60-67
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
DOC_EXTS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"}
TEXT_EXTS = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".py",
    ".js",
    ".ts",
    ".go",
    ".rs",
    ".java",
    ".cpp",
    ".c",
    ".sh",
    ".yaml",
    ".yml",
    ".toml",
    ".html",
    ".css",
    ".sql",
    ".rb",
    ".swift",
    ".kt",
    ".r",
    ".lua",
}
SUPPORTED_EXTS = VIDEO_EXTS | AUDIO_EXTS | IMAGE_EXTS | DOC_EXTS | TEXT_EXTS

# Resolve repo root from __file__ (…/orgs/clearworksai/skills/outputs-router/ → 4 dirs up:
# outputs-router -> skills -> clearworksai -> orgs -> repo root)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
# Agent deliverables are gitignored local state (`orgs/clearworksai/*`), so a git
# worktree checkout does NOT contain them. MIRROR_AGENTS_DIR lets the planner point
# at the live checkout's agents dir while the script itself runs from a worktree.
AGENTS_DIR = os.environ.get(
    "MIRROR_AGENTS_DIR", os.path.join(REPO_ROOT, "orgs/clearworksai/agents")
)


def discover_deliverables_roots():
    """
    Discover every agent that has a `deliverables/` dir under AGENTS_DIR.

    P1.2 originally hardcoded 5 legacy agents (auditmaster/muse/larry/pa/frank2),
    which silently skipped the RUNNING `-codex` set (auditmaster-codex holds ~831
    files) and any future agent. The `-codex` deliverables mirror their legacy
    counterparts' subtree layout, so the same dirmap rules apply once the
    `<agent>-codex/` prefix rules are present in dirmap.json. Auto-discovery keeps
    the roots in sync with the actual fleet: any `<agent>/deliverables/` is scanned.
    """
    roots = {}
    if not os.path.isdir(AGENTS_DIR):
        return roots
    for agent in sorted(os.listdir(AGENTS_DIR)):
        d = os.path.join(AGENTS_DIR, agent, "deliverables")
        if os.path.isdir(d):
            roots[agent] = d
    return roots


DELIVERABLES_ROOTS = discover_deliverables_roots()
MIRROR_JOB = "deliverables-mirror-p1.2"

# Support env override for tmp-dir test fixtures
MIRROR_KS_BASE = os.environ.get("MIRROR_KS_BASE", os.path.expanduser("~/code/knowledge-sync/"))


def load_dirmap(dirmap_path="dirmap.json"):
    """Load dirmap.json with rules and exclusions."""
    with open(dirmap_path, "r") as f:
        return json.load(f)


def compute_target_path(source_path, agent, rule, dirmap, source_root):
    """
    Compute target path based on rule type and source relpath.

    Returns absolute target path or None for excluded files.
    """
    relpath = os.path.relpath(source_path, source_root)
    source_basename = os.path.basename(source_path)

    # Check exclusions
    for part in dirmap["exclude"]["dir_parts"]:
        if part in source_path.split(os.sep):
            return None
    for glob in dirmap["exclude"]["name_globs"]:
        if source_basename.endswith(glob.replace("*", "")):
            return None

    # Check top_level_only for diagrams
    if rule.get("top_level_only"):
        parent_dir = os.path.dirname(source_path)
        if os.path.abspath(parent_dir) != os.path.abspath(source_root):
            return None

    # Compute target based on content type
    if rule["type"] == "client":
        client_home = dirmap["client_home"]
        target_dir = os.path.join(MIRROR_KS_BASE, client_home, rule["client"])
        target_path = os.path.join(target_dir, relpath)
    elif rule["type"] == "diagram":
        # Special case: frank2 + auditmaster top-level diagrams go to basename only.
        # Match the base agent name so the `-codex` variants route identically to
        # their legacy counterparts.
        base_agent = agent[: -len("-codex")] if agent.endswith("-codex") else agent
        if base_agent in ("frank2", "auditmaster") and rule.get("top_level_only"):
            base_dest = CONTENT_TYPE_MAPPING["diagram"]
            target_path = os.path.join(base_dest, source_basename)
        else:
            base_dest = CONTENT_TYPE_MAPPING["diagram"]
            target_path = os.path.join(base_dest, "deliverables-mirror", agent, relpath)
    else:
        base_dest = CONTENT_TYPE_MAPPING[rule["type"]]
        target_path = os.path.join(base_dest, "deliverables-mirror", agent, relpath)

    return os.path.abspath(target_path)


def find_matching_rule(relpath, dirmap):
    """
    Find first matching rule for a given relpath (agent/relpath).

    Returns rule dict or None if no match.
    """
    for rule in dirmap["rules"]:
        prefix = rule["prefix"]
        if relpath.startswith(prefix):
            # Check top_level_only if specified
            if rule.get("top_level_only"):
                # relpath depth must be exactly 2 (agent/file.ext)
                parts = relpath.split(os.sep)
                if len(parts) != 2:
                    continue
            # Honor an optional ext_in allow-list: a rule restricted to certain
            # extensions (e.g. a diagram rule for .png/.svg) must not swallow files
            # of other extensions and starve a later fallback rule (e.g. sop) that
            # shares the same prefix. Case-insensitive on the file side; dirmap
            # values are already lowercase dotted extensions.
            ext_in = rule.get("ext_in")
            if ext_in is not None:
                ext = os.path.splitext(relpath)[1].lower()
                if ext not in ext_in:
                    continue  # keep scanning; later rules may match
            return rule
    return None


def compute_sha256(filepath):
    """Compute SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def merge_frontmatter(file_path, args):
    """
    Merge provenance frontmatter into .md/.txt files.

    - If file starts with ---\n…\n---\n, parse and add keys only if absent.
    - If no frontmatter, prepend new block.
    - Returns merged bytes.
    """
    with open(file_path, "rb") as f:
        original_bytes = f.read()

    original_text = original_bytes.decode("utf-8")
    frontmatter_start = "---\n"
    frontmatter_end = "\n---\n"

    new_frontmatter_lines = [
        "---",
        f"agent: {args.agent}",
        f"job: {args.job}",
        f"source-task: {args.source_task}",
        f"date: {args.date}",
        f"mirror-of: {args.source_path}",
        "---",
    ]

    if original_text.startswith(frontmatter_start):
        # Existing frontmatter - parse and merge
        parts = original_text.split(frontmatter_end, 1)
        if len(parts) == 2:
            block_part, body_part = parts
            block_lines = block_part.split("\n")

            # Parse existing keys
            existing_keys = set()
            for line in block_lines:
                if ":" in line and not line.strip().startswith("#"):
                    key = line.split(":")[0].strip()
                    existing_keys.add(key)

            # Add new keys only if absent
            final_block_lines = []
            for line in block_lines:
                final_block_lines.append(line)

            for new_line in new_frontmatter_lines[1:-1]:  # Skip --- markers
                key = new_line.split(":")[0].strip()
                if key not in existing_keys:
                    final_block_lines.append(new_line)

            merged_text = "\n".join(final_block_lines) + frontmatter_end + body_part
            return merged_text.encode("utf-8")

    # No frontmatter - prepend
    new_block = "\n".join(new_frontmatter_lines) + "\n"
    return (new_block + original_text).encode("utf-8")


def create_provenance_sidecar(file_path, args):
    """
    Create .provenance.md sidecar for binary files.
    Reuses P1.0 format + mirror-of line.
    """
    provenance_path = f"{file_path}.provenance.md"
    frontmatter = f"""---
agent: {args.agent}
job: {args.job}
source-task: {args.source_task}
date: {args.date}
mirror-of: {args.source_path}
---
"""
    with open(provenance_path, "w") as f:
        f.write(frontmatter)


def strip_provenance_frontmatter(file_bytes, job_name):
    """
    Strip injected provenance keys for diff verification.

    - If job == MIRROR_JOB, strip exactly the 5 injected keys.
    - If source had no frontmatter, strip the entire prepended block.
    - Returns stripped bytes.
    """
    text = file_bytes.decode("utf-8")
    frontmatter_start = "---\n"
    frontmatter_end = "\n---\n"

    if not text.startswith(frontmatter_start):
        return file_bytes  # No frontmatter to strip

    parts = text.split(frontmatter_end, 1)
    if len(parts) != 2:
        return file_bytes  # Malformed, return as-is

    block_part, body_part = parts
    block_lines = block_part.split("\n")

    # Check if this looks like our injected block
    injected_keys = {"agent", "job", "source-task", "date", "mirror-of"}
    has_injected_keys = any(
        any(line.strip().startswith(f"{key}:") for line in block_lines)
        for key in injected_keys
    )

    if not has_injected_keys:
        return file_bytes  # Not our block, return as-is

    # Strip only injected keys
    filtered_lines = []
    for line in block_lines:
        is_injected = False
        for key in injected_keys:
            if line.strip().startswith(f"{key}:"):
                is_injected = True
                break
        if not is_injected:
            filtered_lines.append(line)

    if not filtered_lines or all(l.strip() in ("---", "") for l in filtered_lines):
        # All lines were injected - entire block was ours
        return body_part.encode("utf-8")

    # Some pre-existing content remains
    filtered_block = "\n".join(filtered_lines)
    return (filtered_block + frontmatter_end + body_part).encode("utf-8")


def plan_subcommand(args):
    """Walk deliverables roots, apply dirmap, emit manifest."""
    dirmap = load_dirmap(args.dirmap)

    manifest = []
    unmapped_paths = []

    for agent, root in DELIVERABLES_ROOTS.items():
        if not os.path.exists(root):
            continue

        for source_root, dirs, files in os.walk(root):
            for filename in files:
                source_path = os.path.join(source_root, filename)

                relpath = os.path.relpath(source_path, root)
                full_key = f"{agent}/{relpath}"

                # Find matching rule
                rule = find_matching_rule(full_key, dirmap)
                if not rule:
                    unmapped_paths.append(full_key)
                    continue

                # Check exclusions — both dir_parts AND name_globs, mirroring the
                # checks compute_target_path() applies (else a name_glob match returns
                # target=None but was still recorded status="planned", which crashes
                # mirror_subcommand on os.path.exists(None)).
                source_basename = os.path.basename(source_path)
                exclusion_reason = None
                for part in dirmap["exclude"]["dir_parts"]:
                    if part in source_path.split(os.sep):
                        exclusion_reason = f"dir_part: {part}"
                        break
                if exclusion_reason is None:
                    for glob in dirmap["exclude"]["name_globs"]:
                        if source_basename.endswith(glob.replace("*", "")):
                            exclusion_reason = f"name_glob: {glob}"
                            break

                if exclusion_reason is not None:
                    manifest.append(
                        {
                            "source": source_path,
                            "target": None,
                            "agent": agent,
                            "content_type": None,
                            "client": None,
                            "status": "excluded",
                            "reason": exclusion_reason,
                            "sha256": compute_sha256(source_path),
                            "supported_ext": os.path.splitext(source_path)[1].lower() in SUPPORTED_EXTS,
                            "planned_at": datetime.now().isoformat(),
                            "mirrored_at": None,
                        }
                    )
                else:
                    # No exclusion triggered
                    target_path = compute_target_path(source_path, agent, rule, dirmap, root)
                    file_ext = os.path.splitext(source_path)[1].lower()

                    manifest.append(
                        {
                            "source": source_path,
                            "target": target_path,
                            "agent": agent,
                            "content_type": rule["type"],
                            "client": rule.get("client"),
                            "status": "planned",
                            "reason": None,
                            "sha256": compute_sha256(source_path),
                            "supported_ext": file_ext in SUPPORTED_EXTS,
                            "planned_at": datetime.now().isoformat(),
                            "mirrored_at": None,
                        }
                    )

    # Fail loudly on unmapped paths
    if unmapped_paths:
        print(f"Error: {len(unmapped_paths)} unmapped paths:", file=sys.stderr)
        for path in unmapped_paths[:20]:
            print(f"  {path}", file=sys.stderr)
        if len(unmapped_paths) > 20:
            print(f"  ... and {len(unmapped_paths) - 20} more", file=sys.stderr)
        sys.exit(1)

    # Write manifest
    with open(args.out, "w") as f:
        for row in manifest:
            f.write(json.dumps(row) + "\n")

    status_counts = {"planned": 0, "excluded": 0}
    for row in manifest:
        status_counts[row["status"]] = status_counts.get(row["status"], 0) + 1

    print(f"plan complete: {json.dumps(status_counts)}")
    return 0


def mirror_subcommand(args):
    """Mirror files per manifest, dry-run by default."""
    # Load existing manifest
    manifest = []
    with open(args.manifest, "r") as f:
        for line in f:
            if line.strip():
                manifest.append(json.loads(line))

    # Build args for provenance
    provenance_args = SimpleNamespace(
        agent="codexer",
        job=MIRROR_JOB,
        source_task=args.source_task,
        date=datetime.now().strftime("%Y-%m-%d"),
    )

    status_counts = {}
    planned_writes = []

    for row in manifest:
        if row["status"] in ("excluded", "skipped-identical", "conflict"):
            status_counts[row["status"]] = status_counts.get(row["status"], 0) + 1
            continue

        source_path = row["source"]
        target_path = row["target"]

        # Check if target exists
        if os.path.exists(target_path):
            source_sha = row["sha256"]
            file_ext = os.path.splitext(target_path)[1].lower()

            if file_ext in (".md", ".txt"):
                # Compare after stripping provenance
                with open(target_path, "rb") as f:
                    target_bytes = f.read()
                stripped_target = strip_provenance_frontmatter(target_bytes, MIRROR_JOB)
                with open(source_path, "rb") as f:
                    source_bytes = f.read()
                target_sha = hashlib.sha256(stripped_target).hexdigest()
            else:
                # For binaries, just compare the file directly
                target_sha = compute_sha256(target_path)

            if source_sha == target_sha:
                row["status"] = "skipped-identical"
                row["mirrored_at"] = datetime.now().isoformat()
                status_counts["skipped-identical"] = status_counts.get("skipped-identical", 0) + 1
                continue
            else:
                row["status"] = "conflict"
                row["reason"] = "target exists with different content"
                row["mirrored_at"] = None
                status_counts["conflict"] = status_counts.get("conflict", 0) + 1
                continue

        # Dry-run or execute
        if not args.execute:
            status_counts["planned"] = status_counts.get("planned", 0) + 1
            planned_writes.append(source_path)
            if len(planned_writes) <= 20:
                row["status"] = "planned"
            continue

        # Execute copy
        dest_dir = os.path.dirname(target_path)
        os.makedirs(dest_dir, exist_ok=True)
        shutil.copy2(source_path, target_path)

        # Add provenance
        provenance_args.source_path = source_path.replace(os.path.expanduser("~"), "~")
        file_ext = os.path.splitext(target_path)[1].lower()
        if file_ext in (".md", ".txt"):
            merged_bytes = merge_frontmatter(target_path, provenance_args)
            with open(target_path, "wb") as f:
                f.write(merged_bytes)
        else:
            create_provenance_sidecar(target_path, provenance_args)

        row["status"] = "mirrored"
        row["mirrored_at"] = datetime.now().isoformat()
        status_counts["mirrored"] = status_counts.get("mirrored", 0) + 1

    # Write updated manifest atomically
    if args.execute:
        tmp_manifest = f"{args.manifest}.tmp"
        with open(tmp_manifest, "w") as f:
            for row in manifest:
                f.write(json.dumps(row) + "\n")
        os.rename(tmp_manifest, args.manifest)

    if not args.execute:
        print(f"mirror dry-run: {json.dumps(status_counts)}")
        print(f"Planned writes (first 20 of {len(planned_writes)}):")
        for path in planned_writes[:20]:
            print(f"  {path}")
        if len(planned_writes) > 20:
            print(f"  ... and {len(planned_writes) - 20} more")
    else:
        print(f"mirror execute: {json.dumps(status_counts)}")

    return 0


def verify_subcommand(args):
    """Verify manifest vs live state."""
    # Load manifest
    manifest = []
    with open(args.manifest, "r") as f:
        for line in f:
            if line.strip():
                manifest.append(json.loads(line))

    # Count: manifest row count >= live file count
    live_count = 0
    for root in DELIVERABLES_ROOTS.values():
        if os.path.exists(root):
            for _, dirs, files in os.walk(root):
                # Skip excluded dirs
                dirs[:] = [d for d in dirs if d not in ["__pycache__", ".git"]]
                for filename in files:
                    # Skip excluded files
                    for glob in ["*.pyc", "*.bak*", ".gitignore", ".DS_Store"]:
                        if filename.endswith(glob.replace("*", "")):
                            break
                    else:
                        live_count += 1

    manifest_count = len(manifest)
    if manifest_count < live_count:
        print(f"FAIL: manifest count ({manifest_count}) < live count ({live_count})", file=sys.stderr)
        return 1

    # Per-pair diffs
    failing_rows = []
    for row in manifest:
        if row["status"] not in ("mirrored", "skipped-identical"):
            if row["status"] in ("conflict", "planned"):
                failing_rows.append((row, "status not mirrored/skipped-identical"))
            continue

        source_path = row["source"]
        target_path = row["target"]

        if not os.path.exists(target_path):
            failing_rows.append((row, "target missing"))
            continue

        file_ext = os.path.splitext(target_path)[1].lower()
        if file_ext in (".md", ".txt"):
            # Compare after stripping provenance
            with open(target_path, "rb") as f:
                target_bytes = f.read()
            stripped_target = strip_provenance_frontmatter(target_bytes, MIRROR_JOB)
            with open(source_path, "rb") as f:
                source_bytes = f.read()

            if stripped_target != source_bytes:
                failing_rows.append((row, "provenance-stripped diff non-empty"))
        else:
            # For binaries, compare directly and check sidecar
            if not filecmp.cmp(source_path, target_path, shallow=False):
                failing_rows.append((row, "binary diff non-empty"))

            sidecar_path = f"{target_path}.provenance.md"
            if not os.path.exists(sidecar_path):
                failing_rows.append((row, "sidecar missing"))

    # Check for conflicts
    for row in manifest:
        if row["status"] == "conflict":
            failing_rows.append((row, "conflict status"))

    if failing_rows:
        print(f"FAIL: {len(failing_rows)} failing rows:", file=sys.stderr)
        for row, reason in failing_rows[:20]:
            print(f"  {row['source']}: {reason}", file=sys.stderr)
        if len(failing_rows) > 20:
            print(f"  ... and {len(failing_rows) - 20} more", file=sys.stderr)
        return 1

    print(f"verify GREEN: {manifest_count} rows, {live_count} live files")
    return 0


def main():
    parser = argparse.ArgumentParser(description="P1.2 deliverables mirror tool")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # plan subcommand
    plan_parser = subparsers.add_parser("plan", help="Generate mirror manifest")
    plan_parser.add_argument("--dirmap", default="dirmap.json", help="Path to dirmap.json")
    plan_parser.add_argument("--out", default="manifests/p1-2-mirror-manifest.jsonl", help="Output manifest path")

    # mirror subcommand
    mirror_parser = subparsers.add_parser("mirror", help="Mirror files per manifest")
    mirror_parser.add_argument("--manifest", required=True, help="Path to manifest file")
    mirror_parser.add_argument("--execute", action="store_true", help="Actually write files (default: dry-run)")
    mirror_parser.add_argument("--source-task", help="Bus task ID for provenance")

    # verify subcommand
    verify_parser = subparsers.add_parser("verify", help="Verify manifest vs live state")
    verify_parser.add_argument("--manifest", required=True, help="Path to manifest file")

    args = parser.parse_args()

    if args.subcommand == "plan":
        return plan_subcommand(args)
    elif args.subcommand == "mirror":
        return mirror_subcommand(args)
    elif args.subcommand == "verify":
        return verify_subcommand(args)


if __name__ == "__main__":
    sys.exit(main())