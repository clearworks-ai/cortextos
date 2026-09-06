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


def test_parse_node_block_reads_required_keys(tmp_path: Path) -> None:
    from brain_rollup import parse_node_block

    tmp = tmp_path / "brain_rollup_test_node.md"
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


def test_parse_node_block_raises_on_missing_required_keys(tmp_path: Path) -> None:
    from brain_rollup import NodeBlockError, parse_node_block

    tmp = tmp_path / "brain_rollup_test_bad_node.md"
    tmp.write_text("## Node\nid: alloi-99\n", encoding="utf-8")
    with pytest.raises(NodeBlockError):
        parse_node_block(tmp)


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


def test_open_rows_splits_on_unescaped_pipes_only(tmp_path: Path) -> None:
    """G2R2-P2-1: an escaped pipe (`\\|`) inside a cell must stay literal —
    it is not a column delimiter — and must come back unescaped (as a
    plain `|`) in the parsed cell, with the row still parsed into exactly
    5 cells (not split into extra fields by the escaped pipe)."""
    from brain_rollup import _open_rows

    body = "| Reconcile Q3 \\| Q4 invoices | Ivette \\| Ramos | 2026-09-20 | commitment:z | open |\n"
    rows = _open_rows(body)
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {"item", "owner", "deadline", "source", "status"}
    assert row["item"] == "Reconcile Q3 | Q4 invoices"
    assert row["owner"] == "Ivette | Ramos"
    assert row["deadline"] == "2026-09-20"
    assert row["source"] == "commitment:z"
    assert row["status"] == "open"


def test_open_rows_splits_when_cell_ends_in_even_backslash_run_before_pipe(tmp_path: Path) -> None:
    """Coordinator fold: the old `(?<!\\\\)\\|` lookbehind only inspects the
    ONE character immediately before a `|` — it cannot tell an escaped
    backslash (`\\\\`, two chars) from an escaped pipe (`\\|`), so a cell
    that legitimately ends in a literal backslash right before the real
    column delimiter (an EVEN run of backslashes, e.g. `foo\\\\|`) was
    wrongly treated as an escaped delimiter. The row then split into fewer
    than 5 cells and was silently dropped. A left-to-right scanner that
    consumes each `\\` + next-char pair as one unit must still find the
    real delimiter right after the pair and produce exactly 5 cells, with
    the trailing backslash preserved (unescaped to one literal `\\`)."""
    from brain_rollup import _open_rows

    body = "| Reconcile Q3\\\\ | Ivette Ramos | 2026-09-20 | commitment:z | open |\n"
    rows = _open_rows(body)
    assert len(rows) == 1
    row = rows[0]
    assert row["item"] == "Reconcile Q3\\"
    assert row["owner"] == "Ivette Ramos"
    assert row["deadline"] == "2026-09-20"
    assert row["source"] == "commitment:z"
    assert row["status"] == "open"

    # regression guard: `\|` inside a cell must still stay literal (not a
    # delimiter) after the scanner rewrite.
    escaped_pipe_body = "| a \\| b | owner | — | src | open |\n"
    escaped_rows = _open_rows(escaped_pipe_body)
    assert len(escaped_rows) == 1
    assert escaped_rows[0]["item"] == "a | b"


def test_render_state_sections_keeps_open_item_row_ending_in_backslash(tmp_path: Path) -> None:
    """Integration: the trailing-backslash item must reach STATE.md's
    rendered Waiting-on output, not just parse correctly in isolation."""
    from brain_rollup import load_nodes, render_state_sections

    vault = _seed_state_fixture(tmp_path)
    alloi01 = vault / "raw/areas/clearworks/org-brain/projects/alloi-01.md"
    text = alloi01.read_text(encoding="utf-8")
    text += "| Reconcile Q3\\\\ | Ivette Ramos | 2026-09-20 | commitment:z | open |\n"
    alloi01.write_text(text, encoding="utf-8")

    nodes = load_nodes(vault)
    body = render_state_sections(nodes, "2026-09-10")
    assert "Reconcile Q3\\" in body


