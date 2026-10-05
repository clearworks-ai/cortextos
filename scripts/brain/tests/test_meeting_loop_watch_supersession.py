"""Cutover-bound supersession: historical processing-errors stay auditable
but never become current Telegram content. Only a new post-cutover
active failure may alert.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest

import client_state_digest as cs_digest
import meeting_loop_watch as mlw

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "meeting_loop_watch"
LIVE_VAULT_STATE = Path("/Users/joshweiss/code/knowledge-sync/raw/media/transcripts/_state")
LIVE_ENVELOPES = Path("/Users/joshweiss/code/knowledge-sync/raw/media/transcripts/fireflies")
LIVE_IDS = (
    "01M3CZV2S8YT86EPJD5ND4XG7D",
    "01M3CZV2RRC8G785KQKC402070",
)
CREDIT = "Credit balance"
SYNTHETIC_ID = "SYNTHETIC_POST_CUTOVER"
SYNTHETIC_MSG = "synthetic post-cutover extract failed"


def _printed(text: str) -> str:
    return text.rstrip("\n")


def _loop_body(text: str) -> str:
    for sep in ("\n\nClient state", "\n\n⚠️ Gmail"):
        if sep in text:
            return text.split(sep, 1)[0]
    return text


def _seed_gmail(tmp_path: Path, monkeypatch) -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    state_dir = tmp_path / "client-state"
    state_dir.mkdir()
    vault_dir = tmp_path / "client-vault"
    vault_dir.mkdir()
    (state_dir / "observations.jsonl").write_text("", encoding="utf-8")
    (state_dir / "run-receipt.json").write_text(
        json.dumps({
            "last_success_at": now_iso, "window_days": 3, "message_count": 0,
            "truncation": [], "cost_usd": 0.0,
        }),
        encoding="utf-8",
    )
    cs_digest.write_baseline(
        state_dir, {"org_name_multi": [], "domain_multi": [], "missing_gmail_refs": []}, now_iso
    )
    monkeypatch.setenv("CLIENT_STATE_DIR", str(state_dir))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(vault_dir))


def _seed_incomplete(
    tmp_path: Path,
    *,
    mid: str,
    title: str,
    date_string: str,
    error_doc: dict | None,
    fetched_at: str | None = None,
) -> tuple[Path, Path]:
    envelopes = tmp_path / "vault" / "raw/media/transcripts/fireflies"
    state = tmp_path / "vault" / "raw/media/transcripts/_state"
    env = envelopes / mid
    env.mkdir(parents=True)
    (env / "source.json").write_text('{"text_units": [{"text": "x"}]}', encoding="utf-8")
    if fetched_at:
        (env / "meta.json").write_text(
            json.dumps({"fetched_at": fetched_at, "fetcher": "fetch_fireflies/1"}),
            encoding="utf-8",
        )
    if error_doc is not None:
        err_dir = state / f"fireflies-{mid}"
        err_dir.mkdir(parents=True)
        (err_dir / "processing-error.json").write_text(
            json.dumps(error_doc, indent=2) + "\n", encoding="utf-8"
        )
    return envelopes, state


def _install_watch(
    monkeypatch,
    tmp_path: Path,
    *,
    envelopes: Path,
    state: Path,
    rows: list[dict],
    ack_path: Path | None = None,
    sent: list[str] | None = None,
) -> list[str]:
    captured = sent if sent is not None else []
    monkeypatch.setattr(mlw, "ENVELOPES", envelopes)
    monkeypatch.setattr(mlw, "STATE", state)
    monkeypatch.setattr(mlw, "ACK_PATH", ack_path or (tmp_path / "ack.json"))
    monkeypatch.setattr(mlw.envparse, "parse_env_file", lambda _p: {"FIREFLIES_API_KEY": "x"})
    monkeypatch.setattr(mlw, "list_transcripts", lambda _k, throttle_s=0: rows)
    monkeypatch.setattr(mlw, "_probe", lambda _u: "ok")
    monkeypatch.setattr(mlw, "send_telegram", lambda text: captured.append(text) or True)
    _seed_gmail(tmp_path, monkeypatch)
    return captured


def _fixture_error(mid: str) -> dict:
    return json.loads((FIXTURES / f"processing-error-{mid}.json").read_text(encoding="utf-8"))


def _ack_frozen(path: Path, before: bytes | None) -> None:
    if before is None:
        assert not path.exists()
    else:
        assert path.read_bytes() == before


def test_superseded_pre_cutover_processing_error_is_absent_from_outbound(
    monkeypatch, tmp_path, capsys
):
    mid = LIVE_IDS[0]
    err = _fixture_error(mid)
    assert CREDIT in err["message"]
    envelopes, state = _seed_incomplete(
        tmp_path,
        mid=mid,
        title="Clearworks/Calasia Catchup",
        date_string="2026-09-29T20:30:00Z",
        error_doc=err,
        fetched_at="2026-09-29T20:49:05Z",
    )
    error_path = state / f"fireflies-{mid}" / "processing-error.json"
    before = error_path.read_bytes()
    ack_path = tmp_path / "ack.json"
    _install_watch(
        monkeypatch,
        tmp_path,
        envelopes=envelopes,
        state=state,
        rows=[{"id": mid, "title": "Clearworks/Calasia Catchup", "dateString": "2026-09-29T20:30:00Z"}],
        ack_path=ack_path,
    )

    rc = mlw.main(["--dry-run", "--days", "30"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "Meeting loop OK" in out
    assert "needs a look" not in out
    assert "all filed (receipts present)" not in out
    assert "superseded, not current" in out
    assert CREDIT not in out
    assert mid not in out
    assert error_path.read_bytes() == before
    assert json.loads(error_path.read_text(encoding="utf-8"))["message"] == err["message"]
    _ack_frozen(ack_path, None)


def test_post_cutover_processing_failure_alerts_on_dry_run_and_real_path(
    monkeypatch, tmp_path, capsys
):
    err = {
        "at": "2026-10-04T12:00:00+00:00",
        "class": "processing",
        "message": f"{SYNTHETIC_MSG}\nFAILED at extract: rc=3",
        "returncode": 3,
    }
    envelopes, state = _seed_incomplete(
        tmp_path,
        mid=SYNTHETIC_ID,
        title="New post-cutover meeting",
        date_string="2026-10-04T12:00:00Z",
        error_doc=err,
        fetched_at="2026-10-04T12:00:00Z",
    )
    ack_path = tmp_path / "ack.json"
    sent: list[str] = []
    _install_watch(
        monkeypatch,
        tmp_path,
        envelopes=envelopes,
        state=state,
        rows=[{"id": SYNTHETIC_ID, "title": "New post-cutover meeting", "dateString": "2026-10-04T12:00:00Z"}],
        ack_path=ack_path,
        sent=sent,
    )

    rc_dry = mlw.main(["--dry-run", "--days", "30"])
    dry_out = capsys.readouterr().out
    assert rc_dry == 0
    _ack_frozen(ack_path, None)
    assert "recorded processing failure" in dry_out
    assert SYNTHETIC_ID in dry_out
    assert SYNTHETIC_MSG in dry_out
    assert "NOT in the vault" not in dry_out
    assert CREDIT not in dry_out
    assert sent == []

    rc_real = mlw.main(["--days", "30"])
    real_out = capsys.readouterr().out
    assert rc_real == 0
    assert sent, "real watcher path must compose outbound content"
    assert _printed(real_out) == sent[0]
    assert _loop_body(dry_out) == _loop_body(real_out)
    assert "recorded processing failure" in sent[0]
    assert SYNTHETIC_MSG in sent[0]
    assert (state / f"fireflies-{SYNTHETIC_ID}" / "processing-error.json").is_file()
    _ack_frozen(ack_path, None)


def test_acked_fingerprint_does_not_suppress_a_new_error_on_same_id(
    monkeypatch, tmp_path, capsys
):
    mid = "SAME_ID_NEW_FAILURE"
    ack_path = tmp_path / "ack.json"
    ack_path.write_text(
        json.dumps({
            "cutover_at": "2026-10-01T00:00:00+00:00",
            "superseded": {
                mid: {"error_at": "2026-09-29T20:49:09+00:00", "class": "processing"},
            },
        }),
        encoding="utf-8",
    )
    before_ack = ack_path.read_bytes()
    err = {
        "at": "2026-10-05T09:00:00+00:00",
        "class": "processing",
        "message": "new post-cutover failure on same meeting",
        "returncode": 3,
    }
    envelopes, state = _seed_incomplete(
        tmp_path,
        mid=mid,
        title="Retry after cutover",
        date_string="2026-10-05T09:00:00Z",
        error_doc=err,
        fetched_at="2026-10-05T09:00:00Z",
    )
    _install_watch(
        monkeypatch,
        tmp_path,
        envelopes=envelopes,
        state=state,
        rows=[{"id": mid, "title": "Retry after cutover", "dateString": "2026-10-05T09:00:00Z"}],
        ack_path=ack_path,
    )

    rc = mlw.main(["--dry-run", "--days", "30"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "needs a look" in out
    assert "recorded processing failure" in out
    assert mid in out
    assert "new post-cutover failure on same meeting" in out
    _ack_frozen(ack_path, before_ack)


def test_real_path_persists_ack_without_error_text_dry_run_does_not(
    monkeypatch, tmp_path, capsys
):
    mid = LIVE_IDS[1]
    err = _fixture_error(mid)
    envelopes, state = _seed_incomplete(
        tmp_path,
        mid=mid,
        title="Justin Garner and Josh Weiss",
        date_string="2026-09-29T21:00:00Z",
        error_doc=err,
        fetched_at="2026-09-29T21:32:34Z",
    )
    ack_path = tmp_path / "ack.json"
    sent: list[str] = []
    _install_watch(
        monkeypatch,
        tmp_path,
        envelopes=envelopes,
        state=state,
        rows=[{"id": mid, "title": "Justin Garner and Josh Weiss", "dateString": "2026-09-29T21:00:00Z"}],
        ack_path=ack_path,
        sent=sent,
    )

    mlw.main(["--dry-run", "--days", "30"])
    dry_out = capsys.readouterr().out
    _ack_frozen(ack_path, None)
    assert CREDIT not in dry_out
    assert mid not in dry_out
    assert "Meeting loop OK" in dry_out
    assert "all filed (receipts present)" not in dry_out

    rc = mlw.main(["--days", "30"])
    printed = capsys.readouterr().out
    assert rc == 0
    assert sent and _printed(printed) == sent[0]
    assert _loop_body(dry_out) == _loop_body(printed)
    assert "all filed (receipts present)" not in printed
    assert "all filed (receipts present)" not in sent[0]
    ack = json.loads(ack_path.read_text(encoding="utf-8"))
    assert ack["cutover_at"] == "2026-10-01T00:00:00+00:00"
    rec = ack["superseded"][mid]
    assert rec["error_at"] == err["at"]
    assert rec["class"] == "processing"
    assert CREDIT not in ack_path.read_text(encoding="utf-8")
    assert "message" not in rec
    assert set(rec) == {"error_at", "class"}


def _live_error_path(mid: str) -> Path:
    return LIVE_VAULT_STATE / f"fireflies-{mid}" / "processing-error.json"


def _overlay_live_plus_synthetic(tmp_path: Path) -> tuple[Path, Path]:
    envelopes = tmp_path / "vault" / "raw/media/transcripts/fireflies"
    state = tmp_path / "vault" / "raw/media/transcripts/_state"
    envelopes.mkdir(parents=True)
    state.mkdir(parents=True)
    for mid in LIVE_IDS:
        shutil.copytree(LIVE_ENVELOPES / mid, envelopes / mid)
        shutil.copytree(LIVE_VAULT_STATE / f"fireflies-{mid}", state / f"fireflies-{mid}")
    syn_env = envelopes / SYNTHETIC_ID
    syn_env.mkdir()
    (syn_env / "source.json").write_text('{"text_units": [{"text": "x"}]}', encoding="utf-8")
    (syn_env / "meta.json").write_text(
        json.dumps({"fetched_at": "2026-10-04T15:00:00Z", "fetcher": "test"}),
        encoding="utf-8",
    )
    syn_state = state / f"fireflies-{SYNTHETIC_ID}"
    syn_state.mkdir()
    (syn_state / "processing-error.json").write_text(
        json.dumps({
            "at": "2026-10-04T15:00:00+00:00",
            "class": "processing",
            "message": SYNTHETIC_MSG,
            "returncode": 3,
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    return envelopes, state


@pytest.mark.skipif(
    not all(_live_error_path(mid).is_file() for mid in LIVE_IDS),
    reason="live Sep 29 processing-error evidence is not on this machine",
)
def test_live_sep29_ids_credit_balance_absent_synthetic_processing_failure_alerts(
    monkeypatch, tmp_path, capsys
):
    snapshots = {mid: _live_error_path(mid).read_bytes() for mid in LIVE_IDS}
    for mid, blob in snapshots.items():
        assert CREDIT.encode() in blob

    envelopes, state = _overlay_live_plus_synthetic(tmp_path)
    ack_path = tmp_path / "live-ack.json"
    rows = [
        {"id": LIVE_IDS[0], "title": "Clearworks/Calasia Catchup", "dateString": "2026-09-29T20:30:00Z"},
        {"id": LIVE_IDS[1], "title": "Justin Garner and Josh Weiss", "dateString": "2026-09-29T21:00:00Z"},
        {"id": SYNTHETIC_ID, "title": "Synthetic post-cutover", "dateString": "2026-10-04T15:00:00Z"},
    ]
    sent: list[str] = []
    _install_watch(
        monkeypatch,
        tmp_path,
        envelopes=envelopes,
        state=state,
        rows=rows,
        ack_path=ack_path,
        sent=sent,
    )

    rc_dry = mlw.main(["--dry-run", "--days", "30"])
    dry_out = capsys.readouterr().out
    assert rc_dry == 0
    _ack_frozen(ack_path, None)
    assert CREDIT not in dry_out
    assert "recorded processing failure" in dry_out
    assert SYNTHETIC_ID in dry_out
    assert SYNTHETIC_MSG in dry_out
    assert "NOT in the vault" not in dry_out
    for mid in LIVE_IDS:
        assert mid not in dry_out
        assert _live_error_path(mid).read_bytes() == snapshots[mid]

    rc_real = mlw.main(["--days", "30"])
    real_out = capsys.readouterr().out
    assert rc_real == 0
    assert sent and _printed(real_out) == sent[0]
    assert _loop_body(dry_out) == _loop_body(real_out)
    assert CREDIT not in sent[0]
    assert SYNTHETIC_MSG in sent[0]
    assert "recorded processing failure" in sent[0]
    for mid in LIVE_IDS:
        assert mid not in sent[0]
        assert _live_error_path(mid).read_bytes() == snapshots[mid]
    ack = json.loads(ack_path.read_text(encoding="utf-8"))
    assert CREDIT not in ack_path.read_text(encoding="utf-8")
    for mid in LIVE_IDS:
        assert mid in ack["superseded"]
    assert SYNTHETIC_ID not in ack.get("superseded", {})
