"""Chunked resume: clone confirmed IDs, never replay them, small atomic chunks."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-chunked-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery


def _seed_generation(root, name, completed):
    work = root / name
    persist = work / "chromadb"
    persist.mkdir(parents=True)
    sqlite = persist / "chroma.sqlite3"
    sqlite.write_bytes(b"confirmed-sqlite")
    (work / "embedding-cache.sqlite").write_bytes(b"cache")
    mmrag_recovery._write_supervised_progress(
        work / "supervised-ingest-progress.json",
        {
            "persist": str(persist.resolve()),
            "completed": completed,
            "collection": "shared-clearworksai",
        },
    )
    return work, sqlite


def test_clone_copies_persist_and_does_not_mutate_source(tmp_path):
    completed = [str(tmp_path / "a.md"), str(tmp_path / "b.md")]
    src, sqlite = _seed_generation(tmp_path, "recovery-side-3", completed)
    before = sqlite.read_bytes()
    before_stat = (sqlite.stat().st_size, sqlite.stat().st_mtime_ns)
    dest = tmp_path / "recovery-side-4"
    receipt = mmrag_recovery.clone_confirmed_generation(src, dest)
    assert receipt["result"] == "CLONE_OK"
    assert receipt["completed_count"] == 2
    assert (dest / "chromadb/chroma.sqlite3").read_bytes() == before
    assert sqlite.read_bytes() == before
    assert (sqlite.stat().st_size, sqlite.stat().st_mtime_ns) == before_stat
    cloned_progress = json_progress(dest)
    assert cloned_progress["persist"] == str((dest / "chromadb").resolve())
    assert cloned_progress["completed"] == completed


def json_progress(work):
    import json
    return json.loads((work / "supervised-ingest-progress.json").read_text(encoding="utf-8"))


def test_clone_refuses_overwrite_of_source_generation(tmp_path):
    src, _sqlite = _seed_generation(tmp_path, "recovery-side-3", ["a"])
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.clone_confirmed_generation(src, src)


def test_confirmed_ids_must_all_survive_in_store_export():
    completed = ["/wiki/a.md", "/wiki/b.md"]
    present = ["/wiki/a.md", "/wiki/b.md", "/wiki/partial.md"]
    receipt = mmrag_recovery.verify_confirmed_source_ids(completed, present)
    assert receipt["result"] == "CONFIRMED_IDS_OK"
    assert receipt["confirmed_count"] == 2
    assert receipt["extra_in_store"] == ["/wiki/partial.md"]
    with pytest.raises(mmrag_recovery.ConservationFailed):
        mmrag_recovery.verify_confirmed_source_ids(completed, ["/wiki/a.md"])


def test_remaining_manifest_excludes_everything_already_in_store():
    inventory = {
        "files": [
            {"path": "/wiki/a.md"},
            {"path": "/wiki/b.md"},
            {"path": "/wiki/c.md"},
            {"path": "/wiki/d.md"},
        ]
    }
    present = ["/wiki/a.md", "/wiki/b.md", "/wiki/partial-from-failed-batch.md"]
    manifest = mmrag_recovery.remaining_file_manifest(inventory, present)
    assert manifest["result"] == "REMAINING_MANIFEST_OK"
    assert manifest["remaining"] == ["/wiki/c.md", "/wiki/d.md"]
    assert "/wiki/a.md" not in manifest["remaining"]


def test_remaining_manifest_skips_zero_chunk_progress_attempts():
    inventory = {
        "files": [
            {"path": "/wiki/done-no-chunks.xls"},
            {"path": "/wiki/in-store.md"},
            {"path": "/wiki/unfinished.md"},
        ]
    }
    present = ["/wiki/in-store.md"]
    completed = ["/wiki/done-no-chunks.xls", "/wiki/in-store.md"]
    manifest = mmrag_recovery.remaining_file_manifest(inventory, present, completed)
    assert manifest["remaining"] == ["/wiki/unfinished.md"]
    assert manifest["zero_chunk_attempts"] == ["/wiki/done-no-chunks.xls"]
    assert "/wiki/done-no-chunks.xls" not in manifest["remaining"]


def test_store_ids_must_survive_a_later_chunk():
    before = ["/wiki/a.md", "/wiki/b.md", "/wiki/partial.md"]
    after = ["/wiki/a.md", "/wiki/b.md", "/wiki/partial.md", "/wiki/next.srt"]
    receipt = mmrag_recovery.verify_store_ids_survived(before, after)
    assert receipt["result"] == "STORE_IDS_SURVIVED"
    assert receipt["before_count"] == 3
    assert receipt["added"] == ["/wiki/next.srt"]
    with pytest.raises(mmrag_recovery.ConservationFailed):
        mmrag_recovery.verify_store_ids_survived(before, ["/wiki/a.md", "/wiki/next.srt"])


def test_snapshot_copies_persist_without_mutating_source(tmp_path):
    src = tmp_path / "recovery-side-4" / "chromadb"
    src.mkdir(parents=True)
    sqlite = src / "chroma.sqlite3"
    sqlite.write_bytes(b"v4-bytes")
    before = sqlite.read_bytes()
    before_stat = (sqlite.stat().st_size, sqlite.stat().st_mtime_ns)
    dest = tmp_path / "recovery-side-4" / "chromadb.pre-chunk-1"
    receipt = mmrag_recovery.snapshot_side_persist(src, dest)
    assert receipt["result"] == "SNAPSHOT_OK"
    assert (dest / "chroma.sqlite3").read_bytes() == before
    assert sqlite.read_bytes() == before
    assert (sqlite.stat().st_size, sqlite.stat().st_mtime_ns) == before_stat
    v3_dest = tmp_path / "recovery-side-3" / "chromadb.pre-chunk-1"
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.snapshot_side_persist(src, v3_dest)


def test_next_chunk_is_small_and_isolates_oversized_json(tmp_path):
    files = []
    for index in range(10):
        path = tmp_path / f"doc-{index}.md"
        path.write_text("x\n", encoding="utf-8")
        files.append(str(path))
    large = tmp_path / "full-transcript.json"
    with large.open("wb") as handle:
        handle.seek(mmrag_recovery.LARGE_JSON_MIN_BYTES - 1)
        handle.write(b"x")
    first = mmrag_recovery.next_atomic_chunk(files + [str(large)])
    assert first["kind"] == "default"
    assert len(first["files"]) == mmrag_recovery.ISOLATED_CHUNK_MAX_FILES
    assert first["timeout_s"] == mmrag_recovery.ISOLATED_CHUNK_TIMEOUT_S
    assert first["timeout_s"] < 6 * 3600
    rest = files[mmrag_recovery.ISOLATED_CHUNK_MAX_FILES:] + [str(large)]
    second = mmrag_recovery.next_atomic_chunk(rest)
    assert second["kind"] == "default"
    assert second["files"] == files[8:10]
    third = mmrag_recovery.next_atomic_chunk([str(large)])
    assert third["kind"] == "large_json"
    assert third["files"] == [str(large)]
    assert third["timeout_s"] == mmrag_recovery.ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S


def test_failed_chunk_may_retry_only_that_chunk_not_confirmed(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    confirmed = tmp_path / "done.md"
    confirmed.write_text("done\n", encoding="utf-8")
    pending = tmp_path / "next.md"
    pending.write_text("next\n", encoding="utf-8")
    calls = []

    def fake_worker(argv, **kwargs):
        calls.append({"files": argv[2:-3], "timeout_s": kwargs.get("timeout_s")})
        return {"result": "WORKER_TIMEOUT", "retry": False, "timeout_s": kwargs.get("timeout_s")}

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.run_one_recovery_chunk(
        [str(pending)],
        confirmed_paths=[str(confirmed)],
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        chunk_receipt_path=tmp_path / "chunk-receipt.json",
    )
    assert receipt["result"] == "WORKER_TIMEOUT"
    assert receipt["retry_chunk"] is True
    assert receipt["replay_confirmed"] is False
    assert calls[0]["files"] == [str(pending)]
    assert str(confirmed) not in calls[0]["files"]


def test_run_one_chunk_refuses_to_replay_confirmed_paths(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    confirmed = tmp_path / "done.md"
    confirmed.write_text("done\n", encoding="utf-8")

    def fake_worker(*_args, **_kwargs):
        raise AssertionError("must not ingest confirmed IDs")

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.run_one_recovery_chunk(
            [str(confirmed)],
            confirmed_paths=[str(confirmed)],
            python_executable=sys.executable,
            mmrag_py=tmp_path / "mmrag.py",
            env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
            progress_path=tmp_path / "progress.json",
            log_path=tmp_path / "log.txt",
            chunk_receipt_path=tmp_path / "chunk-receipt.json",
        )


def test_run_one_chunk_refuses_progress_replay_before_worker(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    attempted = tmp_path / "zero-chunk.xls"
    attempted.write_text("xls\n", encoding="utf-8")
    mmrag_recovery._write_supervised_progress(
        tmp_path / "progress.json",
        {
            "persist": str(side.resolve()),
            "completed": [str(attempted)],
            "collection": "shared-clearworksai",
        },
    )

    def fake_worker(*_args, **_kwargs):
        raise AssertionError("must not ingest confirmed progress IDs")

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.run_one_recovery_chunk(
            [str(attempted)],
            confirmed_paths=[],
            python_executable=sys.executable,
            mmrag_py=tmp_path / "mmrag.py",
            env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
            progress_path=tmp_path / "progress.json",
            log_path=tmp_path / "log.txt",
            chunk_receipt_path=tmp_path / "chunk-receipt.json",
        )
