import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class FakeCollection:
    def __init__(self, name="shared-clearworksai"):
        self.name = name
        self.records = {}
        self.delete_calls = []

    def count(self):
        return len(self.records)

    def get(self, ids=None, include=None):
        if ids is None:
            keys = list(self.records.keys())
        else:
            keys = [doc_id for doc_id in ids if doc_id in self.records]
        return {
            "ids": keys,
            "metadatas": [self.records[key]["metadata"] for key in keys],
            "documents": [self.records[key]["document"] for key in keys],
        }

    def upsert(self, ids, embeddings=None, documents=None, metadatas=None):
        for idx, doc_id in enumerate(ids):
            self.records[doc_id] = {
                "document": documents[idx] if documents else "",
                "metadata": metadatas[idx] if metadatas else {},
            }

    def delete(self, ids):
        self.delete_calls.append(list(ids))
        for doc_id in ids:
            self.records.pop(doc_id, None)


class FlakyDeleteCollection(FakeCollection):
    def __init__(self, fail_on_calls):
        super().__init__()
        self._fail_on_calls = set(fail_on_calls)

    def delete(self, ids):
        call_number = len(self.delete_calls) + 1
        self.delete_calls.append(list(ids))
        if call_number in self._fail_on_calls:
            raise RuntimeError("segment write failed")
        for doc_id in ids:
            self.records.pop(doc_id, None)


def _prime_source_chunks(collection, file_path, *, chunk_count=1, content_hash="seed", extra_metadata=None):
    source_path = str(Path(file_path).resolve())
    for idx in range(chunk_count):
        metadata = {
            "source": source_path,
            "source_file": source_path,
            "type": "text",
            "chunk_index": idx,
            "total_chunks": chunk_count,
            "content_hash": content_hash,
            "source_mtime": 1.0,
            "filename": Path(file_path).name,
            "file_ext": Path(file_path).suffix.lower(),
        }
        if extra_metadata:
            metadata.update(extra_metadata)
        collection.upsert(
            ids=[f"{source_path}:{idx}"],
            documents=[f"chunk {idx}"],
            metadatas=[metadata],
        )


def _fake_ingest_file(client, config, collection, file_path):
    file_path = Path(file_path)
    metadata = {
        **mmrag._common_source_metadata(file_path),
        "type": "text",
        "chunk_index": 0,
        "total_chunks": 1,
        "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    collection.upsert(
        ids=[mmrag.file_id(file_path, 0)],
        documents=[file_path.read_text(encoding="utf-8", errors="replace")],
        metadatas=[metadata],
    )
    return 1


def test_purge_ignored_and_missing_is_idempotent(tmp_path):
    keep = tmp_path / "keep.md"
    keep.write_text("keep", encoding="utf-8")

    ignored = tmp_path / ".claude" / "worktrees" / "dup.md"
    ignored.parent.mkdir(parents=True)
    ignored.write_text("dup", encoding="utf-8")

    missing = tmp_path / "gone.md"

    collection = FakeCollection()
    _prime_source_chunks(collection, keep, chunk_count=1, content_hash="keep")
    _prime_source_chunks(collection, ignored, chunk_count=2, content_hash="ignored")
    _prime_source_chunks(collection, missing, chunk_count=1, content_hash="missing")

    dry_run = mmrag._purge_collection(collection, dry_run=True)
    assert dry_run["purged_files"] == 2
    assert dry_run["purged_chunks"] == 3
    assert dry_run["reasons"]["ignored"]["files"] == 1
    assert dry_run["reasons"]["missing_from_disk"]["files"] == 1
    assert collection.count() == 4

    real_run = mmrag._purge_collection(collection, dry_run=False)
    assert real_run["purged_files"] == 2
    assert real_run["purged_chunks"] == 3
    assert collection.count() == 1

    second_run = mmrag._purge_collection(collection, dry_run=False)
    assert second_run["purged_files"] == 0
    assert second_run["purged_chunks"] == 0
    assert collection.count() == 1


