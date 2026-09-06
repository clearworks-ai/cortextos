from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from atomic import atomic_write
from sign_dry_run import marker_path

# Captured at collection time, before the autouse _no_live_daemon fixture
# below narrows os.environ["PATH"] to /usr/bin:/bin for every test — needed
# by test_apply_runs_phase3_rollup_status_filed_before_commit to locate a
# real `node` interpreter (node_modules/.bin/tsx's shebang) once that
# narrowing is in effect.
_ORIGINAL_PATH = os.environ.get("PATH", "")


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
    separately by test_sign_dry_run.py, above).

    CH-1/S-2: progress.validate_sign_marker() now requires non-empty
    signed_by/signed_at plus a capture_sha256 that matches a real
    capture_path file — a marker with just {"signed_by": "test"} (this
    helper's pre-fix output) no longer passes the sign-check at all, so this
    now writes a fully valid marker.

    Finding 4b: signed_by must additionally be in validate_sign_marker's
    allowlist (default {"Josh"}) — "test" is not, so this now signs as
    "Josh" (the capture_path already lives inside the envelope directory,
    satisfying finding 4a's containment check unchanged)."""
    marker = marker_path(vault, "fireflies", meeting_id)
    capture = marker.parent / "dry-run.txt"
    capture.parent.mkdir(parents=True, exist_ok=True)
    capture_text = (
        "home=projects/alloi-03.md node=alloi-03 rule=2\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1\ntasks:\nsubject: Recap\n"
    )
    capture.write_text(capture_text, encoding="utf-8")
    atomic_write(marker, json.dumps({
        "meeting_id": meeting_id,
        "signed_by": "Josh",
        "signed_at": "2026-09-05T00:00:00Z",
        "capture_path": str(capture),
        "capture_sha256": hashlib.sha256(capture_text.encode("utf-8")).hexdigest(),
    }).encode("utf-8"))


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


def test_apply_has_no_refetch_flag(tmp_path):
    # D-09 review finding 1, part (d): the simplest way to guarantee --apply
    # never re-fetches after sign-off is to never expose a --refetch flag on
    # this CLI at all (fetch_fireflies.py has its own --refetch, but
    # run_meeting.py never passes it through) — argparse must refuse this
    # combination outright.
    from run_meeting import main

    with pytest.raises(SystemExit) as exc:
        main([
            "--meeting-id", "MID", "--apply", "--refetch",
            "--repo-root", str(tmp_path / "repo"), "--vault", str(tmp_path / "vault"),
        ])
    assert exc.value.code == 2


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


MID = "01M1MW2GAZ1DQ0C6PG3KJ557JA"


def _git(vault: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(vault), *args], capture_output=True, text=True)


def _seed_apply_vault(tmp_path: Path) -> tuple[Path, Path, str]:
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
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\nclient: alloi\n"
        "parent: alloi-01\ntitle: Tactical Reports\naliases: tacticals, tactical report, arch tactical\n"
        "domains: alloi.us\ndelivery_state: active\n\n## History (dated, newest first)\n\n- old\n\n"
        "## Open Items\n",
        encoding="utf-8",
    )
    env_dir = vault / "raw/media/transcripts/fireflies" / MID
    env_dir.mkdir(parents=True)
    source = {
        "schema": "brain.source/1", "source": {"kind": "fireflies", "id": MID},
        "title": "Weekly tacticals review", "occurred_at": "2026-09-04T17:00:00Z", "duration_s": 900,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            # G0b C2-4: 5 external attendees (not 1) so this fixture's own
            # receipt actually clears the real FR-012 line ~332 acceptance
            # minimum (>=5 CRM contacts, G-54) instead of only proving the
            # partial "not a zero" guard round 2 settled for.
            {"name": "Marcos", "email": "marcos@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Sam", "email": "sam@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Alex", "email": "alex@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Priya", "email": "priya@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Dana", "email": "dana@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "Please send the tactical report draft by Monday", "ts": 0}],
        "native_summary": {"overview": "Scoped tactical reports."},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (env_dir / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (env_dir / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    # G0a F-5: without a seeded extraction.json whose inputSha matches
    # source.json's own recomputed sha256, extract_meeting.py's main() falls
    # through its idempotency check and shells the real `claude -p` binary —
    # a live, metered, network-dependent, nondeterministic call on every run
    # of this test (three --apply invocations here). Seed it so the
    # `existing_sha == input_sha and not args.re_extract` branch
    # (extract_meeting.py:303-306) short-circuits with rc=0 and zero LLM
    # calls. Same fixture shape as test_run_meeting_dry.py's _seed(), which
    # already proves this schema passes extract_meeting.py's real
    # validate_extraction() check.
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
            "evidence": "Please send the tactical report draft by Monday",
        },
        "summary": {"overview": "Scoped tactical reports.", "bullets": []},
        "decisions": [
            {"text": "Keep cadence", "quote": "Please send the tactical report draft by Monday"}
        ],
        "commitments": [
            {
                "text": "Send the tactical report draft",
                "owner_participant": 0,
                "owner_name": "Josh Weiss",
                "deadline_iso": "2026-09-08",
                "quote": "Please send the tactical report draft by Monday",
            }
        ],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }
    (env_dir / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai").mkdir(parents=True)
    (repo / "orgs/clearworksai/secrets.env").write_text("", encoding="utf-8")
    # R2-F-2: pre-create the CRM data directory under the tmp repo fixture
    # so upsert-contact.py's CONTACTS_PATH.write_text(...) (no mkdir of its
    # own) succeeds writing there instead of anywhere else — this, combined
    # with progress.crm_env(os.environ, repo) always deriving CRM_* paths
    # from --repo-root (R2-F-1), is what keeps every CRM write under
    # tmp_path and never inside the real checkout or CODE_ROOT worktree.
    (repo / "orgs/clearworksai/agents/crm/crm").mkdir(parents=True)
    _git(vault, "init", "-q")
    _git(vault, "config", "user.email", "b@b")
    _git(vault, "config", "user.name", "b")
    # G0a F-6: land the FR-014 .gitignore lines (spec line 359: "_state/ ...
    # added by the build") in the seed commit, exactly matching Task 9 Step
    # 0's one-time production build step — --apply itself never touches
    # .gitignore. *.md.lock covers meeting_writeback.py's client_file_lock
    # leftover (:53-56), which no code in this plan removes. *.lock (broader)
    # covers the concurrent G2-P1-4 fix's client_file_lock use on the
    # (non-.md) recap/writeback ledger paths — same transient-lock-file
    # class, different extension.
    (vault / ".gitignore").write_text(
        "raw/media/transcripts/_state/\n*.md.lock\n*.lock\n", encoding="utf-8"
    )
    _git(vault, "add", "-A")
    _git(vault, "commit", "-q", "-m", "seed")
    return vault, repo, MID


def _install_fakes(tmp_path: Path) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    cortextos = bindir / "cortextos"
    cortextos.write_text(
        "#!/bin/sh\n"
        'if [ "$1 $2" = "bus event-dedup" ]; then echo SURFACE; exit 0; fi\n'
        'if [ "$1 $2" = "bus create-task" ]; then echo task-1; exit 0; fi\n'
        'if [ "$1" = "list-workers" ]; then exit 1; fi\n'
        "exit 0\n"
    )
    cortextos.chmod(0o755)
    gws = bindir / "gws"
    gws.write_text("#!/bin/sh\nexit 0\n")
    gws.chmod(0o755)
    # G0a F-5: defense in depth on top of the seeded extraction.json's
    # matching inputSha (which already makes extract_meeting.py return 0
    # before ever building a `claude -p` command). If that short-circuit
    # ever regresses, this shim makes the failure loud and immediate instead
    # of silently placing a real, network-dependent LLM call.
    claude = bindir / "claude"
    claude.write_text(
        "#!/bin/sh\necho 'claude must never be invoked by an R2 test' >&2\nexit 99\n"
    )
    claude.chmod(0o755)
    # G0a F-5 defense in depth: `_status_plan_argv` prefers the repo's own
    # pinned node_modules/.bin/tsx by absolute path and never touches PATH
    # when that file exists, falling back to `npx --no-install tsx` (which
    # DOES resolve via PATH) only when the local install is missing. Trap
    # both names so a regression to the ambient/unpinned resolution is loud.
    npx_trap_log = tmp_path / "npx-tsx-trap.log"
    for name in ("npx", "tsx"):
        shim = bindir / name
        shim.write_text(
            f'#!/bin/sh\necho "TRAPPED $0 $@" >> "{npx_trap_log}"\nexit 98\n'
        )
        shim.chmod(0o755)
    return bindir


def _write_capture(tmp_path: Path) -> Path:
    capture = tmp_path / "dry-run.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nSend the tactical report draft · owner: Josh · due 2026-09-08\n"
        "subject: Recap: Weekly tacticals review — 2026-09-04\n",
        encoding="utf-8",
    )
    return capture


def _write_phase3_capture(tmp_path: Path) -> Path:
    capture = tmp_path / "dry-run-phase3.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1 open_questions=0 dropped={}\n"
        "tasks:\nSend the tactical report draft · owner: Josh · due 2026-09-08\n"
        "subject: Recap: Weekly tacticals review — 2026-09-04\n"
        "would-touch: clients/alloi.md (engagements-rollup)\n"
        "would-touch: STATE.md (state)\n"
        "would-write: raw/areas/clearworks/clients/alloi/status-update-2026-09-04.md\n"
        "would-file: 2026-09-04 filed \"Weekly tacticals review\" under alloi-03 "
        "→ alloi-03 (rule 2, conf 1.0) fireflies:" + MID + "\n",
        encoding="utf-8",
    )
    return capture


def _assert_only_pathspec_and_ignored_changed(vault: Path, pathspec: list[str]) -> None:
    """G0a F-6: a bare (pathspec-less) `git status --porcelain` cannot pass —
    `client_file_lock` (meeting_writeback.py:53-56) leaves an untracked
    `<page>.md.lock`, and (pre-fix) `--apply` itself mutated `.gitignore`.
    Both are now handled by landing `.gitignore` lines once, in the seed
    commit (never inside `--apply`, see Task 9 Step 0), so this asserts two
    things: (1) the literal FR-012 line 328 wording — `git status
    --porcelain -- <the FR-014 pathspec>` is empty; (2) nothing changed
    OUTSIDE that pathspec either, except `.gitignore` (unmodified since the
    seed, but allowed by name here as belt-and-suspenders) and `*.md.lock`
    (gitignored, so it should never even appear — asserted anyway)."""
    scoped = _git(vault, "status", "--porcelain", "--", *pathspec)
    assert scoped.stdout.strip() == "", scoped.stdout
    full = _git(vault, "status", "--porcelain")
    unexpected = [
        line for line in full.stdout.splitlines()
        if not line.endswith(".gitignore") and not line.endswith(".md.lock")
    ]
    assert unexpected == [], f"unexpected changes outside pathspec/.gitignore/.md.lock: {unexpected}"


def _fanout_commitment_id(mid: str) -> str:
    from adapt_meeting import _commitment_id

    return _commitment_id("fireflies", mid, "Send the tactical report draft", 0)


def _commitment_id_for_text(mid: str, text: str) -> str:
    from adapt_meeting import _commitment_id

    return _commitment_id("fireflies", mid, text, 0)


def _add_second_commitment(vault: Path, mid: str) -> None:
    """Appends a second OURS (Josh-owned) commitment to the seeded
    extraction.json so a test can exercise a scenario needing >=2
    commitments (e.g. CH-5's partial-task-map-recovery case) on top of
    _seed_apply_vault's single-commitment fixture."""
    extraction_path = vault / "raw/media/transcripts/fireflies" / mid / "extraction.json"
    extraction = json.loads(extraction_path.read_text(encoding="utf-8"))
    extraction["commitments"].append({
        "text": "Send the follow-up deck",
        "owner_participant": 0,
        "owner_name": "Josh Weiss",
        "deadline_iso": "2026-09-10",
        "quote": "Please send the tactical report draft by Monday",
    })
    extraction_path.write_text(json.dumps(extraction), encoding="utf-8")


def test_apply_recovers_task_map_from_bus_when_fanout_dedup_skips_after_lost_checkpoint(tmp_path):
    # CH-5: kill the parent after fanout creates a task and returns, but
    # before progress is merged. On restart, `cortextos bus event-dedup`
    # returns SKIP for the now-already-surfaced commitment (--strict path)
    # and fanout's own task_map comes back empty — the orchestrator must not
    # silently mark tasks done with an empty map (permanently losing the
    # mapping and failing acceptance forever); it reconstructs the mapping
    # from `cortextos bus list-tasks --json` first, matching on the
    # `[commitment:<id>]` description marker meeting-fanout.py itself uses
    # for its own CH-4 retry-lookup.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    cid = _fanout_commitment_id(mid)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    cortextos = bindir / "cortextos"
    cortextos.write_text(
        "#!/bin/sh\n"
        'if [ "$1 $2" = "bus event-dedup" ]; then echo SKIP; exit 0; fi\n'
        f'if [ "$1 $2" = "bus list-tasks" ]; then echo \'[{{"id": "recovered-task-1", '
        f'"description": "owner: Josh [commitment:{mid}/{cid}]"}}]\'; exit 0; fi\n'
        'if [ "$1" = "list-workers" ]; then exit 1; fi\n'
        "exit 0\n"
    )
    cortextos.chmod(0o755)
    (bindir / "gws").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "gws").chmod(0o755)
    claude = bindir / "claude"
    claude.write_text("#!/bin/sh\necho 'claude must never be invoked by an R2 test' >&2\nexit 99\n")
    claude.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout

    import progress
    prog_path = progress.progress_path(vault, "fireflies", mid)
    doc = progress.load_progress(prog_path)
    assert {"commitmentId": cid, "taskId": "recovered-task-1"} in doc["tasks"]["created"]

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert {"commitmentId": cid, "taskId": "recovered-task-1"} in receipt["tasks"]


