"""FR-007 / G-15 / G-HIST-1 / G-HIST-2: the email History renderer is a NEW sibling
to writeback_render.render_page (that one's idempotency at :133-137 REFUSES any entry
whose [source:] marker already exists — exactly wrong for FR-001's revision semantics).
This renderer always appends; it never rewrites or removes an existing line."""
from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import writeback_email as we


def test_render_history_entry_shape():
    entry = we.HistoryEntry(
        date="2026-09-14", subject="Q3 renewal", source_ref="gmail:abc123",
        summary="Discussed pricing", decisions=["Go with tier 2"],
        open_questions=["When does contract start?"],
    )
    lines = we.render_history_entry(entry)
    assert lines == [
        "- 2026-09-14 — Q3 renewal (email) [source: gmail:abc123]",
        "  - Summary: Discussed pricing",
        "  - Decisions: Go with tier 2",
        "  - Open questions: When does contract start?",
    ]


def test_render_history_entry_no_decisions_or_open_questions():
    entry = we.HistoryEntry(
        date="2026-09-14", subject="Quick check-in", source_ref="gmail:xyz",
        summary="", decisions=[], open_questions=[],
    )
    lines = we.render_history_entry(entry)
    assert lines == [
        "- 2026-09-14 — Quick check-in (email) [source: gmail:xyz]",
        "  - Summary: none",
        "  - Decisions: none",
    ]


def test_render_history_entry_revision_marker():
    entry = we.HistoryEntry(
        date="2026-09-15", subject="Q3 renewal (follow-up)", source_ref="gmail:abc123",
        summary="Updated numbers", decisions=[], open_questions=[],
        revision_of="deadbeef00112233",
    )
    lines = we.render_history_entry(entry)
    assert lines[0] == (
        "- 2026-09-15 — Q3 renewal (follow-up) (email) "
        "[source: gmail:abc123] (revision of deadbeef)"
    )


def test_render_history_entry_escapes_leading_markdown_chars():
    entry = we.HistoryEntry(
        date="2026-09-14", subject="# Sneaky heading", source_ref="gmail:x",
        summary="- also sneaky", decisions=["| table row"], open_questions=["# question"],
    )
    lines = we.render_history_entry(entry)
    assert lines[0].startswith("- 2026-09-14 — \\# Sneaky heading")
    assert "Summary: \\- also sneaky" in lines[1]
    assert "Decisions: \\| table row" in lines[2]
    assert "Open questions: \\# question" in lines[3]


_OLD_PAGE = """---
title: Example Client
---

## Contacts

- Jane Doe <jane@example.com>

## History (dated, newest first)

- 2026-01-01 — Kickoff call (meeting: meetings/2026-01-01-kickoff-fireflies-abcd1234.md) [source: fireflies:abcd1234]
  - Outcomes: Kicked off the engagement
  - Decisions: none

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
"""


def _entry():
    return we.HistoryEntry(
        date="2026-09-14", subject="Pricing question", source_ref="gmail:xyz789",
        summary="Client asked about tier pricing", decisions=[], open_questions=[],
    )


def _assert_prefix_preserving(old_text: str, new_text: str) -> None:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    idx = 0
    for line in old_lines:
        while idx < len(new_lines) and new_lines[idx] != line:
            idx += 1
        assert idx < len(new_lines), f"missing original line: {line!r}"
        idx += 1


def test_apply_history_appends_into_existing_section_preserving_old_lines():
    new_page = we.apply_history(_OLD_PAGE, _entry())
    _assert_prefix_preserving(_OLD_PAGE, new_page)
    assert "- 2026-09-14 — Pricing question (email) [source: gmail:xyz789]" in new_page
    assert new_page.index("2026-01-01 — Kickoff call") < new_page.index("2026-09-14 — Pricing question")
    assert "## Open Items" in new_page


