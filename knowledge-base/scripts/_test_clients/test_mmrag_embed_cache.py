import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class _EmbedValues:
    def __init__(self, values):
        self.values = values


class _EmbedResponse:
    def __init__(self, values):
        self.embeddings = [_EmbedValues(values)]


class CountingEmbedModels:
    def __init__(self):
        self.embed_attempts = 0

    def embed_content(self, model=None, contents=None, config=None, **kwargs):
        self.embed_attempts += 1
        digest = hashlib.sha256(
            mmrag._canonical_embed_bytes(contents)
            + model.encode("utf-8")
            + str(getattr(config, "task_type", "")).encode("utf-8")
        ).digest()
        values = [float(digest[0]), float(digest[1]), float(self.embed_attempts)]
        return _EmbedResponse(values)


class CountingEmbedClient:
    def __init__(self):
        self.models = CountingEmbedModels()


class DiskBackedCollection:
    def __init__(self, storage_dir, name, *, ndarray_embeddings=False):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.name = name
        self.ndarray_embeddings = ndarray_embeddings
        self._path = self.storage_dir / f"{name}.json"
        if not self._path.exists():
            self._path.write_text("{}", encoding="utf-8")

    def _load(self):
        return json.loads(self._path.read_text(encoding="utf-8"))

    def _save(self, payload):
        self._path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")

    def count(self):
        return len(self._load())

    def get(self, ids=None, include=None, limit=None, offset=None):
        payload = self._load()
        keys = list(payload.keys()) if ids is None else [doc_id for doc_id in ids if doc_id in payload]
        start = offset or 0
        end = None if limit is None else start + limit
        keys = keys[start:end]

        result = {"ids": keys}
        include = include or []
        if "documents" in include:
            result["documents"] = [payload[key]["document"] for key in keys]
        if "embeddings" in include:
            embeddings = [payload[key]["embedding"] for key in keys]
            result["embeddings"] = np.array(embeddings, dtype=float) if self.ndarray_embeddings else embeddings
        if "metadatas" in include:
            result["metadatas"] = [payload[key]["metadata"] for key in keys]
        return result

    def upsert(self, ids, embeddings=None, documents=None, metadatas=None):
        payload = self._load()
        for idx, doc_id in enumerate(ids):
            payload[doc_id] = {
                "document": documents[idx] if documents else "",
                "embedding": embeddings[idx] if embeddings else None,
                "metadata": metadatas[idx] if metadatas else {},
            }
        self._save(payload)

    def delete(self, ids):
        payload = self._load()
        for doc_id in ids:
            payload.pop(doc_id, None)
        self._save(payload)


class DiskBackedClient:
    def __init__(self, storage_dir, *, ndarray_embeddings=False):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.ndarray_embeddings = ndarray_embeddings

    def get_or_create_collection(self, name, metadata=None):
        return DiskBackedCollection(self.storage_dir, name, ndarray_embeddings=self.ndarray_embeddings)

    def get_collection(self, name):
        path = self.storage_dir / f"{name}.json"
        if not path.exists():
            raise KeyError(name)
        return DiskBackedCollection(self.storage_dir, name, ndarray_embeddings=self.ndarray_embeddings)

    def list_collections(self):
        return [type("CollectionRef", (), {"name": path.stem}) for path in self.storage_dir.glob("*.json")]

    def close(self):
        return None


def _patch_disk_chroma(monkeypatch, *, ndarray_embeddings=False):
    monkeypatch.setattr(
        mmrag,
        "get_chroma_client",
        lambda chroma_dir=None: DiskBackedClient(
            chroma_dir or mmrag.CHROMADB_DIR,
            ndarray_embeddings=ndarray_embeddings,
        ),
    )


def _snapshot_tree(root):
    root = Path(root)
    if not root.exists():
        return {}
    snapshot = {}
    for file_path in sorted(path for path in root.rglob("*") if path.is_file()):
        snapshot[str(file_path.relative_to(root))] = file_path.read_bytes()
    return snapshot


def _seed_live_chunk(collection, file_path, document, embedding):
    resolved = Path(file_path).resolve()
    collection.upsert(
        ids=[mmrag.file_id(resolved, 0)],
        documents=[document],
        embeddings=[embedding],
        metadatas=[mmrag._common_source_metadata(resolved)],
    )


def _configure_cache(monkeypatch, tmp_path):
    monkeypatch.delenv("MMRAG_EMBED_CACHE", raising=False)
    monkeypatch.setenv("MMRAG_EMBED_CACHE_PATH", str(tmp_path / "embedding-cache.sqlite"))


def test_embed_cache_hit_skips_api(tmp_path, monkeypatch):
    _configure_cache(monkeypatch, tmp_path)
    client = CountingEmbedClient()

    first = mmrag.embed_content(client, {}, "same chunk")
    second = mmrag.embed_content(client, {}, "same chunk")

    assert first == second
    assert client.models.embed_attempts == 1


