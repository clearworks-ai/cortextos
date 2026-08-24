"""FR-016 drain and FR-004 fixture backup mechanics.

Temp fixtures only. Never lsof, open, or snapshot the live Chroma store.
Never SIGKILL. Live ~/.cortextos KB roots are blocked until human L0.
"""

from __future__ import annotations

import hashlib
import os
import stat
import tarfile
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
import sys
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_ROOT = Path.home() / ".cortextos"
LIVE_KB = LIVE_ROOT / "cortextos1" / "orgs" / "clearworksai" / "knowledge-base"


def _assert_isolated(path):
    resolved = Path(path).resolve()
    assert LIVE_ROOT not in resolved.parents, f"test path leaked onto live tree: {resolved}"


def _seed_kb(tmp_path):
    _assert_isolated(tmp_path)
    kb = tmp_path / "knowledge-base"
    chromadb = kb / "chromadb"
    chromadb.mkdir(parents=True)
    sqlite = chromadb / "chroma.sqlite3"
    sqlite.write_bytes(b"fake-chroma-sqlite")
    (chromadb / "segment-dir").mkdir()
    (chromadb / "segment-dir" / "data.bin").write_bytes(b"hnsw-bytes")
    (kb / "config.json").write_text('{"default_collection":"shared"}\n', encoding="utf-8")
    (kb / "embedding-cache.sqlite").write_bytes(b"fake-embed-cache")
    (kb / "media").mkdir()
    (kb / "media" / "skip-me.bin").write_bytes(b"not-in-backup")
    return kb


def test_live_kb_root_is_blocked_without_opening_sqlite():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked) as exc_info:
        mmrag_recovery.drain_chroma_openers(LIVE_KB / "chromadb" / "chroma.sqlite3")
    assert exc_info.value.result == "LIVE_EPOCH_BLOCKED"


def test_live_kb_backup_is_blocked_without_snapshot():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked) as exc_info:
        mmrag_recovery.snapshot_kb_surfaces(LIVE_KB, LIVE_KB.parent / "should-not-exist")
    assert exc_info.value.result == "LIVE_EPOCH_BLOCKED"


def test_dummy_open_handle_fails_drain(tmp_path):
    kb = _seed_kb(tmp_path)
    sqlite = kb / "chromadb" / "chroma.sqlite3"
    fd = os.open(sqlite, os.O_RDWR)
    try:
        receipt = mmrag_recovery.drain_chroma_openers(sqlite, timeout_s=0.2, poll_s=0.05)
        assert receipt["result"] == "DRAIN_FAIL"
        assert any(int(opener["pid"]) == os.getpid() for opener in receipt["openers"])
        assert str(sqlite) in receipt["checked_paths"]
    finally:
        os.close(fd)


def test_drain_pass_when_no_openers(tmp_path):
    kb = _seed_kb(tmp_path)
    sqlite = kb / "chromadb" / "chroma.sqlite3"
    receipt = mmrag_recovery.drain_chroma_openers(sqlite, timeout_s=0.2, poll_s=0.05)
    assert receipt["result"] == "DRAIN_PASS"
    assert receipt["openers"] == []


def test_backup_refuses_when_drain_fails(tmp_path):
    kb = _seed_kb(tmp_path)
    dest = tmp_path / "backup"
    sqlite = kb / "chromadb" / "chroma.sqlite3"
    fd = os.open(sqlite, os.O_RDWR)
    try:
        with pytest.raises(mmrag_recovery.DrainFailed) as exc_info:
            mmrag_recovery.snapshot_kb_surfaces(kb, dest, drain_timeout_s=0.2)
        assert exc_info.value.receipt["result"] == "DRAIN_FAIL"
        assert not dest.exists() or not any(dest.iterdir())
    finally:
        os.close(fd)
    # Fixture bytes unchanged after refused backup.
    assert (kb / "chromadb" / "chroma.sqlite3").read_bytes() == b"fake-chroma-sqlite"


def test_backup_after_drain_includes_required_surfaces_and_is_write_once(tmp_path):
    kb = _seed_kb(tmp_path)
    dest = tmp_path / "backup"
    receipt = mmrag_recovery.snapshot_kb_surfaces(kb, dest, drain_timeout_s=1)

    assert receipt["result"] == "BACKUP_OK"
    assert receipt["drain"]["result"] == "DRAIN_PASS"
    archive = Path(receipt["archive_path"])
    assert archive.is_file()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert receipt["archive_sha256"] == digest
    assert receipt["drain"]["result"] == "DRAIN_PASS"

    with tarfile.open(archive, "r:*") as tar:
        names = tar.getnames()
    assert any(name == "chromadb" or name.startswith("chromadb/") for name in names)
    assert "config.json" in names
    assert "embedding-cache.sqlite" in names
    assert not any("media/" in name or name == "media" for name in names)

    mode = stat.S_IMODE(archive.stat().st_mode)
    assert mode & 0o222 == 0, f"archive must be write-once, mode={oct(mode)}"

    # Source fixture untouched.
    assert (kb / "config.json").read_text(encoding="utf-8") == '{"default_collection":"shared"}\n'
    assert (kb / "embedding-cache.sqlite").read_bytes() == b"fake-embed-cache"


def test_recovery_module_never_force_kills():
    source = Path(mmrag_recovery.__file__).read_text(encoding="utf-8")
    assert "signal.SIGKILL" not in source
    assert "kill -9" not in source
    assert "os.kill(" not in source
    assert "SIGKILL" not in source


def test_wal_and_shm_are_included_in_opener_scan(tmp_path):
    kb = _seed_kb(tmp_path)
    sqlite = kb / "chromadb" / "chroma.sqlite3"
    wal = Path(str(sqlite) + "-wal")
    shm = Path(str(sqlite) + "-shm")
    wal.write_bytes(b"wal")
    shm.write_bytes(b"shm")
    fd = os.open(wal, os.O_RDWR)
    try:
        receipt = mmrag_recovery.drain_chroma_openers(sqlite, timeout_s=0.2, poll_s=0.05)
        assert receipt["result"] == "DRAIN_FAIL"
        assert str(wal) in receipt["checked_paths"]
        assert str(shm) in receipt["checked_paths"]
    finally:
        os.close(fd)
