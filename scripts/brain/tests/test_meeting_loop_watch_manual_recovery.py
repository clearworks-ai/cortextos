"""Offline SENT-scope recovery; draft reconciliation has its own receipt contract."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

import meeting_loop_watch as mlw
from test_meeting_loop_watch_supersession import _install_watch, _seed_incomplete

MEETING = "SYNTHETIC_MANUAL_RECOVERY"
ERROR = {
    "at": "2026-10-05T21:02:14+00:00", "class": "processing",
    "message": "Extra data: line 57 column 1 (char 3069)\nFAILED at extract: rc=3",
    "returncode": 3,
}


def _write_json(path: Path, doc: object) -> str:
    blob = (json.dumps(doc, indent=2) + "\n").encode()
    path.write_bytes(blob)
    return hashlib.sha256(blob).hexdigest()


def _recovery_fixture(
    tmp_path, monkeypatch, *, meeting_id=MEETING, account="operator@example.test",
    recipient="customer@example.test", draft_id="r1111111111111111111",
    gmail_message_id="gmail:1111111111111111", label_ids=("SENT",),
):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 6, tzinfo=timezone.utc)

    monkeypatch.setattr(mlw, "datetime", FrozenDatetime)
    envelopes, state = _seed_incomplete(
        tmp_path, mid=meeting_id, title="Synthetic manual recovery meeting",
        date_string="2026-10-05T20:30:00Z", error_doc=ERROR,
    )
    source_path = envelopes / meeting_id / "source.json"
    _write_json(source_path, {
        "source": {"kind": "fireflies", "id": meeting_id},
        "participants": [
            {"email": account, "side": "ours"},
            {"email": recipient, "side": "theirs"},
        ],
        "text_units": [{"text": "Synthetic meeting, not live evidence"}],
    })
    error_path = state / f"fireflies-{meeting_id}" / "processing-error.json"
    identity = {
        "source_ref": f"fireflies:{meeting_id}", "draft_id": draft_id,
        "gmail_message_id": gmail_message_id, "account": account, "recipient": recipient,
    }
    evidence = {
        "schema": "manual-recovery-identity/v1", **identity,
        "label_ids": list(label_ids), "sent_at": "2026-10-05T22:00:00+00:00",
    }
    evidence_path = tmp_path / "synthetic-identity-evidence.json"
    evidence_hash = _write_json(evidence_path, evidence)
    recovery = {
        "kind": "verified_manual_recovery", "meeting_id": meeting_id, **identity,
        "error_at": ERROR["at"], "error_sha256": hashlib.sha256(error_path.read_bytes()).hexdigest(),
        "scope": "recap_sent_only", "verifier": "synthetic-test-verifier",
        "verified_at": "2026-10-05T22:01:00+00:00",
        "identity_evidence": {"path": str(evidence_path), "sha256": evidence_hash},
    }
    ack = {"cutover_at": mlw.DEFAULT_CUTOVER_AT, "superseded": {},
           "verified_manual_recoveries": {meeting_id: recovery}}
    rows = [{"id": meeting_id, "title": "Synthetic manual recovery meeting", "dateString": "2026-10-05T20:30:00Z"}]
    sent = _install_watch(monkeypatch, tmp_path, envelopes=envelopes, state=state, rows=rows)
    return ack, error_path, rows, sent


def test_manual_recovery_survives_save_reload_and_composes_truthful_outbound(
    tmp_path, monkeypatch, capsys,
):
    ack, error_path, _, sent = _recovery_fixture(tmp_path, monkeypatch)
    before_error = error_path.read_bytes()
    assert hashlib.sha256(before_error).hexdigest() == "d39e060f2c0e7f5377f43a59666b63b4c57369460ea6d01a833c348f0d57f9a0"

    # Explicit operator persistence, NOT a watcher action.
    mlw._save_ack(ack)
    assert mlw._load_ack() == ack
    before_ack = mlw.ACK_PATH.read_bytes()
    for flags in (["--dry-run"], ["--send"]):
        assert mlw.main([*flags, "--days", "30"]) == 0
        out = capsys.readouterr().out.rstrip("\n")
        assert MEETING not in out and "Synthetic manual recovery meeting" not in out and "Extra data" not in out
        assert "manually recovered/superseded" in out
        assert "canonical processing remains unverified" in out
        assert "all filed" not in out and "processing complete" not in out
        if flags == ["--send"]:
            assert sent == [out]
    assert error_path.read_bytes() == before_error
    assert mlw.ACK_PATH.read_bytes() == before_ack
    assert not error_path.with_name("receipt.json").exists()


@pytest.mark.parametrize(("field", "value"), [
    ("meeting_id", "OTHER_MEETING"), ("source_ref", "fireflies:OTHER_MEETING"),
    ("draft_id", "r8888888888888888888"),  # unrelated (GBK-shaped) draft
    ("recipient", "wrong@example.net"), ("account", "wrong@example.net"),
    ("gmail_message_id", None), ("gmail_message_id", "gmail:0000000000000000"),
    ("kind", "completed"), ("scope", "all_obligations"),
    ("verifier", ""), ("verified_at", "not-a-date"),
    ("identity_evidence", None), ("identity_evidence", {"path": "missing", "sha256": "0" * 64}),
    ("error_at", "2026-10-05T21:02:15+00:00"), ("error_sha256", "0" * 64),
])
def test_inexact_or_malformed_recovery_fails_closed(field, value, tmp_path, monkeypatch, capsys):
    ack, _, _, sent = _recovery_fixture(tmp_path, monkeypatch)
    ack["verified_manual_recoveries"][MEETING][field] = value
    _write_json(mlw.ACK_PATH, ack)

    assert mlw.main(["--send", "--days", "30"]) == 0
    out = capsys.readouterr().out.rstrip("\n")
    assert sent == [out]
    assert MEETING in out and "recorded processing failure" in out
    assert "manually recovered" not in out


@pytest.mark.parametrize(("field", "value"), [
    ("schema", "wrong-schema"), ("label_ids", ["DRAFT"]), ("label_ids", "SENT"),
    ("label_ids", ["SENT", "DRAFT"]), ("sent_at", None),
    ("label_ids", ["SENT", 123]),
    ("sent_at", "2026-10-05T20:00:00+00:00"),
    ("sent_at", "2026-10-05T23:00:00+00:00"),
    ("account", "wrong@example.net"), ("recipient", "wrong@example.net"),
    ("source_ref", "fireflies:OTHER_MEETING"), ("draft_id", "r8888888888888888888"),
])
def test_supporting_sent_identity_must_match(field, value, tmp_path, monkeypatch, capsys):
    ack, _, _, _ = _recovery_fixture(tmp_path, monkeypatch)
    rec = ack["verified_manual_recoveries"][MEETING]
    path = Path(rec["identity_evidence"]["path"])
    evidence = json.loads(path.read_text())
    evidence[field] = value
    rec["identity_evidence"]["sha256"] = _write_json(path, evidence)
    _write_json(mlw.ACK_PATH, ack)

    assert mlw.main(["--dry-run", "--days", "30"]) == 0
    out = capsys.readouterr().out
    assert MEETING in out and "recorded processing failure" in out
    assert "manually recovered" not in out


@pytest.mark.parametrize("field", ["account", "recipient"])
def test_even_consistent_email_evidence_must_match_source_participants(field, tmp_path, monkeypatch, capsys):
    ack, _, _, _ = _recovery_fixture(tmp_path, monkeypatch)
    rec = ack["verified_manual_recoveries"][MEETING]
    path = Path(rec["identity_evidence"]["path"])
    evidence = json.loads(path.read_text())
    rec[field] = evidence[field] = "wrong@example.net"
    rec["identity_evidence"]["sha256"] = _write_json(path, evidence)
    _write_json(mlw.ACK_PATH, ack)

    assert mlw.main(["--dry-run", "--days", "30"]) == 0
    assert MEETING in capsys.readouterr().out


def test_timestamp_only_ack_cannot_bypass_invalid_manual_recovery(tmp_path, monkeypatch, capsys):
    ack, _, _, _ = _recovery_fixture(tmp_path, monkeypatch)
    ack["verified_manual_recoveries"][MEETING]["gmail_message_id"] = None
    ack["superseded"][MEETING] = {"class": "processing", "error_at": ERROR["at"]}
    _write_json(mlw.ACK_PATH, ack)

    assert mlw.main(["--dry-run", "--days", "30"]) == 0
    assert MEETING in capsys.readouterr().out


@pytest.mark.parametrize("change", ["same_timestamp_new_fingerprint", "new_timestamp"])
def test_recovery_does_not_cover_another_failed_attempt(change, tmp_path, monkeypatch, capsys):
    ack, error_path, _, sent = _recovery_fixture(tmp_path, monkeypatch)
    mlw._save_ack(ack)
    error = {**ERROR, "message": "new unrecovered failure"}
    if change == "new_timestamp":
        error["at"] = "2026-10-05T23:00:00+00:00"
    _write_json(error_path, error)

    assert mlw.main(["--send", "--days", "30"]) == 0
    out = capsys.readouterr().out.rstrip("\n")
    assert sent == [out]
    assert MEETING in out and "new unrecovered failure" in out
    assert "manually recovered" not in out


@pytest.mark.parametrize("bad", [None, [], "invalid", {MEETING: None}, {MEETING: []}])
def test_malformed_recovery_container_fails_closed(bad, tmp_path, monkeypatch, capsys):
    ack, _, _, _ = _recovery_fixture(tmp_path, monkeypatch)
    ack["verified_manual_recoveries"] = bad
    _write_json(mlw.ACK_PATH, ack)
    assert mlw.main(["--dry-run", "--days", "30"]) == 0
    out = capsys.readouterr().out
    assert MEETING in out and "recorded processing failure" in out
    assert "Fireflies section error" not in out


def test_recovery_keeps_new_alert_and_two_proposals_open_without_mutations(tmp_path, monkeypatch, capsys):
    ack, error_path, rows, sent = _recovery_fixture(tmp_path, monkeypatch)
    _seed_incomplete(
        tmp_path, mid="SYNTHETIC_UNRECOVERED", title="Synthetic unhandled failure",
        date_string="2026-10-05T23:00:00Z",
        error_doc={**ERROR, "message": "synthetic post-cutover failure"},
    )
    rows.append({"id": "SYNTHETIC_UNRECOVERED", "dateString": "2026-10-05T23:00:00Z"})
    for proposal in ("proposal-one", "proposal-two"):
        _write_json(tmp_path / f"{proposal}.json", {"id": proposal, "status": "open", "sent": False})
    mlw._save_ack(ack)
    before = {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}

    def forbidden(*args, **kwargs):
        raise AssertionError("watcher must not write state, recover, replay, or mutate Gmail")

    monkeypatch.setattr(mlw, "_save_ack", forbidden)
    monkeypatch.setattr(mlw, "atomic_write", forbidden)
    monkeypatch.setattr(mlw.subprocess, "run", forbidden)
    monkeypatch.setattr(Path, "write_bytes", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    monkeypatch.setattr(Path, "unlink", forbidden)
    for flags in ([], ["--dry-run"], ["--send", "--dry-run"], ["--send"]):
        assert mlw.main([*flags, "--days", "30"]) == 0
        out = capsys.readouterr().out.rstrip("\n")
        assert MEETING not in out and "Extra data" not in out
        assert "SYNTHETIC_UNRECOVERED" in out and "recorded processing failure" in out
        assert "manually recovered/superseded" in out
        assert "Separate proposal obligations are unchanged" in out
        assert len(sent) == (1 if flags == ["--send"] else 0)
    assert sent == [out]
    assert before == {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert not error_path.with_name("receipt.json").exists()


def test_restart_reloads_recovery_and_real_main_captures_outbound(tmp_path, monkeypatch, capsys):
    ack, _, _, _ = _recovery_fixture(tmp_path, monkeypatch)
    mlw._save_ack(ack)
    # Fresh interpreter, real watcher main and file reads; external APIs are
    # fixture-fed and the Telegram sender is captured, never contacted.
    script = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import meeting_loop_watch as watch
watch.ENVELOPES, watch.STATE, watch.ACK_PATH = map(Path, sys.argv[2:5])
watch.envparse.parse_env_file = lambda p: {'FIREFLIES_API_KEY': 'synthetic'}
watch.list_transcripts = lambda *a, **k: [{'id': sys.argv[5], 'dateString': '2026-10-05T20:30:00Z'}]
watch._probe = lambda u: 'ok'
watch.gmail_section_lines = lambda a: (['Synthetic Gmail boundary'], None)
sent = []
watch.send_telegram = lambda content: sent.append(content) or True
assert watch.main(['--send', '--days', '36500']) == 0
assert len(sent) == 1 and sys.argv[5] not in sent[0]
assert 'manually recovered/superseded' in sent[0]
assert watch._load_ack() == json.loads(watch.ACK_PATH.read_text())
print('CAPTURED_OUTBOUND=' + json.dumps(sent[0]))
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(Path(mlw.__file__).parent), str(mlw.ENVELOPES),
         str(mlw.STATE), str(mlw.ACK_PATH), MEETING],
        text=True, capture_output=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert "CAPTURED_OUTBOUND=" in result.stdout


def test_generic_draft_without_completed_surfacing_receipts_stays_active(tmp_path, monkeypatch, capsys):
    ack, _, _, sent = _recovery_fixture(tmp_path, monkeypatch, label_ids=("DRAFT",))
    ack["verified_manual_recoveries"][MEETING]["scope"] = "recap_draft_created_and_surfaced"
    _write_json(mlw.ACK_PATH, ack)
    for flags in (["--dry-run"], ["--send"]):
        assert mlw.main([*flags, "--days", "30"]) == 0
        out = capsys.readouterr().out.rstrip("\n")
        assert MEETING in out and "recorded processing failure" in out
        assert "manually reconciled" not in out
    assert sent == [out]


def test_help_requires_atomic_notification_cron_migration(capsys):
    with pytest.raises(SystemExit) as exit_result:
        mlw.main(["--help"])
    assert exit_result.value.code == 0
    help_text = capsys.readouterr().out
    assert "meeting-loop-watch and meeting-loop-watch-pm" in help_text
    assert "--send" in help_text and "atomically" in help_text and "promotion" in help_text
