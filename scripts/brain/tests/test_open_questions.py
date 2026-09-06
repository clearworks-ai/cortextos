"""Josh's R3 add: open_questions, quote-gated exactly like decisions (D-08),
optional/absent-tolerant unlike decisions (old extraction.json files, incl.
the applied Alloi meeting's, carry no open_questions key at all)."""
from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

SOURCE = {
    "schema": "brain.source/1",
    "source": {"kind": "fireflies", "id": "abc12345zzzz"},
    "title": "Tacticals sync",
    "occurred_at": "2026-09-04T17:00:00Z",
    "participants": [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
    ],
    "text_units": [{"i": 0, "speaker": "Josh", "text": "Should we bill Alloi monthly or quarterly?", "ts": 0}],
}


def _base_extraction(**extra: object) -> dict:
    return {
        "schema": "brain.extraction/1",
        "inputSha": "x",
        "promptSha": "x",
        "model": "sonnet",
        "cost_usd": 0.0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {"org_name": "Alloi", "domain": "alloi.us", "relationship": "client", "confidence": 0.9, "evidence": "x"},
        "summary": {"overview": "x", "bullets": []},
        "decisions": [],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": None,
        "meeting_type": "delivery",
        **extra,
    }


def test_validate_extraction_accepts_missing_open_questions() -> None:
    from extract_meeting import validate_extraction

    validate_extraction(_base_extraction())  # no KeyError / ValueError


def test_validate_extraction_accepts_grounded_open_question() -> None:
    from extract_meeting import validate_extraction

    obj = _base_extraction(
        open_questions=[{"text": "Billing cadence", "quote": "bill Alloi monthly or quarterly", "owner": "Marcos"}]
    )
    validate_extraction(obj)  # no error


def test_validate_extraction_rejects_unknown_open_question_key() -> None:
    import pytest
    from extract_meeting import validate_extraction

    obj = _base_extraction(open_questions=[{"text": "x", "quote": "x", "bogus": "x"}])
    with pytest.raises(ValueError):
        validate_extraction(obj)


def test_quote_gate_drops_ungrounded_open_question() -> None:
    from resolve_meeting import quote_gate

    extraction = _base_extraction(
        open_questions=[
            {"text": "Billing cadence", "quote": "bill Alloi monthly or quarterly"},
            {"text": "Fabricated", "quote": "this text is not in the transcript"},
        ]
    )
    validated = quote_gate(extraction, SOURCE)
    assert len(validated["open_questions"]) == 1
    assert validated["open_questions"][0]["text"] == "Billing cadence"
    assert validated["dropped"]["open_questions"] == 1


def test_quote_gate_open_questions_absent_defaults_empty() -> None:
    from resolve_meeting import quote_gate

    validated = quote_gate(_base_extraction(), SOURCE)
    assert validated["open_questions"] == []
    assert validated["dropped"]["open_questions"] == 0


def test_adapt_meeting_core_carries_open_question_text() -> None:
    from datetime import datetime, timezone

    from adapt_meeting import adapt

    validated = {
        "commitments": [],
        "decisions": [],
        "open_questions": [{"text": "Billing cadence", "quote": "x", "owner": "Marcos"}],
        "summary": {"overview": "x", "bullets": []},
        "classification": {"org_name": "Alloi"},
        "meeting_type": "delivery",
        "deal_state": None,
        "proposed_delivery_state": None,
    }
    resolution = {"home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2, "created": None, "relationship": "client", "confidence": 1.0, "counterparty_slug": "alloi"}
    files = adapt(SOURCE, validated, resolution, datetime(2026, 9, 5, tzinfo=timezone.utc))
    meeting = files["writeback-payload.json"]["meetings"][0]
    assert meeting["open_questions"] == ["Billing cadence"]
    assert files["recap-payload.json"]["meetings"][0]["open_questions"] == ["Billing cadence"]


def test_history_block_open_questions_line_only_when_nonempty() -> None:
    from writeback_render import _history_block

    with_oq = {"title": "t", "date": "2026-09-04", "id": "m1", "summary": {}, "decisions": [], "open_items": [], "open_questions": ["Billing cadence"]}
    without_oq = dict(with_oq, open_questions=[])
    lines_with = _history_block(with_oq)
    lines_without = _history_block(without_oq)
    assert any(ln.startswith("  - Open questions:") for ln in lines_with)
    assert not any(ln.startswith("  - Open questions:") for ln in lines_without)
    assert "Billing cadence" in lines_with[-1]


def test_render_meeting_note_open_questions_section() -> None:
    from writeback_render import render_meeting_note

    meeting = {
        "id": "m1", "date": "2026-09-04", "title": "t", "client_context": "alloi",
        "resolution": {"node": "alloi-03", "rule": 2}, "summary": {"overview": "x"},
        "open_questions": ["Billing cadence"],
    }
    note = render_meeting_note(meeting)
    assert "## Open questions" in note
    assert "- Billing cadence" in note

    meeting_empty = dict(meeting, open_questions=[])
    note_empty = render_meeting_note(meeting_empty)
    assert "## Open questions" not in note_empty


def test_recap_build_open_questions_block() -> None:
    import importlib.util

    path = Path(__file__).resolve().parents[3] / "orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py"
    spec = importlib.util.spec_from_file_location("meeting_recap_draft_oq", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    meeting = {"title": "t", "date": "2026-09-04", "client_context": "alloi", "summary": {}, "next_steps": [], "open_questions": ["Billing cadence"], "id": "m1"}
    body = mod.build_body(meeting, "")
    assert "Open questions:" in body
    assert "1. Billing cadence" in body

    body_empty = mod.build_body(dict(meeting, open_questions=[]), "")
    assert "Open questions:" not in body_empty
