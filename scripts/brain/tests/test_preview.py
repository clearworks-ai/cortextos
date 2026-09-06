from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

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
            # Finding 2 (D-09 review): the description must be byte-identical
            # to what meeting-fanout.py's create_task call would actually
            # receive, including the trailing `[commitment:<meeting_id>/<id>]`
            # marker (previously omitted here).
            "description": (
                "owner: Josh · From meeting fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA · "
                "Send the tactical report draft · due 2026-09-08 · "
                "[commitment:01M1MW2GAZ1DQ0C6PG3KJ557JA/abc123]"
            ),
        }
    ]


def test_bus_task_preview_never_synthesizes_owner_label() -> None:
    # Finding 2: fanout's Commitment.owner_label is empty (never
    # synthesized) when the step carries none, and the desc-building block
    # branches to a DIFFERENT format with no owner text at all. Preview must
    # match, not invent "owner: Unassigned".
    from preview import bus_task_preview

    fanout = {
        "meetings": [
            {
                "next_steps": [
                    {
                        "commitmentId": "no-owner-1",
                        "text": "Draft contract terms",
                        "owner_identity": "",
                    },
                ]
            }
        ]
    }
    rows = bus_task_preview(fanout, set(), meeting_id="MID")
    assert rows == [
        {
            "commitmentId": "no-owner-1",
            "title": "Draft contract terms",
            "owner_identity": "",
            "owner_label": "",
            "due": None,
            "description": "From meeting MID · [commitment:MID/no-owner-1]",
        }
    ]


def test_bus_task_preview_falls_back_to_action_when_text_missing() -> None:
    # Finding 2: meeting-fanout.py's Commitment.text is
    # `_s(step.get("text")) or _s(step.get("action"))` — preview must use
    # the same fallback so title/description match what fanout would use.
    from preview import bus_task_preview

    fanout = {
        "meetings": [
            {
                "next_steps": [
                    {
                        "commitmentId": "c-action",
                        "action": "Send the follow-up deck",
                        "owner_identity": "sam@example.com",
                        "owner_label": "owner: Sam",
                        "deadline": "2026-09-10",
                    },
                ]
            }
        ]
    }
    rows = bus_task_preview(fanout, set(), meeting_id="MID")
    assert rows[0]["title"] == "Send the follow-up deck"
    assert rows[0]["description"] == (
        "owner: Sam · From meeting fireflies:MID · Send the follow-up deck · "
        "due 2026-09-10 · [commitment:MID/c-action]"
    )


def test_crm_interaction_preview_drops_name_only_attendees_via_fanout_fallback() -> None:
    # F-1 FINAL review: event.json carries no attendees (edge case / legacy
    # payload), so the preview falls back to fanout-meeting.json's attendees
    # — which FR-004 fills with bare NAME strings (no email) for email-less
    # speakers. Those must never turn into a preview row.
    from preview import crm_interaction_preview

    event = {"meeting_id": "MID", "attendees": []}
    validated = {"summary": {"overview": "ov"}, "deal_state": None}
    resolution = {"deal_state": None}
    fanout = {
        "meetings": [
            {
                "id": "MID",
                "attendees": [
                    "marcos@alloi.us", "sam@alloi.us", "pat@alloi.us",
                    "kim@alloi.us", "lee@alloi.us", "ray@alloi.us",
                    "Ivette Ramos", "Joseph Chang", "Molly",
                ],
            }
        ]
    }
    rows = crm_interaction_preview(event, validated, resolution, fanout)
    assert len(rows) == 6
    assert {r["contact"] for r in rows} == {
        "marcos@alloi.us", "sam@alloi.us", "pat@alloi.us",
        "kim@alloi.us", "lee@alloi.us", "ray@alloi.us",
    }


