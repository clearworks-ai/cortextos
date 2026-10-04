"""FR-006/FR-008 (C6/C8): CRM writes, owner_name-based task dedup/planning,
WriterError/TaskEnumerationError on any failed subprocess. G-CRM-1/G-DEDUP-1/
G-TASK-1."""
from __future__ import annotations

import difflib
import sys
from dataclasses import dataclass
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from helpers_client_state import FakeRunner

import client_state_writes as csw

CRM_DIR = Path("/fake/crm")


@dataclass
class _Msg:
    id: str


def test_ensure_contact_known_email_no_upsert_call():
    contacts = [{"id": "c1", "name": "Jane Doe", "emails": ["jane@example.com"]}]
    runner = FakeRunner()
    contact_id = csw.ensure_contact(runner, CRM_DIR, "Jane Doe", "Jane@Example.com", contacts)
    assert contact_id == "c1"
    assert runner.calls == []


def test_ensure_contact_unknown_email_argv_pinned():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "upsert-contact.py")), rc=0, stdout="c2\n")
    contact_id = csw.ensure_contact(runner, CRM_DIR, "Marcos Ruiz", "marcos@acme.com", [])
    assert contact_id == "c2"
    assert runner.calls == [[
        "python3", str(CRM_DIR / "upsert-contact.py"),
        "--name", "Marcos Ruiz", "--email", "marcos@acme.com", "--match-email", "--source-ref", "gmail:auto",
    ]]


def test_ensure_contact_raises_writer_error_on_nonzero_rc():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "upsert-contact.py")), rc=1, stdout="", stderr="boom")
    try:
        csw.ensure_contact(runner, CRM_DIR, "Marcos", "marcos@acme.com", [])
        assert False, "expected WriterError"
    except csw.WriterError as exc:
        assert "boom" in str(exc)


def test_ensure_contact_fallback_reloads_contacts_json(tmp_path):
    crm_dir = tmp_path
    (crm_dir / "contacts.json").write_text(
        '{"contacts": [{"id": "c-suppressed", "name": "Blocked", "emails": ["blocked@acme.com"]}]}',
        encoding="utf-8",
    )
    runner = FakeRunner()
    runner.record(("python3", str(crm_dir / "upsert-contact.py")), rc=0, stdout="", stderr="SUPPRESSED: not written")
    contact_id = csw.ensure_contact(runner, crm_dir, "Blocked", "blocked@acme.com", [])
    assert contact_id == "c-suppressed"


def test_write_interaction_argv_pinned():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0,
                   stdout='{"contact_id": "c1", "type": "email", "source_ref": "gmail:abc123"}')
    msg = _Msg(id="abc123")
    extraction = {"summary": "Discussed Q3 renewal",
                  "decisions": [{"text": "Go with tier 2"}, {"text": "Send updated MSA"}]}
    csw.write_interaction(runner, CRM_DIR, "c1", msg, extraction)
    assert runner.calls == [[
        "python3", str(CRM_DIR / "add-interaction.py"),
        "--contact-id", "c1", "--type", "email", "--summary", "Discussed Q3 renewal",
        "--source-ref", "gmail:abc123", "--decision", "Go with tier 2", "--decision", "Send updated MSA",
    ]]


def test_write_interaction_raises_writer_error_on_nonzero_rc():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=1, stdout="", stderr="disk full")
    msg = _Msg(id="m9")
    try:
        csw.write_interaction(runner, CRM_DIR, "c1", msg, {"summary": "x", "decisions": []})
        assert False, "expected WriterError"
    except csw.WriterError as exc:
        assert "disk full" in str(exc)


def test_write_interaction_raises_writer_error_on_unparsable_stdout():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0, stdout="not json")
    msg = _Msg(id="m9")
    try:
        csw.write_interaction(runner, CRM_DIR, "c1", msg, {"summary": "x", "decisions": []})
        assert False, "expected WriterError"
    except csw.WriterError:
        pass


@dataclass
class _ContextItem:
    id: int
    text: str
    owner: str
    source: str


def test_normalize_owner_aliases_and_passthrough():
    assert csw.normalize_owner("Josh") == "josh"
    assert csw.normalize_owner("josh weiss") == "josh"
    assert csw.normalize_owner("  ME  ") == "josh"
    assert csw.normalize_owner("Clearworks") == "josh"
    assert csw.normalize_owner("Marcos Ruiz") == "marcos ruiz"


