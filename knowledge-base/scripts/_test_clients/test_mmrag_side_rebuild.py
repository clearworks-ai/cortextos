"""FR-007 fixture side-rebuild scaffolding.

Empty sibling persist only. Never copy live HNSW, never call
_rebuild_collection against live, never open the hosted KB.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-side-rebuild-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_ROOT = Path.home() / ".cortextos"
LIVE_KB = LIVE_ROOT / "cortextos1" / "orgs" / "clearworksai" / "knowledge-base"


def _seed_kb(tmp_path):
    kb = tmp_path / "knowledge-base"
    live = kb / "chromadb"
    live.mkdir(parents=True)
    (live / "chroma.sqlite3").write_bytes(b"live-sqlite")
    segment = live / "uuid-segment"
    segment.mkdir()
    (segment / "data.bin").write_bytes(b"live-hnsw")
    (kb / "config.json").write_text('{"default_collection":"shared"}\n', encoding="utf-8")
    (kb / "embedding-cache.sqlite").write_bytes(b"live-cache")
    return kb, live


def _snapshot(root):
    root = Path(root)
    snapshot = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            snapshot[str(path.relative_to(root))] = path.read_bytes()
    return snapshot


def test_side_scaffold_creates_empty_sibling_persist_without_copying_live(tmp_path):
    kb, live = _seed_kb(tmp_path)
    before = _snapshot(live)
    receipt = mmrag_recovery.prepare_side_rebuild_scaffold(kb)

    persist = Path(receipt["persist_dir"])
    work = Path(receipt["work_dir"])
    assert receipt["result"] == "SIDE_SCAFFOLD_OK"
    assert persist.is_dir()
    assert persist != live.resolve()
    assert persist.parent == work.resolve()
    assert persist.parent.name == "recovery-side"
    assert persist.name == "chromadb"
    assert not persist.name.startswith("chromadb.rebuild-")
    assert not any(persist.rglob("*"))
    assert _snapshot(live) == before
    assert (live / "chroma.sqlite3").read_bytes() == b"live-sqlite"


def test_side_scaffold_points_env_at_side_cache_and_persist(tmp_path):
    kb, live = _seed_kb(tmp_path)
    receipt = mmrag_recovery.prepare_side_rebuild_scaffold(kb)
    env = receipt["env"]
    persist = Path(receipt["persist_dir"]).resolve()
    cache = Path(receipt["embed_cache_path"]).resolve()
    assert Path(env["MMRAG_CHROMADB_DIR"]).resolve() == persist
    assert Path(env["MMRAG_SIDE_CHROMADB_DIR"]).resolve() == persist
    assert Path(env["MMRAG_EMBED_CACHE_PATH"]).resolve() == cache
    assert persist != live.resolve()
    assert cache != (kb / "embedding-cache.sqlite").resolve()
    assert cache.parent == Path(receipt["work_dir"]).resolve()


def test_side_scaffold_refuses_live_knowledge_base():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked):
        mmrag_recovery.prepare_side_rebuild_scaffold(LIVE_KB)


def test_assert_side_rebuild_target_refuses_live_and_rebuild_temp_names(tmp_path):
    kb, live = _seed_kb(tmp_path)
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.assert_side_rebuild_target(live, live)
    rebuild_temp = live.parent / "chromadb.rebuild-1-2-0"
    rebuild_temp.mkdir()
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.assert_side_rebuild_target(live, rebuild_temp)
    side = live.parent / "recovery-side" / "chromadb"
    side.mkdir(parents=True)
    mmrag_recovery.assert_side_rebuild_target(live, side)


def test_side_scaffold_refuses_populated_side_persist(tmp_path):
    kb, _live = _seed_kb(tmp_path)
    dirty = kb / "recovery-side" / "chromadb"
    dirty.mkdir(parents=True)
    (dirty / "chroma.sqlite3").write_bytes(b"old-side")
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.prepare_side_rebuild_scaffold(kb)


def test_recovery_driver_never_calls_rebuild_or_chroma_client():
    source = Path(mmrag_recovery.__file__).read_text(encoding="utf-8")
    _, body = source.split("def prepare_side_rebuild_scaffold", 1)
    assert "_rebuild_collection(" not in body
    assert "get_chroma_client(" not in body
    assert "_rebuild_collection(" not in source
    assert "get_chroma_client(" not in source