def test_apply_exits_8_when_fanout_dedup_skips_and_bus_has_no_matching_task(tmp_path):
    # CH-5: the same lost-checkpoint scenario, but this time the bus
    # genuinely has no task carrying the commitment marker (recovery yields
    # nothing) — the orchestrator must refuse to mark tasks done with a
    # fabricated/empty mapping and exit 8 instead.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    cid = _fanout_commitment_id(mid)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    cortextos = bindir / "cortextos"
    cortextos.write_text(
        "#!/bin/sh\n"
        'if [ "$1 $2" = "bus event-dedup" ]; then echo SKIP; exit 0; fi\n'
        'if [ "$1 $2" = "bus list-tasks" ]; then echo \'[]\'; exit 0; fi\n'
        'if [ "$1" = "list-workers" ]; then exit 1; fi\n'
        "exit 0\n"
    )
    cortextos.chmod(0o755)
    (bindir / "gws").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "gws").chmod(0o755)
    claude = bindir / "claude"
    claude.write_text("#!/bin/sh\necho 'claude must never be invoked by an R2 test' >&2\nexit 99\n")
    claude.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 8, result.stderr + result.stdout
    assert f"FAILED at tasks: dedup skipped but no created task recorded for {cid}" in result.stderr

    import progress
    prog_path = progress.progress_path(vault, "fireflies", mid)
    doc = progress.load_progress(prog_path)
    assert not progress.step_done(doc, "tasks")


