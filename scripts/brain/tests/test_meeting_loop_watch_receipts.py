"""meeting_loop_watch must key 'filed' on the receipt, not on the envelope dir.

Ported from main (8c956a0b / PR #389) onto this branch's SECTION-split
meeting_loop_watch, so the eventual rebase keeps both behaviours.

2026-09-14: the webhook worker fetched a transcript, then died at extract; the
watch reported "all filed" because the envelope dir existed. A watcher that
cannot tell fetched-and-abandoned from filed is the failure it exists to catch.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import meeting_loop_watch as mlw  # noqa: E402


def _run(monkeypatch, tmp_path: Path, *, with_receipt: bool, capsys):
    vault = tmp_path / "vault"
    envelopes = vault / "raw/media/transcripts/fireflies"
    state = vault / "raw/media/transcripts/_state"
    (envelopes / "MID1").mkdir(parents=True)
    if with_receipt:
        (state / "fireflies-MID1").mkdir(parents=True)
        (state / "fireflies-MID1" / "receipt.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(mlw, "ENVELOPES", envelopes)
    monkeypatch.setattr(mlw, "STATE", state)
    monkeypatch.setattr(mlw.envparse, "parse_env_file", lambda _p: {"FIREFLIES_API_KEY": "x"})
    monkeypatch.setattr(mlw, "list_transcripts", lambda _k, throttle_s=0: [
        {"id": "MID1", "title": "Client sync", "dateString": "2099-01-01T10:00:00Z"},
    ])
    monkeypatch.setattr(mlw, "_probe", lambda _u: "ok")
    monkeypatch.setattr(mlw, "_occurred", lambda _r: mlw.datetime.now(mlw.timezone.utc))
    # the Gmail section is a separate concern here; point it at an empty dir
    monkeypatch.setenv("CLIENT_STATE_DIR", str(tmp_path / "client-state"))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(tmp_path / "client-vault"))
    rc = mlw.main(["--dry-run", "--days", "1"])
    return rc, capsys.readouterr().out


def test_envelope_without_receipt_is_reported_not_filed(monkeypatch, tmp_path, capsys):
    rc, out = _run(monkeypatch, tmp_path, with_receipt=False, capsys=capsys)
    assert rc == 0
    assert "Meeting loop OK" not in out
    assert "fetched but NOT processed" in out
    assert "MID1" in out


def test_envelope_with_receipt_is_ok(monkeypatch, tmp_path, capsys):
    rc, out = _run(monkeypatch, tmp_path, with_receipt=True, capsys=capsys)
    assert rc == 0
    assert "Meeting loop OK" in out
    assert "NOT processed" not in out
