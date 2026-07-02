import json
import os
import sys
from pathlib import Path


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class FakeRebuildCollection:
    def __init__(self, storage_dir, name):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.name = name
        self._path = self.storage_dir / f"{name}.json"
        if not self._path.exists():
            self._path.write_text("[]", encoding="utf-8")

    def _load_ids(self):
        return json.loads(self._path.read_text(encoding="utf-8"))

    def _save_ids(self, ids):
        self._path.write_text(json.dumps(sorted(ids)), encoding="utf-8")

    def count(self):
        return len(self._load_ids())

    def upsert(self, ids, embeddings=None, documents=None, metadatas=None):
        current = set(self._load_ids())
        current.update(ids)
        self._save_ids(current)


class FakeRebuildClient:
    def __init__(self, storage_dir):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)

    def get_or_create_collection(self, name, metadata=None):
        return FakeRebuildCollection(self.storage_dir, name)

    def get_collection(self, name):
        path = self.storage_dir / f"{name}.json"
        if not path.exists():
            raise KeyError(name)
        return FakeRebuildCollection(self.storage_dir, name)

    def list_collections(self):
        return [type("CollectionRef", (), {"name": path.stem}) for path in self.storage_dir.glob("*.json")]

    def close(self):
        return None


def _patch_fake_chroma(monkeypatch):
    monkeypatch.setattr(
        mmrag,
        "get_chroma_client",
        lambda chroma_dir=None: FakeRebuildClient(chroma_dir or mmrag.CHROMADB_DIR),
    )


def _seed_collection(path, name, count):
    client = FakeRebuildClient(path)
    collection = client.get_or_create_collection(name)
    collection.upsert(ids=[f"seed-{idx}" for idx in range(count)])


def _snapshot_tree(root):
    root = Path(root)
    if not root.exists():
        return {}
    snapshot = {}
    for file_path in sorted(path for path in root.rglob("*") if path.is_file()):
        snapshot[str(file_path.relative_to(root))] = file_path.read_bytes()
    return snapshot


def _ingest_one_chunk(client, config, collection, file_path):
    file_path = Path(file_path)
    collection.upsert(ids=[file_path.name], documents=[file_path.name], metadatas=[{"source": str(file_path)}])
    return 1


def test_rebuild_failure_leaves_live_dir_unchanged(tmp_path, monkeypatch):
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (root / name).write_text(name, encoding="utf-8")

    _seed_collection(live_dir, "shared-clearworksai", 5)
    before = _snapshot_tree(live_dir)

    def flaky_ingest(client, config, collection, file_path):
        file_path = Path(file_path)
        if file_path.name != "a.md":
            raise RuntimeError("mid-run failure")
        return _ingest_one_chunk(client, config, collection, file_path)

    _patch_fake_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "ingest_file", flaky_ingest)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    report = mmrag._rebuild_collection(
        None,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert report["swap_succeeded"] is False
    assert report["swap_aborted"] is True
    assert report["failed_files"] == 2
    assert _snapshot_tree(live_dir) == before
    assert Path(report["temp_dir"]).exists()
    assert report["backup_dir"] is None


def test_rebuild_happy_path_swaps_and_keeps_backup(tmp_path, monkeypatch):
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (root / name).write_text(name, encoding="utf-8")

    _seed_collection(live_dir, "shared-clearworksai", 1)

    _patch_fake_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "ingest_file", _ingest_one_chunk)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    report = mmrag._rebuild_collection(
        None,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert report["swap_succeeded"] is True
    assert report["backup_dir"]
    assert Path(report["backup_dir"]).exists()
    live_collection = FakeRebuildClient(live_dir).get_collection("shared-clearworksai")
    backup_collection = FakeRebuildClient(report["backup_dir"]).get_collection("shared-clearworksai")
    assert live_collection.count() == 3
    assert backup_collection.count() == 1


def test_rebuild_sanity_guard_aborts_near_empty_temp(tmp_path, monkeypatch):
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    (root / "a.md").write_text("a", encoding="utf-8")

    _seed_collection(live_dir, "shared-clearworksai", 10)
    before = _snapshot_tree(live_dir)

    _patch_fake_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "ingest_file", _ingest_one_chunk)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    report = mmrag._rebuild_collection(
        None,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert report["swap_succeeded"] is False
    assert report["swap_aborted"] is True
    assert any("allow-shrink" in reason for reason in report["abort_reasons"])
    assert _snapshot_tree(live_dir) == before


def test_rebuild_size_guard_aborts_swap(tmp_path, monkeypatch):
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md"):
        (root / name).write_text(name, encoding="utf-8")

    _seed_collection(live_dir, "shared-clearworksai", 1)
    before = _snapshot_tree(live_dir)

    _patch_fake_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "ingest_file", _ingest_one_chunk)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    original_dir_size = mmrag._directory_size_bytes

    def fake_dir_size(path):
        path = Path(path)
        if path == live_dir:
            return 100
        if "rebuild" in path.name:
            return 2500
        return original_dir_size(path)

    monkeypatch.setattr(mmrag, "_directory_size_bytes", fake_dir_size)

    report = mmrag._rebuild_collection(
        None,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert report["swap_succeeded"] is False
    assert report["swap_aborted"] is True
    assert any("20x" in reason for reason in report["abort_reasons"])
    assert _snapshot_tree(live_dir) == before