def test_render_state_sections_keeps_open_item_row_with_escaped_pipe(tmp_path: Path) -> None:
    """G2R2-P2-1 integration: under the old blind-split-on-every-pipe
    parser, an escaped pipe in a cell added extra `|` boundaries and made
    the whole row fail to match the fixed 5-column shape — the item was
    silently dropped out of STATE.md entirely, not just mis-split. With the
    fix the row must still parse and its (unescaped) item text must reach
    the rendered STATE.md open-items output."""
    from brain_rollup import load_nodes, render_state_sections

    vault = _seed_state_fixture(tmp_path)
    alloi01 = vault / "raw/areas/clearworks/org-brain/projects/alloi-01.md"
    text = alloi01.read_text(encoding="utf-8")
    text += "| Reconcile Q3 \\| Q4 invoices | Ivette \\| Ramos | 2026-09-20 | commitment:z | open |\n"
    alloi01.write_text(text, encoding="utf-8")

    nodes = load_nodes(vault)
    body = render_state_sections(nodes, "2026-09-10")
    assert "Reconcile Q3 | Q4 invoices" in body
    assert "Ivette | Ramos" in body


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


def test_render_state_sections_includes_open_project_under_closed_engagement(tmp_path: Path) -> None:
    """Finding 2 (FR-007 line ~234, D-09 line 52): the old traversal only
    walked children of OPEN engagements, so an active/paused/scoping
    project whose parent engagement is closed (or any other non-open
    state) never surfaced in Active work / Waiting on / Decisions / Next
    priorities. render_state_sections must derive its working set from
    every open node directly."""
    from brain_rollup import load_nodes, render_state_sections

    vault = _seed_state_fixture(tmp_path)
    alloi01 = vault / "raw/areas/clearworks/org-brain/projects/alloi-01.md"
    text = alloi01.read_text(encoding="utf-8")
    text = text.replace("delivery_state: active", "delivery_state: closed", 1)
    alloi01.write_text(text, encoding="utf-8")

    nodes = load_nodes(vault)
    assert nodes["alloi-01"]["delivery_state"] == "closed"
    assert nodes["alloi-03"]["delivery_state"] == "active"

    body = render_state_sections(nodes, "2026-09-10")
    active_section = body.split("## Active work", 1)[1].split("## Waiting on", 1)[0]
    assert "Tactical Reports" in active_section
    assert "## Waiting on" in body and "Run tactical reports — Ivette Ramos" in body
    assert "## Decisions made" in body and "Reports land Monday EOD." in body


def test_render_state_sections_includes_open_project_with_missing_parent(tmp_path: Path) -> None:
    """Finding 2: an open project whose `parent:` id has no corresponding
    node at all (never orphaned by state, just never written) must still
    surface — grouped under an `(unparented)` bucket rather than vanishing."""
    from brain_rollup import load_nodes, render_state_sections

    vault = _seed_state_fixture(tmp_path)
    alloi03 = vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md"
    text = alloi03.read_text(encoding="utf-8")
    text = text.replace("parent: alloi-01", "parent: ghost-01", 1)
    alloi03.write_text(text, encoding="utf-8")
    # remove the engagement entirely so alloi-01 doesn't exist as a node
    (vault / "raw/areas/clearworks/org-brain/projects/alloi-01.md").unlink()

    nodes = load_nodes(vault)
    assert "alloi-01" not in nodes
    assert nodes["alloi-03"]["parent"] == "ghost-01"

    body = render_state_sections(nodes, "2026-09-10")
    active_section = body.split("## Active work", 1)[1].split("## Waiting on", 1)[0]
    assert "(unparented)" in active_section
    assert "Tactical Reports" in active_section
    assert active_section.index("(unparented)") < active_section.index("Tactical Reports")


