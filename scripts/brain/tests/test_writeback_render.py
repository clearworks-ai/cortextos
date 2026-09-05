"""FR-005 / D-15: dry-run diffs every file --apply would touch; 8 CONTROL tests stay green."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

WB_PATH = (
    Path(__file__).resolve().parents[3]
    / "orgs/clearworksai/agents/pa/scripts/meeting_writeback.py"
)
SPEC = importlib.util.spec_from_file_location("meeting_writeback_script", WB_PATH)
assert SPEC and SPEC.loader
WB = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WB
SPEC.loader.exec_module(WB)


def _payload(**res_extra: object) -> dict:
    resolution = {
        "home_path": "projects/alloi-03.md",
        "node": "alloi-03",
        "rule": 2,
        "created": None,
        "relationship": "client",
        "confidence": "high",
    }
    resolution.update(res_extra)
    return {
        "meetings": [
            {
                "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA",
                "title": "Tacticals sync",
                "date": "2026-09-04T17:00:00Z",
                "organizer": "Josh Weiss",
                "attendees": ["josh@clearworks.us"],
                "client_context": "alloi",
                "summary": {"overview": "Scoped tactical reports."},
                "decisions": ["Keep weekly cadence"],
                "next_steps": [],
                "meeting_type": "delivery",
                "resolution": resolution,
                "promotion": None,
                "open_items": [
                    {
                        "item": "Ship dry-run",
                        "owner": "Josh",
                        "deadline": "2026-09-08",
                        "source": "commitment:abc",
                        "status": "open",
                    }
                ],
            }
        ]
    }


def test_render_page_preserves_unknown_section() -> None:
    from writeback_render import render_page

    old = """# Client: Alloi — Tactical Reports

## Node
id: alloi-03

## Custom
keep-me-byte-for-byte

## History (dated, newest first)

- old entry

## Open Items
| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
"""
    new = render_page(old, _payload()["meetings"][0])
    assert "keep-me-byte-for-byte" in new
    assert "## Custom" in new
    assert new.index("## Custom") < new.index("## History")
    assert "Scoped tactical reports" in new or "Tacticals sync" in new


def test_render_page_open_items_bare_heading_gets_header() -> None:
    from writeback_render import render_page

    old = """# Client: Alloi — Tactical Reports

## History (dated, newest first)

- old entry

## Open Items
"""
    meeting = _payload()["meetings"][0]
    meeting["open_items"] = [
        {
            "item": "Ship dry-run",
            "owner": "Josh",
            "deadline": "2026-09-08",
            "source": "commitment:abc",
            "status": "open",
        },
        {
            "item": "Review deck",
            "owner": "Josh",
            "deadline": "2026-09-09",
            "source": "commitment:def",
            "status": "open",
        },
    ]
    new = render_page(old, meeting)
    lines = new.splitlines()
    idx = lines.index("## Open Items")
    assert lines[idx + 1] == ""
    assert lines[idx + 2] == "| Item | Owner | Deadline | Source | Status |"
    assert lines[idx + 3] == "|---|---|---|---|---|"
    assert lines[idx + 4] == "| Ship dry-run | Josh | 2026-09-08 | commitment:abc | open |"
    assert lines[idx + 5] == "| Review deck | Josh | 2026-09-09 | commitment:def | open |"


def test_render_page_open_items_existing_header_not_duplicated() -> None:
    from writeback_render import render_page

    old = """# Client: Alloi — Tactical Reports

## History (dated, newest first)

- old entry