def test_apply_partial_task_map_recovers_only_the_still_unmapped_commitment(tmp_path):
    # CH-5 (finding 1, round 2): the pre-fix reconstruction ran ONLY when the
    # entire merged task_map was empty. Simulate a partial crash instead:
    # progress.json already durably recorded c1's mapping from an earlier
    # run, but c2's fanout succeeded and then the parent died before
    # merge_progress recorded IT — so this run's fanout dedup-SKIPs both
    # (both were already surfaced), created_pairs comes back non-empty (c1
    # alone), and the pre-fix code never even looked at the bus for c2,
    # permanently losing its mapping. The fix must recover c2 specifically
    # without disturbing c1.
    import progress

    vault, repo, mid = _seed_apply_vault(tmp_path)
    _add_second_commitment(vault, mid)
    c1 = _fanout_commitment_id(mid)
    c2 = _commitment_id_for_text(mid, "Send the follow-up deck")

    bindir = tmp_path / "bin"
    bindir.mkdir()
    cortextos = bindir / "cortextos"
    cortextos.write_text(
        "#!/bin/sh\n"
        'if [ "$1 $2" = "bus event-dedup" ]; then echo SKIP; exit 0; fi\n'
        f'if [ "$1 $2" = "bus list-tasks" ]; then echo \'[{{"id": "recovered-c2-task", '
        f'"description": "owner: Josh [commitment:{mid}/{c2}]"}}]\'; exit 0; fi\n'
        'if [ "$1" = "list-workers" ]; then exit 1; fi\n'
        "exit 0\n"
    )
    cortextos.chmod(0o755)
    (bindir / "gws").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "gws").chmod(0o755)
    claude = bindir / "claude"
    claude.write_text("#!/bin/sh\necho 'claude must never be invoked by an R2 test' >&2\nexit 99\n")
    claude.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    prog_path = progress.progress_path(vault, "fireflies", mid)
    progress.merge_progress(prog_path, "tasks", {
        "done": False,
        "created": [{"commitmentId": c1, "taskId": "task-old-1"}],
        "created_ids": [c1],
        "pending": [],
    })

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout

    doc = progress.load_progress(prog_path)
    assert progress.step_done(doc, "tasks")
    assert {"commitmentId": c1, "taskId": "task-old-1"} in doc["tasks"]["created"]
    assert {"commitmentId": c2, "taskId": "recovered-c2-task"} in doc["tasks"]["created"]

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert {"commitmentId": c1, "taskId": "task-old-1"} in receipt["tasks"]
    assert {"commitmentId": c2, "taskId": "recovered-c2-task"} in receipt["tasks"]


