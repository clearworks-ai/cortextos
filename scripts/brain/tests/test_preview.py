from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_recap_recipients_are_josh_only() -> None:
    from preview import recap_recipients

    assert recap_recipients({}) == {"to": ["josh@clearworks.ai"], "cc": []}


def test_crm_interaction_preview_one_row_per_attendee() -> None:
    from preview import crm_interaction_preview

    event = {"meeting_id": "01M1MW2GAZ1DQ0C6PG3KJ557JA", "attendees": ["marcos@alloi.us", "sam@alloi.us"]}
    validated = {"summary": {"overview": "Scoped tactical reports."}, "deal_state": None}
    resolution = {"deal_state": None}
    rows = crm_interaction_preview(event, validated, resolution)
    assert rows == [
        {
            "contact": "marcos@alloi.us",
            "type": "meeting",
            "source_ref": "fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA",
            "sentiment": "neutral",
            "summary": "Scoped tactical reports.",
            "deal_state": None,
        },
        {
            "contact": "sam@alloi.us",
            "type": "meeting",
            "source_ref": "fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA",
            "sentiment": "neutral",
            "summary": "Scoped tactical reports.",
            "deal_state": None,
        },
    ]


def test_bus_task_preview_full_payload_minus_created_ids() -> None:
    from preview import bus_task_preview

    fanout = {
        "meetings": [
            {
                "next_steps": [
                    {
                        "commitmentId": "abc123",
                        "text": "Send the tactical report draft",
                        "owner_identity": "pa-codex",
                        "owner_label": "owner: Josh",
                        "deadline": "2026-09-08",
                    },
                    {
                        "commitmentId": "already-done",
                        "text": "Old one",
                        "owner_identity": "pa-codex",
                        "owner_label": "owner: Josh",
                        "deadline": None,
                    },
                ]
            }
        ]
    }
    rows = bus_task_preview(fanout, {"already-done"}, meeting_id="01M1MW2GAZ1DQ0C6PG3KJ557JA")
    assert rows == [
        {
            "commitmentId": "abc123",
            "title": "Send the tactical report draft",
            "owner_identity": "pa-codex",
            "owner_label": "owner: Josh",
            "due": "2026-09-08",
            "description": (
                "owner: Josh · From meeting fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA · "
                "Send the tactical report draft · due 2026-09-08"
            ),
        }
    ]
