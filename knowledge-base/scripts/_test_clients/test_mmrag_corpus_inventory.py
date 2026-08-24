"""FR-005 fixture corpus inventory (Oracle A).

Temp wiki/raw trees only. Never open Chroma or walk the live knowledge-base.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-inventory-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_ROOT = Path.home() / ".cortextos"
LIVE_KB = LIVE_ROOT / "cortextos1" / "orgs" / "clearworksai" / "knowledge-base"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _seed_roots(tmp_path):
    wiki = tmp_path / "wiki"
    raw = tmp_path / "raw"
    wiki.mkdir()
    raw.mkdir()
    keep_wiki = wiki / "keep.md"
    keep_wiki.write_text("# keep\n", encoding="utf-8")
    nested = wiki / "topics"
    nested.mkdir()
    keep_nested = nested / "note.md"
    keep_nested.write_text("nested\n", encoding="utf-8")
    ignored_dir = wiki / "node_modules"
    ignored_dir.mkdir()
    (ignored_dir / "pkg.md").write_text("ignored-dir\n", encoding="utf-8")
    (wiki / "skip.log").write_text("ignored-ext\n", encoding="utf-8")
    (wiki / ".hidden.md").write_text("hidden\n", encoding="utf-8")
    keep_raw = raw / "source.txt"
    keep_raw.write_text("raw-bytes\n", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("not-in-roots\n", encoding="utf-8")
    return wiki, raw, {
        "keep_wiki": keep_wiki,
        "keep_nested": keep_nested,
        "keep_raw": keep_raw,
        "outside": outside,
    }


def test_inventory_emits_canonical_rows_and_omits_ignored(tmp_path):
    wiki, raw, files = _seed_roots(tmp_path)
    receipt = mmrag_recovery.inventory_corpus_roots([wiki, raw])
    assert receipt["result"] == "INVENTORY_OK"
    rows = receipt["files"]
    paths = {row["path"] for row in rows}
    assert str(files["keep_wiki"].resolve()) in paths
    assert str(files["keep_nested"].resolve()) in paths
    assert str(files["keep_raw"].resolve()) in paths
    assert str(files["outside"].resolve()) not in paths
    assert not any("node_modules" in row["path"] for row in rows)
    assert not any(row["path"].endswith("skip.log") for row in rows)
    assert not any(Path(row["path"]).name.startswith(".") for row in rows)

    keep = next(row for row in rows if row["path"] == str(files["keep_wiki"].resolve()))
    expected = files["keep_wiki"].read_bytes()
    assert keep["sha256"] == _sha256_bytes(expected)
    assert keep["size"] == len(expected)
    assert "mtime_ns" in keep
    assert rows == sorted(rows, key=lambda row: row["path"])


def test_inventory_refuses_live_knowledge_base_root():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked):
        mmrag_recovery.inventory_corpus_roots([LIVE_KB])


def test_inventory_refuses_chroma_persist_root(tmp_path):
    persist = tmp_path / "chromadb"
    persist.mkdir()
    (persist / "chroma.sqlite3").write_bytes(b"not-corpus")
    with pytest.raises(mmrag_recovery.InventoryRefused):
        mmrag_recovery.inventory_corpus_roots([persist])


def test_inventory_requires_explicit_roots():
    with pytest.raises(mmrag_recovery.InventoryRefused):
        mmrag_recovery.inventory_corpus_roots(None)


def test_inventory_source_never_opens_chroma():
    source = Path(mmrag_recovery.__file__).read_text(encoding="utf-8")
    _, body = source.split("def inventory_corpus_roots", 1)
    assert "PersistentClient(" not in body
    assert "sqlite3.connect" not in body
    assert "import chromadb" not in body
