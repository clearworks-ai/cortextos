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