def _run_apply_with_fake_writeback(tmp_path: Path, wb_exit: int, wb_stderr: str) -> subprocess.CompletedProcess:
    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    fake_wb = tmp_path / "fake_writeback.py"
    fake_wb.write_text(
        f"import sys\nprint({wb_stderr!r}, file=sys.stderr)\nsys.exit({wb_exit})\n", encoding="utf-8",
    )
    env["BRAIN_TEST_WRITEBACK_OVERRIDE"] = str(fake_wb)

    driver = tmp_path / "run_with_override.py"
    driver.write_text(
        "import os, sys\n"
        "sys.path.insert(0, os.environ['BRAIN_DIR'])\n"
        "import run_meeting\n"
        "run_meeting.WRITEBACK = __import__('pathlib').Path(os.environ['BRAIN_TEST_WRITEBACK_OVERRIDE'])\n"
        "raise SystemExit(run_meeting.main(sys.argv[1:]))\n",
        encoding="utf-8",
    )
    env["BRAIN_DIR"] = str(BRAIN)

    return subprocess.run(
        [sys.executable, str(driver), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )


def test_apply_writeback_rc1_exits_7_with_stderr_tail(tmp_path):
    # CH-8/S-1: FR-012's exit-code table assigns every FR-005 (writeback)
    # failure exit 7, regardless of the subprocess's own return code.
    # meeting_writeback.py itself can return 1 (apply_resolution's
    # SystemExit(1) for a payload missing source.kind/id) — both truthy, so
    # the pre-fix `wb.returncode or 7` never fired and leaked the raw code.
    result = _run_apply_with_fake_writeback(
        tmp_path, 1, "apply_resolution: missing source.kind/source.id (D-16)",
    )
    assert result.returncode == 7, result.stderr + result.stdout
    assert "FAILED at writeback: rc=1" in result.stderr
    assert "missing source.kind/source.id" in result.stderr


def test_apply_writeback_rc64_exits_7(tmp_path):
    # CH-8/S-1: rc=64 (legacy no-resolution/bad-args path) is also truthy —
    # must still map to exit 7, not leak 64.
    result = _run_apply_with_fake_writeback(tmp_path, 64, "bad args")
    assert result.returncode == 7, result.stderr + result.stdout
    assert "FAILED at writeback: rc=64" in result.stderr


def test_apply_restart_and_force_are_zero_new_writes(tmp_path):
    from progress import acceptance_minimums, fr014_pathspec
    from writeback_render import meeting_note_rel

    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    def run_apply(*extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
             "--repo-root", str(repo), "--vault", str(vault), "--apply", *extra],
            capture_output=True, text=True, env=env,
        )

    r1 = run_apply()
    assert r1.returncode == 0, r1.stderr + r1.stdout
    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt1 = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt1["vault_sha"]

    # G0b C2-4: the production --apply path itself calls
    # progress.acceptance_minimums() before the vault commit and embeds the
    # result in receipt.json. With 5 external attendees (rev3), this
    # fixture's own receipt now clears the FULL FR-012 line ~332 minimum set
    # — round 2 settled for only proving the guard wasn't a silent zero,
    # because its 1-external-attendee fixture could never clear >=5
    # contacts by construction.
    validated_doc = json.loads(
        (vault / "raw/media/transcripts/fireflies" / mid / "validated.json").read_text(encoding="utf-8")
    )
    minimums = acceptance_minimums(receipt1, decisions_kept=len(validated_doc.get("decisions") or []))
    assert minimums == []
    assert receipt1["minimums"] == {"ok": True, "missing": [], "enforced": True}
    assert len(receipt1["contacts"]) >= 5

    # R2-F-2/R2-F-1: prove the CRM data this run wrote lives under the tmp
    # repo fixture, never the real checkout or the CODE_ROOT worktree.
    crm_dir = repo / "orgs/clearworksai/agents/crm/crm"
    assert (crm_dir / "contacts.json").exists()
    interactions_text = (crm_dir / "interactions.jsonl").read_text(encoding="utf-8")
    assert f"fireflies:{mid}" in interactions_text

    wb_payload = json.loads(
        (vault / "raw/media/transcripts/fireflies" / mid / "writeback-payload.json").read_text(encoding="utf-8")
    )
    pathspec = fr014_pathspec(
        mid, str(receipt1.get("home_path") or ""), meeting_note_rel(wb_payload["meetings"][0])
    )

    r2 = run_apply()
    assert r2.returncode == 0, r2.stderr + r2.stdout
    assert "already applied" in r2.stdout
    _assert_only_pathspec_and_ignored_changed(vault, pathspec)

    r3 = run_apply("--force")
    assert r3.returncode == 0, r3.stderr + r3.stdout
    receipt3 = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt3["vault_sha"] == receipt1["vault_sha"]
    assert receipt3["last_run_at"] != receipt1["last_run_at"]
    assert receipt3["minimums"] == {"ok": True, "missing": [], "enforced": True}
    _assert_only_pathspec_and_ignored_changed(vault, pathspec)


