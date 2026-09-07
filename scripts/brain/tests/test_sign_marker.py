from __future__ import annotations

import json
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

# Same R2-only capture test_sign_dry_run._capture_text() returns (five FR-012 nouns, no phase-3 nouns);
# inlined because scripts/brain/tests is not on sys.path for cross-imports.
def _capture_text() -> str:
    return ("home=projects/alloi-03.md node=alloi-03 rule=2\n--- a/projects/alloi-03.md\n+++ b/projects/alloi-03.md\n"
            "quotes kept decisions=1 commitments=1\ntasks:\nsubject: Recap\n")


def _seed(tmp_path: Path, mid: str = "MARKER1") -> tuple[Path, Path]:
    vault = tmp_path / "vault"
    data_dir = vault / "raw/media/transcripts/fireflies" / mid
    data_dir.mkdir(parents=True)
    (data_dir / "source.sha256").write_text("a" * 64 + "\n", encoding="utf-8")
    (data_dir / "extraction.json").write_text(json.dumps({"inputSha": "b" * 64}), encoding="utf-8")
    capture = tmp_path / "dry-run.txt"
    capture.write_text(_capture_text(), encoding="utf-8")
    return vault, capture


def test_write_marker_is_byte_identical_to_sign_dry_run(tmp_path):
    from sign_dry_run import main, marker_path
    from sign_marker import write_marker

    vault, capture = _seed(tmp_path)
    assert main(["--meeting-id", "MARKER1", "--vault", str(vault), "--signed-by", "Josh",
                 "--signed-at", "2026-09-05T00:00:00Z", "--dry-run-capture", str(capture)]) == 0
    legacy = json.loads(marker_path(vault, "fireflies", "MARKER1").read_text(encoding="utf-8"))
    marker_path(vault, "fireflies", "MARKER1").unlink()

    rc, path, message = write_marker(vault, "fireflies", "MARKER1", capture,
                                     signed_by="Josh", signed_at="2026-09-05T00:00:00Z")
    assert rc == 0 and path == marker_path(vault, "fireflies", "MARKER1")
    assert "phase-3 preview incomplete" in message  # R2-only capture: warning, not failure
    fresh = json.loads(path.read_text(encoding="utf-8"))
    legacy.pop("written_at"); fresh.pop("written_at")
    assert fresh == legacy
    assert set(fresh) == {"meeting_id", "signed_by", "signed_at", "capture", "capture_path",
                          "capture_sha256", "phase3_capture_sha256", "source_sha256",
                          "extraction_input_sha"}


def test_write_marker_extra_fields_and_refusals(tmp_path):
    from sign_marker import marker_path, write_marker

    vault, capture = _seed(tmp_path, "MARKER2")
    rc, path, _ = write_marker(vault, "fireflies", "MARKER2", capture, signed_by="Josh",
                               signed_at="2026-09-05T00:00:00Z",
                               extra={"batch_id": "fireflies-20260906T000000Z", "digest_sha256": "c" * 64})
    assert rc == 0
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["batch_id"] == "fireflies-20260906T000000Z" and doc["digest_sha256"] == "c" * 64

    rc, path, message = write_marker(vault, "fireflies", "MARKER3", tmp_path / "missing.txt",
                                     signed_by="Josh", signed_at="2026-09-05T00:00:00Z")
    assert (rc, path) == (1, None) and "not found" in message
    assert not marker_path(vault, "fireflies", "MARKER3").exists()

    bad = tmp_path / "bad.txt"
    bad.write_text("home=x\n", encoding="utf-8")
    rc, path, message = write_marker(vault, "fireflies", "MARKER4", bad,
                                     signed_by="Josh", signed_at="2026-09-05T00:00:00Z")
    assert rc == 1 and "missing nouns" in message
    assert not marker_path(vault, "fireflies", "MARKER4").exists()
