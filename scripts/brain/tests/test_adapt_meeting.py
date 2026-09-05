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
