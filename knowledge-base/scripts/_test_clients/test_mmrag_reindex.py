import os
import sys
from pathlib import Path


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


def test_reindex_preserves_intro_and_uses_title_fallbacks(tmp_path):
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "intelligence"
    topic_dir.mkdir(parents=True)

    (topic_dir / "alpha.md").write_text(
        "---\n"
        "title: Alpha Title\n"
        "description: Alpha summary\n"
        "---\n"
        "alpha body\n",
        encoding="utf-8",
    )
    (topic_dir / "beta.md").write_text("# Beta Heading\n\nbeta body\n", encoding="utf-8")
    (topic_dir / "gamma-note.md").write_text("plain body\n", encoding="utf-8")
    index_path = topic_dir / "_index.md"
    index_path.write_text(
        "# Intelligence\n\n"
        "Manual intro stays here.\n\n"
        f"{mmrag.AUTO_INDEX_BEGIN}\n"
        f"{mmrag.AUTO_INDEX_END}\n",
        encoding="utf-8",
    )

    report = mmrag._reindex_indexes(wiki_root, dry_run=False)
    body = index_path.read_text(encoding="utf-8")

    assert report["indexes_updated"] == 1
    assert "Manual intro stays here." in body
    assert "- [[alpha|Alpha Title]]: Alpha summary" in body
    assert "- [[beta|Beta Heading]]" in body
    assert "- [[gamma-note|Gamma Note]]" in body


def test_reindex_appends_managed_block_when_index_has_no_markers_and_is_idempotent(tmp_path):
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "ops"
    topic_dir.mkdir(parents=True)

    (topic_dir / "one.md").write_text("# One\n", encoding="utf-8")
    (topic_dir / "two.md").write_text("# Two\n", encoding="utf-8")
    index_path = topic_dir / "_index.md"
    index_path.write_text("# Ops\n\nExisting body.\n", encoding="utf-8")

    first = mmrag._reindex_indexes(wiki_root, dry_run=False)
    first_body = index_path.read_text(encoding="utf-8")
    second = mmrag._reindex_indexes(wiki_root, dry_run=False)
    second_body = index_path.read_text(encoding="utf-8")

    assert first["indexes_updated"] == 1
    assert mmrag.AUTO_INDEX_BEGIN in first_body
    assert first_body.startswith("# Ops\n\nExisting body.")
    assert second["indexes_updated"] == 0
    assert second_body == first_body


def test_reindex_creates_missing_index_and_tracks_add_remove_changes(tmp_path):
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "sales"
    topic_dir.mkdir(parents=True)

    (topic_dir / "first.md").write_text("# First\n", encoding="utf-8")
    (topic_dir / "second.md").write_text("# Second\n", encoding="utf-8")

    created = mmrag._reindex_indexes(wiki_root, dry_run=False)
    index_path = topic_dir / "_index.md"
    created_body = index_path.read_text(encoding="utf-8")

    (topic_dir / "third.md").write_text("# Third\n", encoding="utf-8")
    added = mmrag._reindex_indexes(wiki_root, dry_run=False)
    added_body = index_path.read_text(encoding="utf-8")

    (topic_dir / "second.md").unlink()
    removed = mmrag._reindex_indexes(wiki_root, dry_run=False)
    removed_body = index_path.read_text(encoding="utf-8")

    assert created["indexes_created"] == 1
    assert "- [[first|First]]" in created_body
    assert "- [[second|Second]]" in created_body
    assert added["indexes_updated"] == 1
    assert "- [[third|Third]]" in added_body
    assert removed["indexes_updated"] == 1
    assert "- [[second|Second]]" not in removed_body


def test_reindex_dry_run_writes_nothing(tmp_path):
    wiki_root = tmp_path / "wiki"
    topic_dir = wiki_root / "delivery"
    topic_dir.mkdir(parents=True)

    (topic_dir / "one.md").write_text("# One\n", encoding="utf-8")
    (topic_dir / "two.md").write_text("# Two\n", encoding="utf-8")
    index_path = topic_dir / "_index.md"
    index_path.write_text("# Delivery\n", encoding="utf-8")
    original = index_path.read_text(encoding="utf-8")

    report = mmrag._reindex_indexes(wiki_root, dry_run=True)

    assert report["indexes_updated"] == 1
    assert report["diffs"]
    assert index_path.read_text(encoding="utf-8") == original
