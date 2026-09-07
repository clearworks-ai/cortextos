from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_digest_line_format_without_creation() -> None:
    from file_digest import digest_line

    resolution = {"home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2, "confidence": 1.0, "created": None}
    line = digest_line("2026-09-04", "Alloi Tacticals Troubleshooting", resolution, "fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA")
    assert line == (
        '2026-09-04 filed "Alloi Tacticals Troubleshooting" under alloi-03 → alloi-03 '
        "(rule 2, conf 1.0) fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA"
    )


def test_digest_line_includes_new_suffix_when_created() -> None:
    from file_digest import digest_line

    resolution = {
        "home_path": "orgs/newco-fixture.md", "node": "none", "rule": 6, "confidence": 0.8,
        "created": {"kind": "org", "slug": "newco-fixture", "relationship": "prospect"},
    }
    line = digest_line("2026-09-04", "Variant B meeting", resolution, "fireflies:xyz")
    assert "NEW prospect newco-fixture" in line
    assert " → " not in line  # node: none => no arrow suffix
    assert line.endswith("fireflies:xyz")


def test_append_filed_line_idempotent_on_source_key(tmp_path: Path) -> None:
    from file_digest import append_filed_line

    log_path = tmp_path / "_filed.log"
    appended1 = append_filed_line(log_path, "fireflies:abc", "2026-09-04 filed \"x\" under alloi-03 (rule 2, conf 1.0) fireflies:abc")
    assert appended1 is True
    text1 = log_path.read_text(encoding="utf-8")
    appended2 = append_filed_line(log_path, "fireflies:abc", "2026-09-04 filed \"x\" under alloi-03 (rule 2, conf 1.0) fireflies:abc")
    assert appended2 is False
    assert log_path.read_text(encoding="utf-8") == text1  # zero-diff on repeat