def test_apply_ledger_already_skipped_recovers_subject_and_still_passes_minimums(tmp_path):
    # CH-6 (supersedes the old G0b C2-4 scenario here): pre-seeding the recap
    # ledger with this meeting's key BEFORE the run simulates the exact
    # crash window CH-6 describes — a prior run's real Gmail draft + ledger
    # append already happened, then it crashed before progress.json's
    # "draft" key was merged. FR-008 ledger-skips on this run (0 drafts
    # created THIS run) with no `planned` entry, so the pre-fix orchestrator
    # recorded `subject: None` forever and failed acceptance (exit 9) even
    # though the draft genuinely exists. The fix must recover (or, absent a
    # recoverable subject — this ledger line predates the `<key>\t<subject>`
    # format — fall back to a placeholder) and NEVER count this as a
    # zero-draft acceptance failure.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    ledger = vault / "raw/media/transcripts/_recap-ledger.txt"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(f"fireflies:{mid}\n", encoding="utf-8")  # legacy row, no recoverable subject

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["draft"] == "(ledger-skipped)"
    assert receipt["minimums"]["ok"] is True
    assert receipt["minimums"]["missing"] == []
    assert receipt["vault_sha"]


def test_apply_recap_recovers_real_subject_from_ledger_tab_row(tmp_path):
    # CH-6: when the ledger row DOES carry the `<key>\t<subject>` format
    # meeting_recap_draft.append_ledger writes, recovery must use the real
    # subject rather than the generic placeholder.
    import progress

    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    real_subject = "Recap: Weekly tacticals review — 2026-09-04"
    ledger = vault / "raw/media/transcripts/_recap-ledger.txt"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(f"fireflies:{mid}\t{real_subject}\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout

    prog_path = progress.progress_path(vault, "fireflies", mid)
    doc = progress.load_progress(prog_path)
    assert doc["draft"]["subject"] == real_subject

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["draft"] == real_subject
    assert receipt["minimums"]["ok"] is True


def test_apply_exits_9_when_decisions_shortfall_blocks_commit_before_vault_write(tmp_path):
    # G0b C2-4 (retained under CH-6): the production --apply path must still
    # call progress.acceptance_minimums() against the composed receipt and
    # fail loud (exit 9) BEFORE the vault commit for a genuine shortfall —
    # CH-6 only changed how a ledger-skip's draft subject is recorded, not
    # whether other acceptance minimums are enforced for the acceptance
    # meeting. Zero out the seeded extraction's decisions so decisions_kept
    # drops below the >=1 minimum while every other step still succeeds.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    extraction_path = vault / "raw/media/transcripts/fireflies" / mid / "extraction.json"
    extraction = json.loads(extraction_path.read_text(encoding="utf-8"))
    extraction["decisions"] = []
    extraction_path.write_text(json.dumps(extraction), encoding="utf-8")

    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    pre_head = _git(vault, "rev-parse", "HEAD").stdout.strip()

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 9, result.stderr + result.stdout
    assert "FAILED at minimums" in result.stderr

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["minimums"]["ok"] is False
    assert receipt["minimums"]["enforced"] is True
    assert "decisions_kept=0 < 1" in receipt["minimums"]["missing"]

    post_head = _git(vault, "rev-parse", "HEAD").stdout.strip()
    assert post_head == pre_head  # never committed


def test_apply_non_acceptance_meeting_never_blocked_by_minimums_shortfall(tmp_path, monkeypatch):
    # G2-P1-1: FR-012 line ~332's acceptance minimums are the ACCEPTANCE
    # MEETING's own gate, not a general per-meeting production block. Move
    # the enforced set (via the env override) to a different id, so this
    # fixture's own meeting id — MID, with a genuine shortfall seeded below —
    # is no longer enforced: --apply must still complete and commit, with
    # `minimums.enforced: false` and the real shortfall visible only as
    # `ok: false, missing: [...]` for observability, never a block.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    extraction_path = vault / "raw/media/transcripts/fireflies" / mid / "extraction.json"
    extraction = json.loads(extraction_path.read_text(encoding="utf-8"))
    extraction["decisions"] = []
    extraction_path.write_text(json.dumps(extraction), encoding="utf-8")

    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    env["BRAIN_ACCEPTANCE_MEETING_IDS"] = "some-other-meeting-id"
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert "FAILED at minimums" not in result.stderr

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["vault_sha"]
    assert receipt["minimums"]["enforced"] is False
    assert receipt["minimums"]["ok"] is False
    assert "decisions_kept=0 < 1" in receipt["minimums"]["missing"]


def test_acceptance_meeting_ids_default_and_env_override(monkeypatch):
    # G2-P1-1: module const overridable via BRAIN_ACCEPTANCE_MEETING_IDS
    # (comma list) — test both the default and the override.
    import run_meeting

    monkeypatch.delenv("BRAIN_ACCEPTANCE_MEETING_IDS", raising=False)
    assert run_meeting._acceptance_meeting_ids() == {"01M1MW2GAZ1DQ0C6PG3KJ557JA"}

    monkeypatch.setenv("BRAIN_ACCEPTANCE_MEETING_IDS", "abc, def ,ghi")
    assert run_meeting._acceptance_meeting_ids() == {"abc", "def", "ghi"}


def _stamp_phase3_capture(vault: Path, mid: str) -> None:
    """Deviation (Task 4/Task 5 boundary): `progress.validate_phase3_capture`
    (this task) requires a `phase3_capture_sha256` field on the SAME
    d09-signed.json marker `validate_sign_marker` already checks — but
    `sign_dry_run.py` (Task 5's exclusive file, D-09 phase-3 re-sign CLI) is
    the thing that writes it, and Task 5 has not landed yet. Rather than
    touch sign_dry_run.py out of scope, hand-stamp the same field directly
    onto the real marker sign_dry_run.py just wrote, hashed from the exact
    bytes of the capture file it already bound via `capture_path` — this
    exercises Task 4's own gate (which only re-verifies the hash against the
    capture file's CURRENT bytes, never its noun content) faithfully end to
    end for every test that runs the full --apply path past FR-008."""
    marker = marker_path(vault, "fireflies", mid)
    doc = json.loads(marker.read_text(encoding="utf-8"))
    capture_file = Path(doc["capture_path"])
    doc["phase3_capture_sha256"] = hashlib.sha256(capture_file.read_bytes()).hexdigest()
    atomic_write(marker, json.dumps(doc, sort_keys=True).encode("utf-8"))


def _sign_for_restart_test(vault: Path, mid: str, tmp_path: Path, env: dict) -> None:
    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)


