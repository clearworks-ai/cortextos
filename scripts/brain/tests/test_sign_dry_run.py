from __future__ import annotations

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
    assert marker_path(vault, "fireflies", "01M1MW2GAZ1DQ0C6PG3KJ557JA").exists()