def _load_meeting_crm_sync_module():
    """importlib load of meeting-crm-sync.py (hyphenated filename, can't
    `import`), same pattern as `_load_meeting_fanout_module` below — used to
    prove preview.py's `crm_interaction_preview` produces exactly the rows
    the REAL apply path (`external_attendees` / `upsert_contacts` /
    `append_interactions`) would write, via the shared `crm_attendees`
    derivation (F-1 FINAL review)."""
    import importlib.util

    code_root = BRAIN.parent.parent
    path = code_root / "orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py"
    spec = importlib.util.spec_from_file_location("brain_test_meeting_crm_sync", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_crm_interaction_preview_matches_real_meeting_crm_sync_module() -> None:
    """6 emailed attendees + 3 name-only (FR-004 fills bare names for
    email-less speakers) -> preview shows exactly 6 rows AND those 6 contacts
    are byte-identical to what the REAL meeting-crm-sync.py module's
    `external_attendees`/`upsert_contacts`/`append_interactions` would
    upsert and log — proving no --full-file apply/preview drift (F-1)."""
    module = _load_meeting_crm_sync_module()

    event = {"meeting_id": "MID", "attendees": []}
    full_meeting = {
        "id": "MID",
        "attendees": [
            "marcos@alloi.us", "sam@alloi.us", "pat@alloi.us",
            "kim@alloi.us", "lee@alloi.us", "ray@alloi.us",
            "Ivette Ramos", "Joseph Chang", "Molly",
        ],
    }
    fanout = {"meetings": [full_meeting]}

    real_attendees = module.external_attendees(event, full_meeting)
    real_contact_ids = {a["email"] for a in real_attendees}
    assert len(real_attendees) == 6  # the real module also drops the 3 name-only entries

    from preview import crm_interaction_preview

    validated = {"summary": {"overview": "ov"}, "deal_state": None}
    resolution = {"deal_state": None}
    preview_rows = crm_interaction_preview(event, validated, resolution, fanout)

    assert len(preview_rows) == 6
    assert {row["contact"] for row in preview_rows} == real_contact_ids


def _load_meeting_fanout_module():
    """importlib load of meeting-fanout.py (hyphenated filename, can't
    `import`): meeting-fanout.py is read-only for this fix (D-09 review
    scope names it explicitly), and its per-commitment description string is
    built inline inside `fanout()`'s loop — interleaved with dedup/
    create_task/create_approval side effects — not a standalone function
    that could be imported and called directly without executing those.
    Deviation (documented per the D-09 review instructions, since the file
    cannot be edited to extract one): preview._fanout_task_description
    replicates that inline block instead of calling into meeting-fanout.py.
    This loader + the parity test below is how that replication is pinned —
    any future drift between the two makes the signed dry-run preview a lie
    about the task actually created, and this test fails loudly."""
    import importlib.util

    code_root = BRAIN.parent.parent
    path = code_root / "orgs/clearworksai/agents/crm/crm/meeting-fanout.py"
    spec = importlib.util.spec_from_file_location("brain_test_meeting_fanout", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # meeting-fanout.py uses `from __future__ import annotations` (string
    # annotations) on its @dataclass Deps/Commitment/FanoutResult classes —
    # dataclasses resolves those via sys.modules[cls.__module__], so the
    # module must be registered there BEFORE exec_module runs the class
    # bodies, or dataclass() crashes with "NoneType has no attribute
    # __dict__" trying to look itself up.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_preview_description_matches_real_meeting_fanout_module() -> None:
    """D-09 review finding 2, deviation test: run the REAL meeting-fanout.py
    module's fanout() (via importlib, fake Deps, no subprocess/network) over
    3 commitments — one with an owner_label + deadline, one with neither an
    owner_label nor an action fallback but a deadline, and one with no
    owner_label and no deadline (the no-owner-label case) — and assert
    preview.bus_task_preview's `description` for each is byte-identical to
    the `desc` fanout actually passed to create_task."""
    module = _load_meeting_fanout_module()

    meeting_id = "MID"
    next_steps = [
        {
            "commitmentId": "c1",
            "text": "Send proposal",
            "owner_identity": "sam@example.com",
            "owner_label": "owner: Sam",
            "deadline": "2026-09-10",
        },
        {
            "commitmentId": "c2",
            "text": "Follow up with legal",
            "owner_identity": "pa-codex",
            "deadline": "2026-09-12",
        },
        {
            "commitmentId": "c3",
            "text": "Draft contract terms",
            "owner_identity": "",
        },
    ]
    full_payload = {"meetings": [{"id": meeting_id, "next_steps": next_steps}]}

    created: list[dict[str, Any]] = []

    def fake_create_task(*, title, assignee, needs_approval=False, desc=None, due=None):
        created.append({"title": title, "desc": desc})
        return f"task-{len(created)}"

    deps = module.Deps(
        load_full=lambda _mid: full_payload,
        create_task=fake_create_task,
        create_approval=lambda **_kw: "",
        post_briefs=lambda _payload: True,
        add_followup=lambda **_kw: "",
        send_telegram=lambda *_a: None,
        dedup_surface=lambda _key: True,
    )
    result = module.fanout(
        meeting_id=meeting_id, event_file=None, deps=deps, dry_run=False, strict=False,
    )
    assert len(created) == 3

    from preview import bus_task_preview

    preview_rows = bus_task_preview(full_payload, set(), meeting_id=meeting_id)
    assert len(preview_rows) == 3
    for fanout_call, preview_row in zip(created, preview_rows):
        assert preview_row["description"] == fanout_call["desc"]
        assert preview_row["title"] == fanout_call["title"]
