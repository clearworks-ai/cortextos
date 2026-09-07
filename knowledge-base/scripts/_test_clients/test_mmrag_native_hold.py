"""I1 native-hold factory tests.

Temp fixtures only. Never construct PersistentClient against a live
~/.cortextos store, and never write NATIVE_HOLD onto the live KB root.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-hold-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)
os.environ.pop("MMRAG_CHROMADB_DIR", None)
os.environ.pop("MMRAG_CONFIG", None)
os.environ.pop("MMRAG_SIDE_CHROMADB_DIR", None)
os.environ.pop("MMRAG_OPERATION", None)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag

MMRAG_PY = Path(PARENT) / "mmrag.py"
LIVE_ROOT = Path.home() / ".cortextos"


class _ExplodingChroma:
    def PersistentClient(self, path=None, **_kwargs):
        raise AssertionError(f"PersistentClient must not construct: {path}")


class _FakeCollection:
    def __init__(self, name):
        self.name = name

    def count(self):
        return 0


class _FakeClient:
    def __init__(self, path, existing=None):
        self.path = path
        self.existing = list(existing or [])
        self.created = []

    def list_collections(self):
        return [SimpleNamespace(name=name) for name in self.existing]

    def get_collection(self, name):
        if name not in self.existing:
            raise KeyError(name)
        return _FakeCollection(name)

    def get_or_create_collection(self, name, metadata=None):
        self.created.append(name)
        if name not in self.existing:
            self.existing.append(name)
        return _FakeCollection(name)


class _RecordingChroma:
    def __init__(self, existing=None):
        self.paths = []
        self.clients = []
        self.existing = list(existing or [])

    def PersistentClient(self, path=None, **_kwargs):
        self.paths.append(str(path))
        client = _FakeClient(path, existing=self.existing)
        self.clients.append(client)
        return client


def _assert_isolated(path):
    resolved = Path(path).resolve()
    assert LIVE_ROOT not in resolved.parents, f"test path leaked onto live tree: {resolved}"
    assert resolved != LIVE_ROOT


def _bind_tmp(monkeypatch, tmp_path):
    _assert_isolated(tmp_path)
    chroma_dir = tmp_path / "chromadb"
    chroma_dir.mkdir()
    monkeypatch.setattr(mmrag, "MMRAG_DIR", tmp_path)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", chroma_dir)
    monkeypatch.delenv("MMRAG_SIDE_CHROMADB_DIR", raising=False)
    monkeypatch.delenv("MMRAG_OPERATION", raising=False)
    mmrag.set_mmrag_operation("")
    return chroma_dir


def _write_hold(tmp_path, mode):
    (tmp_path / mmrag.NATIVE_HOLD_FILENAME).write_text(
        json.dumps({"mode": mode}) + "\n",
        encoding="utf-8",
    )


def test_exclusive_hold_refuses_live_client_without_constructing(tmp_path, monkeypatch):
    chroma_dir = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "exclusive")
    monkeypatch.setitem(sys.modules, "chromadb", _ExplodingChroma())
    mmrag.set_mmrag_operation("query")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag.get_chroma_client()

    payload = exc_info.value.to_dict()
    assert payload["result"] == "STORE_QUARANTINED"
    assert payload["store_health"] == "QUARANTINED"
    assert payload["hold_mode"] == "exclusive"
    assert payload["operation"] == "query"
    assert Path(payload["chroma_dir"]).resolve() == chroma_dir.resolve()


def test_writers_hold_refuses_ingest_without_constructing(tmp_path, monkeypatch):
    _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "writers")
    monkeypatch.setitem(sys.modules, "chromadb", _ExplodingChroma())
    mmrag.set_mmrag_operation("ingest")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag.get_chroma_client()

    assert exc_info.value.to_dict()["hold_mode"] == "writers"
    assert exc_info.value.to_dict()["operation"] == "ingest"


def test_writers_hold_refuses_missing_live_get_or_create(tmp_path, monkeypatch):
    chroma_dir = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "writers")
    fake = _RecordingChroma(existing=[])
    monkeypatch.setitem(sys.modules, "chromadb", fake)
    mmrag.set_mmrag_operation("query")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag.get_chroma_collection("shared-clearworksai")

    assert fake.paths == [str(chroma_dir)]
    assert fake.clients[0].created == []
    assert "get_or_create" in exc_info.value.detail


def test_writers_hold_allows_query_of_existing_collection(tmp_path, monkeypatch):
    chroma_dir = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "writers")
    fake = _RecordingChroma(existing=["shared-clearworksai"])
    monkeypatch.setitem(sys.modules, "chromadb", fake)
    mmrag.set_mmrag_operation("query")

    collection = mmrag.get_chroma_collection("shared-clearworksai")
    assert collection.name == "shared-clearworksai"
    assert fake.paths == [str(chroma_dir)]
    assert fake.clients[0].created == []


def test_exclusive_hold_allows_approved_side_path_only(tmp_path, monkeypatch):
    chroma_dir = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "exclusive")
    side = tmp_path / "chromadb.recovery"
    side.mkdir()
    monkeypatch.setenv("MMRAG_SIDE_CHROMADB_DIR", str(side))
    fake = _RecordingChroma()
    monkeypatch.setitem(sys.modules, "chromadb", fake)
    mmrag.set_mmrag_operation("ingest")

    client = mmrag.get_chroma_client(chroma_dir=side)
    assert str(client.path) == str(side)
    assert fake.paths == [str(side)]

    with pytest.raises(mmrag.NativeHoldError):
        mmrag.get_chroma_client(chroma_dir=chroma_dir)


def test_exclusive_hold_allows_side_when_chromadb_env_points_at_side(tmp_path, monkeypatch):
    live = _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "exclusive")
    side = tmp_path / "recovery-side" / "chromadb"
    side.mkdir(parents=True)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", side)
    monkeypatch.setenv("MMRAG_SIDE_CHROMADB_DIR", str(side))
    fake = _RecordingChroma()
    monkeypatch.setitem(sys.modules, "chromadb", fake)
    mmrag.set_mmrag_operation("ingest")

    client = mmrag.get_chroma_client()
    assert str(client.path) == str(side)
    assert fake.paths == [str(side)]

    with pytest.raises(mmrag.NativeHoldError):
        mmrag.get_chroma_client(chroma_dir=live)


def test_invalid_hold_file_is_invalid_config_and_does_not_construct(tmp_path, monkeypatch):
    _bind_tmp(monkeypatch, tmp_path)
    (tmp_path / mmrag.NATIVE_HOLD_FILENAME).write_text('{"mode":"nope"}\n', encoding="utf-8")
    monkeypatch.setitem(sys.modules, "chromadb", _ExplodingChroma())
    mmrag.set_mmrag_operation("query")

    with pytest.raises(mmrag.NativeHoldError) as exc_info:
        mmrag.get_chroma_client()

    assert exc_info.value.to_dict()["result"] == "INVALID_CONFIG"


def test_cmd_status_does_not_map_hold_to_count_zero(tmp_path, monkeypatch):
    _bind_tmp(monkeypatch, tmp_path)
    _write_hold(tmp_path, "exclusive")
    monkeypatch.setitem(sys.modules, "chromadb", _ExplodingChroma())
    monkeypatch.setattr(mmrag, "load_config", lambda: {"default_collection": "shared-clearworksai"})
    mmrag.set_mmrag_operation("status")
    args = SimpleNamespace(collection=None, json=True)

    with pytest.raises(mmrag.NativeHoldError):
        mmrag.cmd_status(args)


def test_cli_exclusive_query_exits_3_with_quarantine_json(tmp_path):
    _assert_isolated(tmp_path)
    (tmp_path / "NATIVE_HOLD").write_text('{"mode":"exclusive"}\n', encoding="utf-8")
    env = os.environ.copy()
    env["MMRAG_DIR"] = str(tmp_path)
    env["MMRAG_CHROMADB_DIR"] = str(tmp_path / "chromadb")
    env.pop("MMRAG_SIDE_CHROMADB_DIR", None)

    proc = subprocess.run(
        [sys.executable, str(MMRAG_PY), "query", "hello", "--json"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 3, proc.stderr
    payload = json.loads(proc.stdout.strip().splitlines()[0])
    assert payload["result"] == "STORE_QUARANTINED"
    assert payload["hold_mode"] == "exclusive"
    assert payload["operation"] == "query"


def test_no_hold_file_still_constructs_against_tmp(tmp_path, monkeypatch):
    chroma_dir = _bind_tmp(monkeypatch, tmp_path)
    fake = _RecordingChroma()
    monkeypatch.setitem(sys.modules, "chromadb", fake)
    mmrag.set_mmrag_operation("query")

    mmrag.get_chroma_client()
    assert fake.paths == [str(chroma_dir)]
