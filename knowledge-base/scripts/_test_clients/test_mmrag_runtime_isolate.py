"""FR-008 isolated worker and runtime preflight.

Fixture subprocesses only. Never open the live Chroma store.
"""

from __future__ import annotations

import os
import signal
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-isolate-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_ROOT = Path.home() / ".cortextos"


def test_timeout_constants_sit_inside_bus_and_hook_deadlines():
    assert mmrag_recovery.HOOK_QUERY_TIMEOUT_MS == 12000
    assert mmrag_recovery.BUS_QUERY_TIMEOUT_MS == 30000
    assert mmrag_recovery.ISOLATED_QUERY_TIMEOUT_S * 1000 < mmrag_recovery.HOOK_QUERY_TIMEOUT_MS
    assert mmrag_recovery.ISOLATED_QUERY_TIMEOUT_S * 1000 < mmrag_recovery.BUS_QUERY_TIMEOUT_MS
    assert mmrag_recovery.ISOLATED_INGEST_BATCH_TIMEOUT_S == 45 * 60
    assert mmrag_recovery.ISOLATED_INGEST_BATCH_TIMEOUT_S < 6 * 3600
    assert mmrag_recovery.ISOLATED_INGEST_TIMEOUT_S == mmrag_recovery.ISOLATED_INGEST_BATCH_TIMEOUT_S
    assert mmrag_recovery.ISOLATED_INGEST_BATCH_MAX_FILES == 80
    assert mmrag_recovery.ISOLATED_VIDEO_BATCH_TIMEOUT_S == 3 * 3600
    assert mmrag_recovery.ISOLATED_VIDEO_BATCH_TIMEOUT_S < 6 * 3600
    assert mmrag_recovery.LARGE_JSON_MIN_BYTES == 5_000_000
    assert mmrag_recovery.ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S == 3 * 3600
    assert mmrag_recovery.ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S < 6 * 3600
    assert mmrag_recovery.ISOLATED_CHUNK_MAX_FILES == 8
    assert mmrag_recovery.ISOLATED_CHUNK_TIMEOUT_S == 15 * 60
    assert mmrag_recovery.ISOLATED_CHUNK_TIMEOUT_S < 6 * 3600
    assert mmrag_recovery.ISOLATED_LOW_RISK_CHUNK_MAX_FILES == 2
    assert mmrag_recovery.ISOLATED_LOW_RISK_CHUNK_TIMEOUT_S == 10 * 60
    assert mmrag_recovery.ISOLATED_LOW_RISK_CHUNK_TIMEOUT_S < 6 * 3600
    assert mmrag_recovery.RECOVERY_SIDE_V3_DIRNAME in mmrag_recovery.STALE_RECOVERY_SIDE_DIRNAMES
    assert mmrag_recovery.RECOVERY_SIDE_V4_DIRNAME not in mmrag_recovery.STALE_RECOVERY_SIDE_DIRNAMES


def test_unsupported_tuple_fails_closed_and_is_not_live_health_proof(monkeypatch):
    monkeypatch.setattr(
        mmrag_recovery,
        "probe_runtime_identity",
        lambda _python: {
            "result": "IDENTITY_OK",
            "python_version": "3.14.7",
            "chromadb_version": "1.5.7",
            "python_executable": "/unsupported/python",
            "bindings_path": "/unsupported/bindings",
            "bindings_sha256": "abc",
            "live_health_proven": False,
        },
    )
    receipt = mmrag_recovery.preflight_native_runtime("/unsupported/python")
    assert receipt["result"] == "UNSUPPORTED_RUNTIME"
    assert receipt["live_health_proven"] is False


def test_supported_tuple_is_not_proof_live_store_is_healthy(monkeypatch):
    monkeypatch.setattr(
        mmrag_recovery,
        "probe_runtime_identity",
        lambda _python: {
            "result": "IDENTITY_OK",
            "python_version": "3.13.12",
            "chromadb_version": "1.5.9",
            "python_executable": "/supported/python",
            "bindings_path": "/supported/bindings",
            "bindings_sha256": "def",
            "live_health_proven": False,
        },
    )
    receipt = mmrag_recovery.preflight_native_runtime("/supported/python")
    assert receipt["result"] == "RUNTIME_OK"
    assert receipt["live_health_proven"] is False


def test_hung_worker_returns_timeout_and_does_not_retry():
    receipt = mmrag_recovery.run_isolated_chroma_worker(
        ["-c", "import time; time.sleep(30)"],
        python_executable=sys.executable,
        timeout_s=0.3,
        require_supported=False,
    )
    assert receipt["result"] == "WORKER_TIMEOUT"
    assert receipt["retry"] is False
    second = mmrag_recovery.run_isolated_chroma_worker(
        ["-c", "import time; time.sleep(30)"],
        python_executable=sys.executable,
        timeout_s=0.3,
        require_supported=False,
    )
    assert second["result"] == "WORKER_TIMEOUT"
    assert second["retry"] is False


def test_signaled_worker_is_typed_and_not_retried():
    receipt = mmrag_recovery.run_isolated_chroma_worker(
        ["-c", "import os, signal; os.kill(os.getpid(), signal.SIGSEGV)"],
        python_executable=sys.executable,
        timeout_s=5,
        require_supported=False,
    )
    assert receipt["result"] == "WORKER_SIGNALED"
    assert receipt["signal"] == signal.SIGSEGV
    assert receipt["retry"] is False


def test_unsupported_preflight_does_not_spawn_worker(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("Popen must not run after unsupported preflight")

    monkeypatch.setattr(
        mmrag_recovery,
        "preflight_native_runtime",
        lambda _python: {
            "result": "UNSUPPORTED_RUNTIME",
            "live_health_proven": False,
            "detail": "fixture unsupported",
        },
    )
    monkeypatch.setattr(mmrag_recovery.subprocess, "Popen", boom)
    receipt = mmrag_recovery.run_isolated_chroma_worker(
        ["-c", "print('nope')"],
        python_executable=sys.executable,
        timeout_s=1,
        require_supported=True,
    )
    assert receipt["result"] == "UNSUPPORTED_RUNTIME"


def test_recovery_driver_does_not_call_count_in_process():
    source = Path(mmrag_recovery.__file__).read_text(encoding="utf-8")
    assert "collection.count(" not in source
    assert "PersistentClient(" not in source
    assert "import chromadb" not in source.split("_RUNTIME_PROBE", 1)[0]


def test_isolate_paths_stay_off_live_tree(tmp_path):
    resolved = tmp_path.resolve()
    assert LIVE_ROOT not in resolved.parents
