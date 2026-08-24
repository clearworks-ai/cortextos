"""FR-015 side embedding-cache isolation.

Temp fixtures only. Never open or mutate the live embedding-cache.sqlite.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-cache-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)
os.environ.pop("MMRAG_CHROMADB_DIR", None)
os.environ.pop("MMRAG_CONFIG", None)
os.environ.pop("MMRAG_EMBED_CACHE_PATH", None)
os.environ.pop("MMRAG_SIDE_CHROMADB_DIR", None)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag

LIVE_ROOT = Path.home() / ".cortextos"
LIVE_KB = LIVE_ROOT / "cortextos1" / "orgs" / "clearworksai" / "knowledge-base"


def _assert_isolated(path):
    resolved = Path(path).resolve()
    assert LIVE_ROOT not in resolved.parents, f"test path leaked onto live tree: {resolved}"
    assert resolved != LIVE_ROOT


def _bind_tmp(monkeypatch, tmp_path):
    _assert_isolated(tmp_path)
    monkeypatch.setattr(mmrag, "MMRAG_DIR", tmp_path)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", tmp_path / "chromadb")
    monkeypatch.delenv("MMRAG_EMBED_CACHE_PATH", raising=False)
    monkeypatch.delenv("MMRAG_SIDE_CHROMADB_DIR", raising=False)
    (tmp_path / "chromadb").mkdir()
    return tmp_path / mmrag.DEFAULT_EMBED_CACHE_FILENAME


def _write_hold(tmp_path, mode="exclusive"):
    (tmp_path / mmrag.NATIVE_HOLD_FILENAME).write_text(
        '{"mode":"%s"}\n' % mode,
        encoding="utf-8",
    )


def test_hold_refuses_live_embed_cache_open_and_does_not_create_it(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path)
    mmrag.set_mmrag_operation("ingest")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag._open_embed_cache()

    payload = exc_info.value.to_dict()
    assert payload["result"] == "STORE_QUARANTINED"
    assert "embedding-cache" in (payload.get("detail") or "")
    assert not live_cache.exists()


def test_side_worker_env_does_not_resolve_to_live_cache_path(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    side = tmp_path / "chromadb.recovery"
    side.mkdir()
    _write_hold(tmp_path)

    prepared = mmrag.prepare_side_embed_cache(side)
    assert prepared == (side / mmrag.DEFAULT_EMBED_CACHE_FILENAME).resolve()
    assert prepared != live_cache.resolve()
    assert Path(os.environ["MMRAG_EMBED_CACHE_PATH"]).resolve() == prepared
    assert mmrag._embed_cache_path() == prepared


def test_side_open_writes_only_side_cache_live_mtime_unchanged(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    live_cache.write_bytes(b"live-cache-bytes")
    live_stat = live_cache.stat()
    side = tmp_path / "chromadb.recovery"
    side.mkdir()
    _write_hold(tmp_path)
    mmrag.prepare_side_embed_cache(side)
    mmrag.set_mmrag_operation("ingest")

    conn = mmrag._open_embed_cache()
    assert conn is not None
    conn.close()

    side_cache = side / mmrag.DEFAULT_EMBED_CACHE_FILENAME
    assert side_cache.is_file()
    assert live_cache.read_bytes() == b"live-cache-bytes"
    assert live_cache.stat().st_mtime_ns == live_stat.st_mtime_ns
    assert live_cache.stat().st_size == live_stat.st_size


def test_copy_live_cache_into_side_then_treat_as_side_owned(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    live_conn = sqlite3.connect(str(live_cache))
    live_conn.execute("CREATE TABLE marker (id INTEGER)")
    live_conn.execute("INSERT INTO marker VALUES (7)")
    live_conn.commit()
    live_conn.close()
    live_stat = live_cache.stat()

    side = tmp_path / "chromadb.recovery"
    side.mkdir()
    prepared = mmrag.prepare_side_embed_cache(side, copy_from_live=True)
    assert prepared.is_file()
    assert prepared != live_cache.resolve()

    copied = sqlite3.connect(str(prepared))
    row = copied.execute("SELECT id FROM marker").fetchone()
    copied.close()
    assert row == (7,)
    assert live_cache.stat().st_mtime_ns == live_stat.st_mtime_ns


def test_copy_from_live_fails_closed_when_live_cache_missing(tmp_path, monkeypatch):
    _bind_tmp(monkeypatch, tmp_path)
    side = tmp_path / "chromadb.recovery"
    side.mkdir()
    with pytest.raises(FileNotFoundError):
        mmrag.prepare_side_embed_cache(side, copy_from_live=True)


def test_side_persist_without_cache_override_refuses_live_cache(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    side_persist = tmp_path / "chromadb.recovery"
    side_persist.mkdir()
    monkeypatch.setenv("MMRAG_SIDE_CHROMADB_DIR", str(side_persist))
    mmrag.set_mmrag_operation("ingest")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag._open_embed_cache()

    payload = exc_info.value.to_dict()
    assert payload["result"] == "INVALID_CONFIG"
    assert not live_cache.exists()


def test_prepare_refuses_cache_inside_chroma_persist_dir(tmp_path, monkeypatch):
    _bind_tmp(monkeypatch, tmp_path)
    persist = tmp_path / "chromadb.recovery"
    persist.mkdir()
    (persist / "chroma.sqlite3").write_bytes(b"not-a-work-tree")
    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag.prepare_side_embed_cache(persist)
    assert exc_info.value.to_dict()["result"] == "INVALID_CONFIG"


def test_writers_hold_also_refuses_live_embed_cache(tmp_path, monkeypatch):
    live_cache = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "writers")
    mmrag.set_mmrag_operation("query")
    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag._open_embed_cache()
    assert exc_info.value.to_dict()["hold_mode"] == "writers"
    assert not live_cache.exists()
