"""FR-003 writer freeze: hold file + reconcile enabled=false, prompt/schedule intact."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-freeze-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_KB = Path.home() / ".cortextos/cortextos1/orgs/clearworksai/knowledge-base"


def _cron_blob(name, *, enabled=True, extra=None):
    job = {
        "name": name,
        "prompt": f"prompt-body-for-{name}",
        "schedule": "37 3 * * *",
        "enabled": enabled,
    }
    if extra:
        job.update(extra)
    return job


def _seed(tmp_path):
    kb = tmp_path / "knowledge-base"
    kb.mkdir()
    (kb / "chromadb").mkdir()
    agents = tmp_path / "agents"
    cron_files = {}
    for agent in ("larry", "larry-codex"):
        agent_dir = agents / agent
        agent_dir.mkdir(parents=True)
        payload = {
            "updated_at": "2026-08-22T01:13:45.827Z",
            "crons": [
                _cron_blob("heartbeat", extra={"schedule": "4h"}),
                _cron_blob("kb-reconcile-nightly"),
                _cron_blob("claude-mem-export", extra={"schedule": "12 3 * * *"}),
            ],
        }
        path = agent_dir / "crons.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        cron_files[agent] = path
    frank = agents / "frank2"
    frank.mkdir()
    (frank / "crons.json").write_text(
        json.dumps({
            "updated_at": "2026-08-22T01:13:45.827Z",
            "crons": [_cron_blob("weekly-synthesis", extra={"schedule": "0 9 * * 1"})],
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    return kb, cron_files, frank / "crons.json"


def test_freeze_writes_exclusive_hold_and_disables_only_reconcile(tmp_path):
    kb, cron_files, frank = _seed(tmp_path)
    before = {agent: path.read_bytes() for agent, path in cron_files.items()}
    frank_before = frank.read_bytes()
    evidence = tmp_path / "evidence"
    receipt = mmrag_recovery.freeze_writers(
        "cortextos1",
        evidence,
        kb_root=kb,
        cron_files=cron_files,
    )
    hold = Path(receipt["hold_path"])
    assert receipt["result"] == "FREEZE_OK"
    assert json.loads(hold.read_text(encoding="utf-8"))["mode"] == "exclusive"
    assert stat.S_IMODE(hold.stat().st_mode) == 0o600
    for agent, path in cron_files.items():
        data = json.loads(path.read_text(encoding="utf-8"))
        jobs = {job["name"]: job for job in data["crons"]}
        assert jobs["kb-reconcile-nightly"]["enabled"] is False
        assert jobs["kb-reconcile-nightly"]["prompt"] == "prompt-body-for-kb-reconcile-nightly"
        assert jobs["kb-reconcile-nightly"]["schedule"] == "37 3 * * *"
        assert jobs["heartbeat"]["enabled"] is True
        assert jobs["claude-mem-export"]["enabled"] is True
        original = json.loads(before[agent].decode("utf-8"))
        orig_jobs = {job["name"]: job for job in original["crons"]}
        for name, job in orig_jobs.items():
            assert jobs[name]["prompt"] == job["prompt"]
            assert jobs[name]["schedule"] == job["schedule"]
    assert frank.read_bytes() == frank_before
    restored = mmrag_recovery.restore_writer_crons(receipt)
    assert restored["result"] == "CRON_RESTORE_OK"
    for agent, path in cron_files.items():
        assert path.read_bytes() == before[agent]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == hashlib.sha256(before[agent]).hexdigest()


def test_freeze_refuses_other_instance(tmp_path):
    kb, cron_files, _frank = _seed(tmp_path)
    with pytest.raises(mmrag_recovery.FreezeRefused):
        mmrag_recovery.freeze_writers(
            "default",
            tmp_path / "evidence",
            kb_root=kb,
            cron_files=cron_files,
        )


def test_freeze_without_live_epoch_refuses_hosted_kb():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked):
        mmrag_recovery.freeze_writers(
            "cortextos1",
            Path("/tmp/mmrag-freeze-evidence-should-not-exist"),
            kb_root=LIVE_KB,
            cron_files={"larry": LIVE_KB, "larry-codex": LIVE_KB},
        )
