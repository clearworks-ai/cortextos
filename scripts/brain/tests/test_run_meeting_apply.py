from __future__ import annotations

import hashlib
import json
import os
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
    # leftover (:53-56), which no code in this plan removes.
    (vault / ".gitignore").write_text(
        "raw/media/transcripts/_state/\n*.md.lock\n", encoding="utf-8"
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
    assert receipt1["minimums"] == {"ok": True, "missing": []}
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
    assert receipt3["minimums"] == {"ok": True, "missing": []}
    _assert_only_pathspec_and_ignored_changed(vault, pathspec)


def test_apply_exits_9_when_acceptance_minimums_fail_zero_draft(tmp_path):
    # G0b C2-4: the production --apply path must call
    # progress.acceptance_minimums() against the composed receipt and fail
    # loud (exit 9) BEFORE the vault commit — not just the test-helper
    # function checked in isolation. Pre-seed the recap ledger so FR-008
    # skips (0 drafts created, no real draft subject recorded) while every
    # other step (writeback/crm/tasks) succeeds normally; the receipt
    # composed just before the commit then has draft=null, which
    # acceptance_minimums flags, and the run must fail before ever
    # committing to the vault's git history.
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

    ledger = vault / "raw/media/transcripts/_recap-ledger.txt"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(f"fireflies:{mid}\n", encoding="utf-8")

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
    assert "draft is null" in receipt["minimums"]["missing"]

    post_head = _git(vault, "rev-parse", "HEAD").stdout.strip()
    assert post_head == pre_head  # never committed


def test_apply_restart_resumes_after_writeback_without_rewriting_home_page(tmp_path):
    """Directive binding rule (d), beyond the plan's literal Step 1 text:
    FR-012's restart contract (spec ~318-335) is "continues from the first
    step whose progress key is not done" — simulate a crash right after the
    writeback step committed its progress.json outcome (but before crm/
    tasks/draft/commit ran, and before any receipt.json existed) by
    pre-seeding progress.json's "writeback" key as done, using the exact
    home_path/node/rule this fixture's real writeback step always produces
    (same fixture as _write_capture's "home=projects/alloi-03.md
    node=alloi-03 rule=2" — deterministic, not probed). The resumed run
    must skip re-invoking meeting_writeback.py (the only code path that
    mutates the home page's text) and continue through crm/tasks/draft/
    commit to a full receipt. Proof the home page was never rewritten: its
    on-disk bytes (sha256) and mtime are identical before and after the
    resumed run — nothing but the real writeback subprocess ever touches
    that file's content."""
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

    home_page = vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
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
    assert receipt["minimums"] == {"ok": True, "missing": []}