def test_reconcile_new_files_then_idempotent(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (root / name).write_text(name, encoding="utf-8")

    collection = FakeCollection()
    monkeypatch.setattr(mmrag, "ingest_file", _fake_ingest_file)

    first = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    assert first["new_files"] == 3
    assert first["new_chunks"] == 3
    assert first["changed_files"] == 0
    assert collection.count() == 3

    second = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    assert second["new_files"] == 0
    assert second["changed_files"] == 0
    assert second["removed_files"] == 0
    assert second["ignored_files"] == 0
    assert second["unchanged_files"] == 3
    assert collection.count() == 3


def test_reconcile_reingests_changed_file_without_duplicate_chunks(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    doc = root / "doc.md"
    doc.write_text("v1", encoding="utf-8")

    collection = FakeCollection()
    monkeypatch.setattr(mmrag, "ingest_file", _fake_ingest_file)

    mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    original_count = collection.count()

    doc.write_text("v2", encoding="utf-8")
    changed = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)

    state = mmrag._collect_index_state(collection)
    source_path = str(doc.resolve())

    assert changed["changed_files"] == 1
    assert collection.count() == original_count
    assert state[source_path]["hashes"] == {mmrag._file_content_hash(doc)}


def test_reconcile_removes_missing_and_ignored_sources(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    keep = root / "keep.md"
    keep.write_text("keep", encoding="utf-8")
    remove_me = root / "remove.md"
    remove_me.write_text("remove", encoding="utf-8")

    ignored = tmp_path / ".claude" / "worktrees" / "dup.md"
    ignored.parent.mkdir(parents=True)
    ignored.write_text("dup", encoding="utf-8")

    collection = FakeCollection()
    monkeypatch.setattr(mmrag, "ingest_file", _fake_ingest_file)

    mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    _prime_source_chunks(collection, ignored, chunk_count=1, content_hash="ignored")
    remove_me.unlink()

    report = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)

    assert report["removed_files"] == 1
    assert report["ignored_files"] == 1
    assert collection.count() == 1


def test_reconcile_dry_run_mutates_nothing(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    doc = root / "doc.md"
    doc.write_text("v1", encoding="utf-8")

    collection = FakeCollection()
    monkeypatch.setattr(mmrag, "ingest_file", _fake_ingest_file)

    mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    before = collection.count()
    doc.write_text("v2", encoding="utf-8")

    dry_run = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=True)
    assert dry_run["changed_files"] == 1
    assert collection.count() == before


def test_ingest_text_metadata_includes_content_hash_and_source_mtime(tmp_path, monkeypatch):
    doc = tmp_path / "note.md"
    doc.write_text("hello world", encoding="utf-8")
    collection = FakeCollection()

    monkeypatch.setattr(mmrag, "embed_content", lambda client, config, content: [0.1])
    mmrag.args_force = False

    count = mmrag.ingest_text_file(None, {"text_chunk_size": 1000, "text_chunk_overlap": 0}, collection, doc)
    metadata = collection.get(include=["metadatas"])["metadatas"][0]

    assert count == 1
    assert metadata["source_file"] == str(doc.resolve())
    assert metadata["content_hash"] == mmrag._file_content_hash(doc)
    assert isinstance(metadata["source_mtime"], float)


def test_cmd_ingest_skips_explicit_ignored_path_without_force(tmp_path, monkeypatch, capsys):
    ignored = tmp_path / ".claude" / "worktrees" / "dup.md"
    ignored.parent.mkdir(parents=True)
    ignored.write_text("dup", encoding="utf-8")

    collection = FakeCollection()
    ingest_calls = []

    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag.UsageTracker, "summary_line", lambda self: "summary")
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: object())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    monkeypatch.setattr(mmrag, "ingest_file", lambda *args: ingest_calls.append(args[-1]) or 1)

    mmrag.cmd_ingest(SimpleNamespace(paths=[str(ignored)], collection="shared-clearworksai", force=False))

    captured = capsys.readouterr().out
    assert ingest_calls == []
    assert "SKIP (ignored)" in captured


def test_purge_batches_large_delete_sets(tmp_path):
    missing = tmp_path / "missing.md"
    collection = FakeCollection()
    _prime_source_chunks(collection, missing, chunk_count=mmrag.DELETE_BATCH_SIZE + 125, content_hash="missing")

    report = mmrag._purge_collection(collection, dry_run=False)

    assert report["purged_files"] == 1
    assert report["purged_chunks"] == mmrag.DELETE_BATCH_SIZE + 125
    assert len(collection.delete_calls) > 1
    assert all(len(batch) <= mmrag.DELETE_BATCH_SIZE for batch in collection.delete_calls)
    assert collection.count() == 0


def test_reconcile_batches_large_delete_sets_for_changed_source(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    doc = root / "doc.md"
    doc.write_text("v2", encoding="utf-8")

    collection = FakeCollection()
    _prime_source_chunks(
        collection,
        doc,
        chunk_count=mmrag.DELETE_BATCH_SIZE + 125,
        content_hash="old-hash",
    )
    monkeypatch.setattr(mmrag, "ingest_file", _fake_ingest_file)

    report = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)
    state = mmrag._collect_index_state(collection)

    assert report["changed_files"] == 1
    assert report["delete_failures"]["files"] == 0
    assert len(collection.delete_calls) > 1
    assert all(len(batch) <= mmrag.DELETE_BATCH_SIZE for batch in collection.delete_calls)
    assert state[str(doc.resolve())]["hashes"] == {mmrag._file_content_hash(doc)}


def test_reconcile_skips_reingest_when_a_delete_batch_fails(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    doc = root / "doc.md"
    doc.write_text("v2", encoding="utf-8")

    collection = FlakyDeleteCollection(fail_on_calls={1})
    _prime_source_chunks(
        collection,
        doc,
        chunk_count=mmrag.DELETE_BATCH_SIZE + 125,
        content_hash="old-hash",
    )
    ingest_calls = []
    monkeypatch.setattr(mmrag, "ingest_file", lambda *args: ingest_calls.append(args[-1]) or 1)

    report = mmrag._reconcile_collection(None, {}, collection, [root], dry_run=False)

    assert report["changed_files"] == 0
    assert report["delete_failures"]["files"] == 1
    assert ingest_calls == []
    assert report["total_files_indexed_after"] == 1