def test_apply_rejects_marker_missing_source_binding_fields(tmp_path):
    # D-09 review finding 1: a legacy marker (signed before this fix, or —
    # as here — hand-seeded the way _seed_signed_marker does, with no
    # source_sha256/extraction_input_sha) must be refused once --apply
    # reaches the post-fetch envelope-bound check, distinctly from a
    # genuine post-signing change.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    _seed_signed_marker(vault, mid)  # legacy-shaped marker: no binding fields
    env = os.environ.copy()  # already PATH-narrowed by the autouse _no_live_daemon fixture

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 15, result.stderr + result.stdout
    assert "FAILED at sign-check:" in result.stderr
    assert "missing" in result.stderr
    assert "source changed since sign-off" not in result.stderr

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    assert not receipt_path.exists()


def test_apply_rejects_when_source_changed_after_signoff(tmp_path):
    # D-09 review finding 1: the marker alone previously proved only that a
    # human reviewed SOME capture — not that the envelope --apply is about
    # to act on is still the one reviewed. Sign against the real fixture,
    # then mutate source.json (and recompute its sha256, so the drift is a
    # genuine change to the SOURCE the sign-off bound to, not merely a
    # corrupted sha file) before running --apply.
    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    env_dir = vault / "raw/media/transcripts/fireflies" / mid
    source_path = env_dir / "source.json"
    source_doc = json.loads(source_path.read_text(encoding="utf-8"))
    source_doc["title"] = "Weekly tacticals review (edited after sign-off)"
    raw = json.dumps(source_doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    source_path.write_bytes(raw)
    (env_dir / "source.sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n", encoding="utf-8")

    pre_head = _git(vault, "rev-parse", "HEAD").stdout.strip()

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 15, result.stderr + result.stdout
    assert "FAILED at sign-check: source changed since sign-off" in result.stderr

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    assert not receipt_path.exists()
    post_head = _git(vault, "rev-parse", "HEAD").stdout.strip()
    assert post_head == pre_head  # never committed


def test_apply_restart_resumes_after_writeback_when_marker_present_leaves_page_untouched(tmp_path):
    """Directive binding rule (d), beyond the plan's literal Step 1 text:
    FR-012's restart contract (spec ~318-335) is "continues from the first
    step whose progress key is not done" — simulate a crash right after the
    writeback step committed its progress.json outcome (but before crm/
    tasks/draft/commit ran, and before any receipt.json existed) by
    pre-seeding progress.json's "writeback" key as done, using the exact
    home_path/node/rule this fixture's real writeback step always produces
    (same fixture as _write_capture's "home=projects/alloi-03.md
    node=alloi-03 rule=2" — deterministic, not probed).

    CH-9: `progress.writeback.done: true` alone is not proof the write
    happened — this is the HONEST-checkpoint half: the home page already
    carries meeting_writeback.py's own `[source: <kind>:<id>]` citation
    marker (as a real completed writeback would have left it), so
    progress.writeback_marker_present() confirms the checkpoint and the
    resumed run must skip re-invoking meeting_writeback.py (the only code
    path that mutates the home page's text) and continue through
    crm/tasks/draft/commit to a full receipt. Proof the home page was never
    rewritten: its on-disk bytes (sha256) and mtime are identical before and
    after the resumed run."""
    import progress

    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    home_page = vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    home_page.write_text(
        home_page.read_text(encoding="utf-8").replace(
            "## History (dated, newest first)\n\n- old\n",
            f"## History (dated, newest first)\n\n"
            # Coordinator follow-up finding: writeback_marker_present now
            # requires the writeback-shaped bullet (date + em-dash + ...
            # ending in the marker), matching writeback_render._history_
            # block's real output — not just any line containing the marker
            # substring.
            f"- 2026-09-04 — recap [source: fireflies:{mid}]\n- old\n",
        ),
        encoding="utf-8",
    )
    before_bytes = home_page.read_bytes()
    before_sha = hashlib.sha256(before_bytes).hexdigest()
    before_mtime_ns = home_page.stat().st_mtime_ns

    prog_path = progress.progress_path(vault, "fireflies", mid)
    progress.merge_progress(prog_path, "writeback", {
        "done": True, "home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2,
        "history_added": True, "open_items_added": True, "promotion_applied": False,
    })

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert "resume: writeback marker missing, redoing" not in result.stderr

    after_bytes = home_page.read_bytes()
    assert hashlib.sha256(after_bytes).hexdigest() == before_sha
    assert home_page.stat().st_mtime_ns == before_mtime_ns

    doc = progress.load_progress(prog_path)
    assert progress.step_done(doc, "writeback")
    assert progress.step_done(doc, "crm")
    assert progress.step_done(doc, "tasks")
    assert progress.step_done(doc, "draft")
    assert progress.step_done(doc, "commit")

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["vault_sha"]
    assert receipt["minimums"] == {"ok": True, "missing": [], "enforced": True}


def test_apply_restart_redoes_writeback_when_bogus_checkpoint_has_no_marker(tmp_path):
    """CH-9: this is the BOGUS-checkpoint half — `progress.writeback.done:
    true` with the home page carrying NO `[source: <kind>:<id>]` citation
    (a hand-edited or corrupted progress.json, or a checkpoint written
    without the write actually landing) must never be trusted silently.
    progress.writeback_marker_present() must return False, the orchestrator
    must log `resume: writeback marker missing, redoing`, reset the step,
    and actually re-run meeting_writeback.py — so the page DOES change this
    time and ends up carrying the real citation."""
    import progress

    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")
    _sign_for_restart_test(vault, mid, tmp_path, env)

    home_page = vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    before_bytes = home_page.read_bytes()  # no [source: ...] marker — bogus checkpoint

    prog_path = progress.progress_path(vault, "fireflies", mid)
    progress.merge_progress(prog_path, "writeback", {
        "done": True, "home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2,
        "history_added": True, "open_items_added": True, "promotion_applied": False,
    })

    result = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert "resume: writeback marker missing, redoing" in result.stderr

    after_bytes = home_page.read_bytes()
    assert after_bytes != before_bytes
    assert f"[source: fireflies:{mid}]" in after_bytes.decode("utf-8")

    doc = progress.load_progress(prog_path)
    assert progress.step_done(doc, "writeback")
    assert progress.step_done(doc, "commit")

    receipt_path = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["vault_sha"]
    assert receipt["minimums"]["ok"] is True


def test_apply_runs_phase3_rollup_status_filed_before_commit(tmp_path):
    """FR-012 line 327: FR-007 -> FR-011 -> FR-013 -> commit, after FR-008.
    Extends the existing _seed_apply_vault fixture's engagement/child pages
    with a ## Reporting block so FR-011 finds a real engagement to feed the
    unchanged engine, and asserts all three phase-3 progress keys land plus
    STATE.md/clients/alloi.md/_filed.log are all inside the committed diff."""
    vault, repo, mid = _seed_apply_vault(tmp_path)
    # add the parent engagement page + a ## Reporting block on alloi-03.md,
    # matching the real Alloi seed (D-03) so FR-011 resolves node's parent
    # AND F-6's gate (parent must exist and be kind: engagement) is satisfied.
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    (proj / "alloi-01.md").write_text(
        "# Client: Alloi — Managed Services\n\n## Node\nid: alloi-01\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: Managed Services\ndomains: alloi.us\ndelivery_state: active\n\n"
        "## Reporting\ncadence: weekly\nchannel: email\ncontact: marcos@alloi.us\nlast_update:\n\n"
        "## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    alloi03 = proj / "alloi-03.md"
    text = alloi03.read_text(encoding="utf-8")
    if "## Reporting" not in text:
        text = text.replace("## History", "## Reporting\ncadence:\nchannel:\ncontact:\nlast_update:\n\n## History", 1)
        alloi03.write_text(text, encoding="utf-8")
    _git(vault, "add", "-A")
    _git(vault, "commit", "-q", "-m", "seed phase3")

    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    # Deviation: unlike every no-engagement R2 fixture, this test genuinely
    # reaches FR-011 and shells the repo's real node_modules/.bin/tsx, whose
    # shebang is `#!/usr/bin/env node` — the autouse _no_live_daemon fixture
    # narrows PATH to /usr/bin:/bin (to keep the real cortextos/gws off it),
    # which also hides `node`. Append node's real directory AFTER bindir so
    # the PATH-trapped fake gws/cortextos/claude in bindir still win over
    # any same-named real binary that happens to live alongside node.
    node_bin = shutil.which("node", path=_ORIGINAL_PATH)
    if node_bin:
        env["PATH"] = f"{env['PATH']}:{os.path.dirname(node_bin)}"
    env["BRAIN_ENABLED_AGENTS_JSON"] = str(tmp_path / "no-agents.json")
    (tmp_path / "no-agents.json").write_text("{}", encoding="utf-8")

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_phase3_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    r = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stderr + r.stdout

    prog = json.loads((vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "progress.json").read_text(encoding="utf-8"))
    assert prog["rollup"]["done"] is True
    assert prog["status_update"]["done"] is True
    assert prog["status_update"]["action"] in ("draft", "brief") or str(prog["status_update"]["action"]).startswith("skip:")
    assert prog["filed"]["done"] is True

    committed = _git(vault, "show", "--stat", "HEAD").stdout
    assert "STATE.md" in committed
    assert "clients/alloi.md" in committed
    assert "_filed.log" in committed

    filed_log = (vault / "raw/areas/clearworks/org-brain/_filed.log").read_text(encoding="utf-8")
    assert f"fireflies:{mid}" in filed_log


def test_existing_r2_fixtures_skip_status_update_no_engagement_no_subprocess(tmp_path):
    """G0a F-6: none of the pre-existing R2 fixtures seed projects/alloi-01.md
    (only alloi-03.md, whose ## Node names parent: alloi-01 without that
    page existing). Before the F-6 gate, eng_id was trusted anyway and every
    R2 apply test would have shelled a real tsx subprocess. After the gate,
    eng_id must stay empty and status_update must skip in pure Python — the
    PATH-trapped npx/tsx shims (added to _install_fakes below) must never
    fire, proving no node/tsx dependency was added to this test's cost."""
    vault, repo, mid = _seed_apply_vault(tmp_path)
    bindir = _install_fakes(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"

    sign = subprocess.run(
        [sys.executable, str(BRAIN / "sign_dry_run.py"), "--meeting-id", mid, "--vault", str(vault),
         "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
         "--dry-run-capture", str(_write_phase3_capture(tmp_path))],
        capture_output=True, text=True, env=env,
    )
    assert sign.returncode == 0, sign.stderr
    _stamp_phase3_capture(vault, mid)

    r = subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", mid,
         "--repo-root", str(repo), "--vault", str(vault), "--apply"],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    prog = json.loads((vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "progress.json").read_text(encoding="utf-8"))
    assert prog["status_update"]["action"] == "skip: no-engagement"
    npx_trap_log = tmp_path / "npx-tsx-trap.log"
    assert not npx_trap_log.exists() or npx_trap_log.read_text(encoding="utf-8").strip() == ""
