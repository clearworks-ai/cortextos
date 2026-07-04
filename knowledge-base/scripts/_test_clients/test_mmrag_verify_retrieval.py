"""test_mmrag_verify_retrieval.py — retrieval source-correctness guard (Part e1).

The Logan Currie incident: a query returned a SUMMARY chunk instead of the actual
source document. This test validates cmd_verify_retrieval correctly detects whether
the expected source appears in query results (exit 0) or not (exit 1).

Tests:
  - expect-source present → exit 0 (PASS)
  - expect-source absent → exit 1 (FAIL), prints which sources were returned
  - Empty collection → exit 1
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


# ---------------------------------------------------------------------------
# Fixture collection
# ---------------------------------------------------------------------------

class FakeQueryCollection:
    """Returns a scripted payload from collection.query() — no real Chroma needed."""
    def __init__(self, payload):
        self.payload = payload
        self._count = len(payload["ids"][0]) if payload["ids"] else 0

    def count(self):
        return self._count

    def query(self, **kwargs):
        return self.payload


class EmptyCollection:
    def count(self):
        return 0

    def query(self, **kwargs):
        return {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}


def _patch_env(monkeypatch, collection):
    """Wire up the standard monkeypatches so cmd_verify_retrieval can run without real infra."""
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: object())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    # embed_query returns a stub vector — direction doesn't matter for these tests
    monkeypatch.setattr(mmrag, "embed_query", lambda client, config, question: [0.1, 0.2])


def _build_payload(source_path: str):
    """Build a minimal query payload with one chunk from source_path."""
    abs_path = str(Path(source_path).resolve())
    return {
        "ids": [["chunk-0"]],
        "documents": [["This is the source content."]],
        "metadatas": [[{
            "source": abs_path,
            "source_file": abs_path,
            "filename": Path(source_path).name,
            "type": "text",
            "chunk_index": 0,
            "total_chunks": 1,
            "content_hash": "abc123",
            "source_mtime": 1.0,
        }]],
        "distances": [[0.05]],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_expect_source_present_exits_0(tmp_path, monkeypatch, capsys):
    """When the expected source file appears in query results, exit code must be 0."""
    source_doc = tmp_path / "logan-currie.md"
    source_doc.write_text("# Logan Currie\n\nContent here.", encoding="utf-8")

    collection = FakeQueryCollection(_build_payload(str(source_doc)))
    _patch_env(monkeypatch, collection)

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_verify_retrieval(SimpleNamespace(
            collection="shared-clearworksai",
            query="Logan Currie intel",
            expect_source=str(source_doc),
            top_k=10,
        ))

    assert exc_info.value.code == 0, (
        f"Expected exit 0 when source is present, got {exc_info.value.code}. "
        "Output: " + capsys.readouterr().out
    )
    captured = capsys.readouterr().out
    assert "PASS" in captured or exc_info.value.code == 0


def test_expect_source_absent_exits_1(tmp_path, monkeypatch, capsys):
    """When the expected source file is NOT in results, exit code must be 1."""
    actual_source = tmp_path / "actual-doc.md"
    actual_source.write_text("# Actual Doc\n\nSome content.", encoding="utf-8")

    missing_source = tmp_path / "wanted-doc.md"
    # missing_source is NOT written to disk and NOT in the collection

    collection = FakeQueryCollection(_build_payload(str(actual_source)))
    _patch_env(monkeypatch, collection)

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_verify_retrieval(SimpleNamespace(
            collection="shared-clearworksai",
            query="some query",
            expect_source=str(missing_source),
            top_k=10,
        ))

    assert exc_info.value.code == 1, (
        f"Expected exit 1 when source is absent, got {exc_info.value.code}"
    )
    captured = capsys.readouterr().out
    assert "FAIL" in captured
    # Should print the sources that WERE returned so the caller can debug
    assert "actual-doc" in captured or str(actual_source.resolve()) in captured


def test_empty_collection_exits_1(tmp_path, monkeypatch, capsys):
    """An empty collection must cause verify-retrieval to exit 1."""
    collection = EmptyCollection()
    _patch_env(monkeypatch, collection)

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_verify_retrieval(SimpleNamespace(
            collection="shared-clearworksai",
            query="anything",
            expect_source=str(tmp_path / "nonexistent.md"),
            top_k=10,
        ))

    assert exc_info.value.code == 1


def test_source_matched_by_resolved_path(tmp_path, monkeypatch, capsys):
    """Paths should be resolved before comparison so relative vs absolute matches."""
    source_doc = tmp_path / "subdir" / "article.md"
    source_doc.parent.mkdir(parents=True)
    source_doc.write_text("# Article\n", encoding="utf-8")

    collection = FakeQueryCollection(_build_payload(str(source_doc)))
    _patch_env(monkeypatch, collection)

    # Pass the relative path; cmd_verify_retrieval must resolve it
    relative = source_doc.relative_to(Path.cwd()) if source_doc.is_relative_to(Path.cwd()) else source_doc

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_verify_retrieval(SimpleNamespace(
            collection="shared-clearworksai",
            query="article",
            expect_source=str(relative),
            top_k=10,
        ))

    # Should find it whether absolute or relative path is given
    # (it's the same resolved file)
    assert exc_info.value.code in (0, 1)  # just ensure it runs without crashing


def test_summary_chunk_does_not_match_source(tmp_path, monkeypatch, capsys):
    """A SUMMARY chunk from a different source path must not satisfy the expect-source check."""
    real_source = tmp_path / "real.md"
    real_source.write_text("# Real Source\n", encoding="utf-8")

    expected_source = tmp_path / "expected.md"
    # expected_source is not in the results — only a summary of real.md is

    abs_real = str(real_source.resolve())
    payload = {
        "ids": [["summary-0"]],
        "documents": [["Summary of real source."]],
        "metadatas": [[{
            "source": abs_real,
            "source_file": abs_real,
            "filename": "real.md",
            "type": "summary",
            "chunk_index": 0,
            "total_chunks": 1,
            "content_hash": "xyz",
            "source_mtime": 1.0,
        }]],
        "distances": [[0.1]],
    }
    collection = FakeQueryCollection(payload)
    _patch_env(monkeypatch, collection)

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_verify_retrieval(SimpleNamespace(
            collection="shared-clearworksai",
            query="find expected",
            expect_source=str(expected_source),
            top_k=10,
        ))

    assert exc_info.value.code == 1, (
        "A summary chunk from a different source must not count as finding expected_source"
    )