def test_embed_cache_key_respects_content_model_and_task_type(tmp_path, monkeypatch):
    _configure_cache(monkeypatch, tmp_path)
    client = CountingEmbedClient()

    first = mmrag.embed_content(client, {"embedding_model": "model-a"}, "same chunk")
    second = mmrag.embed_content(client, {"embedding_model": "model-a"}, "same chunk")
    mmrag.embed_content(client, {"embedding_model": "model-a"}, "same chunk!", task_type="RETRIEVAL_DOCUMENT")
    mmrag.embed_content(client, {"embedding_model": "model-b"}, "same chunk", task_type="RETRIEVAL_DOCUMENT")
    mmrag.embed_content(client, {"embedding_model": "model-a"}, "same chunk", task_type="RETRIEVAL_QUERY")

    same_multimodal = mmrag._embed_cache_signature({}, ["desc", b"bytes"], "RETRIEVAL_DOCUMENT")["content_key"]
    same_multimodal_again = mmrag._embed_cache_signature({}, ["desc", b"bytes"], "RETRIEVAL_DOCUMENT")["content_key"]
    changed_multimodal = mmrag._embed_cache_signature({}, ["desc", b"other"], "RETRIEVAL_DOCUMENT")["content_key"]

    assert first == second
    assert client.models.embed_attempts == 4
    assert same_multimodal == same_multimodal_again
    assert same_multimodal != changed_multimodal


def test_embed_cache_disabled_falls_back_to_plain_embedding(tmp_path, monkeypatch):
    monkeypatch.setenv("MMRAG_EMBED_CACHE", "0")
    monkeypatch.setenv("MMRAG_EMBED_CACHE_PATH", str(tmp_path / "embedding-cache.sqlite"))
    client = CountingEmbedClient()

    mmrag.embed_content(client, {}, "same chunk")
    mmrag.embed_content(client, {}, "same chunk")

    assert client.models.embed_attempts == 2


def test_rebuild_resume_uses_checkpoint_and_preserves_live_store(tmp_path, monkeypatch):
    _configure_cache(monkeypatch, tmp_path)
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (root / name).write_text(name, encoding="utf-8")

    before = _snapshot_tree(live_dir)
    _patch_disk_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    failure_state = {"raised": False}

    def flaky_ingest(client, config, collection, file_path):
        file_path = Path(file_path)
        if file_path.name == "b.md" and not failure_state["raised"]:
            failure_state["raised"] = True
            raise RuntimeError("mid-run failure")
        return mmrag.ingest_text_file(client, config, collection, file_path)

    monkeypatch.setattr(mmrag, "ingest_file", flaky_ingest)
    first_client = CountingEmbedClient()
    first = mmrag._rebuild_collection(
        first_client,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert first["swap_succeeded"] is False
    assert first["swap_aborted"] is True
    assert _snapshot_tree(live_dir) == before
    assert first_client.models.embed_attempts == 2

    second_client = CountingEmbedClient()
    second = mmrag._rebuild_collection(
        second_client,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    assert second["swap_succeeded"] is True
    assert second["checkpoint_resumed"] is True
    assert second["resumed_files"] == 2
    assert second["temp_dir"] == first["temp_dir"]
    assert second_client.models.embed_attempts == 1


def test_rebuild_backfills_cache_from_live_collection(tmp_path, monkeypatch):
    _configure_cache(monkeypatch, tmp_path)
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    existing_a = root / "a.md"
    existing_b = root / "b.md"
    new_c = root / "c.md"
    existing_a.write_text("a body", encoding="utf-8")
    existing_b.write_text("b body", encoding="utf-8")
    new_c.write_text("c body", encoding="utf-8")

    live_client = DiskBackedClient(live_dir)
    live_collection = live_client.get_or_create_collection("shared-clearworksai")
    _seed_live_chunk(live_collection, existing_a, "a body", [9.0, 1.0, 0.0])
    _seed_live_chunk(live_collection, existing_b, "b body", [8.0, 1.0, 0.0])

    _patch_disk_chroma(monkeypatch, ndarray_embeddings=True)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    client = CountingEmbedClient()
    report = mmrag._rebuild_collection(
        client,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=True,
        force=False,
    )

    assert report["swap_succeeded"] is True
    assert report["cache_backfill"]["backfilled"] == 2
    assert report["cache_backfill"]["lazy_fallback"] is False
    assert client.models.embed_attempts == 1


def test_rebuild_fresh_ignores_checkpoint(tmp_path, monkeypatch):
    _configure_cache(monkeypatch, tmp_path)
    live_dir = tmp_path / "chromadb"
    root = tmp_path / "root"
    root.mkdir()
    for name in ("a.md", "b.md", "c.md"):
        (root / name).write_text(name, encoding="utf-8")

    _patch_disk_chroma(monkeypatch)
    monkeypatch.setattr(mmrag, "CHROMADB_DIR", live_dir)

    failure_state = {"raised": False}

    def flaky_ingest(client, config, collection, file_path):
        file_path = Path(file_path)
        if file_path.name == "b.md" and not failure_state["raised"]:
            failure_state["raised"] = True
            raise RuntimeError("mid-run failure")
        return mmrag.ingest_text_file(client, config, collection, file_path)

    monkeypatch.setattr(mmrag, "ingest_file", flaky_ingest)
    first = mmrag._rebuild_collection(
        CountingEmbedClient(),
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
    )

    second_client = CountingEmbedClient()
    second = mmrag._rebuild_collection(
        second_client,
        {},
        "shared-clearworksai",
        [root],
        dry_run=False,
        allow_shrink=False,
        force=False,
        fresh=True,
    )

    assert second["swap_succeeded"] is True
    assert second["checkpoint_resumed"] is False
    assert second["resumed_files"] == 0
    assert second["temp_dir"] != first["temp_dir"]
    assert second_client.models.embed_attempts == 1
