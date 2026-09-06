"""FR-004 adapt: stable commitmentId, email attendees, owner_identity, deadlines."""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _payloads(dir_path: Path, *, owner_name: str = "Josh Weiss", side: str = "ours") -> None:
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": "abc12345zzzz"},
        "title": "Tacticals sync",
        "occurred_at": "2026-09-04T17:00:00Z",
        "participants": [
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Marcos",
                "email": "marcos@alloi.us",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        "text_units": [{"i": 0, "speaker": "Josh", "text": "ship it", "ts": 0}],
    }
    (dir_path / "source.json").write_text(json.dumps(source), encoding="utf-8")
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%d")
    validated = {
        "schema": "brain.extraction/1",
        "commitments": [
            {
                "text": "Ship dry-run",
                "owner_participant": 0 if side == "ours" else 1,
                "owner_name": owner_name,
                "deadline_iso": tomorrow,
                "quote": "ship it",
            }
        ],
        "decisions": [{"text": "Keep cadence", "quote": "ship it"}],
        "summary": {"overview": "Scoped tacticals.", "bullets": []},
        "classification": {"org_name": "Alloi", "domain": "alloi.us", "relationship": "client", "confidence": 0.9, "evidence": "x"},
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
        "dropped": {"decisions": 0, "commitments": 0, "promotion": False},
    }
    (dir_path / "validated.json").write_text(json.dumps(validated), encoding="utf-8")
    (dir_path / "resolution.json").write_text(
        json.dumps(
            {
                "home_path": "projects/alloi-03.md",
                "node": "alloi-03",
                "rule": 2,
                "created": None,
                "relationship": "client",
                "confidence": 1.0,
                "kind": "client",
                "counterparty_slug": "alloi",
                "corroborated": True,
                "also_present": [],
                "dropped": validated["dropped"],
                "deal_state": "won",
                "meeting_type": "delivery",
            }
        ),
        encoding="utf-8",
    )


def test_stable_ids_and_email_attendees(tmp_path) -> None:
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    assert main(["--source", str(src)]) == 0
    first = {p: (src / p).read_bytes() for p in ("writeback-payload.json", "recap-payload.json", "event.json", "fanout-meeting.json")}
    assert main(["--source", str(src)]) == 0
    second = {p: (src / p).read_bytes() for p in first}
    assert first == second
    event = json.loads(first["event.json"])
    assert event["attendees"] == ["marcos@alloi.us"]
    assert event["meeting_type"] == "delivery"
    wb = json.loads(first["writeback-payload.json"])
    cid = wb["meetings"][0]["commitment_ids"][0]
    assert len(cid) == 16
    assert all(c in "0123456789abcdef" for c in cid)
    recap = json.loads(first["recap-payload.json"])
    assert recap["meetings"][0]["attendees"] == ["josh@clearworks.ai", "marcos@alloi.us"]
    fan = json.loads(first["fanout-meeting.json"])
    step = fan["meetings"][0]["next_steps"][0]
    assert step["owner_identity"] == "pa-codex"
    assert step["direction"] == "internal"
    assert wb["meetings"][0]["resolution"]["counterparty"] == "alloi"


def test_owner_identity_regex_exits_12() -> None:
    from adapt_meeting import require_owner_identity
    import pytest

    require_owner_identity("pa-codex")
    with pytest.raises(SystemExit) as exc:
        require_owner_identity("Not Valid")
    assert exc.value.code == 12


def test_occurred_at_epoch_ms_string_converted(tmp_path) -> None:
    from adapt_meeting import main
    from fetch_fireflies import _iso_from_fireflies_date

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    source = json.loads((src / "source.json").read_text(encoding="utf-8"))
    ms = 1788548400000
    source["occurred_at"] = str(ms)
    (src / "source.json").write_text(json.dumps(source), encoding="utf-8")
    assert main(["--source", str(src)]) == 0
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    expected = _iso_from_fireflies_date(str(ms))
    assert wb["meetings"][0]["date"] == expected
    assert wb["meetings"][0]["date"].startswith("2026-09-0")


def test_event_meeting_type_always_delivery_writeback_keeps_validated(tmp_path) -> None:
    """D-08: meeting_type is recorded in resolution.json + the meeting note only —
    never written to event.json, which feeds meeting-crm-sync and must never let
    a sales-type meeting touch pipeline.json (FR-004 G-31). The WRITEBACK payload
    is allowed to carry the real validated meeting_type."""
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    validated = json.loads((src / "validated.json").read_text(encoding="utf-8"))
    validated["meeting_type"] = "sales"
    (src / "validated.json").write_text(json.dumps(validated), encoding="utf-8")
    assert main(["--source", str(src)]) == 0
    event = json.loads((src / "event.json").read_text(encoding="utf-8"))
    assert event["meeting_type"] == "delivery"
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    assert wb["meetings"][0]["meeting_type"] == "sales"


