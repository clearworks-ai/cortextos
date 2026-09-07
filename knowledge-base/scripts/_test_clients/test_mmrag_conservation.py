"""FR-009 Comparator C. JSON fixtures only. No Chroma import."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-conserve-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery


def test_conservation_passes_matching_paths_and_ordinals():
    oracle_a = {
        "files": [
            {"path": "/wiki/a.md", "sha256": "aa"},
            {"path": "/raw/b.txt", "sha256": "bb"},
        ]
    }
    oracle_b = {
        "chunks": [
            {"id": "1", "source_file": "/wiki/a.md", "chunk_index": 0, "text_sha256": "t0"},
            {"id": "2", "source_file": "/wiki/a.md", "chunk_index": 1, "text_sha256": "t1"},
            {"id": "3", "source_file": "/raw/b.txt", "chunk_index": 0, "text_sha256": "t2"},
        ]
    }
    receipt = mmrag_recovery.compare_conservation(oracle_a, oracle_b)
    assert receipt["result"] == "CONSERVATION_PASS"
    assert receipt["source_count"] == 2


def test_conservation_fails_when_a_file_is_dropped():
    oracle_a = {
        "files": [
            {"path": "/wiki/a.md", "sha256": "aa"},
            {"path": "/raw/b.txt", "sha256": "bb"},
        ]
    }
    oracle_b = {
        "chunks": [
            {"id": "1", "source_file": "/wiki/a.md", "chunk_index": 0, "text_sha256": "t0"},
        ]
    }
    with pytest.raises(mmrag_recovery.ConservationFailed):
        mmrag_recovery.compare_conservation(oracle_a, oracle_b)


def test_conservation_source_has_no_chroma_import():
    source = Path(mmrag_recovery.__file__).read_text(encoding="utf-8")
    _, body = source.split("def compare_conservation", 1)
    assert "import chromadb" not in body
    assert "PersistentClient(" not in body


def test_gold_queries_come_from_corpus_files_not_live_query():
    inventory = {
        "files": [
            {"path": "/Users/joshweiss/code/knowledge-sync/wiki/alpha-runbook.md"},
            {"path": "/Users/joshweiss/code/knowledge-sync/raw/notes.txt"},
        ]
    }
    gold = mmrag_recovery.author_gold_queries(inventory, limit=2)
    assert gold["not_from"] == "live-kb-query"
    assert gold["queries"][0]["expected_source"].endswith("alpha-runbook.md")
    assert gold["sha256"]
    again = mmrag_recovery.author_gold_queries(inventory, limit=2)
    assert again["sha256"] == gold["sha256"]
