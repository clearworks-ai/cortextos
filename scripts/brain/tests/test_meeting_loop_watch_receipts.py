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


def _run(monkeypatch, tmp_path: Path, *, with_receipt: bool, with_failure: bool = False,
         with_empty_source: bool = False, capsys):
    vault = tmp_path / "vault"
    envelopes = vault / "raw/media/transcripts/fireflies"
    state = vault / "raw/media/transcripts/_state"
    (envelopes / "MID1").mkdir(parents=True)
    if with_empty_source:
        (envelopes / "MID1" / "source.json").write_text('{"text_units": []}', encoding="utf-8")
    else:
        (envelopes / "MID1" / "source.json").write_text(
            '{"text_units": [{"text": "x"}]}', encoding="utf-8"
        )
    if with_receipt:
        (state / "fireflies-MID1").mkdir(parents=True)
        (state / "fireflies-MID1" / "receipt.json").write_text("{}", encoding="utf-8")
    if with_failure:
        (state / "fireflies-MID1").mkdir(parents=True, exist_ok=True)
        (state / "fireflies-MID1" / "processing-error.json").write_text(
            '{"class":"processing","message":"FAILED at commit: index.lock"}', encoding="utf-8"
        )
    monkeypatch.setattr(mlw, "ENVELOPES", envelopes)
    monkeypatch.setattr(mlw, "STATE", state)
    monkeypatch.setattr(mlw, "ACK_PATH", tmp_path / "ack.json")
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
    assert "fetched but completion UNVERIFIED" in out
    assert "re-run run_meeting.py --apply for each" not in out
    assert "MID1" in out
    ack_path = tmp_path / "ack.json"
    assert not ack_path.exists()


def test_envelope_with_receipt_is_ok(monkeypatch, tmp_path, capsys):
    rc, out = _run(monkeypatch, tmp_path, with_receipt=True, capsys=capsys)
    assert rc == 0
    assert "Meeting loop OK" in out
    assert "NOT processed" not in out


def test_recorded_failure_is_reported_as_failure_not_unknown_completion(monkeypatch, tmp_path, capsys):
    rc, out = _run(monkeypatch, tmp_path, with_receipt=False, with_failure=True, capsys=capsys)
    assert rc == 0
    assert "recorded processing failure" in out
    assert "completion UNVERIFIED" not in out
    assert "index.lock" in out


def test_existing_empty_envelope_is_skipped(monkeypatch, tmp_path, capsys):
    rc, out = _run(monkeypatch, tmp_path, with_receipt=False, with_empty_source=True, capsys=capsys)
    assert rc == 0
    assert "Meeting loop OK" in out
    assert "1 empty recording(s) skipped" in out
    assert "completion UNVERIFIED" not in out


def test_missing_envelope_does_not_claim_verified_nonempty(monkeypatch, tmp_path, capsys):
    _run(monkeypatch, tmp_path, with_receipt=False, capsys=capsys)
    monkeypatch.setattr(mlw, "ENVELOPES", tmp_path / "no-envelopes")
    mlw.main(["--dry-run", "--days", "1"])
    out = capsys.readouterr().out
    assert "content not yet verified" in out
    assert "not empty" not in out
    assert "Every failure in this chain has been silent" not in out
