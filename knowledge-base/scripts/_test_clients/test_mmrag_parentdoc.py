import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class FakeQueryCollection:
    def __init__(self, payload):
        self.payload = payload

    def count(self):
        return len(self.payload["ids"][0])

    def query(self, **kwargs):
        return self.payload


def _patch_query_env(monkeypatch, collection):
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: object())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    monkeypatch.setattr(mmrag, "embed_query", lambda client, config, question: [0.1])


def test_query_docs_json_groups_documents_and_reads_full_text(tmp_path, monkeypatch, capsys):
    doc_a = tmp_path / "alpha.md"
    doc_a.write_text("# Alpha\n\nAlpha body\n", encoding="utf-8")
    doc_b = tmp_path / "beta.md"
    doc_b.write_text("# Beta\n\nBeta body\n", encoding="utf-8")

    payload = {
        "ids": [["a1", "a2", "b1"]],
        "documents": [["Alpha highlight", "Alpha backup", "Beta highlight"]],
        "metadatas": [[
            {"source": str(doc_a.resolve()), "source_file": str(doc_a.resolve()), "filename": "alpha.md", "type": "text"},
            {"source": str(doc_a.resolve()), "source_file": str(doc_a.resolve()), "filename": "alpha.md", "type": "text"},
            {"source": str(doc_b.resolve()), "source_file": str(doc_b.resolve()), "filename": "beta.md", "type": "text"},
        ]],
        "distances": [[0.1, 0.25, 0.2]],
    }
    collection = FakeQueryCollection(payload)
    _patch_query_env(monkeypatch, collection)

    mmrag.cmd_query(SimpleNamespace(
        question="alpha",
        top_k=5,
        threshold=None,
        max_tokens=0,
        collection="shared-clearworksai",
        type=None,
        json=True,
        full=True,
        docs=True,
        parent=False,
        top_docs=2,
        no_recency=True,
    ))

    output = json.loads(capsys.readouterr().out)
    assert output["documents"][0]["source_file"] == str(doc_a.resolve())
    assert output["documents"][1]["source_file"] == str(doc_b.resolve())
    assert "chunks" in output
    assert "results" in output
    assert output["full_document"]["content"] == doc_a.read_text(encoding="utf-8")


def test_query_docs_full_truncates_oversized_document(tmp_path, monkeypatch, capsys):
    doc_a = tmp_path / "huge.md"
    doc_a.write_text("A" * (mmrag.MAX_FULL_DOC_BYTES + 128), encoding="utf-8")

    payload = {
        "ids": [["a1"]],
        "documents": [["Alpha highlight"]],
        "metadatas": [[
            {"source": str(doc_a.resolve()), "source_file": str(doc_a.resolve()), "filename": "huge.md", "type": "text"},
        ]],
        "distances": [[0.05]],
    }
    collection = FakeQueryCollection(payload)
    _patch_query_env(monkeypatch, collection)

    mmrag.cmd_query(SimpleNamespace(
        question="huge",
        top_k=5,
        threshold=None,
        max_tokens=0,
        collection="shared-clearworksai",
        type=None,
        json=True,
        full=True,
        docs=True,
        parent=False,
        top_docs=1,
        no_recency=True,
    ))

    output = json.loads(capsys.readouterr().out)
    assert output["full_document"]["truncated"] is True
    assert "note" in output["full_document"]


def test_default_query_output_stays_chunk_oriented(tmp_path, monkeypatch, capsys):
    doc_a = tmp_path / "alpha.md"
    doc_a.write_text("# Alpha\n\nAlpha body\n", encoding="utf-8")

    payload = {
        "ids": [["a1"]],
        "documents": [["Alpha highlight"]],
        "metadatas": [[
            {"source": str(doc_a.resolve()), "source_file": str(doc_a.resolve()), "filename": "alpha.md", "type": "text"},
        ]],
        "distances": [[0.1]],
    }
    collection = FakeQueryCollection(payload)
    _patch_query_env(monkeypatch, collection)

    mmrag.cmd_query(SimpleNamespace(
        question="alpha",
        top_k=5,
        threshold=None,
        max_tokens=0,
        collection="shared-clearworksai",
        type=None,
        json=False,
        full=False,
        docs=False,
        parent=False,
        top_docs=1,
        no_recency=True,
    ))

    output = capsys.readouterr().out
    assert "Results:" in output
    assert "Content:" in output
    assert "Documents:" not in output
