from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

WB_PATH = (
    Path(__file__).resolve().parents[3]
    / "orgs/clearworksai/agents/pa/scripts/meeting_writeback.py"
)
SPEC = importlib.util.spec_from_file_location("meeting_writeback_apply", WB_PATH)
assert SPEC and SPEC.loader
WB = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WB
SPEC.loader.exec_module(WB)


def _payload() -> dict:
    return {
        "meetings": [
            {
                "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA",
                # G0b C2-2 (D-16 spec line 59 / FR-005 line 192): writeback
                # is source-agnostic — apply_resolution() derives its
                # idempotency key from this field, never a hardcoded
                # "fireflies:" literal. adapt_meeting.py emits it (Task 6).
                "source": {"kind": "fireflies", "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA"},
                "title": "Tacticals sync",
                "date": "2026-09-04T17:00:00Z",
                "summary": {"overview": "Scoped tactical reports."},
                "decisions": ["Keep weekly cadence"],
                "resolution": {
                    "home_path": "projects/alloi-03.md",
                    "node": "alloi-03",
                    "rule": 2,
                    "created": None,
                },
                "open_items": [
                    {
                        "item": "Ship apply",
                        "owner": "Josh",
                        "deadline": "2026-09-08",
                        "source": "commitment:abc",
                        "status": "open",
                    }
                ],
            }
        ]
    }


def test_apply_writes_home_and_note_atomically_and_is_idempotent(tmp_path):
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "projects").mkdir(parents=True)
    home = brain / "projects" / "alloi-03.md"
    home.write_text(
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\n\n"
        "## Current state\n\nSome untouched prose.\n\n"
        "## History (dated, newest first)\n\n- 2026-08-01 — old entry\n\n"
        "## Open Items\n\n| Item | Owner | Deadline | Source | Status |\n|---|---|---|---|---|\n",
        encoding="utf-8",
    )
    ledger = tmp_path / "ledger.txt"

    result1 = WB.apply_resolution(_payload(), org_root=vault, ledger_path=ledger)
    text_after_1 = home.read_text(encoding="utf-8")
    assert "Some untouched prose." in text_after_1
    assert "[source: fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA]" in text_after_1
    assert "Ship apply" in text_after_1
    assert str(home) in result1["written"]
    assert ledger.read_text(encoding="utf-8").strip() == "fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA"
    # G0b C2-1 (D-15 spec line 58 / FR-005 line 192): the ledger append is
    # temp + os.replace (atomic_write), never a bare open("a") — assert no
    # .tmp-* residue is left in the ledger's directory after a successful
    # write.
    assert not any(p.name.startswith(".tmp-") for p in ledger.parent.iterdir())

    result2 = WB.apply_resolution(_payload(), org_root=vault, ledger_path=ledger)
    assert home.read_text(encoding="utf-8") == text_after_1
    assert result2["written"] == []
    assert str(home) in result2["skipped"]
    assert ledger.read_text(encoding="utf-8").strip() == "fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA"


def test_apply_ledger_key_derives_from_payload_source_not_a_literal(tmp_path):
    # G0b C2-2 (D-16 spec line 59): the idempotency key must come from the
    # payload's own source{kind,id} — proven by using a DIFFERENT id for the
    # meeting's top-level "id" (recap/CRM identity) vs its source.id (the
    # writeback ledger/History-citation identity), which a hardcoded
    # f"fireflies:{mid}" literal (built off meeting["id"]) could never
    # produce correctly.
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "projects").mkdir(parents=True)
    home = brain / "projects" / "alloi-03.md"
    home.write_text(
        "## Node\nid: alloi-03\n\n## History (dated, newest first)\n\n- old\n\n## Open Items\n\n",
        encoding="utf-8",
    )
    payload = {
        "meetings": [
            {
                "id": "recap-identity-only",
                "source": {"kind": "gmail", "id": "thread-999"},
                "title": "Email thread",
                "date": "2026-09-04T17:00:00Z",
                "summary": {},
                "decisions": [],
                "resolution": {"home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2, "created": None},
                "open_items": [],
            }
        ]
    }
    ledger = tmp_path / "ledger.txt"
    WB.apply_resolution(payload, org_root=vault, ledger_path=ledger)
    assert ledger.read_text(encoding="utf-8").strip() == "gmail:thread-999"
    assert "[source: gmail:thread-999]" in home.read_text(encoding="utf-8")


def test_apply_created_page_conflict_exits_7(tmp_path):
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs").mkdir(parents=True)
    collide = brain / "orgs" / "newco-fixture.md"
    collide.write_text("# NewCo Fixture\n\nunrelated existing page, no our marker here\n", encoding="utf-8")
    payload = {
        "meetings": [
            {
                "id": "OTHERMEETINGID0000000000000",
                "source": {"kind": "fireflies", "id": "OTHERMEETINGID0000000000000"},
                "title": "Intro call",
                "date": "2026-09-04T17:00:00Z",
                "summary": {},
                "decisions": [],
                "resolution": {
                    "home_path": "orgs/newco-fixture.md",
                    "node": None,
                    "created": {"kind": "org", "slug": "newco-fixture", "relationship": "prospect"},
                },
                "open_items": [],
            }
        ]
    }
    try:
        WB.apply_resolution(payload, org_root=vault, ledger_path=tmp_path / "ledger.txt")
        assert False, "expected SystemExit(7)"
    except SystemExit as exc:
        assert exc.code == 7


def test_apply_promotion_changes_delivery_state_once(tmp_path):
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "projects").mkdir(parents=True)
    home = brain / "projects" / "alloi-03.md"
    home.write_text(
        "## Node\nid: alloi-03\ndelivery_state: active\n\n"
        "## History (dated, newest first)\n\n- old\n\n## Open Items\n\n",
        encoding="utf-8",
    )
    payload = {
        "meetings": [
            {
                "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA",
                "source": {"kind": "fireflies", "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA"},
                "title": "Delivery review",
                "date": "2026-09-04T17:00:00Z",
                "summary": {"overview": "Delivered the report."},
                "decisions": ["Signed off on delivery"],
                "resolution": {"home_path": "projects/alloi-03.md", "node": "alloi-03", "rule": 2, "created": None},
                "promotion": {"state": "delivered", "quote": "Signed off on delivery"},
                "open_items": [],
            }
        ]
    }
    WB.apply_resolution(payload, org_root=vault, ledger_path=tmp_path / "ledger.txt")
    text = home.read_text(encoding="utf-8")
    assert "delivery_state: delivered" in text
    assert "[source: fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA]" in text