def test_main_state_zero_diff_on_rerun_with_closed_parent_orphan(tmp_path: Path) -> None:
    """Finding 2 must not break FR-007's idempotency guarantee: two runs of
    main() over the same canonical inputs (including an open project under
    a closed engagement) must produce byte-identical STATE.md."""
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    alloi01 = vault / "raw/areas/clearworks/org-brain/projects/alloi-01.md"
    text = alloi01.read_text(encoding="utf-8")
    text = text.replace("delivery_state: active", "delivery_state: closed", 1)
    alloi01.write_text(text, encoding="utf-8")

    rc = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 0
    state = (vault / "raw/areas/clearworks/org-brain/STATE.md").read_text(encoding="utf-8")
    rc2 = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc2 == 0
    state2 = (vault / "raw/areas/clearworks/org-brain/STATE.md").read_text(encoding="utf-8")
    assert state2 == state


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
    rc = main(["--all", "--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 6


def test_main_requires_today_argument(tmp_path: Path) -> None:
    """CH-4: --today has no wall-clock default — a rerun across UTC midnight
    with zero canonical-input changes must never be able to produce a diff
    from an implicit clock read. The CLI must refuse to run at all without
    an explicit --today (argparse required -> exit 2), not silently fall
    back to now()."""
    import pytest

    from brain_rollup import main

    vault = tmp_path / "vault"
    with pytest.raises(SystemExit) as exc:
        main(["--all", "--vault", str(vault)])
    assert exc.value.code == 2


def test_main_exits_6_on_unsanitized_client_slug_path_traversal(tmp_path: Path) -> None:
    """CH-1: a node's `client:` field is untrusted (LLM-extracted, or a
    hand-edited node file) and must never be used to build a filesystem
    path outside org-brain/clients/. `--all` must refuse the whole run
    before writing anything for a slug that fails validation or whose
    resolved path escapes the clients/ directory."""
    from brain_rollup import main

    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    _write(
        proj / "evil-01.md",
        "## Node\nid: evil-01\nkind: engagement\nclient: ../../tmp/escaped\n"
        "parent:\ntitle: Evil\n\n## Reporting\nlast_update:\n",
    )
    rc = main(["--all", "--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 6

    # nothing escaped org-brain/clients/, and STATE.md (processed after the
    # per-client loop) was never reached/written either
    escaped = vault / "raw/areas/clearworks/tmp/escaped.md"
    assert not escaped.exists()
    assert not (vault / "raw/areas/clearworks/org-brain/clients").exists()
    assert not (vault / "raw/areas/clearworks/org-brain/STATE.md").exists()


def test_main_accepts_a_legitimately_slug_shaped_client(tmp_path: Path) -> None:
    """Sanity check that CH-1's tightened validation doesn't reject the
    ordinary case: a normal lowercase-alnum-and-hyphen client slug."""
    from brain_rollup import main

    vault = _seed_projects(tmp_path)
    rc = main(["--all", "--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 0
    client_path = vault / "raw/areas/clearworks/org-brain/clients/alloi.md"
    assert client_path.is_file()
    assert "<!-- generated: engagements-rollup -->" in client_path.read_text(encoding="utf-8")


def test_main_state_generated_region_regenerates_at_the_end_of_the_file(tmp_path: Path) -> None:
    """CH-3: FR-007 requires the generated:state block to live at the END
    of STATE.md. A prior run (or hand-edit) that leaves a legacy section
    AFTER the generated block must be corrected on the next regeneration —
    the block moves to the end, the legacy section survives ahead of it."""
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    state_path = vault / "raw/areas/clearworks/org-brain/STATE.md"
    _write(
        state_path,
        "# STATE\n\n<!-- generated: state -->\nOLD BODY\n<!-- /generated -->\n\n"
        "## Legacy Notes\n\nKeep this section, written by hand.\n",
    )
    rc = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 0
    state = state_path.read_text(encoding="utf-8")
    assert "Keep this section, written by hand." in state
    assert state.index("Legacy Notes") < state.index("<!-- generated: state -->")
    assert state.rstrip().endswith("<!-- /generated -->")


def test_main_exits_6_on_unterminated_state_generated_region(tmp_path: Path) -> None:
    """CH-3: a generated:state opening marker with no closing marker must
    never let the generic first-subsequent `<!-- /generated -->` (which
    could belong to some other region) be treated as its close."""
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    state_path = vault / "raw/areas/clearworks/org-brain/STATE.md"
    _write(
        state_path,
        "# STATE\n\n<!-- generated: state -->\nOLD BODY, NO CLOSING MARKER AT ALL\n\n"
        "## Legacy Notes\n\ntext\n",
    )
    rc = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 6


def test_main_exits_6_on_state_terminated_by_a_different_regions_close(tmp_path: Path) -> None:
    """CH-3 (still-open): an unterminated `<!-- generated: state -->`
    followed by a second region's `<!-- generated: other -->` ... `<!--
    /generated -->` must NOT let that other region's closing marker be
    borrowed as state's own close. The first marker encountered after
    state's opening marker is another region's OPEN, not a CLOSE — this
    must fail exit 6, same as having no closing marker at all, and must
    leave the file on disk untouched."""
    from brain_rollup import main

    vault = _seed_state_fixture(tmp_path)
    state_path = vault / "raw/areas/clearworks/org-brain/STATE.md"
    original = (
        "# STATE\n\n<!-- generated: state -->\nOLD STATE BODY, NO CLOSE OF ITS OWN\n\n"
        "<!-- generated: other -->\nsome other region's body\n<!-- /generated -->\n"
    )
    _write(state_path, original)
    rc = main(["--vault", str(vault), "--today", "2026-09-10"])
    assert rc == 6
    assert state_path.read_text(encoding="utf-8") == original