def test_deal_state_copied_to_writeback(tmp_path) -> None:
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    assert main(["--source", str(src)]) == 0
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    assert wb["meetings"][0]["deal_state"] == "won"


def test_missing_validated_exits_12(tmp_path) -> None:
    """FR-012 exit-code table: FR-004 (adapt_meeting.py) failures exit 12."""
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    (src / "validated.json").unlink()
    assert main(["--source", str(src)]) == 12


def test_enabled_agent_owner_gets_own_identity(tmp_path, monkeypatch) -> None:
    """D-17/FR-004: an OURS commitment owned by an enabled fleet agent gets
    owner_identity == that exact enabled name (not pa-codex), label 'owner: <name>'."""
    from adapt_meeting import main

    roster = tmp_path / "enabled-agents.json"
    roster.write_text(json.dumps({"larry": {"enabled": True}}), encoding="utf-8")
    monkeypatch.setenv("BRAIN_ENABLED_AGENTS_JSON", str(roster))

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src, owner_name="Larry", side="ours")
    source = json.loads((src / "source.json").read_text(encoding="utf-8"))
    source["participants"][0] = {
        "name": "Larry",
        "email": None,
        "side": "ours",
        "spoke": True,
        "notetaker": False,
        "handle": None,
    }
    (src / "source.json").write_text(json.dumps(source), encoding="utf-8")

    assert main(["--source", str(src)]) == 0
    fan = json.loads((src / "fanout-meeting.json").read_text(encoding="utf-8"))
    step = fan["meetings"][0]["next_steps"][0]
    assert step["owner_identity"] == "larry"
    assert step["owner_label"] == "owner: Larry"


def test_roster_missing_josh_still_pa_codex(tmp_path, monkeypatch) -> None:
    from adapt_meeting import main

    monkeypatch.setenv("BRAIN_ENABLED_AGENTS_JSON", str(tmp_path / "nope.json"))
    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    assert main(["--source", str(src)]) == 0
    fan = json.loads((src / "fanout-meeting.json").read_text(encoding="utf-8"))
    step = fan["meetings"][0]["next_steps"][0]
    assert step["owner_identity"] == "pa-codex"
    assert step["owner_label"] == "owner: Josh"


def test_ours_steps_carry_commitment_id(tmp_path) -> None:
    # G0a F-8: the earlier draft of this test invented three fixture-builder
    # helpers (_source_fixture/_validated_fixture/_resolution_fixture) that
    # do not exist in this file. The only helper this module defines is
    # `_payloads(dir_path, *, owner_name="Josh Weiss", side="ours")`, which
    # WRITES source.json/validated.json/resolution.json into a directory
    # (see the top of this file) — use it the same way every other test here
    # does, then drive the real CLI seam (`adapt_meeting.main`).
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src, side="ours")
    assert main(["--source", str(src)]) == 0
    fan = json.loads((src / "fanout-meeting.json").read_text(encoding="utf-8"))
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    ours_steps = fan["meetings"][0]["next_steps"]
    assert len(ours_steps) == 1
    assert ours_steps[0]["commitmentId"] == wb["meetings"][0]["commitment_ids"][0]


def test_meeting_core_carries_source_kind_and_id(tmp_path) -> None:
    # G0b C2-2 (D-16 spec line 59 / FR-005 line 192): meeting_writeback.py's
    # apply_resolution() (Task 2) derives its idempotency key from the
    # payload's own source{kind,id} — never a hardcoded "fireflies:"
    # literal — so the adapter must actually emit it on the
    # writeback-payload.json meeting item. Spec v1.5's payload contract
    # (line 176) doesn't yet list `source` there; noted in Open Questions
    # for a v1.6 patch.
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src, side="ours")
    assert main(["--source", str(src)]) == 0
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    assert wb["meetings"][0]["source"] == {"kind": "fireflies", "id": "abc12345zzzz"}


def test_deadline_floor_null(tmp_path) -> None:
    from adapt_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _payloads(src)
    validated = json.loads((src / "validated.json").read_text(encoding="utf-8"))
    validated["commitments"][0]["deadline_iso"] = "2020-01-01"
    (src / "validated.json").write_text(json.dumps(validated), encoding="utf-8")
    assert main(["--source", str(src)]) == 0
    fan = json.loads((src / "fanout-meeting.json").read_text(encoding="utf-8"))
    assert fan["meetings"][0]["next_steps"][0].get("deadline") in (None, "")
    wb = json.loads((src / "writeback-payload.json").read_text(encoding="utf-8"))
    item = wb["meetings"][0]["open_items"][0]
    assert item["status"] == "open"
