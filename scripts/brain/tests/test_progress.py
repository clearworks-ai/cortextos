from __future__ import annotations

import hashlib
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


def test_vault_commit_excludes_prestaged_unrelated_file(tmp_path):
    # CH-2: a bare `git commit -m <msg>` after the restricted `git add`
    # commits the ENTIRE index, so any file a concurrent process had already
    # staged (outside the FR-014 pathspec) rode along in the same commit
    # while every scoped `git status --porcelain -- <pathspec>` assertion
    # still passed. The commit itself must be scoped to the pathspec too.
    from progress import vault_commit

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.email", "b@b"], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.name", "b"], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    sha0, committed0 = vault_commit(vault, ["f.txt"], "seed")
    assert committed0 and sha0

    (vault / "f.txt").write_text("y", encoding="utf-8")
    unrelated = vault / "unrelated.txt"
    unrelated.write_text("z", encoding="utf-8")
    subprocess.run(["git", "-C", str(vault), "add", "unrelated.txt"], check=True)

    sha, committed = vault_commit(vault, ["f.txt"], "scoped commit")
    assert committed and sha

    show = subprocess.run(
        ["git", "-C", str(vault), "show", "--name-only", "--format=", "HEAD"],
        capture_output=True, text=True, check=True,
    )
    named = show.stdout.split()
    assert "unrelated.txt" not in named
    assert "f.txt" in named

    status = subprocess.run(
        ["git", "-C", str(vault), "status", "--porcelain"], capture_output=True, text=True, check=True,
    )
    assert "A  unrelated.txt" in status.stdout


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


# ── CH-1/S-2: validate_sign_marker ───────────────────────────────────────────


def _valid_marker_doc(capture: Path) -> dict:
    text = capture.read_text(encoding="utf-8")
    return {
        "signed_by": "Josh",
        "signed_at": "2026-09-05T00:00:00Z",
        "capture_path": str(capture),
        "capture_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def test_validate_sign_marker_missing_file_is_missing_reason(tmp_path):
    from progress import validate_sign_marker

    assert validate_sign_marker(tmp_path / "d09-signed.json") == "d09-signed.json missing"


def test_validate_sign_marker_rejects_empty_object(tmp_path):
    from atomic import atomic_write
    from progress import validate_sign_marker

    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, b"{}")
    reason = validate_sign_marker(marker)
    assert reason is not None
    assert "signed_by" in reason


def test_validate_sign_marker_rejects_missing_signed_at(tmp_path):
    from atomic import atomic_write
    from progress import validate_sign_marker

    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps({"signed_by": "Josh"}).encode("utf-8"))
    reason = validate_sign_marker(marker)
    assert reason is not None
    assert "signed_at" in reason


def test_validate_sign_marker_rejects_capture_sha_mismatch(tmp_path):
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    doc = _valid_marker_doc(capture)
    doc["capture_sha256"] = "0" * 64
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(doc).encode("utf-8"))
    reason = validate_sign_marker(marker)
    assert reason == "capture_sha256 mismatch"


def test_validate_sign_marker_accepts_full_valid_marker(tmp_path):
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(_valid_marker_doc(capture)).encode("utf-8"))
    assert validate_sign_marker(marker) is None


def test_validate_sign_marker_rejects_unknown_signer(tmp_path):
    # Finding 4b: signed_by must be in an allowlist (default {"Josh"}) — a
    # marker naming any other signer is rejected even if everything else
    # (hash, timestamp, envelope) is valid.
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    doc = _valid_marker_doc(capture)
    doc["signed_by"] = "Mallory"
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(doc).encode("utf-8"))
    reason = validate_sign_marker(marker)
    assert reason is not None
    assert "allowlist" in reason


def test_validate_sign_marker_accepts_signer_from_env_override(tmp_path, monkeypatch):
    from atomic import atomic_write
    from progress import validate_sign_marker

    monkeypatch.setenv("BRAIN_SIGNERS", "Josh,Alex")
    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    doc = _valid_marker_doc(capture)
    doc["signed_by"] = "Alex"
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(doc).encode("utf-8"))
    assert validate_sign_marker(marker) is None


# ── D-09 review finding 1: envelope-bound sign-off ────────────────────────────


def _valid_marker_doc_with_binding(capture: Path, *, source_sha256: str, extraction_input_sha: str) -> dict:
    doc = _valid_marker_doc(capture)
    doc["source_sha256"] = source_sha256
    doc["extraction_input_sha"] = extraction_input_sha
    return doc


def test_validate_sign_marker_envelope_check_skipped_when_no_envelope_given(tmp_path):
    # Backward compatible default: existing callers that never pass
    # `envelope=` (e.g. the original pre-fetch check in run_meeting.py) get
    # exactly the old behavior — a marker missing the new fields entirely
    # still passes when envelope is not given.
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(_valid_marker_doc(capture)).encode("utf-8"))
    assert validate_sign_marker(marker) is None


