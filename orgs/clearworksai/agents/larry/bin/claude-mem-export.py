#!/usr/bin/env python3
"""
claude-mem-export.py — Export new observations/session_summaries from claude-mem to markdown

Usage:
    python3 claude-mem-export.py --db <path> --out-root <path> --state <path> --ledger <path> [--source-task <id>] [--dry-run]

Exit codes:
    0 = green
    1 = red (any failure)
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args():
    parser = argparse.ArgumentParser(description="Export claude-mem observations/summaries to markdown")
    parser.add_argument("--db", required=True, help="Path to claude-mem.db")
    parser.add_argument("--out-root", required=True, help="Output directory root")
    parser.add_argument("--state", required=True, help="State file path")
    parser.add_argument("--ledger", required=True, help="Ledger file path")
    parser.add_argument("--source-task", default="cron:claude-mem-export", help="Source task ID")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode (no writes)")
    return parser.parse_args()


def open_db_readonly(db_path: str) -> sqlite3.Connection:
    """Open database in read-only mode with busy timeout."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        return conn
    except Exception as e:
        raise RuntimeError(f"Failed to open database: {e}")


def load_state(state_path: Path) -> Optional[Dict[str, Any]]:
    """Load state from file, return None if missing/unparseable."""
    if not state_path.exists():
        return None
    try:
        with open(state_path) as f:
            return json.load(f)
    except Exception:
        return None


def save_state(state_path: Path, state: Dict[str, Any], dry_run: bool) -> None:
    """Save state atomically."""
    if dry_run:
        return
    
    tmp_path = state_path.with_suffix(".tmp")
    with open(tmp_path, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp_path, state_path)


def append_ledger(ledger_path: Path, row: Dict[str, Any], dry_run: bool) -> None:
    """Append row to ledger file."""
    if dry_run:
        return
    
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ledger_path, "a") as f:
        f.write(json.dumps(row) + "\n")


def get_max_id(conn: sqlite3.Connection, table: str) -> int:
    """Get MAX(id) from table, return 0 if empty."""
    cursor = conn.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}")
    return cursor.fetchone()[0]


def query_new_rows(conn: sqlite3.Connection, table: str, last_id: int) -> List[sqlite3.Row]:
    """Query rows with id > last_id, ordered by id ASC."""
    if table == "observations":
        query = """
            SELECT id, memory_session_id, project, type, title, subtitle, text, facts,
                   narrative, concepts, files_modified, created_at
            FROM observations
            WHERE id > ?
            ORDER BY id ASC
        """
    else:  # session_summaries
        query = """
            SELECT id, memory_session_id, project, request, investigated, learned,
                   completed, next_steps, files_edited, notes, created_at
            FROM session_summaries
            WHERE id > ?
            ORDER BY id ASC
        """
    
    cursor = conn.execute(query, (last_id,))
    return cursor.fetchall()


def parse_json_array(value: Optional[str]) -> List[str]:
    """Parse JSON array, return empty list on failure."""
    if not value:
        return []
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return parsed
        return []
    except Exception:
        return []


def render_observation_row(row: sqlite3.Row) -> str:
    """Render a single observation row as markdown."""
    lines = []
    
    # Section header
    title = row["title"] or f"observation {row['id']}"
    type_label = row["type"] or "unknown"
    lines.append(f"## [{type_label}] {title}")
    
    # Meta line
    session_short = row["memory_session_id"][:8] if row["memory_session_id"] else "unknown"
    created_at = row["created_at"] or "unknown"
    lines.append(f"- id: {row['id']} · project: {row['project']} · session: {session_short} · {created_at}")
    
    # Subtitle if present
    if row["subtitle"]:
        lines.append(f"- {row['subtitle']}")
    
    # Facts as bullets
    facts = parse_json_array(row["facts"])
    if facts:
        lines.append("")
        lines.append("Facts:")
        for fact in facts:
            lines.append(f"- {fact}")
    
    # Concepts as comma line
    concepts = parse_json_array(row["concepts"])
    if concepts:
        lines.append("")
        lines.append(f"Concepts: {', '.join(concepts)}")
    
    # Files modified
    files = parse_json_array(row["files_modified"])
    if files:
        lines.append("")
        lines.append(f"Files modified: {', '.join(files)}")
    else:
        lines.append("")
        lines.append("Files modified: (none)")
    
    # Narrative if present
    if row["narrative"]:
        lines.append("")
        lines.append(row["narrative"])
    
    # Text if present
    if row["text"]:
        lines.append("")
        lines.append(row["text"])
    
    return "\n".join(lines)


