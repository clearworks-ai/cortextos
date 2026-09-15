"""meeting_loop_retry: re-run run_meeting --apply for envelopes without a receipt.

2026-09-14: the webhook worker fetched a transcript, then the extract step was
refused ("Credit balance is too low"); nothing ever retried it. An envelope
without a receipt and without a fetch-error is exactly "died after fetch".
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import meeting_loop_retry as mlr  # noqa: E402
import progress  # noqa: E402


def _env(vault: Path, mid: str) -> Path:
    d = vault / "raw/media/transcripts/fireflies" / mid
    d.mkdir(parents=True)
    (d / "source.json").write_text("{}", encoding="utf-8")
    return d


def test_pending_is_envelope_without_receipt_and_without_fetch_error(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    _env(vault, "PENDING1")
    _env(vault, "DONE1")
    rp = progress.receipt_path(vault, "fireflies", "DONE1")
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text("{}", encoding="utf-8")
    _env(vault, "FETCHERR1")
    fe = vault / "raw/media/transcripts/_state/fireflies-FETCHERR1"
    fe.mkdir(parents=True, exist_ok=True)
    (fe / "fetch-error.json").write_text("{}", encoding="utf-8")
    assert mlr.pending_envelopes(vault, days=3) == ["PENDING1"]


def test_pending_ignores_envelopes_older_than_the_window(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    _env(vault, "OLD1")
    now = datetime.now(timezone.utc) + timedelta(days=10)
    assert mlr.pending_envelopes(vault, days=3, now=now) == []


def test_main_retries_each_pending_with_apply_and_reports(tmp_path: Path, monkeypatch, capsys) -> None:
    vault = tmp_path / "vault"
    _env(vault, "PENDING1")
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append([str(c) for c in cmd])
        return subprocess.CompletedProcess(cmd, 0, stdout="ok\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    rc = mlr.main(["--vault", str(vault), "--repo-root", str(tmp_path), "--days", "3"])
    assert rc == 0
    assert len(calls) == 1
    assert calls[0][1].endswith("run_meeting.py")
    assert "--meeting-id" in calls[0] and "fireflies:PENDING1" in calls[0]
    assert "--apply" in calls[0] and "--dry-run" not in calls[0]
    out = capsys.readouterr().out
    summary = json.loads(out.strip().splitlines()[-1])
    assert summary["pending"] == 1 and summary["ok"] is True


def test_main_exit_1_when_a_retry_fails(tmp_path: Path, monkeypatch, capsys) -> None:
    vault = tmp_path / "vault"
    _env(vault, "PENDING1")
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 3, stdout="", stderr="FAILED at extract: rc=3\n"))
    rc = mlr.main(["--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 1
    assert "FAILED at extract" in capsys.readouterr().out


def test_main_noop_when_nothing_pending(tmp_path: Path, monkeypatch, capsys) -> None:
    vault = tmp_path / "vault"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
    rc = mlr.main(["--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 0
    assert json.loads(capsys.readouterr().out.strip())["pending"] == 0