def test_validate_sign_marker_rejects_marker_missing_binding_fields_when_envelope_given(tmp_path):
    # A legacy marker (signed before this fix, or _seed_signed_marker-style
    # test fixture) has none of source_sha256/extraction_input_sha — this
    # must fail distinctly from "source changed since sign-off" once an
    # envelope is passed.
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    atomic_write(marker, json.dumps(_valid_marker_doc(capture)).encode("utf-8"))

    envelope = tmp_path / "envelope"
    envelope.mkdir()
    (envelope / "source.sha256").write_text("abc123\n", encoding="utf-8")
    (envelope / "extraction.json").write_text(json.dumps({"inputSha": "abc123"}), encoding="utf-8")

    reason = validate_sign_marker(marker, envelope=envelope)
    assert reason is not None
    assert "missing" in reason
    assert reason != "source changed since sign-off"


def test_validate_sign_marker_accepts_matching_source_and_extraction_sha(tmp_path):
    # The positive case: source_sha256/extraction_input_sha recorded at sign
    # time still equal the envelope's CURRENT values.
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    doc = _valid_marker_doc_with_binding(capture, source_sha256="abc123", extraction_input_sha="abc123")
    atomic_write(marker, json.dumps(doc).encode("utf-8"))

    envelope = tmp_path / "envelope"
    envelope.mkdir()
    (envelope / "source.sha256").write_text("abc123\n", encoding="utf-8")
    (envelope / "extraction.json").write_text(json.dumps({"inputSha": "abc123"}), encoding="utf-8")

    assert validate_sign_marker(marker, envelope=envelope) is None


def test_validate_sign_marker_rejects_when_envelope_source_sha_changed_since_signoff(tmp_path):
    # The envelope's source.sha256 no longer matches what was signed (the
    # source changed after sign-off, e.g. a manual --refetch or hand-edit).
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    doc = _valid_marker_doc_with_binding(capture, source_sha256="signed-sha", extraction_input_sha="signed-sha")
    atomic_write(marker, json.dumps(doc).encode("utf-8"))

    envelope = tmp_path / "envelope"
    envelope.mkdir()
    (envelope / "source.sha256").write_text("changed-sha\n", encoding="utf-8")
    (envelope / "extraction.json").write_text(json.dumps({"inputSha": "signed-sha"}), encoding="utf-8")

    assert validate_sign_marker(marker, envelope=envelope) == "source changed since sign-off"


def test_validate_sign_marker_rejects_when_envelope_extraction_sha_changed_since_signoff(tmp_path):
    # The source itself didn't change, but extraction.json's inputSha did
    # (e.g. a manual re-extraction) — still must be caught.
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    doc = _valid_marker_doc_with_binding(capture, source_sha256="signed-sha", extraction_input_sha="signed-sha")
    atomic_write(marker, json.dumps(doc).encode("utf-8"))

    envelope = tmp_path / "envelope"
    envelope.mkdir()
    (envelope / "source.sha256").write_text("signed-sha\n", encoding="utf-8")
    (envelope / "extraction.json").write_text(json.dumps({"inputSha": "different-sha"}), encoding="utf-8")

    assert validate_sign_marker(marker, envelope=envelope) == "source changed since sign-off"


def test_validate_sign_marker_rejects_when_envelope_files_absent(tmp_path):
    # No source.sha256/extraction.json at all in the envelope (fail closed,
    # never treat "can't verify" as "verified").
    from atomic import atomic_write
    from progress import validate_sign_marker

    capture = tmp_path / "dry-run.txt"
    capture.write_text("real capture bytes", encoding="utf-8")
    marker = tmp_path / "d09-signed.json"
    doc = _valid_marker_doc_with_binding(capture, source_sha256="signed-sha", extraction_input_sha="signed-sha")
    atomic_write(marker, json.dumps(doc).encode("utf-8"))

    envelope = tmp_path / "envelope"
    envelope.mkdir()

    assert validate_sign_marker(marker, envelope=envelope) == "source changed since sign-off"


def test_validate_sign_marker_rejects_capture_outside_envelope(tmp_path):
    # Finding 4a: capture_path must resolve inside the marker's own envelope
    # directory (its parent dir) — a marker pointing anywhere else on disk,
    # even with a matching hash, must not pass.
    from atomic import atomic_write
    from progress import validate_sign_marker

    envelope = tmp_path / "_state" / "fireflies-MID"
    envelope.mkdir(parents=True)
    outside_capture = tmp_path / "elsewhere" / "dry-run.txt"
    outside_capture.parent.mkdir(parents=True)
    outside_capture.write_text("real capture bytes", encoding="utf-8")
    doc = _valid_marker_doc(outside_capture)
    marker = envelope / "d09-signed.json"
    atomic_write(marker, json.dumps(doc).encode("utf-8"))
    assert validate_sign_marker(marker) == "capture outside envelope"


