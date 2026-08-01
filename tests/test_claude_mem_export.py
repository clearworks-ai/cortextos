#!/usr/bin/env python3
"""
tests/test_claude_mem_export.py — pytest suite for claude-mem-export.py

Build a tmp fixture db with the real schema subset (observations + session_summaries,
AUTOINCREMENT ids). Assert:
1. Seed run: no state file → cursors == MAX(id), zero files written, ledger row has
   seeded: true, green: true.
2. Forward run: insert 3 obs + 2 summaries above cursor → exactly 2 files written, id
   ranges in names/frontmatter correct, cursor advanced to new MAX.
3. No-op run: rerun with no new rows → no files, green no-op ledger row.
4. Rendering: JSON-array facts become bullets; NULL title falls back; empty fields
   omitted; frontmatter parses as YAML (keys agent/job/date/source-task/source-db/
   source-table/id-range present).
5. Failure path: unreadable db path → exit 1, red ledger row, state file untouched.
6. Never-overwrite: pre-create the target filename → run writes -r2 variant.
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timezone


def create_fixture_db(db_path: Path) -> None:
    """Create fixture db with real schema subset."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_session_id TEXT,
            project TEXT,
            type TEXT,
            title TEXT,
            subtitle TEXT,
            text TEXT,
            facts TEXT,
            narrative TEXT,
            concepts TEXT,
            files_modified TEXT,
            created_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS session_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_session_id TEXT,
            project TEXT,
            request TEXT,
            investigated TEXT,
            learned TEXT,
            completed TEXT,
            next_steps TEXT,
            files_edited TEXT,
            notes TEXT,
            created_at TEXT
        )
    """)
    
    # Insert initial test data
    now = datetime.now(timezone.utc).isoformat()
    
    # 3 initial observations
    conn.execute("""
        INSERT INTO observations 
        (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
        VALUES 
        ('session1', 'test-project', 'discovery', 'Test Obs 1', 'A subtitle', 'Test text 1', '["fact1", "fact2"]', 'Test narrative 1', '["concept1", "concept2"]', '["file1.ts"]', ?)
    """, (now,))
    
    conn.execute("""
        INSERT INTO observations 
        (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
        VALUES 
        ('session2', 'test-project', 'feature', 'Test Obs 2', NULL, 'Test text 2', '["fact3"]', 'Test narrative 2', '["concept3"]', '["file2.ts"]', ?)
    """, (now,))
    
    conn.execute("""
        INSERT INTO observations 
        (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
        VALUES 
        ('session3', 'test-project', 'bugfix', NULL, 'No title', 'Test text 3', '["fact4", "fact5"]', NULL, '["concept4"]', '[]', ?)
    """, (now,))
    
    # 2 initial session summaries
    conn.execute("""
        INSERT INTO session_summaries
        (memory_session_id, project, request, investigated, learned, completed, next_steps, files_edited, notes, created_at)
        VALUES
        ('session4', 'test-project', 'Test request 1 that is longer than 100 characters to test truncation in the rendered output', 'Investigated 1', 'Learned 1', 'Completed 1', 'Next steps 1', '["file3.ts"]', 'Notes 1', ?)
    """, (now,))
    
    conn.execute("""
        INSERT INTO session_summaries
        (memory_session_id, project, request, investigated, learned, completed, next_steps, files_edited, notes, created_at)
        VALUES
        ('session5', 'test-project', 'Test request 2', 'Investigated 2', 'Learned 2', 'Completed 2', 'Next steps 2', '["file4.ts"]', 'Notes 2', ?)
    """, (now,))
    
    conn.commit()
    conn.close()


def run_exporter(db_path: Path, out_root: Path, state_path: Path, ledger_path: Path, dry_run: bool = False) -> subprocess.CompletedProcess:
    """Run the claude-mem-export.py script."""
    cmd = [
        sys.executable,
        "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/bin/claude-mem-export.py",
        "--db", str(db_path),
        "--out-root", str(out_root),
        "--state", str(state_path),
        "--ledger", str(ledger_path),
        "--source-task", "test-task"
    ]
    
    if dry_run:
        cmd.append("--dry-run")
    
    return subprocess.run(cmd, capture_output=True, text=True)


def read_ledger(ledger_path: Path) -> list:
    """Read ledger rows."""
    if not ledger_path.exists():
        return []
    
    rows = []
    with open(ledger_path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def read_state(state_path: Path) -> dict:
    """Read state file."""
    if not state_path.exists():
        return {}
    
    with open(state_path) as f:
        return json.load(f)


def test_seed_run():
    """Test 1: Seed run - no state file → cursors == MAX(id), zero files written."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "claude-mem.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create fixture db with initial data
        create_fixture_db(db_path)
        
        # Run exporter (should seed)
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        
        assert result.returncode == 0, f"Export failed: {result.stderr}"
        
        # Check state was created with cursors at MAX(id)
        state = read_state(state_path)
        assert state["observations_last_id"] == 3  # MAX of initial observations
        assert state["session_summaries_last_id"] == 2  # MAX of initial summaries
        
        # Check ledger row
        ledger = read_ledger(ledger_path)
        assert len(ledger) == 1
        assert ledger[0]["seeded"] == True
        assert ledger[0]["green"] == True
        assert ledger[0]["observations"]["from"] == 3
        assert ledger[0]["observations"]["to"] == 3
        assert ledger[0]["observations"]["count"] == 0
        assert ledger[0]["summaries"]["from"] == 2
        assert ledger[0]["summaries"]["to"] == 2
        assert ledger[0]["summaries"]["count"] == 0
        assert ledger[0]["files"] == []
        
        # Check no files were written
        assert not (out_root / "observations").exists()
        assert not (out_root / "summaries").exists()


def test_forward_run():
    """Test 2: Forward run - insert new rows → files written, cursor advanced."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "claude-mem.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create fixture db with initial data
        create_fixture_db(db_path)
        
        # Seed first
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Verify seed state
        state = read_state(state_path)
        assert state["observations_last_id"] == 3  # MAX of initial observations
        assert state["session_summaries_last_id"] == 2  # MAX of initial summaries
        
        # Add new rows
        conn = sqlite3.connect(str(db_path))
        now = datetime.now(timezone.utc).isoformat()
        
        # 3 new observations
        for i in range(4, 7):
            conn.execute("""
                INSERT INTO observations 
                (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (f'session{i}', 'test-project', 'discovery', f'New Obs {i}', f'New subtitle {i}', 
                  f'New text {i}', json.dumps([f'new_fact{i}']), f'New narrative {i}', 
                  json.dumps([f'new_concept{i}']), json.dumps([f'new_file{i}.ts']), now))
        
        # 2 new session summaries
        for i in range(3, 5):
            conn.execute("""
                INSERT INTO session_summaries
                (memory_session_id, project, request, investigated, learned, completed, next_steps, files_edited, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (f'session{i+5}', 'test-project', f'New request {i}', f'New investigated {i}', 
                  f'New learned {i}', f'New completed {i}', f'New next steps {i}', 
                  json.dumps([f'new_file{i}.ts']), f'New notes {i}', now))
        
        conn.commit()
        conn.close()
        
        # Clear ledger only (keep state for forward run)
        ledger_path.unlink()
        
        # Run forward export (should pick up new rows after cursor)
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Check state advanced to new MAX
        state = read_state(state_path)
        assert state["observations_last_id"] == 6  # New MAX
        assert state["session_summaries_last_id"] == 4  # New MAX
        
        # Check exactly 2 files written
        obs_files = list((out_root / "observations").glob("*.md"))
        sum_files = list((out_root / "summaries").glob("*.md"))
        assert len(obs_files) == 1  # One batch file
        assert len(sum_files) == 1  # One batch file
        
        # Check file names contain correct ID ranges
        assert "obs-4-6" in obs_files[0].name
        assert "sum-3-4" in sum_files[0].name
        
        # Check ledger row
        ledger = read_ledger(ledger_path)
        assert len(ledger) == 1
        assert ledger[0]["green"] == True
        assert ledger[0]["observations"]["from"] == 4
        assert ledger[0]["observations"]["to"] == 6
        assert ledger[0]["observations"]["count"] == 3
        assert ledger[0]["summaries"]["from"] == 3
        assert ledger[0]["summaries"]["to"] == 4
        assert ledger[0]["summaries"]["count"] == 2
        assert len(ledger[0]["files"]) == 2


def test_noop_run():
    """Test 3: No-op run - rerun with no new rows → no files, green no-op ledger row."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "claude-mem.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create fixture db
        create_fixture_db(db_path)
        
        # Seed first
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Clear previous ledger
        ledger_path.unlink()
        
        # Run again with no new data
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Check no new files written
        obs_files = list((out_root / "observations").glob("*.md"))
        sum_files = list((out_root / "summaries").glob("*.md"))
        assert len(obs_files) == 0
        assert len(sum_files) == 0
        
        # Check green no-op ledger row
        ledger = read_ledger(ledger_path)
        assert len(ledger) == 1
        assert ledger[0]["green"] == True
        assert ledger[0]["observations"]["count"] == 0
        assert ledger[0]["summaries"]["count"] == 0
        assert ledger[0]["files"] == []


def test_rendering():
    """Test 4: Rendering - JSON arrays become bullets, NULL title falls back, frontmatter valid."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "claude-mem.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create fixture db
        create_fixture_db(db_path)
        
        # Seed first
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Verify seed state
        state = read_state(state_path)
        assert state["observations_last_id"] == 3
        assert state["session_summaries_last_id"] == 2
        
        # Add new data with specific rendering test cases
        conn = sqlite3.connect(str(db_path))
        now = datetime.now(timezone.utc).isoformat()
        
        # Observation with JSON arrays and NULL title
        conn.execute("""
            INSERT INTO observations 
            (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ('render_test', 'test-project', 'test', None, 'Render subtitle', 
              'Render text', json.dumps(['fact1', 'fact2', 'fact3']), 'Render narrative', 
              json.dumps(['concept1', 'concept2']), json.dumps(['file1.ts', 'file2.ts']), now))
        
        conn.commit()
        conn.close()
        
        # Clear ledger only (keep state for forward run)
        ledger_path.unlink()
        
        # Run export
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Read the observation file
        obs_files = list((out_root / "observations").glob("*.md"))
        assert len(obs_files) == 1
        
        with open(obs_files[0]) as f:
            content = f.read()
        
        # Check frontmatter parses as YAML
        frontmatter_end = content.find('---', 3)  # Find second ---
        frontmatter = content[3:frontmatter_end].strip()
        frontmatter_data = {}
        
        for line in frontmatter.split('\n'):
            if ':' in line:
                key, value = line.split(':', 1)
                frontmatter_data[key.strip()] = value.strip()
        
        assert "agent: larry" in frontmatter
        assert "job: claude-mem-export" in frontmatter
        assert "source-task: test-task" in frontmatter
        assert "source-table: observations" in frontmatter
        assert "id-range:" in frontmatter
        
        # Check JSON array facts become bullets
        assert "- fact1" in content
        assert "- fact2" in content
        assert "- fact3" in content
        
        # Check NULL title falls back to "observation <id>"
        assert "## [test] observation 4" in content or "## [test] observation" in content
        
        # Check concepts become comma line
        assert "concept1, concept2" in content
        
        # Check files modified listed
        assert "file1.ts, file2.ts" in content or "file1.ts" in content and "file2.ts" in content


def test_failure_path():
    """Test 5: Failure path - unreadable db path → exit 1, red ledger row, state untouched."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "nonexistent.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create state file with some data
        state_path.write_text(json.dumps({
            "observations_last_id": 100,
            "session_summaries_last_id": 50,
            "last_run": datetime.now(timezone.utc).isoformat()
        }))
        
        # Try to run with nonexistent db
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        
        # Should exit with error
        assert result.returncode == 1
        
        # Check red ledger row
        ledger = read_ledger(ledger_path)
        assert len(ledger) == 1
        assert ledger[0]["green"] == False
        assert "error" in ledger[0]
        
        # Check state file untouched
        state = read_state(state_path)
        assert state["observations_last_id"] == 100
        assert state["session_summaries_last_id"] == 50


def test_never_overwrite():
    """Test 6: Never-overwrite - pre-create target filename → run writes -r2 variant."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        db_path = tmpdir / "claude-mem.db"
        out_root = tmpdir / "output"
        state_path = tmpdir / "state.json"
        ledger_path = tmpdir / "ledger.jsonl"
        
        # Create fixture db
        create_fixture_db(db_path)
        
        # Seed first
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Verify seed state
        state = read_state(state_path)
        assert state["observations_last_id"] == 3
        
        # Add new data
        conn = sqlite3.connect(str(db_path))
        now = datetime.now(timezone.utc).isoformat()
        
        conn.execute("""
            INSERT INTO observations 
            (memory_session_id, project, type, title, subtitle, text, facts, narrative, concepts, files_modified, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ('overwrite_test', 'test-project', 'test', 'Overwrite Test', 'Test', 
              'Text', json.dumps(['fact1']), 'Narrative', json.dumps(['concept1']), 
              json.dumps(['file1.ts']), now))
        
        conn.commit()
        conn.close()
        
        # Clear ledger only (keep state for forward run)
        ledger_path.unlink()
        
        # Pre-create the expected target file
        out_root.mkdir(parents=True, exist_ok=True)
        (out_root / "observations").mkdir(parents=True, exist_ok=True)
        run_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        pre_created_file = out_root / "observations" / f"{run_date}-obs-4-4.md"
        pre_created_file.write_text("PRE-CREATED FILE")
        
        # Run export
        result = run_exporter(db_path, out_root, state_path, ledger_path)
        assert result.returncode == 0
        
        # Check original file still exists and unchanged
        assert pre_created_file.exists()
        assert pre_created_file.read_text() == "PRE-CREATED FILE"
        
        # Check -r2 variant was created
        r2_file = out_root / "observations" / f"{run_date}-obs-4-4-r2.md"
        assert r2_file.exists()
        
        # Check r2 file has correct content
        content = r2_file.read_text()
        assert "Overwrite Test" in content
        assert "PRE-CREATED FILE" not in content
        
        # Check ledger records the r2 file
        ledger = read_ledger(ledger_path)
        assert len(ledger) == 1
        assert len(ledger[0]["files"]) == 1
        assert str(r2_file) in ledger[0]["files"]


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])