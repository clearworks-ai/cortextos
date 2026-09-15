"""FR-001 observation ledger: round-trip, terminal predicate, escalation dedup."""
from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import observation_ledger as OL


def _row(
    source_ref: str,
    digest: str,
    outcomes: list[str],
    *,
    observed_at: str = "2026-09-14T12:00:00Z",
    writes: list[str] | None = None,
) -> OL.ObservationRow:
    resolutions = [
        OL.Resolution(slug=f"slug-{i}", kind="client", method="contact-email", outcome=o)
        for i, o in enumerate(outcomes)
    ]
    return OL.ObservationRow(
        source_ref=source_ref,
        thread_id="thread-1",
        content_digest=digest,
        observed_at=observed_at,
        resolutions=resolutions,
        writes=writes or [],
    )


def test_content_digest_is_stable_sha256_hex() -> None:
    d1 = OL.content_digest("Subject", "Body text", "a@example.com")
    d2 = OL.content_digest("Subject", "Body text", "a@example.com")
    d3 = OL.content_digest("Subject", "Different body", "a@example.com")
    assert d1 == d2
    assert d1 != d3
    assert len(d1) == 64
    int(d1, 16)  # hex


def test_append_and_latest_round_trip(tmp_path) -> None:
    # G-LEDGER-1
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    row = _row("gmail:m1", "digest-a", ["filed"])
    ledger.append(row)

    got = ledger.latest("gmail:m1")
    assert got is not None
    assert got.source_ref == "gmail:m1"
    assert got.content_digest == "digest-a"
    assert len(got.resolutions) == 1
    assert got.resolutions[0].outcome == "filed"
    assert got.resolutions[0].slug == "slug-0"

    assert ledger.latest("gmail:missing") is None
    assert not any(p.name.startswith(".tmp-") for p in tmp_path.iterdir())


def test_latest_returns_the_last_row_for_a_source_ref(tmp_path) -> None:
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["escalated"]))
    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    got = ledger.latest("gmail:m1")
    assert got.resolutions[0].outcome == "filed"


def test_is_terminal_true_only_when_latest_row_same_digest_all_filed(tmp_path) -> None:
    # G-LEDGER-2
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["filed", "escalated"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is False

    ledger.append(_row("gmail:m1", "digest-a", ["filed", "filed"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is True

    assert ledger.is_terminal("gmail:m1", "digest-stale") is False
    assert ledger.is_terminal("gmail:nope", "digest-a") is False


def test_is_terminal_false_when_latest_row_has_a_different_digest(tmp_path) -> None:
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is True

    ledger.append(_row("gmail:m1", "digest-b", ["escalated"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is False
    assert ledger.is_terminal("gmail:m1", "digest-b") is False


def test_escalated_for_matches_latest_row_same_digest_only(tmp_path) -> None:
    # G-LEDGER-5
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["escalated"]))
    assert ledger.escalated_for("gmail:m1", "digest-a") is True
    assert ledger.escalated_for("gmail:m1", "digest-b") is False
    assert ledger.escalated_for("gmail:nope", "digest-a") is False

    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    assert ledger.escalated_for("gmail:m1", "digest-a") is False


def test_rows_since_filters_by_observed_at(tmp_path) -> None:
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "d1", ["filed"], observed_at="2026-09-10T00:00:00Z"))
    ledger.append(_row("gmail:m2", "d2", ["filed"], observed_at="2026-09-14T00:00:00Z"))
    rows = ledger.rows_since("2026-09-12T00:00:00Z")
    assert [r.source_ref for r in rows] == ["gmail:m2"]


def test_distinct_refs_counts_refs_not_rows(tmp_path) -> None:
    # G-LEDGER-3
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["escalated"]))
    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    ledger.append(_row("gmail:m2", "digest-c", ["filed"]))
    assert ledger.distinct_refs() == {"gmail:m1", "gmail:m2"}


def test_open_email_tasks_parses_task_writes_entries(tmp_path) -> None:
    # G-LEDGER-4 / C4 / G0B-8 (ledger part)
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(
        _row(
            "gmail:m1",
            "digest-a",
            ["filed"],
            writes=["task:t-1|Send Alloi the tacticals doc", "crm:contact-9"],
        )
    )
    ledger.append(
        _row(
            "gmail:m2",
            "digest-b",
            ["filed"],
            writes=["task:t-2|Follow up with Marcos"],
        )
    )
    tasks = ledger.open_email_tasks()
    assert tasks == [
        {"id": "t-1", "title": "Send Alloi the tacticals doc", "source_ref": "gmail:m1"},
        {"id": "t-2", "title": "Follow up with Marcos", "source_ref": "gmail:m2"},
    ]
