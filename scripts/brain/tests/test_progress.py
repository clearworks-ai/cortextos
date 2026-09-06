from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_merge_progress_atomic_and_step_done(tmp_path):
    from progress import load_progress, merge_progress, step_done

    path = tmp_path / "progress.json"
    merge_progress(path, "writeback", {"done": True, "home_path": "projects/alloi-03.md"})
    doc = load_progress(path)
    assert step_done(doc, "writeback")
    assert not step_done(doc, "crm")
    merge_progress(path, "crm", {"done": True, "contacts": ["c1"]})
    doc2 = load_progress(path)
    assert step_done(doc2, "writeback")
    assert doc2["crm"]["contacts"] == ["c1"]


def test_vault_commit_nothing_to_commit_keeps_prior_sha(tmp_path):
    from progress import vault_commit

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.email", "b@b"], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.name", "b"], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    sha1, committed1 = vault_commit(vault, ["f.txt"], "first")
    assert committed1 and sha1
    sha2, committed2 = vault_commit(vault, ["f.txt"], "second: no changes")
    assert committed2 is False
    assert sha2 is None


def test_compose_receipt_preserves_first_applied_at(tmp_path):
    from progress import compose_receipt

    doc = {
        "writeback": {"home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2},
        "crm": {"contacts": ["c1"], "interactions": 1},
        "tasks": {"created": [{"commitmentId": "c1", "taskId": "t1"}]},
        "draft": {"subject": "Recap: Tacticals sync — 2026-09-04"},
    }
    prior = {"vault_sha": "deadbeef", "first_applied_at": "2026-09-05T00:00:00+00:00"}
    receipt = compose_receipt(
        doc, meeting_id="01M1MW2GAZ1DQ0C6PG3KJ557JA", source="fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA",
        vault_sha=None, prior=prior,
    )
    assert receipt["vault_sha"] == "deadbeef"
    assert receipt["first_applied_at"] == "2026-09-05T00:00:00+00:00"
    assert receipt["tasks"] == [{"commitmentId": "c1", "taskId": "t1"}]


def test_crm_env_scopes_contacts_interactions_pipeline_under_repo(tmp_path):
    # R2-F-1 (fold, rev3): meeting-crm-sync.py/meeting-fanout.py at CODE_ROOT
    # (the brain-loop worktree) carry the R2 flags (--full-file, --strict,
    # ...) round-1's per-call resolve_crm_scripts(repo, code_root) tried to
    # get by pointing the whole *script* at --repo-root — but the shared
    # checkout's copies of those two scripts are pre-R2 (no --full-file), so
    # that made every CRM/fanout subprocess exit 2 "unrecognized arguments"
    # (verified via `diff -q` against the shared checkout, 2026-09-05).
    # Round 2's fix decouples CODE from DATA instead: the scripts stay fixed
    # at CODE_ROOT (like WRITEBACK/RECAP), and only the CRM *data* paths —
    # upsert-contact.py:18 CRM_CONTACTS_PATH, add-interaction.py:28
    # CRM_INTERACTIONS_PATH, meeting-crm-sync.py:94/upsert-engagement.py:30
    # CRM_PIPELINE_PATH — move to --repo-root (D-10). meeting-crm-sync's own
    # _run(argv, env=os.environ.copy()) calls (:243, :277, :361) propagate
    # whatever env dict the orchestrator passes down to it.
    from progress import crm_env

    repo = tmp_path / "repo"
    base = {"PATH": "/bin"}
    env = crm_env(base, repo)
    crm_dir = repo / "orgs/clearworksai/agents/crm/crm"
    assert env["CRM_CONTACTS_PATH"] == str(crm_dir / "contacts.json")
    assert env["CRM_INTERACTIONS_PATH"] == str(crm_dir / "interactions.jsonl")
    assert env["CRM_PIPELINE_PATH"] == str(crm_dir / "pipeline.json")
    assert env["PATH"] == "/bin"
    assert "CRM_CONTACTS_PATH" not in base  # crm_env doesn't mutate the caller's dict


def test_check_vault_gitignore_flags_missing_then_clears_once_landed(tmp_path):
    # R2-F-4: FR-014 line ~359's "SHALL ensure raw/media/transcripts/_state/
    # is listed in the vault's .gitignore" had no implementing OR verifying
    # code — Task 9 Step 0 lands the lines by hand, but nothing checked they
    # actually landed before the first --apply. This is read-only: it never
    # mutates .gitignore itself (that stays Task 9 Step 0's job, G0a F-6).
    from progress import check_vault_gitignore

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    assert check_vault_gitignore(vault) == ["raw/media/transcripts/_state/", "*.md.lock"]

    (vault / ".gitignore").write_text(
        "raw/media/transcripts/_state/\n*.md.lock\n", encoding="utf-8"
    )
    assert check_vault_gitignore(vault) == []


def test_check_vault_gitignore_skips_when_vault_is_not_a_git_repo(tmp_path):
    # A bare (non-git) vault fixture is common in this suite's other tests
    # (e.g. Task 8's guard-path tests, which never reach the commit step) —
    # `git check-ignore` there exits 128 (fatal, not a repo), which must
    # never be misread as "not ignored" and block those unrelated tests.
    from progress import check_vault_gitignore

    vault = tmp_path / "vault"
    vault.mkdir()
    assert check_vault_gitignore(vault) == []


def test_fanout_env_sets_triage_owner_and_unsets_briefs_url():
    # G0a F-3: neither orchestrator obligation (FANOUT_TRIAGE_OWNER=pa-codex,
    # unset BRIEFS_INGEST_URL) was implemented anywhere before this fix.
    from progress import fanout_env

    base = {"PATH": "/bin", "BRIEFS_INGEST_URL": "https://example.test/briefs"}
    env = fanout_env(base)
    assert env["FANOUT_TRIAGE_OWNER"] == "pa-codex"
    assert "BRIEFS_INGEST_URL" not in env
    assert env["PATH"] == "/bin"
    assert "BRIEFS_INGEST_URL" in base  # fanout_env doesn't mutate the caller's dict


def test_parse_subprocess_json_handles_pretty_printed_output():
    # G0a F-1: both consumer scripts print json.dumps(obj, indent=2), so
    # stdout.splitlines()[-1] is literally '}' — the pre-fix _last_json_line
    # returned {} on every real invocation. Feed it real pretty-printed
    # output and assert the parsed dict, pinning the seam.
    from progress import parse_subprocess_json

    obj = {"a": 1, "b": {"c": [1, 2, 3]}, "contacts": ["x@y.test"]}
    stdout = json.dumps(obj, indent=2)
    assert parse_subprocess_json(stdout) == obj


def test_parse_subprocess_json_falls_back_to_first_to_last_brace():
    from progress import parse_subprocess_json

    obj = {"a": 1}
    stdout = "some log line\n" + json.dumps(obj, indent=2) + "\ntrailing note\n"
    assert parse_subprocess_json(stdout) == obj


def test_parse_subprocess_json_empty_or_unparseable_is_empty_dict():
    from progress import parse_subprocess_json

    assert parse_subprocess_json("") == {}
    assert parse_subprocess_json("no braces here") == {}


def test_fr014_pathspec_includes_home_only_when_present():
    from progress import fr014_pathspec

    with_home = fr014_pathspec("MID", "projects/alloi-03.md", "meetings/fireflies-MID.md")
    assert "raw/areas/clearworks/org-brain/projects/alloi-03.md" in with_home
    assert "raw/areas/clearworks/org-brain/meetings/fireflies-MID.md" in with_home
    assert "raw/media/transcripts/fireflies/MID" in with_home
    assert "raw/media/transcripts/_recap-ledger.txt" in with_home
    assert "raw/media/transcripts/_writeback-ledger.txt" in with_home

    without_home = fr014_pathspec("MID", "", "meetings/fireflies-MID.md")
    assert not any(p.startswith("raw/areas/clearworks/org-brain/projects/") for p in without_home)


def test_vault_commit_skips_nonexistent_pathspec_entries(tmp_path):
    # G0a F-11: an unconditional `git add -- <pathspec>` raises
    # CalledProcessError (rc 128, "did not match any files") the moment any
    # entry is absent — e.g. _recap-ledger.txt on a run whose draft step
    # short-circuited on the ledger. FR-014 qualifies part of the pathspec
    # with "when they exist"; vault_commit must filter, not crash.
    from progress import vault_commit

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.email", "b@b"], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.name", "b"], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    sha, committed = vault_commit(vault, ["f.txt", "does-not-exist.txt"], "only f.txt exists")
    assert committed and sha