def render_summary_row(row: sqlite3.Row) -> str:
    """Render a single summary row as markdown."""
    lines = []
    
    # Section header
    request = row["request"] or f"session {row['id']}"
    request_short = request[:100] if len(request) > 100 else request
    lines.append(f"## {row['project']} — {request_short}")
    
    # Meta line
    session_short = row["memory_session_id"][:8] if row["memory_session_id"] else "unknown"
    created_at = row["created_at"] or "unknown"
    lines.append(f"- id: {row['id']} · project: {row['project']} · session: {session_short} · {created_at}")
    
    lines.append("")
    
    # Request
    if row["request"]:
        lines.append(f"Request: {row['request']}")
    
    # Investigated
    if row["investigated"]:
        lines.append(f"Investigated: {row['investigated']}")
    
    # Learned
    if row["learned"]:
        lines.append(f"Learned: {row['learned']}")
    
    # Completed
    if row["completed"]:
        lines.append(f"Completed: {row['completed']}")
    
    # Next steps
    if row["next_steps"]:
        lines.append(f"Next steps: {row['next_steps']}")
    
    # Notes
    if row["notes"]:
        lines.append(f"Notes: {row['notes']}")
    
    # Files edited
    files = parse_json_array(row["files_edited"])
    if files:
        lines.append(f"Files edited: {', '.join(files)}")
    else:
        lines.append("Files edited: (none)")
    
    return "\n".join(lines)


def render_observations_batch(rows: List[sqlite3.Row], run_date: str, source_task: str, db_path: str) -> str:
    """Render complete observations batch file."""
    if not rows:
        return ""
    
    from_id = rows[0]["id"]
    to_id = rows[-1]["id"]
    
    lines = [
        "---",
        f"agent: larry",
        f"job: claude-mem-export",
        f"date: {run_date}",
        f"source-task: {source_task}",
        f"source-db: {db_path}",
        f"source-table: observations",
        f"id-range: {from_id}-{to_id}",
        "---",
        "",
        f"# Claude session observations {run_date} (ids {from_id}-{to_id})",
        "",
        f"Auto-exported from claude-mem (forward-only). History before id {from_id-1}: query",
        f"claude-mem FTS directly, do not re-export.",
        "",
    ]
    
    for row in rows:
        lines.append(render_observation_row(row))
        lines.append("")
    
    return "\n".join(lines)


def render_summaries_batch(rows: List[sqlite3.Row], run_date: str, source_task: str, db_path: str) -> str:
    """Render complete summaries batch file."""
    if not rows:
        return ""
    
    from_id = rows[0]["id"]
    to_id = rows[-1]["id"]
    
    lines = [
        "---",
        f"agent: larry",
        f"job: claude-mem-export",
        f"date: {run_date}",
        f"source-task: {source_task}",
        f"source-db: {db_path}",
        f"source-table: session_summaries",
        f"id-range: {from_id}-{to_id}",
        "---",
        "",
        f"# Claude session summaries {run_date} (ids {from_id}-{to_id})",
        "",
        f"Auto-exported from claude-mem (forward-only). History before id {from_id-1}: query",
        f"claude-mem FTS directly, do not re-export.",
        "",
    ]
    
    for row in rows:
        lines.append(render_summary_row(row))
        lines.append("")
    
    return "\n".join(lines)


def write_batch_file(content: str, target_path: Path, dry_run: bool) -> Optional[Path]:
    """Write batch file atomically, avoid overwriting existing. Returns actual path written."""
    if not content:
        return None
    
    target_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Check if file exists, add suffix if needed
    final_path = target_path
    counter = 2
    while final_path.exists():
        stem = target_path.stem
        suffix = target_path.suffix
        final_path = target_path.parent / f"{stem}-r{counter}{suffix}"
        counter += 1
    
    if dry_run:
        print(f"Would write: {final_path} ({len(content)} bytes)")
        return final_path
    
    tmp_path = final_path.with_suffix(".tmp")
    with open(tmp_path, "w") as f:
        f.write(content)
    os.replace(tmp_path, final_path)
    return final_path


