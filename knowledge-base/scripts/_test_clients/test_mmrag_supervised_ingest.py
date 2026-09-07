"""Supervised batch ingest: no 6h corpus wall, no retry after timeout."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-supervised-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery


def test_supervised_refuses_directory_roots_and_six_hour_wall(tmp_path):
    env = {"MMRAG_SIDE_CHROMADB_DIR": str(tmp_path / "side")}
    (tmp_path / "side").mkdir()
    root = tmp_path / "wiki"
    root.mkdir()
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.supervised_side_ingest(
            [root],
            python_executable=sys.executable,
            mmrag_py=tmp_path / "mmrag.py",
            env=env,
            progress_path=tmp_path / "progress.json",
            log_path=tmp_path / "log.txt",
        )
    one = tmp_path / "a.md"
    one.write_text("hi\n", encoding="utf-8")
    with pytest.raises(mmrag_recovery.RebuildRefused):
        mmrag_recovery.supervised_side_ingest(
            [one],
            python_executable=sys.executable,
            mmrag_py=tmp_path / "mmrag.py",
            env=env,
            progress_path=tmp_path / "progress.json",
            log_path=tmp_path / "log.txt",
            batch_timeout_s=6 * 3600,
        )


def test_supervised_timeout_does_not_start_next_batch_or_retry(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    files = []
    for index in range(3):
        path = tmp_path / f"doc-{index}.md"
        path.write_text(f"{index}\n", encoding="utf-8")
        files.append(path)
    calls = []

    def fake_worker(argv, **kwargs):
        calls.append({"argv": argv, "timeout_s": kwargs.get("timeout_s")})
        if len(calls) == 1:
            return {"result": "WORKER_TIMEOUT", "retry": False, "timeout_s": kwargs.get("timeout_s")}
        raise AssertionError("must not spawn another worker after WORKER_TIMEOUT")

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.supervised_side_ingest(
        files,
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        batch_size=1,
        batch_timeout_s=30,
    )
    assert receipt["result"] == "WORKER_TIMEOUT"
    assert receipt["retry"] is False
    assert receipt["batch_index"] == 0
    assert len(calls) == 1
    assert calls[0]["timeout_s"] == 30
    assert calls[0]["timeout_s"] < 6 * 3600
    assert not (tmp_path / "progress.json").exists()


def test_supervised_isolates_videos_into_single_file_batches(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    md = tmp_path / "note.md"
    md.write_text("ok\n", encoding="utf-8")
    video = tmp_path / "recording-video.mp4"
    video.write_bytes(b"not-really-mp4")
    calls = []

    def fake_worker(argv, **kwargs):
        # [mmrag, ingest, *files, -c, collection, --json]
        calls.append({"files": argv[2:-3], "timeout_s": kwargs.get("timeout_s")})
        return {"result": "WORKER_OK", "retry": False, "returncode": 0}

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.supervised_side_ingest(
        [md, video],
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        batch_size=80,
        batch_timeout_s=30,
    )
    assert receipt["result"] == "SUPERVISED_INGEST_OK"
    assert len(calls) == 2
    assert calls[0]["timeout_s"] == 30
    assert calls[1]["timeout_s"] == mmrag_recovery.ISOLATED_VIDEO_BATCH_TIMEOUT_S
    assert calls[1]["timeout_s"] < 6 * 3600
    assert calls[1]["files"] == [str(video)]


def test_supervised_records_completed_batches_only_after_worker_ok(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    files = []
    for index in range(2):
        path = tmp_path / f"ok-{index}.md"
        path.write_text("ok\n", encoding="utf-8")
        files.append(path)

    def fake_worker(argv, **_kwargs):
        return {"result": "WORKER_OK", "retry": False, "returncode": 0}

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.supervised_side_ingest(
        files,
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        batch_size=1,
        batch_timeout_s=30,
    )
    assert receipt["result"] == "SUPERVISED_INGEST_OK"
    assert receipt["completed_count"] == 2
    assert receipt["batch_timeout_s"] == 30


def test_supervised_isolates_oversized_json_not_small_json(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    md = tmp_path / "note.md"
    md.write_text("ok\n", encoding="utf-8")
    small_json = tmp_path / "tiny.json"
    small_json.write_text("{}\n", encoding="utf-8")
    large_json = tmp_path / "full-transcript.json"
    with large_json.open("wb") as handle:
        handle.seek(mmrag_recovery.LARGE_JSON_MIN_BYTES - 1)
        handle.write(b"x")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"mp4")
    calls = []

    def fake_worker(argv, **kwargs):
        calls.append({"files": argv[2:-3], "timeout_s": kwargs.get("timeout_s")})
        return {"result": "WORKER_OK", "retry": False, "returncode": 0}

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.supervised_side_ingest(
        [md, small_json, large_json, video],
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        batch_size=80,
        batch_timeout_s=30,
    )
    assert receipt["result"] == "SUPERVISED_INGEST_OK"
    assert len(calls) == 3
    assert calls[0]["timeout_s"] == 30
    assert set(calls[0]["files"]) == {str(md), str(small_json)}
    assert calls[1]["files"] == [str(large_json)]
    assert calls[1]["timeout_s"] == mmrag_recovery.ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S
    assert calls[1]["timeout_s"] < 6 * 3600
    assert calls[2]["files"] == [str(video)]
    assert calls[2]["timeout_s"] == mmrag_recovery.ISOLATED_VIDEO_BATCH_TIMEOUT_S


def test_supervised_large_json_timeout_does_not_retry_or_continue(tmp_path, monkeypatch):
    side = tmp_path / "side"
    side.mkdir()
    large_json = tmp_path / "full-transcript.json"
    with large_json.open("wb") as handle:
        handle.seek(mmrag_recovery.LARGE_JSON_MIN_BYTES - 1)
        handle.write(b"x")
    later = tmp_path / "later.md"
    later.write_text("nope\n", encoding="utf-8")
    calls = []

    def fake_worker(argv, **kwargs):
        calls.append({"files": argv[2:-3], "timeout_s": kwargs.get("timeout_s")})
        if len(calls) == 1:
            return {"result": "WORKER_TIMEOUT", "retry": False, "timeout_s": kwargs.get("timeout_s")}
        raise AssertionError("must not spawn another worker after WORKER_TIMEOUT")

    monkeypatch.setattr(mmrag_recovery, "run_isolated_chroma_worker", fake_worker)
    receipt = mmrag_recovery.supervised_side_ingest(
        [large_json, later],
        python_executable=sys.executable,
        mmrag_py=tmp_path / "mmrag.py",
        env={"MMRAG_SIDE_CHROMADB_DIR": str(side)},
        progress_path=tmp_path / "progress.json",
        log_path=tmp_path / "log.txt",
        batch_size=80,
        batch_timeout_s=30,
    )
    assert receipt["result"] == "WORKER_TIMEOUT"
    assert receipt["retry"] is False
    assert receipt["batch_kind"] == "large_json"
    assert receipt["batch_index"] == 0
    assert len(calls) == 1
    assert not (tmp_path / "progress.json").exists()
