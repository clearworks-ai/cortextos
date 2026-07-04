"""test_mmrag_index_check.py — index drift detection (Part e1).

The Logan Currie incident root cause: an article was written to disk but never
added to its directory's _index.md, so it was invisible. This test validates
_check_wiki_index_drift correctly detects and reports that gap.

Tests:
  - A file absent from _index.md appears in missing_from_index.
  - After adding the file to the index, the check returns clean.
  - A file that IS in the index is not flagged.
  - An empty wiki root (no files) returns clean.
"""

import os
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

AUTO_BEGIN = mmrag.AUTO_INDEX_BEGIN
AUTO_END = mmrag.AUTO_INDEX_END


def _write_index(directory: Path, stems: list[str]):
    """Write a _index.md using mmrag's managed-block format referencing the given stems."""
    links = "\n".join(f"- [[{stem}|{stem.replace('-', ' ').title()}]]" for stem in stems)
    content = f"# Dir\n\n{AUTO_BEGIN}\n{links}\n{AUTO_END}\n"
    (directory / "_index.md").write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_missing_file_detected(tmp_path):
    """A file on disk that is absent from _index.md must appear in missing_from_index."""
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "intelligence"
    topic_dir.mkdir(parents=True)

    # Write the article to disk
    (topic_dir / "logan-currie.md").write_text("# Logan Currie\n\ncontent", encoding="utf-8")

    # Write an index that does NOT list logan-currie
    _write_index(topic_dir, ["other-article"])

    result = mmrag._check_wiki_index_drift(wiki_root)

    assert result["on_disk"] >= 1
    missing = result["missing_from_index"]
    assert any("logan-currie" in p for p in missing), (
        f"Expected 'logan-currie' in missing_from_index, got: {missing}"
    )


def test_after_adding_to_index_check_is_clean(tmp_path):
    """Once the article is added to _index.md, missing_from_index should be empty."""
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "intelligence"
    topic_dir.mkdir(parents=True)

    (topic_dir / "logan-currie.md").write_text("# Logan Currie\n\ncontent", encoding="utf-8")

    # Index lists the article — no drift expected
    _write_index(topic_dir, ["logan-currie"])

    result = mmrag._check_wiki_index_drift(wiki_root)

    missing = result["missing_from_index"]
    assert not any("logan-currie" in p for p in missing), (
        f"Expected no missing entries after indexing, but got: {missing}"
    )


def test_indexed_file_not_flagged(tmp_path):
    """A file that IS listed in the index must not appear in missing_from_index."""
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "ops"
    topic_dir.mkdir(parents=True)

    (topic_dir / "checklist.md").write_text("# Checklist\n", encoding="utf-8")
    (topic_dir / "runbook.md").write_text("# Runbook\n", encoding="utf-8")

    # Both files listed in the index
    _write_index(topic_dir, ["checklist", "runbook"])

    result = mmrag._check_wiki_index_drift(wiki_root)

    assert result["missing_from_index"] == [], (
        f"Expected empty missing_from_index, got: {result['missing_from_index']}"
    )


def test_underscore_files_are_excluded(tmp_path):
    """_index.md and other underscore files must not be reported as missing."""
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "area"
    topic_dir.mkdir(parents=True)

    (topic_dir / "_index.md").write_text("# Area Index\n", encoding="utf-8")
    (topic_dir / "_master-index.md").write_text("# Master\n", encoding="utf-8")
    (topic_dir / "real-article.md").write_text("# Real\n", encoding="utf-8")

    _write_index(topic_dir, ["real-article"])

    result = mmrag._check_wiki_index_drift(wiki_root)

    for path in result["missing_from_index"]:
        assert not Path(path).name.startswith("_"), (
            f"Underscore file {path!r} must not appear in missing_from_index"
        )


def test_empty_wiki_returns_clean(tmp_path):
    """An empty wiki root with no files should return on_disk == 0, missing == []."""
    wiki_root = tmp_path / "wiki"
    wiki_root.mkdir()

    result = mmrag._check_wiki_index_drift(wiki_root)

    assert result["on_disk"] == 0
    assert result["missing_from_index"] == []


def test_multiple_dirs_detected(tmp_path):
    """Drift across multiple subdirectories is all captured in one report."""
    wiki_root = tmp_path / "wiki"
    for subdir in ("area1", "area2"):
        d = wiki_root / subdir
        d.mkdir(parents=True)
        (d / "article.md").write_text(f"# Article in {subdir}\n", encoding="utf-8")
        # Neither directory has an index at all — all files are unindexed
        # (no _index.md means indexed_stems is empty)

    result = mmrag._check_wiki_index_drift(wiki_root)

    assert result["on_disk"] == 2
    assert len(result["missing_from_index"]) == 2


def test_report_structure(tmp_path):
    """The return dict must have the expected keys."""
    wiki_root = tmp_path / "wiki"
    wiki_root.mkdir()

    result = mmrag._check_wiki_index_drift(wiki_root)

    assert "wiki_root" in result
    assert "indexed" in result
    assert "on_disk" in result
    assert "missing_from_index" in result
    assert isinstance(result["missing_from_index"], list)
