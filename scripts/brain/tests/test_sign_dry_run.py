from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_sign_requires_all_five_fr012_nouns(tmp_path):
    # G0a F-12: FR012_NOUNS previously had only 4 entries while this test's
    # name promised 5. FR-012's dry-run WHEN (line 324) names five nouns —
    # resolution reason, page diff, quotes kept/dropped, task list
    # (title · owner · due), draft subject — so the 5th noun is a unified-diff
    # marker ("--- a/", the exact prefix difflib.unified_diff's fromfile=
    # produces in writeback_render.unified_diff). Both captures below now
    # include it.
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    capture = tmp_path / "dry-run.txt"
    capture.write_text("home=projects/alloi-03.md node=alloi-03 rule=2\nsubject: Recap\n", encoding="utf-8")
    rc = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 1  # missing "quotes kept" / "tasks:" / "--- a/" nouns
    assert not marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA").exists()

    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1\ntasks:\nsubject: Recap\n",
        encoding="utf-8",
    )
    rc2 = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc2 == 0
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    assert marker.exists()

    # CH-1/S-2: sign_dry_run.py must write capture_path + capture_sha256 so
    # progress.validate_sign_marker() can prove the signed capture is the
    # exact bytes reviewed, not just a same-named stand-in.
    #
    # Finding 4c: `capture` here (tmp_path / "dry-run.txt") lives OUTSIDE
    # the marker's envelope directory, exactly like a human's real
    # --dry-run-capture almost always does — sign_dry_run.py must copy it
    # into <envelope>/dry-run.txt so capture_path always resolves inside
    # the envelope (progress.validate_sign_marker's containment check).
    doc = json.loads(marker.read_text(encoding="utf-8"))
    assert doc["capture_path"] == str(marker.parent / "dry-run.txt")
    assert Path(doc["capture_path"]).read_bytes() == capture.read_bytes()
    assert doc["capture_sha256"] == hashlib.sha256(capture.read_bytes()).hexdigest()


def test_sign_writes_a_marker_that_progress_validate_sign_marker_accepts(tmp_path):
    from progress import validate_sign_marker
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    capture = tmp_path / "dry-run.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1\ntasks:\nsubject: Recap\n",
        encoding="utf-8",
    )
    rc = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    assert validate_sign_marker(marker) is None


def _capture_text() -> str:
    return (
        "home=projects/alloi-03.md node=alloi-03 rule=2\n"
        "--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
        "quotes kept decisions=1 commitments=1\ntasks:\nsubject: Recap\n"
    )


def test_sign_copies_external_capture_into_envelope(tmp_path):
    # Finding 4c: an externally-supplied --dry-run-capture (the normal case
    # — a human's scratch/tmp file) must be copied into
    # <envelope>/dry-run.txt so the marker's capture_path always resolves
    # inside the envelope.
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    capture = tmp_path / "somewhere-else" / "capture.txt"
    capture.parent.mkdir(parents=True)
    capture.write_text(_capture_text(), encoding="utf-8")

    rc = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    copied = marker.parent / "dry-run.txt"
    assert copied.is_file()
    assert copied.read_text(encoding="utf-8") == _capture_text()
    doc = json.loads(marker.read_text(encoding="utf-8"))
    assert doc["capture_path"] == str(copied)


def test_sign_keeps_capture_path_when_already_inside_envelope(tmp_path):
    # When the capture is already inside the envelope (e.g. a resumed/
    # re-signed flow that reused the earlier copy), sign_dry_run.py must not
    # make a second, differently-named copy.
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    marker.parent.mkdir(parents=True)
    capture = marker.parent / "dry-run.txt"
    capture.write_text(_capture_text(), encoding="utf-8")

    rc = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    doc = json.loads(marker.read_text(encoding="utf-8"))
    assert doc["capture_path"] == str(capture)