def test_normalize_owner_maps_bus_human_and_user_identities_to_josh():
    """G0B2-10: this release creates its tasks with `--assignee human`, and
    `bus list-tasks` reports them back as assigned_to="human". Without the
    alias, a task we created last run can never suppress the identical
    commitment this run."""
    assert csw.normalize_owner("human") == "josh"     # G-OWNER-1
    assert csw.normalize_owner("User") == "josh"
    assert csw.normalize_owner("pa-codex") == "pa-codex"  # other agents stay distinct


def test_tier1_dedups_against_the_human_assigned_task_this_release_creates():
    """Round trip on the ACTUAL bus-shaped fields: create_task sends
    --assignee human, list_open_tasks reports assigned_to="human", and the
    identical Josh commitment next run must dedup against it (G0B2-10)."""
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    plan = csw.TaskPlan(title="Send updated MSA", owner="Josh", source_ref="gmail:m1", dedup=None)
    task_id = csw.create_task(runner, plan)
    assert runner.calls[0][runner.calls[0].index("--assignee") + 1] == "human"

    # What `bus list-tasks --format json` hands back for that very task.
    open_tasks = [{"id": task_id, "title": "Send updated MSA", "status": "pending", "assigned_to": "human"}]
    extraction = {"commitments": [
        {"text": "Send updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "q", "matches_open_item": None},
    ]}
    plans = csw.plan_tasks(extraction, [], open_tasks, "gmail:m2")
    assert plans[0].dedup == {"tier": 1, "match": "Send updated MSA"}  # G-OWNER-1


def test_write_interaction_rejects_json_that_is_not_an_interaction_record():
    """G0B-11: parseable JSON is not evidence the interaction landed. Every
    add-interaction.py success print carries contact_id AND source_ref."""
    for payload in ('[]', '42', '{"ok": true}', '{"contact_id": "c1"}'):
        runner = FakeRunner()
        runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0, stdout=payload)
        try:
            csw.write_interaction(runner, CRM_DIR, "c1", _Msg(id="m9"), {"summary": "x", "decisions": []})
            assert False, f"expected WriterError for {payload!r}"
        except csw.WriterError:
            pass


def test_write_interaction_rejects_record_for_a_different_contact():
    runner = FakeRunner()
    runner.record(("python3", str(CRM_DIR / "add-interaction.py")), rc=0,
                  stdout='{"contact_id": "OTHER", "source_ref": "gmail:m9"}')
    try:
        csw.write_interaction(runner, CRM_DIR, "c1", _Msg(id="m9"), {"summary": "x", "decisions": []})
        assert False, "expected WriterError"
    except csw.WriterError as exc:
        assert "OTHER" in str(exc)


def test_create_task_rejects_stdout_that_is_not_a_task_id():
    """G0B-11: `bus create-task` prints ONLY the id (src/cli/bus.ts:552), shaped
    task_<epoch>_<8 digits> (src/bus/task.ts:781)."""
    plan = csw.TaskPlan(title="t", owner="Josh", source_ref="gmail:m1", dedup=None)
    for bad in ("warning: queue is full", "task-42", "Task assigned: t"):
        runner = FakeRunner()
        runner.record(("cortextos", "bus", "create-task"), rc=0, stdout=bad + "\n")
        try:
            csw.create_task(runner, plan)
            assert False, f"expected WriterError for {bad!r}"
        except csw.WriterError:
            pass


def test_ensure_contact_rejects_non_slug_stdout_as_an_id(tmp_path):
    """G0B-11: upsert-contact.py prints a slugify()d id (:80-82, :289). Arbitrary
    prose on stdout must raise, not be adopted as a contact id."""
    crm = tmp_path / "crm"
    crm.mkdir()
    runner = FakeRunner()
    runner.record(("python3", str(crm / "upsert-contact.py")), rc=0,
                  stdout="WARNING: contacts.json was locked, retrying\n")
    try:
        csw.ensure_contact(runner, crm, "Marcos", "marcos@acme.org", [])
        assert False, "expected WriterError"
    except csw.WriterError:
        pass


def test_tier1_duplicate_boundary_ratio_exactly_0_75_is_false():
    a, b = "abcd", "abce"
    assert difflib.SequenceMatcher(None, a, b).ratio() == 0.75
    assert csw.tier1_duplicate(a, "josh", b, "josh") is False


