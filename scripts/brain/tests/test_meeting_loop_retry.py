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


# --- 2026-09-15: envelope-less transcripts (the PTY worker produced nothing) --------

def _rows(now):
    d = lambda delta: (now - delta).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return [
        {"id": "01NEW", "title": "GaB Project Management Meeting", "date": d(timedelta(hours=3))},
        {"id": "01HAVE", "title": "already fetched", "date": d(timedelta(hours=2))},
        {"id": "01OLD", "title": "last week", "date": d(timedelta(days=9))},
        {"id": "01ERR", "title": "fetch-error recorded", "date": d(timedelta(hours=1))},
    ]


def test_pending_transcripts_are_listed_recent_without_envelope_or_fetch_error(tmp_path: Path) -> None:
    now = datetime(2026, 9, 15, 20, 0, tzinfo=timezone.utc)
    (tmp_path / "raw/media/transcripts/fireflies/01HAVE").mkdir(parents=True)
    err = tmp_path / "raw/media/transcripts/_state/fireflies-01ERR"
    err.mkdir(parents=True)
    (err / "fetch-error.json").write_text(json.dumps({"class": "empty", "message": "3 sentences"}))
    assert mlr.pending_transcripts(tmp_path, 3, lambda: _rows(now), now=now) == ["01NEW"]


def test_main_fetches_and_applies_envelope_less_transcripts_after_envelope_retries(tmp_path: Path, monkeypatch, capsys) -> None:
    now = datetime.now(timezone.utc)
    calls: list[str] = []
    (tmp_path / "raw/media/transcripts/fireflies/01HAVE").mkdir(parents=True)
    err = tmp_path / "raw/media/transcripts/_state/fireflies-01ERR"
    err.mkdir(parents=True)
    (err / "fetch-error.json").write_text(json.dumps({"class": "empty", "message": "3 sentences"}))
    monkeypatch.setattr(mlr, "pending_envelopes", lambda vault, days, now=None: ["01ENV"])
    monkeypatch.setattr(mlr, "_LISTER", lambda: _rows(now))
    monkeypatch.setattr(mlr, "retry_one", lambda mid, repo_root, vault, dry_run: (calls.append(mid) or (0, "receipt: abc")))
    rc = mlr.main(["--days", "3", "--repo-root", str(tmp_path), "--vault", str(tmp_path)])
    assert rc == 0
    assert calls == ["01ENV", "01NEW"]
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["pending"] == 2 and out["missing"] == 1 and out["ok"] is True


def test_listing_failure_never_blocks_envelope_retries(tmp_path: Path, monkeypatch, capsys) -> None:
    calls: list[str] = []
    monkeypatch.setattr(mlr, "pending_envelopes", lambda vault, days, now=None: ["01ENV"])
    def _boom():
        raise RuntimeError("Fireflies 503")
    monkeypatch.setattr(mlr, "_LISTER", _boom)
    monkeypatch.setattr(mlr, "retry_one", lambda mid, repo_root, vault, dry_run: (calls.append(mid) or (0, "ok")))
    rc = mlr.main(["--repo-root", str(tmp_path), "--vault", str(tmp_path)])
    assert rc == 0 and calls == ["01ENV"]
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["listing_error"].startswith("RuntimeError")


def test_no_fetch_missing_flag_skips_the_listing(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.setattr(mlr, "pending_envelopes", lambda vault, days, now=None: [])
    def _boom():
        raise AssertionError("lister must not be called")
    monkeypatch.setattr(mlr, "_LISTER", _boom)
    assert mlr.main(["--no-fetch-missing", "--repo-root", str(tmp_path), "--vault", str(tmp_path)]) == 0