def test_sign_dry_run_and_validate_sign_marker_reject_outside_envelope_capture(tmp_path):
    # Finding 4a: hand-craft a marker (bypassing sign_dry_run.py's own copy
    # behavior) whose capture_path points outside its envelope — even with
    # a correct hash, validate_sign_marker must refuse it.
    import hashlib as _hashlib

    from atomic import atomic_write
    from progress import validate_sign_marker
    from sign_dry_run import marker_path

    vault = tmp_path / "vault"
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    outside_capture = tmp_path / "outside" / "dry-run.txt"
    outside_capture.parent.mkdir(parents=True)
    outside_capture.write_text(_capture_text(), encoding="utf-8")
    atomic_write(marker, json.dumps({
        "signed_by": "Josh",
        "signed_at": "2026-09-05T00:00:00Z",
        "capture_path": str(outside_capture),
        "capture_sha256": _hashlib.sha256(_capture_text().encode("utf-8")).hexdigest(),
    }).encode("utf-8"))
    assert validate_sign_marker(marker) == "capture outside envelope"


def test_sign_dry_run_records_source_and_extraction_binding_fields(tmp_path):
    # D-09 review finding 1: sign_dry_run.py must record the DATA envelope's
    # (raw/media/transcripts/fireflies/<meeting_id>/, not this marker's own
    # _state/ directory) source.sha256 and extraction.json.inputSha at sign
    # time, so progress.validate_sign_marker(..., envelope=...) can prove
    # nothing changed by the time --apply runs.
    from paths import envelope_dir
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    meeting_id = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
    data_dir = envelope_dir(vault, "fireflies", meeting_id)
    data_dir.mkdir(parents=True)
    (data_dir / "source.sha256").write_text("deadbeef\n", encoding="utf-8")
    (data_dir / "extraction.json").write_text(
        json.dumps({"inputSha": "deadbeef", "decisions": []}), encoding="utf-8",
    )

    capture = tmp_path / "dry-run.txt"
    capture.write_text(_capture_text(), encoding="utf-8")
    rc = main([
        "--meeting-id", meeting_id, "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = marker_path(vault, "fireflies", meeting_id)
    doc = json.loads(marker.read_text(encoding="utf-8"))
    assert doc["source_sha256"] == "deadbeef"
    assert doc["extraction_input_sha"] == "deadbeef"


def test_sign_dry_run_records_null_binding_fields_when_envelope_data_absent(tmp_path):
    # No source.sha256/extraction.json exist yet at sign time (e.g. this
    # test's other fixtures, which never seed the data envelope) — must not
    # crash, and must record null (never a fabricated value) so
    # validate_sign_marker's envelope-bound check correctly refuses it later
    # as "missing from sign marker" rather than a false match.
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    meeting_id = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
    capture = tmp_path / "dry-run.txt"
    capture.write_text(_capture_text(), encoding="utf-8")
    rc = main([
        "--meeting-id", meeting_id, "--vault", str(vault),
        "--signed-by", "Josh", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = marker_path(vault, "fireflies", meeting_id)
    doc = json.loads(marker.read_text(encoding="utf-8"))
    assert doc["source_sha256"] is None
    assert doc["extraction_input_sha"] is None


def test_sign_dry_run_sets_phase3_hash_when_nouns_present(tmp_path: Path) -> None:
    # G0a F-9 ruling (Task 5): a capture containing the phase3-preview: v1
    # header plus the phase-3 preview nouns Task 4 added to _run_dry
    # (would-touch:/would-write:/would-file:, anchored at column 0) must get
    # a phase3_capture_sha256 alongside the existing R2-era capture_sha256.
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\nquotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: x\n"
        "phase3-preview: v1\n"
        "would-touch: clients/alloi.md (engagements-rollup)\n"
        "would-write: raw/areas/clearworks/clients/alloi/status-update-2026-09-10.md\n"
        'would-file: 2026-09-10 filed "x" under alloi-03 fireflies:MID\n',
        encoding="utf-8",
    )
    rc = sign_main([
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker["phase3_capture_sha256"]


def test_sign_dry_run_leaves_phase3_hash_null_on_truncated_capture_missing_writer_evidence(
    tmp_path: Path,
) -> None:
    """Finding 1 (P1): the old check accepted the `phase3-preview: v1`
    header plus ANY single anchored would-* line, so a capture truncated
    right after `would-touch:` (never reaching the status writer's
    would-write: or the filed-log's would-file:) was treated as a complete
    phase-3 review. Each of the three phase-3 writers now needs its own
    evidence line; missing any must leave phase3_capture_sha256 null and
    print an explicit incomplete-preview message naming what's missing."""
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run-truncated.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\nquotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: x\n"
        "phase3-preview: v1\n"
        "would-touch: clients/alloi.md (engagements-rollup)\n",
        encoding="utf-8",
    )
    rc, err = _run_sign_capturing_stderr(sign_main, [
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0  # R2-era sign still succeeds; only the phase-3 field is affected
    assert "phase-3 preview incomplete: missing" in err
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker.get("phase3_capture_sha256") is None


def test_sign_dry_run_leaves_phase3_hash_null_when_would_file_is_not_the_last_line(
    tmp_path: Path,
) -> None:
    """Finding 1: the capture must END with the would-file: block (trailing
    whitespace only) — content appended after it (a truncation-in-the-
    middle symptom, or stray trailing prose) must not be treated as a
    fully-reviewed preview."""
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run-trailing.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\nquotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: x\n"
        "phase3-preview: v1\n"
        "would-touch: clients/alloi.md (engagements-rollup)\n"
        "would-write: raw/areas/clearworks/clients/alloi/status-update-2026-09-10.md\n"
        'would-file: 2026-09-10 filed "x" under alloi-03 fireflies:MID\n'
        "unexpected trailing line after the filed-log block\n",
        encoding="utf-8",
    )
    rc, err = _run_sign_capturing_stderr(sign_main, [
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    assert "phase-3 preview incomplete: missing" in err
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker.get("phase3_capture_sha256") is None


def test_sign_dry_run_sets_phase3_hash_for_skip_status_capture(tmp_path: Path) -> None:
    """Finding 1: `would-write: skip: no-engagement` (the normalized form
    _run_dry now always emits for the status writer, even when there is
    nothing to write) must count as the reviewer having seen that writer's
    decision — a legitimately empty writer is still evidenced."""
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run-skip-status.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\nquotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: x\n"
        "phase3-preview: v1\n"
        "would-touch: clients/alloi.md (engagements-rollup)\n"
        "would-write: skip: no-engagement\n"
        'would-file: 2026-09-10 filed "x" under alloi-03 fireflies:MID\n',
        encoding="utf-8",
    )
    rc = sign_main([
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker["phase3_capture_sha256"]


def _run_sign_capturing_stderr(sign_main, argv: list[str]) -> tuple[int, str]:
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        rc = sign_main(argv)
    return rc, buf.getvalue()


def test_sign_dry_run_leaves_phase3_hash_null_when_nouns_only_incidental(tmp_path: Path) -> None:
    # CH-6: substring containment alone let an R2-era capture whose page
    # diff (or meeting text) merely *mentions* "would-touch:"/"would-write:"
    # etc. — inside a diff hunk, or embedded mid-line — forge the phase-3
    # signal. Neither of these lines is a real anchored `_run_dry` noun
    # (both fail the re.MULTILINE "^would-(touch|write|file): " check), and
    # there is no "phase3-preview: v1" header line at all, so the field must
    # stay null even though the raw substrings are present in the text.
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\n"
        "+some prose that says would-touch: this page next quarter\n"
        "quotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: mentions would-write: nothing real and would-file: too\n",
        encoding="utf-8",
    )
    rc = sign_main([
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker.get("phase3_capture_sha256") is None


def test_sign_dry_run_sets_phase3_hash_from_real_run_dry_capture(tmp_path: Path) -> None:
    # CH-6 end-to-end: a genuine `run_meeting.py --dry-run` capture (real
    # header + real anchored would-* lines, produced by the actual _run_dry
    # phase-3 block, not hand-typed) must set phase3_capture_sha256.
    import sys as _sys
    from pathlib import Path as _Path

    import run_meeting
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "projects" / "alloi-03.md").write_text(
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\nclient: alloi\n"
        "parent: alloi-01\ntitle: Tactical Reports\naliases: tacticals\ndomains: alloi.us\n"
        "delivery_state: active\n\n## History (dated, newest first)\n\n- old\n\n## Open Items\n",
        encoding="utf-8",
    )
    mid = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
    env_dir = vault / "raw/media/transcripts/fireflies" / mid
    env_dir.mkdir(parents=True)
    source = {
        "schema": "brain.source/1", "source": {"kind": "fireflies", "id": mid},
        "title": "Weekly tacticals review", "occurred_at": "2026-09-04T17:00:00Z", "duration_s": 12,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Marcos", "email": "marcos@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "hello tacticals", "ts": 0}],
        "native_summary": {"overview": "hello tacticals"},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (env_dir / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (env_dir / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    # F18 (CH-17): coherent envelope required by the already-fetched short-circuit
    (env_dir / "meta.json").write_text(
        json.dumps({"fetched_at": "2026-09-04T17:00:00Z", "fetcher": "fetch_fireflies/1"}), encoding="utf-8",
    )
    extraction = {
        "schema": "brain.extraction/1", "inputSha": sha, "promptSha": "p", "model": "sonnet",
        "cost_usd": 0, "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {"org_name": "Alloi", "domain": "alloi.us", "relationship": "client", "confidence": 0.9, "evidence": "hello tacticals"},
        "summary": {"overview": "hello tacticals", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [],
        "proposed_delivery_state": None, "deal_state": "won", "meeting_type": "delivery",
    }
    (env_dir / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text('{"contacts":[]}', encoding="utf-8")

    if str(_Path(__file__).resolve().parents[1]) not in _sys.path:
        _sys.path.insert(0, str(_Path(__file__).resolve().parents[1]))
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = run_meeting.main([
            "--meeting-id", f"fireflies:{mid}", "--dry-run",
            "--repo-root", str(repo), "--vault", str(vault),
        ])
    assert rc == 0, buf.getvalue()
    real_capture = tmp_path / "real-dry-run.txt"
    real_capture.write_text(buf.getvalue(), encoding="utf-8")
    assert "phase3-preview: v1" in buf.getvalue()

    sign_rc = sign_main([
        "--meeting-id", mid, "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(real_capture),
    ])
    assert sign_rc == 0
    marker = json.loads(marker_path(vault, "fireflies", mid).read_text(encoding="utf-8"))
    assert marker["phase3_capture_sha256"]


def test_sign_dry_run_leaves_phase3_hash_null_for_r2_era_capture(tmp_path: Path) -> None:
    """The exact stale-marker scenario: a capture taken before this release
    existed, containing only the R2-era five nouns and none of the new
    phase-3 preview lines."""
    from sign_dry_run import main as sign_main, marker_path

    vault = tmp_path / "vault"
    (vault / "raw/media/transcripts/fireflies/MID").mkdir(parents=True)
    capture = tmp_path / "dry-run-r2.txt"
    capture.write_text(
        "home=projects/alloi-03.md node=alloi-03 rule=2 created=none promotion=none\n"
        "--- a/x\n+++ b/x\nquotes kept decisions=1 commitments=1 dropped={}\n"
        "tasks:\nsubject: Recap: x\n",
        encoding="utf-8",
    )
    rc = sign_main([
        "--meeting-id", "MID", "--vault", str(vault), "--signed-by", "Josh",
        "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture),
    ])
    assert rc == 0
    marker = json.loads(marker_path(vault, "fireflies", "MID").read_text(encoding="utf-8"))
    assert marker.get("phase3_capture_sha256") is None

    from progress import validate_phase3_capture

    assert validate_phase3_capture(marker_path(vault, "fireflies", "MID")) == "phase-3 capture unsigned"


def test_sign_dry_run_rejects_unknown_signer(tmp_path):
    # Finding 4b: sign_dry_run.py's own output must also fail
    # validate_sign_marker's allowlist check for a non-allowlisted signer —
    # end-to-end, not just at the unit level.
    from progress import validate_sign_marker
    from sign_dry_run import main, marker_path

    vault = tmp_path / "vault"
    capture = tmp_path / "dry-run.txt"
    capture.write_text(_capture_text(), encoding="utf-8")

    rc = main([
        "--meeting-id", "01M1MW2GAZ1DQ0C6PG3KJ557JA", "--vault", str(vault),
        "--signed-by", "Mallory", "--signed-at", "2026-09-05T00:00:00Z",
        "--dry-run-capture", str(capture),
    ])
    assert rc == 0  # sign_dry_run.py itself has no signer allowlist — the
    # gate lives in validate_sign_marker, run at --apply time.
    marker = marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA")
    reason = validate_sign_marker(marker)
    assert reason is not None
    assert "allowlist" in reason