def main():
    args = parse_args()
    
    db_path = Path(args.db)
    out_root = Path(args.out_root)
    state_path = Path(args.state)
    ledger_path = Path(args.ledger)
    run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ts = datetime.now(timezone.utc).isoformat()
    
    try:
        # Open database read-only
        conn = open_db_readonly(str(db_path))
    except Exception as e:
        # Red ledger row on DB failure
        row = {
            "ts": ts,
            "run": "claude-mem-export",
            "source-task": args.source_task,
            "green": False,
            "error": str(e),
        }
        append_ledger(ledger_path, row, args.dry_run)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    
    try:
        # Load state
        state = load_state(state_path)
        
        # Seed mode if state missing/unparseable
        if state is None:
            obs_max = get_max_id(conn, "observations")
            sum_max = get_max_id(conn, "session_summaries")
            
            new_state = {
                "observations_last_id": obs_max,
                "session_summaries_last_id": sum_max,
                "last_run": ts,
            }
            
            if not args.dry_run:
                save_state(state_path, new_state, args.dry_run)
            
            row = {
                "ts": ts,
                "run": "claude-mem-export",
                "source-task": args.source_task,
                "seeded": True,
                "observations": {"from": obs_max, "to": obs_max, "count": 0},
                "summaries": {"from": sum_max, "to": sum_max, "count": 0},
                "files": [],
                "green": True,
            }
            append_ledger(ledger_path, row, args.dry_run)
            sys.exit(0)
        
        # Query new rows
        obs_last_id = state.get("observations_last_id", 0)
        sum_last_id = state.get("session_summaries_last_id", 0)
        
        obs_rows = query_new_rows(conn, "observations", obs_last_id)
        sum_rows = query_new_rows(conn, "session_summaries", sum_last_id)
        
        # No-op if both empty
        if not obs_rows and not sum_rows:
            row = {
                "ts": ts,
                "run": "claude-mem-export",
                "source-task": args.source_task,
                "observations": {"from": obs_last_id, "to": obs_last_id, "count": 0},
                "summaries": {"from": sum_last_id, "to": sum_last_id, "count": 0},
                "files": [],
                "green": True,
            }
            append_ledger(ledger_path, row, args.dry_run)
            sys.exit(0)
        
        # Render and write batch files
        files_written = []
        
        if obs_rows:
            obs_content = render_observations_batch(obs_rows, run_date, args.source_task, str(db_path))
            obs_from = obs_rows[0]["id"]
            obs_to = obs_rows[-1]["id"]
            obs_path = out_root / "observations" / f"{run_date}-obs-{obs_from}-{obs_to}.md"
            actual_obs_path = write_batch_file(obs_content, obs_path, args.dry_run)
            if actual_obs_path:
                files_written.append(str(actual_obs_path))
        
        if sum_rows:
            sum_content = render_summaries_batch(sum_rows, run_date, args.source_task, str(db_path))
            sum_from = sum_rows[0]["id"]
            sum_to = sum_rows[-1]["id"]
            sum_path = out_root / "summaries" / f"{run_date}-sum-{sum_from}-{sum_to}.md"
            actual_sum_path = write_batch_file(sum_content, sum_path, args.dry_run)
            if actual_sum_path:
                files_written.append(str(actual_sum_path))
        
        # Advance state only after all files written
        new_state = {
            "observations_last_id": obs_rows[-1]["id"] if obs_rows else obs_last_id,
            "session_summaries_last_id": sum_rows[-1]["id"] if sum_rows else sum_last_id,
            "last_run": ts,
        }
        
        if not args.dry_run:
            save_state(state_path, new_state, args.dry_run)
        
        # Append ledger row
        obs_info = {
            "from": obs_rows[0]["id"] if obs_rows else obs_last_id,
            "to": obs_rows[-1]["id"] if obs_rows else obs_last_id,
            "count": len(obs_rows),
        }
        sum_info = {
            "from": sum_rows[0]["id"] if sum_rows else sum_last_id,
            "to": sum_rows[-1]["id"] if sum_rows else sum_last_id,
            "count": len(sum_rows),
        }
        
        row = {
            "ts": ts,
            "run": "claude-mem-export",
            "source-task": args.source_task,
            "observations": obs_info,
            "summaries": sum_info,
            "files": files_written,
            "green": True,
        }
        append_ledger(ledger_path, row, args.dry_run)
        
        sys.exit(0)
        
    except Exception as e:
        # Red ledger row on any failure
        row = {
            "ts": ts,
            "run": "claude-mem-export",
            "source-task": args.source_task,
            "green": False,
            "error": str(e),
        }
        append_ledger(ledger_path, row, args.dry_run)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()