# ── G2-P1-3: merge_task_map ───────────────────────────────────────────────────


def test_merge_task_map_unions_existing_and_new_without_dropping_either():
    from progress import merge_task_map

    existing = [{"commitmentId": "a", "taskId": "1"}]
    new = [{"commitmentId": "b", "taskId": "2"}]
    merged = merge_task_map(existing, new)
    assert merged == [{"commitmentId": "a", "taskId": "1"}, {"commitmentId": "b", "taskId": "2"}]


def test_merge_task_map_existing_wins_on_key_collision():
    from progress import merge_task_map

    existing = [{"commitmentId": "a", "taskId": "durable-1"}]
    new = [{"commitmentId": "a", "taskId": "would-be-duplicate"}]
    assert merge_task_map(existing, new) == [{"commitmentId": "a", "taskId": "durable-1"}]


# ── CH-5: reconstruct_task_map_from_bus ──────────────────────────────────────


def _install_cortextos_shim(tmp_path: Path, script: str) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    cortextos = bindir / "cortextos"
    cortextos.write_text(script)
    cortextos.chmod(0o755)
    return bindir


def test_reconstruct_task_map_from_bus_finds_commitment_marker_in_description(tmp_path, monkeypatch):
    from progress import reconstruct_task_map_from_bus

    bindir = _install_cortextos_shim(
        tmp_path,
        "#!/bin/sh\n"
        'echo \'[{"id": "recovered-1", "description": "owner: Josh [commitment:MID/cid-a]"}]\'\n',
    )
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    recovered = reconstruct_task_map_from_bus("MID", {"cid-a": "some text"})
    assert recovered == [{"commitmentId": "cid-a", "taskId": "recovered-1"}]


def test_reconstruct_task_map_from_bus_returns_empty_when_no_match(tmp_path, monkeypatch):
    from progress import reconstruct_task_map_from_bus

    bindir = _install_cortextos_shim(tmp_path, "#!/bin/sh\necho '[]'\n")
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    assert reconstruct_task_map_from_bus("MID", {"cid-a": "some text"}) == []


def test_reconstruct_task_map_from_bus_returns_empty_when_daemon_down(monkeypatch):
    from progress import reconstruct_task_map_from_bus

    monkeypatch.setenv("PATH", "/usr/bin:/bin")  # no cortextos on PATH
    assert reconstruct_task_map_from_bus("MID", {"cid-a": "some text"}) == []


def test_reconstruct_task_map_from_bus_ignores_task_from_different_meeting(tmp_path, monkeypatch):
    # Finding 2: a bare commitment_id substring match (the pre-fix behavior)
    # would have attached this task even though it belongs to a different
    # meeting — the exact [commitment:<meeting_id>/<id>] pair must not match.
    from progress import reconstruct_task_map_from_bus

    bindir = _install_cortextos_shim(
        tmp_path,
        "#!/bin/sh\n"
        'echo \'[{"id": "wrong-meeting-task", "description": "[commitment:OTHER-MID/cid-a]"}]\'\n',
    )
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    assert reconstruct_task_map_from_bus("MID", {"cid-a": "some text"}) == []


def test_reconstruct_task_map_from_bus_prefers_title_match_on_ambiguity(tmp_path, monkeypatch):
    # Finding 2: two bus tasks carry the same exact marker (should not
    # happen on a healthy bus, but must be handled) — prefer the one whose
    # title equals the commitment text, even though it is not the newest.
    from progress import reconstruct_task_map_from_bus

    bindir = _install_cortextos_shim(
        tmp_path,
        "#!/bin/sh\n"
        "echo '["
        '{"id": "wrong-title-task", "title": "Something else", '
        '"description": "[commitment:MID/cid-a]", "created_at": "2026-09-01T00:00:00Z"}, '
        '{"id": "right-title-task", "title": "Send report", '
        '"description": "[commitment:MID/cid-a]", "created_at": "2026-08-01T00:00:00Z"}'
        "]'\n",
    )
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    recovered = reconstruct_task_map_from_bus("MID", {"cid-a": "Send report"})
    assert recovered == [{"commitmentId": "cid-a", "taskId": "right-title-task"}]


# ── CH-9: writeback_marker_present ────────────────────────────────────────────


def test_writeback_marker_present_true_when_marker_in_page(tmp_path):
    # Shaped like writeback_render._history_block's real output ("- <date>
    # — <text> ... [source: <kind>:<id>]" as the line's terminal
    # characters) — see the dedicated real-shape test below for the exact
    # literal render.
    from progress import writeback_marker_present

    page = tmp_path / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    page.parent.mkdir(parents=True)
    page.write_text(
        "## History (dated, newest first)\n\n- 2026-09-04 — recap [source: fireflies:MID]\n",
        encoding="utf-8",
    )
    assert writeback_marker_present(tmp_path, "projects/alloi-03.md", "fireflies:MID") is True


