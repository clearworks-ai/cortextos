"""FR-001 observation ledger: round-trip, terminal predicate, escalation dedup.
FR-002 run receipt (success + failure paths) + gap detection."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
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


def test_is_terminal_false_for_a_partial_row_even_when_every_resolution_is_filed(tmp_path) -> None:
    """G-LEDGER-7, isolated. The all-filed check (G-LEDGER-2) and the partial
    check normally fire together, because a row that died part-way also carries
    a `partial` resolution. This pins the partial check ON ITS OWN: a row whose
    resolutions are ALL `filed` but which is flagged `partial` is still not
    terminal, so the next run finishes the remainder instead of skipping the
    message. Without it, only the coincidence of the two conditions protects
    the retry."""
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    row = _row("gmail:m1", "digest-a", ["filed", "filed"])
    row.partial = True
    ledger.append(row)
    assert ledger.is_terminal("gmail:m1", "digest-a") is False

    row_done = _row("gmail:m1", "digest-a", ["filed", "filed"])
    ledger.append(row_done)
    assert ledger.is_terminal("gmail:m1", "digest-a") is True


def test_is_terminal_false_when_latest_row_has_a_different_digest(tmp_path) -> None:
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is True

    ledger.append(_row("gmail:m1", "digest-b", ["escalated"]))
    assert ledger.is_terminal("gmail:m1", "digest-a") is False
    assert ledger.is_terminal("gmail:m1", "digest-b") is False


def test_escalated_for_is_monotonic_across_every_row_for_the_pair(tmp_path) -> None:
    """G-LEDGER-5 / G2B-5: escalate-once is MONOTONIC. Once a real run has
    delivered the alert for a (source_ref, digest), a later ignored or filed row
    for that same pair must not make the system forget it and send a second
    one -- so the search covers the WHOLE history for the pair, never just the
    latest row."""
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    ledger.append(_row("gmail:m1", "digest-a", ["escalated"]))
    assert ledger.escalated_for("gmail:m1", "digest-a") is True
    assert ledger.escalated_for("gmail:m1", "digest-b") is False
    assert ledger.escalated_for("gmail:nope", "digest-a") is False

    ledger.append(_row("gmail:m1", "digest-a", ["ignored"]))
    assert ledger.escalated_for("gmail:m1", "digest-a") is True
    ledger.append(_row("gmail:m1", "digest-a", ["filed"]))
    assert ledger.escalated_for("gmail:m1", "digest-a") is True
    # a DIFFERENT digest (edited message) is a fresh alert, never suppressed
    assert ledger.escalated_for("gmail:m1", "digest-b") is False


def test_escalated_for_ignores_simulated_rows_anywhere_in_history(tmp_path) -> None:
    path = tmp_path / "observations.jsonl"
    ledger = OL.Ledger(path)
    sim = _row("gmail:m1", "digest-a", ["escalated"])
    sim.simulated = True
    ledger.append(sim)
    ledger.append(_row("gmail:m1", "digest-a", ["ignored"]))
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


def test_write_and_read_receipt_round_trip(tmp_path) -> None:
    state_dir = tmp_path / "state"
    receipt = {
        "last_success_at": "2026-09-14T12:00:00+00:00",
        "window_days": 3,
        "message_count": 7,
        "truncation": [],
        "cost_usd": 0.42,
    }
    OL.write_receipt(state_dir, receipt)
    got = OL.read_receipt(state_dir)
    assert got == receipt
    assert not any(p.name.startswith(".tmp-") for p in state_dir.iterdir())


def test_read_receipt_returns_none_when_missing(tmp_path) -> None:
    assert OL.read_receipt(tmp_path / "state") is None


def test_record_failure_preserves_previous_last_success_at(tmp_path) -> None:
    # G-RECEIPT-1
    state_dir = tmp_path / "state"
    OL.write_receipt(
        state_dir,
        {
            "last_success_at": "2026-09-10T00:00:00+00:00",
            "window_days": 3,
            "message_count": 5,
            "truncation": [],
            "cost_usd": 0.10,
        },
    )
    OL.record_failure(state_dir, "gws timeout", message_count=0, cost_usd=0.0, truncation=[])
    got = OL.read_receipt(state_dir)
    assert got["last_success_at"] == "2026-09-10T00:00:00+00:00"
    assert got["error"] == "gws timeout"
    assert got["message_count"] == 0
    assert "failed_at" in got


def test_record_failure_with_no_previous_receipt_has_no_last_success_at(tmp_path) -> None:
    state_dir = tmp_path / "state"
    OL.record_failure(state_dir, "lock-held")
    got = OL.read_receipt(state_dir)
    assert got.get("last_success_at") is None
    assert got["error"] == "lock-held"


def test_gap_line_none_when_within_window() -> None:
    receipt = {"last_success_at": "2026-09-13T00:00:00+00:00", "window_days": 3}
    now = datetime(2026, 9, 14, 0, 0, 0, tzinfo=timezone.utc)
    assert OL.gap_line(receipt, 3, now) is None


def test_gap_line_none_when_receipt_missing_or_no_last_success() -> None:
    now = datetime(2026, 9, 14, 0, 0, 0, tzinfo=timezone.utc)
    assert OL.gap_line(None, 3, now) is None
    assert OL.gap_line({"window_days": 3}, 3, now) is None


def test_gap_line_names_days_n_repair_when_stale() -> None:
    # G-RECEIPT-2
    receipt = {"last_success_at": "2026-09-01T00:00:00+00:00", "window_days": 3}
    now = datetime(2026, 9, 14, 0, 0, 0, tzinfo=timezone.utc)
    line = OL.gap_line(receipt, 3, now)
    assert line is not None
    assert "--days 13" in line
    assert "2026-09-01T00:00:00+00:00" in line