def test_vault_commit_add_failure_exits_10(tmp_path, monkeypatch):
    from progress import vault_commit

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    real_run = subprocess.run

    def fake_run(cmd, **kw):
        if len(cmd) >= 4 and cmd[:4] == ["git", "-C", str(vault), "add"]:
            return subprocess.CompletedProcess(cmd, 128, "", "fatal: bad object\n")
        return real_run(cmd, **kw)

    monkeypatch.setattr("progress.subprocess.run", fake_run)
    with pytest.raises(SystemExit) as exc:
        vault_commit(vault, ["f.txt"], "msg")
    assert exc.value.code == 10


def test_acceptance_minimums_flags_every_shortfall():
    # G0a F-9: FR-012's binding acceptance-minimums WHEN/SHALL line (≥1
    # decision, ≥1 OURS task, ≥5 contacts, 1 draft) had no implementing or
    # verifying code anywhere in the plan.
    from progress import acceptance_minimums

    receipt = {"tasks": [], "contacts": ["c1"], "interactions": 0, "draft": None}
    problems = acceptance_minimums(receipt, decisions_kept=0)
    assert problems == [
        "decisions_kept=0 < 1",
        "tasks=0 < 1",
        "contacts=1 < 5",
        "interactions=0 < 1",
        "draft is null",
    ]


def test_acceptance_minimums_passes_when_all_met():
    from progress import acceptance_minimums

    receipt = {
        "tasks": [{"commitmentId": "c1", "taskId": "t1"}],
        "contacts": ["a", "b", "c", "d", "e"],
        "interactions": 5,
        "draft": "Recap: X",
    }
    assert acceptance_minimums(receipt, decisions_kept=1) == []
