"""test_mmrag_fail_loud.py — regression guard for the silent-fail ingest bug.

The Logan Currie / Anthropic-credits incident: mmrag.cmd_ingest counted errors but
never called sys.exit(1), so a run where every file failed still exited 0.

This test:
  - Injects an embed failure so every file errors.
  - Asserts that --fail-on-error causes exit 1 AND --json shows errored > 0, generated == 0.
  - Asserts that WITHOUT the flag the command exits 0 (no regression to existing callers).
  - This test MUST FAIL on the original code and PASS after the change.
"""

import json
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
# Minimal stubs
# ---------------------------------------------------------------------------

class _FailingEmbedModels:
    """Always raises on embed_content — simulates Gemini credit exhaustion."""
    def embed_content(self, *a, **kw):
        raise RuntimeError("Gemini API error: credit balance too low")


class _FailingEmbedClient:
    def __init__(self):
        self.models = _FailingEmbedModels()


class FakeCollection:
    """Minimal in-memory collection — no real Chroma dependency."""
    def __init__(self, name="test-collection"):
        self.name = name
        self.records = {}

    def count(self):
        return len(self.records)

    def get(self, ids=None, include=None, limit=None, offset=None):
        if ids is None:
            keys = list(self.records.keys())
        else:
            keys = [k for k in ids if k in self.records]
        start = offset or 0
        end = None if limit is None else start + limit
        keys = keys[start:end]
        return {
            "ids": keys,
            "metadatas": [self.records[k]["metadata"] for k in keys],
            "documents": [self.records[k]["document"] for k in keys],
        }

    def upsert(self, ids, embeddings=None, documents=None, metadatas=None):
        for idx, doc_id in enumerate(ids):
            self.records[doc_id] = {
                "document": documents[idx] if documents else "",
                "metadata": metadatas[idx] if metadatas else {},
            }

    def delete(self, ids):
        for doc_id in ids:
            self.records.pop(doc_id, None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_args(tmp_path, *, fail_on_error, use_json):
    """Build a SimpleNamespace matching cmd_ingest's expected args."""
    return SimpleNamespace(
        paths=[str(tmp_path)],
        collection="test-collection",
        force=False,
        fail_on_error=fail_on_error,
        json=use_json,
    )


def _seed_files(tmp_path, n=3):
    for i in range(n):
        (tmp_path / f"doc{i}.md").write_text(f"# Doc {i}\n\ncontent", encoding="utf-8")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_fail_on_error_exits_1_when_all_files_error(tmp_path, monkeypatch, capsys):
    """--fail-on-error must cause sys.exit(1) when every file fails to embed."""
    _seed_files(tmp_path)

    collection = FakeCollection()
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag.UsageTracker, "summary_line", lambda self: "summary")
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: _FailingEmbedClient())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    # embed_content raises for every file — simulates full credit depletion
    monkeypatch.setattr(mmrag, "embed_content", lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError("Gemini API error: credit balance too low")
    ))

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_ingest(_make_args(tmp_path, fail_on_error=True, use_json=False))

    assert exc_info.value.code == 1, (
        "cmd_ingest must exit(1) when errors > 0 and --fail-on-error is set. "
        "If this test fails on the ORIGINAL code, that confirms the bug exists."
    )
    # No new chunks should have been ingested
    assert collection.count() == 0


def test_fail_on_error_json_shows_errored_and_zero_generated(tmp_path, monkeypatch, capsys):
    """--json output must include errored > 0 and generated == 0 when all files fail."""
    _seed_files(tmp_path)

    collection = FakeCollection()
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag.UsageTracker, "summary_line", lambda self: "summary")
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: _FailingEmbedClient())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    monkeypatch.setattr(mmrag, "embed_content", lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError("Gemini API error: credit balance too low")
    ))

    with pytest.raises(SystemExit) as exc_info:
        mmrag.cmd_ingest(_make_args(tmp_path, fail_on_error=True, use_json=True))

    assert exc_info.value.code == 1

    captured = capsys.readouterr().out
    # The JSON line must be present and parseable
    json_lines = [line for line in captured.strip().splitlines() if line.startswith("{")]
    assert json_lines, f"No JSON line found in output:\n{captured}"
    payload = json.loads(json_lines[0])

    assert payload["generated"] == 0, f"Expected generated=0, got {payload['generated']}"
    assert payload["errored"] > 0, f"Expected errored>0, got {payload['errored']}"
    assert "collection" in payload
    assert "skipped" in payload


def test_no_fail_on_error_exits_0_despite_errors(tmp_path, monkeypatch, capsys):
    """WITHOUT --fail-on-error the command must exit 0 even when all files error.

    This proves no regression: existing callers that do NOT pass --fail-on-error
    keep the old silent behavior.
    """
    _seed_files(tmp_path)

    collection = FakeCollection()
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag.UsageTracker, "summary_line", lambda self: "summary")
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: _FailingEmbedClient())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    monkeypatch.setattr(mmrag, "embed_content", lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError("Gemini API error: credit balance too low")
    ))

    # Should NOT raise SystemExit
    mmrag.cmd_ingest(_make_args(tmp_path, fail_on_error=False, use_json=False))

    captured = capsys.readouterr().out
    assert "Errors:" in captured or "ERROR:" in captured, (
        "Expected at least one error to be printed, but output was:\n" + captured
    )
    # Normal exit (no sys.exit(1))


def test_json_happy_path_shows_generated_and_zero_errored(tmp_path, monkeypatch, capsys):
    """--json on a successful ingest must emit generated > 0, errored == 0, exit 0."""
    _seed_files(tmp_path)

    collection = FakeCollection()
    monkeypatch.setattr(mmrag.UsageTracker, "persist", lambda self: None)
    monkeypatch.setattr(mmrag.UsageTracker, "summary_line", lambda self: "summary")
    monkeypatch.setattr(mmrag, "load_config", lambda: {"text_chunk_size": 1000, "text_chunk_overlap": 0})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: None)
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: collection)
    # Successful embed returns a stub vector
    monkeypatch.setattr(mmrag, "embed_content", lambda client, config, content, **kw: [0.1, 0.2, 0.3])
    mmrag.args_force = False

    mmrag.cmd_ingest(_make_args(tmp_path, fail_on_error=False, use_json=True))

    captured = capsys.readouterr().out
    json_lines = [line for line in captured.strip().splitlines() if line.startswith("{")]
    assert json_lines, f"No JSON line found in output:\n{captured}"
    payload = json.loads(json_lines[0])

    assert payload["generated"] > 0, f"Expected generated>0 on happy path, got {payload['generated']}"
    assert payload["errored"] == 0, f"Expected errored=0 on happy path, got {payload['errored']}"
