"""FR-009 INDEPENDENCE: the Fireflies and Gmail sections fail independently —
G-07/G0B-16's old main() returned (or crashed) before ANY notification when the
Fireflies side failed; this pins that it no longer does, in either direction."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import client_state_digest as cs_digest  # noqa: E402
import meeting_loop_watch as mlw  # noqa: E402


def _seed_state(tmp_path, *, last_success_iso):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()
    (state_dir / "observations.jsonl").write_text("", encoding="utf-8")
    (state_dir / "run-receipt.json").write_text(json.dumps({
        "last_success_at": last_success_iso, "window_days": 3, "message_count": 0,
        "truncation": [], "cost_usd": 0.0,
    }), encoding="utf-8")
    cs_digest.write_baseline(
        state_dir, {"org_name_multi": [], "domain_multi": [], "missing_gmail_refs": []}, last_success_iso
    )
    return state_dir, vault_dir


def test_main_dry_run_reports_fireflies_error_and_gmail_ok(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(mlw.envparse, "parse_env_file", lambda path: {})
    now_iso = datetime.now(timezone.utc).isoformat()
    state_dir, vault_dir = _seed_state(tmp_path, last_success_iso=now_iso)
    monkeypatch.setenv("CLIENT_STATE_DIR", str(state_dir))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(vault_dir))

    rc = mlw.main(["--dry-run"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "⚠️ Fireflies section error: no FIREFLIES_API_KEY" in out
    assert "Client state (Gmail) OK" in out


def test_main_dry_run_gmail_error_does_not_block_fireflies(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(mlw.envparse, "parse_env_file", lambda path: {"FIREFLIES_API_KEY": "test-key"})
    monkeypatch.setattr(mlw, "list_transcripts", lambda api_key, throttle_s=1.0: [])
    monkeypatch.setattr(mlw, "_probe", lambda url: "ok")
    monkeypatch.setattr(mlw, "ENVELOPES", tmp_path / "no-envelopes-here")  # is_dir() False -> have = set()

    # gmail_section_lines lazily imports client_state_digest and calls its
    # gmail_section -- forcing THAT to raise proves gmail_section_lines's own
    # try/except independence without depending on any particular I/O error
    # shape from a bad path (Path.exists()/is_file() swallow OSError, so a
    # bogus CLIENT_STATE_DIR degrades to "baseline missing" instead of
    # raising -- this is the deterministic way to prove the guard fires).
    def _boom(*a, **k):
        raise RuntimeError("gmail digest blew up")

    monkeypatch.setattr(cs_digest, "gmail_section", _boom)
    monkeypatch.setenv("CLIENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(tmp_path / "vault"))

    rc = mlw.main(["--dry-run"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "Meeting loop OK — 0 transcript(s)" in out
    assert "⚠️ Gmail section error: RuntimeError: gmail digest blew up" in out


def test_main_dry_run_renders_both_sections_when_fireflies_raises(tmp_path, monkeypatch, capsys):
    # G0B-16: list_transcripts (not just a missing API key) raising must not
    # prevent the Gmail digest from being composed and sent.
    monkeypatch.setattr(mlw.envparse, "parse_env_file", lambda path: {"FIREFLIES_API_KEY": "test-key"})

    def _boom(api_key, throttle_s=1.0):
        raise RuntimeError("fireflies API down")

    monkeypatch.setattr(mlw, "list_transcripts", _boom)
    now_iso = datetime.now(timezone.utc).isoformat()
    state_dir, vault_dir = _seed_state(tmp_path, last_success_iso=now_iso)
    monkeypatch.setenv("CLIENT_STATE_DIR", str(state_dir))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(vault_dir))

    rc = mlw.main(["--dry-run"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "⚠️ Fireflies section error: RuntimeError: fireflies API down" in out
    assert "Client state (Gmail) OK" in out


def test_main_dry_run_unreadable_secrets_file_still_renders_the_gmail_section(tmp_path, monkeypatch, capsys):
    """G2A-6: orgs/clearworksai/secrets.env is the FIREFLIES section's input and
    nothing else's. main() read it before either section ran, so a missing or
    unreadable file crashed the whole watch and the Gmail digest — which needs
    no secrets at all — never rendered."""
    def _boom(path):
        raise FileNotFoundError(2, "No such file or directory", str(path))

    monkeypatch.setattr(mlw.envparse, "parse_env_file", _boom)
    now_iso = datetime.now(timezone.utc).isoformat()
    state_dir, vault_dir = _seed_state(tmp_path, last_success_iso=now_iso)
    monkeypatch.setenv("CLIENT_STATE_DIR", str(state_dir))
    monkeypatch.setenv("CLIENT_STATE_VAULT", str(vault_dir))

    rc = mlw.main(["--dry-run"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "⚠️ Fireflies section error: FileNotFoundError" in out
    assert "Client state (Gmail) OK" in out
