"""FR-012 run_meeting --dry-run: apply refused; no gws/bus; diffs + reason line."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_apply_exits_64() -> None:
    from run_meeting import main

    assert main(["--meeting-id", "x", "--apply"]) == 15  # R2: d09-signed gate (FR-012 sign-check)
    assert main(["--meeting-id", "x"]) == 64
    assert main(["--meeting-id", "fireflies:../etc/passwd", "--dry-run"]) == 64


def _seed(tmp_path: Path) -> tuple[Path, Path, str]:
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n\n## History (dated, newest first)\n\n- old\n",
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-03.md").write_text(
        """# Client: Alloi — Tactical Reports

## Node
id: alloi-03
kind: project
client: alloi
parent: alloi-01
title: Tactical Reports
aliases: tacticals, tactical report, arch tactical
domains: alloi.us
delivery_state: active

## History (dated, newest first)

- old

## Open Items
""",
        encoding="utf-8",
    )
    mid = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
    env = vault / "raw/media/transcripts/fireflies" / mid
    env.mkdir(parents=True)
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": mid},
        "title": "Weekly tacticals review",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 12,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Marcos", "email": "marcos@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "hello tacticals", "ts": 0}],
        "native_summary": {"overview": "hello tacticals"},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (env / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (env / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": "Alloi",
            "domain": "alloi.us",
            "relationship": "client",
            "confidence": 0.9,
            "evidence": "hello tacticals",
        },
        "summary": {"overview": "hello tacticals", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [
            {
                "text": "Ship dry-run",
                "owner_participant": 0,
                "owner_name": "Josh Weiss",
                "deadline_iso": "2026-12-01",
                "quote": "hello",
            }
        ],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }
    (env / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text('{"contacts":[]}', encoding="utf-8")
    return vault, repo, mid


def test_dry_run_prints_nouns_and_diffs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    from run_meeting import main

    vault, repo, mid = _seed(tmp_path)
    trap = tmp_path / "trap"
    trap.mkdir()
    for name in ("gws", "bus", "meeting-crm-sync", "meeting-fanout"):
        p = trap / name
        p.write_text("#!/bin/sh\necho TRAPPED \"$0\" >> \"$TRAP_LOG\"\n", encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "trap.log"
    monkeypatch.setenv("TRAP_LOG", str(log))
    monkeypatch.setenv("PATH", str(trap) + os.pathsep + os.environ.get("PATH", ""))

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)
    rc = main(
        [
            "--meeting-id",
            f"fireflies:{mid}",
            "--dry-run",
            "--repo-root",
            str(repo),
            "--vault",
            str(vault),
        ]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "home=" in out and "node=alloi-03" in out and "rule=2" in out
    assert "created=" in out and "promotion=" in out
    assert "---" in out and "+++" in out
    assert "meetings/" in out
    assert "quotes kept decisions=1 commitments=1" in out
    assert "crm interaction rows:" in out
    assert "Ship dry-run · owner: Josh · due 2026-12-01" in out
    assert "task payloads:" in out
    assert "subject:" in out.lower() or "Recap:" in out
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""
    # no progress.json
    assert not (vault / "raw/media/transcripts/_state").exists()


def test_defaults_are_shared_checkout() -> None:
    from run_meeting import DEFAULT_REPO_ROOT, DEFAULT_VAULT
    from pathlib import Path as P

    assert str(DEFAULT_REPO_ROOT) == "/Users/joshweiss/code/cortextos"
    assert Path.home() / "code/knowledge-sync" == DEFAULT_VAULT or str(DEFAULT_VAULT).endswith("knowledge-sync")
    _ = P