def test_tier1_duplicate_boundary_ratio_0_76_is_true():
    a = "abcdefghijklmnopqrstuvwxy"
    b = "abcdefghijklmnopqrs123456"
    assert difflib.SequenceMatcher(None, a, b).ratio() == 0.76
    assert csw.tier1_duplicate(a, "josh", b, "josh") is True


def test_tier1_duplicate_owner_mismatch_never_duplicates():
    assert csw.tier1_duplicate("send the deck", "josh", "send the deck", "marcos") is False


def test_plan_tasks_reads_owner_name_field():
    """G0A-2/G0B-7: the schema-binding field is owner_name, not owner."""
    extraction = {"commitments": [
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "q", "matches_open_item": None},
    ]}
    plans = csw.plan_tasks(extraction, [], [], "gmail:m1")
    assert len(plans) == 1
    assert plans[0].title == "Send the updated MSA"
    assert plans[0].dedup is None


def test_plan_tasks_tier2_wins_over_tier1():
    context = [_ContextItem(1, "Send Alloi the tacticals doc", "josh", "page:alloi")]
    extraction = {"commitments": [
        {"text": "share the tactical plan with Marcos", "owner_name": "Josh", "deadline_iso": None,
         "quote": "q", "matches_open_item": 1},
    ]}
    plans = csw.plan_tasks(extraction, context, [], "gmail:m1")
    assert plans[0].dedup == {"tier": 2, "match": "Send Alloi the tacticals doc"}


def test_plan_tasks_tier1_against_open_tasks_uses_task_owner():
    """G0B-8: owner for a tier-1 match against an open task is THAT task's own
    assigned_to, never a hardcoded 'josh'."""
    open_tasks = [{"id": "t1", "title": "Send the updated MSA to Marcos", "assigned_to": "josh"}]
    extraction = {"commitments": [
        {"text": "Send the updated MSA to Marcos!", "owner_name": "Josh", "deadline_iso": None,
         "quote": "q", "matches_open_item": None},
    ]}
    plans = csw.plan_tasks(extraction, [], open_tasks, "gmail:m2")
    assert plans[0].dedup == {"tier": 1, "match": "Send the updated MSA to Marcos"}

    open_tasks_other_owner = [{"id": "t2", "title": "Send the updated MSA to Marcos", "assigned_to": "marcos"}]
    plans2 = csw.plan_tasks(extraction, [], open_tasks_other_owner, "gmail:m3")
    assert plans2[0].dedup is None  # different owner -- no false match


def test_plan_tasks_theirs_no_task():
    extraction = {"commitments": [
        {"text": "Send us the signed contract", "owner_name": "Marcos Ruiz", "deadline_iso": None,
         "quote": "q", "matches_open_item": None},
    ]}
    assert csw.plan_tasks(extraction, [], [], "gmail:m5") == []


def test_list_open_tasks_argv_open_flag_both_classes_limit_200():
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=0,
                   stdout='[{"id": "t1", "title": "Human task", "assigned_to": "josh"}]')
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "build"), rc=0,
                   stdout='[{"id": "t2", "title": "Build task", "assigned_to": "josh"}]')
    tasks = csw.list_open_tasks(runner)
    assert {t["id"] for t in tasks} == {"t1", "t2"}
    assert runner.calls[0] == [
        "cortextos", "bus", "list-tasks", "--open", "--class", "human", "--format", "json", "--limit", "200",
    ]
    assert runner.calls[1] == [
        "cortextos", "bus", "list-tasks", "--open", "--class", "build", "--format", "json", "--limit", "200",
    ]


def test_list_open_tasks_raises_on_nonzero_rc():
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=1, stdout="", stderr="down")
    try:
        csw.list_open_tasks(runner)
        assert False, "expected TaskEnumerationError"
    except csw.TaskEnumerationError as exc:
        assert "down" in str(exc)


def test_create_task_argv_pinned_and_raises_on_empty_id():
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_12345678\n")
    plan = csw.TaskPlan(title="Send updated MSA", owner="Josh", source_ref="gmail:abc123", dedup=None)
    task_id = csw.create_task(runner, plan)
    assert task_id == "task_1757800000_12345678"
    assert runner.calls == [[
        "cortextos", "bus", "create-task", "Send updated MSA",
        "--assignee", "human", "--type", "human", "--desc", "source gmail:abc123",
    ]]

    runner2 = FakeRunner()
    runner2.record(("cortextos", "bus", "create-task"), rc=0, stdout="")
    try:
        csw.create_task(runner2, plan)
        assert False, "expected WriterError"
    except csw.WriterError:
        pass
