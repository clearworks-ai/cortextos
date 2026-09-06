from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from atomic import atomic_write
from sign_dry_run import marker_path


@pytest.fixture(autouse=True)
def _no_live_daemon(monkeypatch):
    """G0 hard rule: tests must never shell out to a real cortextos or gws
    binary. PATH is narrowed to /usr/bin:/bin — git (a subprocess dependency
    of progress.check_vault_gitignore and this file's own `git init` calls)
    lives at /usr/bin/git; the real cortextos (/opt/homebrew/bin) and gws
    (~/.local/bin) are excluded, so run_meeting.py's worker guard hits
    FileNotFoundError and takes the documented "daemon down, skipped" path
    (G-60) instead of querying this machine's live daemon. Deviation: the
    plan's Task 8 snippet did not show this fixture; added because
    `cortextos` is on this machine's real PATH (verified via `which
    cortextos` -> /opt/homebrew/bin/cortextos) and the task's binding G0
    fold rules require PATH-shimming cortextos/gws in every test."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")


def _seed_signed_marker(vault: Path, meeting_id: str) -> None:
    """G0b C2-3: --skip-sign-check is deleted entirely — no bypass flag can
    exist for a production write gate. Tests that need to get PAST the
    sign-check to exercise a downstream guard seed a real d09-signed.json
    directly (sign_dry_run.py's own nouns-validation logic is covered
    separately by test_sign_dry_run.py, above)."""
    marker = marker_path(vault, "fireflies", meeting_id)
    atomic_write(marker, json.dumps({"meeting_id": meeting_id, "signed_by": "test"}).encode("utf-8"))


def test_apply_refuses_without_sign_marker(tmp_path, monkeypatch):
    from run_meeting import main
    monkeypatch.delenv("FIREFLIES_API_KEY", raising=False)  # symmetry, R2-F-5
    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    rc = main([
        "--meeting-id", "MID", "--apply",
        "--repo-root", str(tmp_path / "repo"), "--vault", str(vault),
    ])
    assert rc == 15


def test_apply_signed_marker_reaches_fetch(tmp_path, monkeypatch):
    import urllib.request
    from run_meeting import main

    # G0a R2-F-5: fetch_fireflies.py:54-57 reads FIREFLIES_API_KEY from the
    # ambient environment BEFORE consulting <repo-root>/orgs/clearworksai/
    # secrets.env — on any shell where that var happens to be exported, this
    # test would otherwise make a live Fireflies GraphQL POST via
    # urllib.request.urlopen (fetch_fireflies.py:211). delenv it
    # structurally and shim urlopen to raise as defense in depth, so a
    # regression here is loud, never a silent live network call.
    monkeypatch.delenv("FIREFLIES_API_KEY", raising=False)

    def _no_network(*_a, **_kw):
        raise AssertionError("urlopen must never be called by an R2 apply-guard test")

    monkeypatch.setattr(urllib.request, "urlopen", _no_network)

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    _seed_signed_marker(vault, "MID")
    # No FIREFLIES fixture/env wired at this step — expect it to fail at the
    # fetch step (exit 2), proving it got PAST: the sign-check (a real
    # d09-signed.json — no bypass flag exists, C2-3), the worker guard
    # (daemon down — cortextos is not on PATH here), the vault .gitignore
    # precondition (R2-F-4 — this vault isn't even a git repo, which
    # check_vault_gitignore treats as "nothing to check"), and the CRM
    # scripts precondition (R2-F-1 — CODE_ROOT's real meeting-crm-sync.py/
    # meeting-fanout.py already carry --full-file by this point in the
    # build, Tasks 5-7).
    rc = main([
        "--meeting-id", "MID", "--apply",
        "--repo-root", str(tmp_path / "repo"), "--vault", str(vault),
    ])
    assert rc == 2


def test_apply_exits_11_when_crm_scripts_predate_r2(tmp_path, monkeypatch):
    # R2-F-1: a mechanical, fail-fast precondition — if CODE_ROOT's CRM/
    # fanout scripts ever regress to a pre-R2 copy (no --full-file), --apply
    # must refuse immediately (exit 11) rather than reach a confusing
    # `rc=2 unrecognized arguments` deep inside _apply_writes.
    import run_meeting

    stale = tmp_path / "stale.py"
    stale.write_text(
        "#!/usr/bin/env python3\nimport argparse\n"
        "p = argparse.ArgumentParser()\np.add_argument('--meeting-id')\np.parse_args()\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(run_meeting, "CRM_SYNC", stale)
    monkeypatch.setattr(run_meeting, "FANOUT_SCRIPT", stale)

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    _seed_signed_marker(vault, "MID")

    rc = run_meeting.main([
        "--meeting-id", "MID", "--apply",
        "--repo-root", str(tmp_path / "repo"), "--vault", str(vault),
    ])
    assert rc == 11


def test_apply_exits_10_when_vault_gitignore_missing_state_or_lock(tmp_path, monkeypatch):
    # R2-F-4: a git-initialized vault that never landed Task 9 Step 0's
    # .gitignore lines must refuse before any write, not silently commit
    # into a vault that will show _state/ or *.md.lock in an unscoped
    # `git status --porcelain` (violating FR-012 line 328).
    from run_meeting import main

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    _seed_signed_marker(vault, "MID")

    rc = main([
        "--meeting-id", "MID", "--apply",
        "--repo-root", str(tmp_path / "repo"), "--vault", str(vault),
    ])
    assert rc == 10
