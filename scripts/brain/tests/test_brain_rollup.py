# scripts/brain/tests/test_brain_rollup.py
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _seed_projects(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    _write(
        proj / "alloi-01.md",
        "# Client: Alloi — Managed Services\n\n## Node\nid: alloi-01\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: Managed Services\naliases:\ndomains: alloi.us\n"
        "delivery_state: active\nopened:\nclosed:\n\n## Reporting\ncadence: weekly\n"
        "channel: email\ncontact: marcos@alloi.us\nlast_update: 2026-08-20\n",
    )
    _write(
        proj / "alloi-03.md",
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\n"
        "client: alloi\nparent: alloi-01\ntitle: Tactical Reports\n"
        "aliases: tacticals, tactical report, arch tactical\ndomains: alloi.us\n"
        "delivery_state: active\nopened:\nclosed:\n\n## Reporting\ncadence:\nchannel:\n"
        "contact:\nlast_update:\n",
    )
    _write(proj / "_template.md", "id: <client>-<nn>\nkind: engagement|project\n")
    return vault


def _seed_state_fixture(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    _write(
        proj / "alloi-01.md",
        "# Client: Alloi — Managed Services\n\n## Node\nid: alloi-01\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: Managed Services\naliases:\ndomains: alloi.us\n"
        "delivery_state: active\nopened:\nclosed:\n\n## Reporting\ncadence: weekly\n"
        "channel: email\ncontact: marcos@alloi.us\nlast_update:\n\n"
        "## History (dated, newest first)\n\n"
        "- 2026-09-01 — Kickoff\n  - Outcomes: none\n  - Decisions: none\n\n"
        "## Open Items\n\n| Item | Owner | Deadline | Source | Status |\n|---|---|---|---|---|\n"
        "| Confirm scope | Josh Weiss | 2026-09-10 | commitment:a | open |\n",
    )
    _write(
        proj / "alloi-03.md",
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\n"
        "client: alloi\nparent: alloi-01\ntitle: Tactical Reports\naliases: tacticals\n"
        "domains: alloi.us\ndelivery_state: active\nopened:\nclosed:\n\n"
        "## Reporting\ncadence:\nchannel:\ncontact:\nlast_update:\n\n"
        "## History (dated, newest first)\n\n"
        "- 2026-09-04 — Alloi Tacticals Troubleshooting\n"
        "  - Outcomes: Installed skill v4.\n"
        "  - Decisions: Reports land Monday EOD.\n\n"
        "## Open Items\n\n| Item | Owner | Deadline | Source | Status |\n|---|---|---|---|---|\n"
        "| Run tactical reports | Ivette Ramos | — | commitment:b | open |\n"
        "| Send follow-up email | Josh Weiss | — | commitment:c | open |\n",
    )
    return vault


def test_parse_node_block_reads_required_keys() -> None:
    from brain_rollup import parse_node_block

    tmp = Path("/tmp/brain_rollup_test_node.md")
    tmp.write_text(
        "## Node\nid: alloi-03\nkind: project\nclient: alloi\nparent: alloi-01\ntitle: Tactical Reports\n"
        "\n## Reporting\ncadence:\n",
        encoding="utf-8",
    )
    node = parse_node_block(tmp)
    assert node == {
        "id": "alloi-03", "kind": "project", "client": "alloi", "parent": "alloi-01",
        "title": "Tactical Reports",
    }
    tmp.unlink()


def test_parse_node_block_raises_on_missing_required_keys() -> None:
    from brain_rollup import NodeBlockError, parse_node_block

    tmp = Path("/tmp/brain_rollup_test_bad_node.md")
    tmp.write_text("## Node\nid: alloi-99\n", encoding="utf-8")
    with pytest.raises(NodeBlockError):
        parse_node_block(tmp)
    tmp.unlink()


def test_load_nodes_skips_underscore_stems(tmp_path: Path) -> None:
    from brain_rollup import load_nodes

    vault = _seed_projects(tmp_path)
    nodes = load_nodes(vault)
    assert set(nodes) == {"alloi-01", "alloi-03"}
    assert nodes["alloi-03"]["parent"] == "alloi-01"


def test_render_engagements_rollup_nests_projects_under_engagement(tmp_path: Path) -> None:
    from brain_rollup import load_nodes, render_engagements_rollup

    vault = _seed_projects(tmp_path)
    nodes = load_nodes(vault)
    body = render_engagements_rollup("alloi", nodes)
    assert "| Managed Services | Tactical Reports | active | " in body
    assert body.count("|") > 4  # header + at least one data row


def test_apply_generated_region_creates_under_marker_when_absent() -> None:
    from brain_rollup import apply_generated_region

    old = "# Client: Alloi\n\n## Current state\n\n- CRM org name: alloi.us\n"
    new = apply_generated_region(old, "engagements-rollup", "TABLE", create_after="## Current state\n")
    assert "<!-- generated: engagements-rollup -->\nTABLE\n<!-- /generated -->" in new
    assert new.index("<!-- generated") < new.index("- CRM org name")


def test_apply_generated_region_rewrites_only_the_region_idempotently() -> None:
    from brain_rollup import apply_generated_region

    old = (
        "# Client: Alloi\n\n## Current state\n\n"
        "<!-- generated: engagements-rollup -->\nOLD TABLE\n<!-- /generated -->\n\n"
        "- CRM org name: alloi.us\n"
    )
    new1 = apply_generated_region(old, "engagements-rollup", "NEW TABLE", create_after="## Current state\n")
    assert "NEW TABLE" in new1 and "OLD TABLE" not in new1
    assert "- CRM org name: alloi.us" in new1
    new2 = apply_generated_region(new1, "engagements-rollup", "NEW TABLE", create_after="## Current state\n")
    assert new2 == new1  # idempotent: unchanged body, zero diff on rerun


def test_render_state_sections_active_waiting_decisions_next(tmp_path: Path) -> None:
    from brain_rollup import load_nodes, render_state_sections

    vault = _seed_state_fixture(tmp_path)
    nodes = load_nodes(vault)
    body = render_state_sections(nodes, "2026-09-10")
    assert "## Active work" in body and "Managed Services" in body and "Tactical Reports" in body
    assert "2026-09-04: Alloi Tacticals Troubleshooting" in body
    assert "## Waiting on" in body and "Run tactical reports — Ivette Ramos" in body
    assert "Send follow-up email" not in body.split("## Waiting on", 1)[1].split("## Decisions", 1)[0]
    assert "## Decisions made" in body and "Reports land Monday EOD." in body
    assert "## Next priorities" in body
    next_section = body.split("## Next priorities", 1)[1]
    assert "Send follow-up email — Josh Weiss" in next_section
    assert "Confirm scope — Josh Weiss (due 2026-09-10)" in next_section


def test_main_writes_state_generated_region_idempotently(tmp_path: Path) -> None:
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    (vault / "raw/areas/clearworks/org-brain/STATE.md").write_text(
        "# STATE · updated 2026-08-10\n\nRead this first.\n", encoding="utf-8"
    )
    rc = main(["--client", "alloi", "--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 0
    state = (vault / "raw/areas/clearworks/org-brain/STATE.md").read_text(encoding="utf-8")
    assert "Read this first." in state  # legacy sections untouched (G-47)
    assert "<!-- generated: state -->" in state and "generated-from:" in state
    rc2 = main(["--client", "alloi", "--vault", str(vault), "--today", "2026-09-10"])
    assert rc2 == 0
    state2 = (vault / "raw/areas/clearworks/org-brain/STATE.md").read_text(encoding="utf-8")
    assert state2 == state  # zero diff on rerun


def test_main_regenerates_state_with_no_client_flag_given(tmp_path: Path) -> None:
    """G0b C1-2: STATE.md's generated region sources every projects/*.md
    node in the vault, independent of whether --client/--all was given or
    matched anything — a meeting that resolved to no client at all must
    still get STATE.md regenerated on the next brain_rollup.py invocation."""
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    rc = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 0
    state = (vault / "raw/areas/clearworks/org-brain/STATE.md").read_text(encoding="utf-8")
    assert "<!-- generated: state -->" in state and "Managed Services" in state
    # and the per-client rollup region was NOT touched (no --client given)
    client_path = vault / "raw/areas/clearworks/org-brain/clients/alloi.md"
    assert not client_path.exists()


def test_main_exits_6_on_malformed_node(tmp_path: Path) -> None:
    from brain_rollup import main

    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    _write(proj / "broken.md", "# Broken\n\n## Node\nid: broken\n")  # missing kind/client
    rc = main(["--all", "--vault", str(vault)])
    assert rc == 6
