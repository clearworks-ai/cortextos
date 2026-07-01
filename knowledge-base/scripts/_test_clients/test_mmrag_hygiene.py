import os
import sys
import time
from pathlib import Path

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


def _iso_local(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))


def test_is_ignored_by_dir_part_and_ext():
    assert mmrag._is_ignored(Path("/tmp/.trash/old.md")) is True
    assert mmrag._is_ignored(Path("/tmp/node_modules/pkg/index.js")) is True
    assert mmrag._is_ignored(Path("/tmp/archive/old.md")) is True
    assert mmrag._is_ignored(Path("/tmp/.claude/worktrees/dup.md")) is True
    assert mmrag._is_ignored(Path("/tmp/contacts-backup/person.md")) is True
    assert mmrag._is_ignored(Path("/tmp/.venv-synth/lib/python3.14/site-packages/httpx/_urls.py")) is True
    assert mmrag._is_ignored(Path("/tmp/.venv-synth/lib/python3.14/site-packages/pkg-1.0.dist-info/METADATA")) is True
    assert mmrag._is_ignored(Path("/tmp/diagram.drawio")) is True
    assert mmrag._is_ignored(Path("/tmp/contact.vcf")) is True
    assert mmrag._is_ignored(Path("/tmp/pic.png")) is False


def test_directory_walk_filter_keeps_multimodal_and_counts_skips(tmp_path):
    (tmp_path / ".trash").mkdir()
    (tmp_path / ".trash" / "old.md").write_text("old", encoding="utf-8")
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / ".obsidian" / "workspace.json").write_text("{}", encoding="utf-8")
    (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
    (tmp_path / "node_modules" / "pkg" / "index.js").write_text("export {}", encoding="utf-8")
    (tmp_path / "diagram.drawio").write_text("<xml/>", encoding="utf-8")
    (tmp_path / "note.md").write_text("note", encoding="utf-8")
    (tmp_path / "pic.png").write_bytes(b"\x89PNG\r\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "deep.md").write_text("deep", encoding="utf-8")

    all_files = sorted(
        path for path in tmp_path.rglob("*")
        if path.is_file() and not path.name.startswith(".")
    )
    kept = [path for path in all_files if not mmrag._is_ignored(path)]

    kept_paths = {path.relative_to(tmp_path).as_posix() for path in kept}
    assert kept_paths == {"note.md", "pic.png", "sub/deep.md"}
    assert len(all_files) - len(kept) == 4


def test_source_created_at_uses_file_mtime(tmp_path):
    file_path = tmp_path / "note.md"
    file_path.write_text("hello", encoding="utf-8")
    target_ts = 1_719_158_400
    os.utime(file_path, (target_ts, target_ts))

    assert mmrag._source_created_at(file_path) == _iso_local(target_ts)


def test_classify_doc_type_categories():
    assert mmrag._classify_doc_type(Path("/tmp/daily/note.md")) == "note"
    assert mmrag._classify_doc_type(Path("/tmp/decisions/decision-log.md")) == "decision"
    assert mmrag._classify_doc_type(Path("/tmp/wiki/playbook.md")) == "reference"
    assert mmrag._classify_doc_type(Path("/tmp/policy/security.md")) == "policy"
    assert mmrag._classify_doc_type(Path("/tmp/assets/screenshot.png")) == "media"
    assert mmrag._classify_doc_type(Path("/tmp/random/plain.txt")) == "other"


def test_recency_decay_profiles():
    now = time.mktime(time.strptime("2026-06-30T12:00:00", "%Y-%m-%dT%H:%M:%S"))
    fresh = "2026-06-30T12:00:00"
    note_half_life = "2026-05-31T12:00:00"
    old = "2026-03-02T12:00:00"

    assert mmrag._recency_decay(fresh, "note", now=now) == pytest.approx(1.0)
    assert mmrag._recency_decay(note_half_life, "note", now=now) == pytest.approx(0.5, rel=1e-6)
    assert mmrag._recency_decay("", "note", now=now) == pytest.approx(mmrag.NEUTRAL_DECAY)
    assert mmrag._recency_decay("not-a-date", "note", now=now) == pytest.approx(mmrag.NEUTRAL_DECAY)
    assert mmrag._recency_decay(old, "policy", now=now) > mmrag._recency_decay(old, "note", now=now)


def test_apply_recency_rerank_prefers_newer_result():
    now = time.mktime(time.strptime("2026-06-30T12:00:00", "%Y-%m-%dT%H:%M:%S"))
    results = [
        {
            "id": "older",
            "content": "same",
            "similarity": 0.9,
            "metadata": {"created_at": "2026-03-02T12:00:00", "doc_type": "note"},
        },
        {
            "id": "newer",
            "content": "same",
            "similarity": 0.9,
            "metadata": {"created_at": "2026-06-29T12:00:00", "doc_type": "note"},
        },
    ]

    reranked = mmrag._apply_recency_rerank(results, enabled=True, now=now)

    assert [result["id"] for result in reranked] == ["newer", "older"]
    assert reranked[0]["final_score"] > reranked[1]["final_score"]
    assert reranked[0]["recency"] > reranked[1]["recency"]


def test_apply_recency_rerank_disabled_preserves_existing_order():
    results = [
        {"id": "first", "content": "a", "similarity": 0.7, "metadata": {}},
        {"id": "second", "content": "b", "similarity": 0.7, "metadata": {}},
    ]

    same_results = mmrag._apply_recency_rerank(results, enabled=False, now=0)

    assert same_results is results
    assert [result["id"] for result in same_results] == ["first", "second"]
    assert "final_score" not in same_results[0]