## Open Items
| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
"""
    new = render_page(old, _payload()["meetings"][0])
    assert new.count("| Item | Owner | Deadline | Source | Status |") == 1


def test_dry_run_prints_all_diffs_and_reason_writes_nothing(tmp_path: Path) -> None:
    org = tmp_path / "org"
    home = org / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    home.parent.mkdir(parents=True)
    home.write_text(
        "# Client: Alloi — Tactical Reports\n\n## History (dated, newest first)\n\n- old\n",
        encoding="utf-8",
    )
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(json.dumps(_payload()), encoding="utf-8")
    ledger = tmp_path / "ledger.txt"
    ledger.write_text("", encoding="utf-8")

    env = {
        "ORG_ROOT": str(org),
        "LEDGER_FILE": str(ledger),
        "CTX_TMP": str(tmp_path),
    }
    out = io.StringIO()
    err = io.StringIO()
    with pytest.MonkeyPatch.context() as mp:
        for k, v in env.items():
            mp.setenv(k, v)
        with redirect_stdout(out), redirect_stderr(err):
            rc = WB.main(["--payload", str(payload_path), "--dry-run"])
    assert rc == 0
    text = out.getvalue()
    assert "---" in text and "+++" in text
    assert "alloi-03.md" in text
    assert "meetings/" in text
    assert "home=" in text and "node=alloi-03" in text and "rule=2" in text
    assert "created=" in text and "promotion=" in text
    assert home.read_text(encoding="utf-8").startswith("# Client: Alloi")
    assert list((org / "raw/areas/clearworks/org-brain/meetings").glob("*.md")) == []
    assert ledger.read_text(encoding="utf-8") == ""


def test_resolution_without_flags_refuses(tmp_path: Path) -> None:
    payload_path = tmp_path / "p.json"
    payload_path.write_text(json.dumps(_payload()), encoding="utf-8")
    (tmp_path / "ledger").write_text("", encoding="utf-8")
    org = tmp_path / "org"
    org.mkdir()
    out = io.StringIO()
    err = io.StringIO()
    env = {"ORG_ROOT": str(org), "LEDGER_FILE": str(tmp_path / "ledger"), "CTX_TMP": str(tmp_path)}
    with pytest.MonkeyPatch.context() as mp:
        for k, v in env.items():
            mp.setenv(k, v)
        with redirect_stdout(out), redirect_stderr(err):
            rc = WB.main(["--payload", str(payload_path)])
    assert rc == 64


def test_created_org_template_fills_name_and_provenance() -> None:
    from writeback_render import render_created_page

    tmpl = """# <Name>

kind:
relationship:
created_from:
confidence:
domains:
emails:
"""
    meeting = _payload(
        home_path="orgs/newco-fixture.md",
        node="none",
        created={"kind": "org", "slug": "newco-fixture", "relationship": "prospect"},
    )["meetings"][0]
    meeting["resolution"]["confidence"] = 0.8
    page = render_created_page(tmpl, meeting)
    assert page.startswith("# Newco Fixture")
    assert "kind: org" in page
    assert "relationship: prospect" in page
    assert "created_from: fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA" in page
    assert "confidence: 0.8" in page


def test_promotion_updates_delivery_state_line() -> None:
    from writeback_render import render_page

    meeting = _payload()["meetings"][0]
    meeting["promotion"] = {"state": "delivered", "quote": "hello tacticals"}
    old = """# Client: Alloi — Tactical Reports

## Node
id: alloi-03
delivery_state: active

## History (dated, newest first)

- old
"""
    new = render_page(old, meeting)
    assert "delivery_state: delivered" in new
    assert "delivery_state: active" not in new


def test_created_page_diff_when_resolution_created(tmp_path: Path) -> None:
    from writeback_render import render_created_page, render_meeting_note

    tmpl = "# Client: Alloi — <title>\n\n## Node\nid: <client>-<nn>\n"
    meeting = _payload(created={"kind": "org", "slug": "alloi-04"})["meetings"][0]
    page = render_created_page(tmpl, meeting)
    note = render_meeting_note(meeting)
    assert "alloi-04" in page or "Tactical" in page
    assert "meeting_id" in note
    assert "01M1MW2G" in note


def test_meeting_note_includes_counterparty() -> None:
    from writeback_render import render_meeting_note

    meeting = _payload()["meetings"][0]
    meeting["resolution"]["counterparty"] = "alloi"
    note = render_meeting_note(meeting)
    assert "counterparty: alloi" in note


def test_history_skips_when_source_already_present() -> None:
    from writeback_render import render_page

    meeting = _payload()["meetings"][0]
    old = """# Client: Alloi — Tactical Reports

## History (dated, newest first)

- 2026-09-04 — Tacticals sync (meeting: meetings/x.md) [source: fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA]
"""
    new = render_page(old, meeting)
    assert new.count("[source: fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA]") == 1


def test_created_person_plans_orgs_home_once(tmp_path: Path) -> None:
    from writeback_render import planned_files

    org = tmp_path / "org"
    brain = org / "raw/areas/clearworks/org-brain"
    (brain / "orgs").mkdir(parents=True)
    (brain / "orgs" / "_template.md").write_text(
        "# <Name>\n\n## History (dated, newest first)\n\n",
        encoding="utf-8",
    )
    meeting = _payload(
        home_path="orgs/jane.md",
        node="none",
        created={"kind": "person", "slug": "jane", "relationship": "person"},
    )["meetings"][0]
    files = planned_files(org, meeting)
    rels = [str(path.relative_to(brain)) for path, _, _ in files]
    assert rels.count("orgs/jane.md") == 1
    assert not any(rel.startswith("projects/") for rel in rels)
    assert any(rel.startswith("meetings/") for rel in rels)
    assert len(files) == 2