def test_apply_history_creates_section_when_absent():
    page_no_history = (
        "## Contacts\n\n- Jane Doe\n\n## Open Items\n\n"
        "| Item | Owner | Deadline | Source | Status |\n|---|---|---|---|---|\n"
    )
    new_page = we.apply_history(page_no_history, _entry())
    _assert_prefix_preserving(page_no_history, new_page)
    assert "## History (dated, newest first)" in new_page
    assert "- 2026-09-14 — Pricing question" in new_page
    assert new_page.index("## Open Items") < new_page.index("## History")


def test_apply_history_never_removes_or_rewrites_a_line():
    new_page = we.apply_history(_OLD_PAGE, _entry())
    for line in [
        "## Contacts",
        "- Jane Doe <jane@example.com>",
        "## History (dated, newest first)",
        "- 2026-01-01 — Kickoff call (meeting: meetings/2026-01-01-kickoff-fireflies-abcd1234.md) [source: fireflies:abcd1234]",
        "  - Outcomes: Kicked off the engagement",
        "  - Decisions: none",
        "## Open Items",
        "| Item | Owner | Deadline | Source | Status |",
        "|---|---|---|---|---|",
    ]:
        assert line in new_page


def test_apply_history_applied_twice_appends_twice_idempotency_is_ledgers_job():
    once = we.apply_history(_OLD_PAGE, _entry())
    twice = we.apply_history(once, _entry())
    assert once.count("gmail:xyz789") == 1
    assert twice.count("gmail:xyz789") == 2


def test_apply_history_revision_entry_appended_after_original():
    revised = we.HistoryEntry(
        date="2026-09-15", subject="Pricing question (follow-up)", source_ref="gmail:xyz789",
        summary="Confirmed tier 2", decisions=[], open_questions=[],
        revision_of="aaaaaaaa11112222",
    )
    once = we.apply_history(_OLD_PAGE, _entry())
    twice = we.apply_history(once, revised)
    _assert_prefix_preserving(once, twice)
    assert "(revision of aaaaaaaa)" in twice
    assert twice.index("2026-09-14 — Pricing question") < twice.index("2026-09-15 — Pricing question (follow-up)")


def test_page_path_for_kinds(tmp_path):
    vault = tmp_path / "vault"
    (vault / "raw" / "areas" / "clearworks" / "org-brain").mkdir(parents=True)
    assert we.page_path_for(vault, "acme-co", "client") == (
        vault / "raw/areas/clearworks/org-brain/clients/acme-co.md"
    )
    assert we.page_path_for(vault, "acme-co", "org") == (
        vault / "raw/areas/clearworks/org-brain/orgs/acme-co.md"
    )
    assert we.page_path_for(vault, "alloi", "project") == (
        vault / "raw/areas/clearworks/org-brain/projects/alloi.md"
    )


# --- G2r3-4: page-level idempotency, independent of the ledger ---------------

def test_history_entry_present_detects_an_already_written_entry():
    from writeback_email import HistoryEntry, apply_history, history_entry_present

    entry = HistoryEntry(date="2026-09-14", subject="Renewal", source_ref="gmail:m1",
                         summary="Marcos asked for the MSA")
    page = "# Client\n\n## History (dated, newest first)\n\n## Open Items\n"
    assert history_entry_present(page, entry) is False

    written = apply_history(page, entry)
    assert history_entry_present(written, entry) is True


def test_history_entry_present_distinguishes_a_revision_from_its_original():
    """A revision of the same source_ref is a DIFFERENT entry and must still be
    appended; only the identical rendered entry counts as already-landed."""
    from writeback_email import HistoryEntry, apply_history, history_entry_present

    original = HistoryEntry(date="2026-09-14", subject="Renewal", source_ref="gmail:m1", summary="v1")
    revision = HistoryEntry(date="2026-09-14", subject="Renewal", source_ref="gmail:m1",
                            summary="v2", revision_of="deadbeefcafe")
    page = "# Client\n\n## History (dated, newest first)\n\n## Open Items\n"
    written = apply_history(page, original)

    assert history_entry_present(written, original) is True
    assert history_entry_present(written, revision) is False     # still owed

    both = apply_history(written, revision)
    assert history_entry_present(both, revision) is True