def test_writeback_marker_present_true_for_real_history_block_shaped_line(tmp_path):
    # Coordinator follow-up finding (2026-09-05): pin acceptance against the
    # REAL writeback_render._history_block output, not just a hand-typed
    # stand-in.
    from progress import writeback_marker_present
    from writeback_render import _history_block

    meeting = {
        "id": "MID",
        "date": "2026-09-04T00:00:00Z",
        "title": "Weekly tacticals review",
        "source": {"kind": "fireflies", "id": "MID"},
        "summary": {"overview": "Scoped tactical reports."},
        "decisions": ["Keep cadence"],
    }
    lines = _history_block(meeting)
    page = tmp_path / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    page.parent.mkdir(parents=True)
    page.write_text(
        "## History (dated, newest first)\n\n" + "\n".join(lines) + "\n- old\n",
        encoding="utf-8",
    )
    assert writeback_marker_present(tmp_path, "projects/alloi-03.md", "fireflies:MID") is True


def test_writeback_marker_present_false_when_history_line_is_prose_not_a_dated_bullet(tmp_path):
    # Coordinator follow-up finding: the pre-fix check accepted ANY line
    # inside the History section containing the marker substring — prose
    # like a migration note that merely repeats the `[source: ...]` text
    # must NOT count as proof meeting_writeback.py actually ran. Only a line
    # shaped like a real writeback bullet (`- <YYYY-MM-DD> — ...` ending
    # with the marker) counts.
    from progress import writeback_marker_present

    page = tmp_path / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    page.parent.mkdir(parents=True)
    page.write_text(
        "## History (dated, newest first)\n\n"
        "Migration note: preserve [source: fireflies:MID] during the vault restructure.\n"
        "- old\n",
        encoding="utf-8",
    )
    assert writeback_marker_present(tmp_path, "projects/alloi-03.md", "fireflies:MID") is False


def test_writeback_marker_present_false_when_page_lacks_marker(tmp_path):
    from progress import writeback_marker_present

    page = tmp_path / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    page.parent.mkdir(parents=True)
    page.write_text("## History (dated, newest first)\n\n- old\n", encoding="utf-8")
    assert writeback_marker_present(tmp_path, "projects/alloi-03.md", "fireflies:MID") is False


def test_writeback_marker_present_false_when_home_rel_or_page_missing(tmp_path):
    from progress import writeback_marker_present

    assert writeback_marker_present(tmp_path, "", "fireflies:MID") is False
    assert writeback_marker_present(tmp_path, "projects/does-not-exist.md", "fireflies:MID") is False


def test_writeback_marker_present_false_when_marker_only_outside_history_section(tmp_path):
    # Finding 3: the marker string exists on the page, but only in a
    # preamble paragraph — not inside the History section meeting_writeback
    # actually appends to — so this must NOT count as proof the write ran.
    from progress import writeback_marker_present

    page = tmp_path / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    page.parent.mkdir(parents=True)
    page.write_text(
        "Some unrelated note that happens to mention [source: fireflies:MID] in passing.\n\n"
        "## History (dated, newest first)\n\n- old entry, no marker here\n",
        encoding="utf-8",
    )
    assert writeback_marker_present(tmp_path, "projects/alloi-03.md", "fireflies:MID") is False


# ── CH-7: resolve_vault_sha_from_history ──────────────────────────────────────


def test_resolve_vault_sha_from_history_finds_prior_commit(tmp_path):
    from progress import resolve_vault_sha_from_history

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.email", "b@b"], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.name", "b"], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "-C", str(vault), "add", "f.txt"], check=True)
    subprocess.run(["git", "-C", str(vault), "commit", "-q", "-m", "seed"], check=True)
    expected = subprocess.run(
        ["git", "-C", str(vault), "rev-parse", "HEAD"], capture_output=True, text=True, check=True,
    ).stdout.strip()

    assert resolve_vault_sha_from_history(vault, ["f.txt"]) == expected


def test_resolve_vault_sha_from_history_returns_none_when_pathspec_has_no_history(tmp_path):
    from progress import resolve_vault_sha_from_history

    vault = tmp_path / "vault"
    vault.mkdir()
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.email", "b@b"], check=True)
    subprocess.run(["git", "-C", str(vault), "config", "user.name", "b"], check=True)
    (vault / "f.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "-C", str(vault), "add", "f.txt"], check=True)
    subprocess.run(["git", "-C", str(vault), "commit", "-q", "-m", "seed"], check=True)

    assert resolve_vault_sha_from_history(vault, ["never-touched.txt"]) is None
