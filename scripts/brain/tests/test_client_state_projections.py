"""C6: client_state_projections is pure -- no I/O, no subprocess. Direct unit
coverage for the argv/text shapes client_state_writes and client_state_gmail
both consume for parity (G-PARITY-1)."""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import client_state_projections as projections
from observation_ledger import ObservationRow, Resolution


@dataclass
class _Msg:
    id: str
    thread_id: str
    from_name: str
    from_email: str
    subject: str
    date_iso: str


def test_plan_history_entry_shape():
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="2026-09-14T10:00:00Z")
    extraction = {
        "summary": "Marcos asked for the MSA",
        "decisions": [{"text": "Go tier 2", "quote": "q"}],
        "open_questions": [{"text": "When?", "quote": "q"}],
    }
    entry = projections.plan_history_entry(msg, extraction, "gmail:m1", None)
    assert entry.date == "2026-09-14"
    assert entry.subject == "Renewal"
    assert entry.source_ref == "gmail:m1"
    assert entry.summary == "Marcos asked for the MSA"
    assert entry.decisions == ["Go tier 2"]
    assert entry.open_questions == ["When?"]
    assert entry.revision_of is None


def test_plan_upsert_contact_argv_sender_only_header_facts():
    argv = projections.plan_upsert_contact_argv(Path("/crm"), "Marcos", "marcos@acme.org")
    assert argv == [
        "python3", str(Path("/crm") / "upsert-contact.py"),
        "--name", "Marcos", "--email", "marcos@acme.org", "--match-email", "--source-ref", "gmail:auto",
    ]


def test_plan_add_interaction_argv():
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="2026-09-14T10:00:00Z")
    extraction = {"summary": "s", "decisions": [{"text": "d1", "quote": "q"}, {"text": "", "quote": "q"}]}
    argv = projections.plan_add_interaction_argv(Path("/crm"), "c1", msg, extraction)
    assert argv == [
        "python3", str(Path("/crm") / "add-interaction.py"),
        "--contact-id", "c1", "--type", "email", "--summary", "s",
        "--source-ref", "gmail:m1", "--decision", "d1",
    ]


def test_plan_task_create_argv():
    @dataclass
    class _Plan:
        title: str
        source_ref: str

    argv = projections.plan_task_create_argv(_Plan(title="Do the thing", source_ref="gmail:m1"))
    assert argv == [
        "cortextos", "bus", "create-task", "Do the thing",
        "--assignee", "human", "--type", "human", "--desc", "source gmail:m1",
    ]


def test_plan_escalation_text_names_reasons():
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="2026-09-14T10:00:00Z")
    resolutions = [Resolution(slug="", kind="", method="", outcome="escalated",
                               reason="ambiguous:acme|alloi", contact_id=None, email="marcos@acme.org")]
    text = projections.plan_escalation(msg, resolutions)
    assert "ambiguous:acme|alloi" in text
    assert "gmail:m1" in text
    assert "marcos@acme.org" in text


def test_plan_digest_line_includes_summary_and_suppression_and_revision():
    row = ObservationRow(
        source_ref="gmail:m1", thread_id="t1", content_digest="deadbeef",
        observed_at="2026-09-14T12:00:00Z",
        resolutions=[Resolution(slug="acme", kind="client", method="page-domain", outcome="filed")],
        extraction={"summary": "Discussed pricing"},
        writes=["crm:c1", "clients/acme.md", "task:t9|Send MSA"],
        revision_of="cafef00d",
        suppressed=[{"title": "Dup task", "tier": 1, "match": "Existing"}],
    )
    lines = projections.plan_digest_line(row)
    joined = "\n".join(lines)
    assert "Discussed pricing" in joined
    assert "Send MSA" in joined
    assert "Dup task" in joined and "Existing" in joined
    assert "supersedes cafef00d" in joined


def test_plan_message_preview_carries_every_g4_field():
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="2026-09-14T10:00:00Z")
    resolutions = [Resolution(slug="acme", kind="client", method="page-domain", outcome="filed",
                               contact_id="c1", email="marcos@acme.org")]
    extraction = {
        "cost_usd": 0.01, "model_receipt": "claude-sonnet-5", "summary": "s",
        "decisions": [{"text": "d1", "quote": "q1"}],
        "commitments": [{"text": "c1t", "owner_name": "Josh", "quote": "q2", "matches_open_item": None}],
        "open_questions": [{"text": "oq1", "quote": "q3"}],
    }
    text = projections.plan_message_preview(
        msg, resolutions, extraction, cached=True,
        crm_lines=["  CRM row: ..."], page_diffs=["  page diff for ..."],
        task_lines=["  task: ... (create)"], escalation_text="ESCALATE-TEXT",
        digest_lines=["- CRM: crm:c1 (gmail:m1) — s [simulated]"],
    )
    for expected in (
        # G0B2-5: the LITERAL `source_ref` token g4-check.sh binds to, emitted by
        # the producer itself -- not a hand-written lookalike in a fixture.
        "source_ref=gmail:m1", "thread_id=t1", "Marcos", "marcos@acme.org", "Renewal",
        "slug='acme'", "cached=True", "cost_usd=0.01", "model_receipt=claude-sonnet-5",
        "d1", "q1", "c1t", "owner=Josh", "q2", "oq1", "q3",
        "CRM row:", "page diff for", "task: ... (create)", "ESCALATE-TEXT",
        # G0A2-10 / C6: the dry-run's own digest preview.
        "digest preview: - CRM: crm:c1 (gmail:m1) — s [simulated]",
        # G0B3-4: the block declares its own outcome.
        "outcome: filed",
    ):
        assert expected in text, expected


def test_plan_message_preview_states_every_absent_section_explicitly():
    """G0B3-4: an ignored or escalated message legitimately produces no
    extraction, CRM row, page diff, task line or grounding quote. The block must
    SAY so — "no CRM row" and "the preview forgot the CRM row" must not look the
    same, to a reader or to the G4 checker."""
    msg = _Msg(id="m9", thread_id="t9", from_name="Rando", from_email="rando@unknown.example",
               subject="Hello", date_iso="2026-09-14T10:00:00Z")
    ignored = [Resolution(slug="", kind="", method="none", outcome="ignored",
                          reason="no-known-entity", email="rando@unknown.example")]
    text = projections.plan_message_preview(
        msg, ignored, None, cached=False, crm_lines=[], page_diffs=[], task_lines=[],
        escalation_text=None,
    )
    assert "outcome: ignored" in text
    for marker in ("  extraction: n/a", "  summary: n/a", "  item: none [quote: none]",
                   "  CRM: none", "  page: none", "  task: none", "  escalation: none",
                   "  digest preview: - none"):
        assert marker in text, marker

    escalated = [Resolution(slug="", kind="", method="page-domain", outcome="escalated",
                            reason="ambiguous:acme|alloi", email="marcos@acme.org")]
    esc_text = projections.plan_message_preview(
        msg, escalated, None, cached=False, crm_lines=[], page_diffs=[], task_lines=[],
        escalation_text="Client State: ambiguous …",
    )
    assert "outcome: escalated" in esc_text
    assert "  escalation: Client State: ambiguous" in esc_text
    assert "  CRM: none" in esc_text and "  page: none" in esc_text and "  task: none" in esc_text


def test_plan_message_preview_marks_a_filed_message_with_no_extracted_items():
    """A perfectly normal filed message whose body carries no decision,
    commitment or open question has NO grounding quote to show — the block says
    `item: none [quote: none]` rather than silently omitting the section."""
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="FYI", date_iso="2026-09-14T10:00:00Z")
    filed = [Resolution(slug="acme", kind="client", method="page-domain", outcome="filed",
                        contact_id="c1", email="marcos@acme.org")]
    text = projections.plan_message_preview(
        msg, filed, {"summary": "FYI only.", "cost_usd": 0.01, "model_receipt": "claude-sonnet-5",
                     "decisions": [], "commitments": [], "open_questions": []},
        cached=False, crm_lines=["  CRM row: contact=c1 argv=['x']"],
        page_diffs=["  page diff for p.md:"], task_lines=[], escalation_text=None,
    )
    assert "outcome: filed" in text
    assert "  item: none [quote: none]" in text
    assert "  task: none" in text


def test_plan_digest_line_renders_planned_writes_for_a_simulated_row():
    """G0A2-2/G0B2-4: a dry-run row carries planned_writes (not writes), so the
    digest can still report what WOULD change, tagged [simulated], while
    nothing downstream can mistake the preview for a completed effect."""
    row = ObservationRow(
        source_ref="gmail:m1", thread_id="t1", content_digest="deadbeef",
        observed_at="2026-09-14T12:00:00Z",
        resolutions=[Resolution(slug="acme", kind="client", method="page-domain", outcome="filed")],
        extraction={"summary": "Discussed pricing"},
        writes=[], planned_writes=["crm:c1", "clients/acme.md", "task:<new>|Send MSA"],
        simulated=True,
    )
    lines = projections.plan_digest_line(row)
    joined = "\n".join(lines)
    assert projections.effective_writes(row) == ["crm:c1", "clients/acme.md", "task:<new>|Send MSA"]
    assert "Discussed pricing" in joined
    assert "Send MSA" in joined
    assert joined.count("[simulated]") == 3
    # and the live row's lines carry no tag
    row.simulated = False
    row.writes = ["crm:c1"]
    assert "[simulated]" not in "\n".join(projections.plan_digest_line(row))


# --- G2a-4: the History entry date is DERIVED, never a blind [:10] slice ------

def test_plan_history_entry_never_emits_a_malformed_date():
    """Even if an un-normalised RFC 2822 value reaches plan_history_entry, the
    entry must not carry 'Sun, 14 Se' as its date."""
    from datetime import datetime, timezone

    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="Sun, 14 Sep 2026 03:00:00 -0700")
    entry = projections.plan_history_entry(msg, {"summary": "s"}, "gmail:m1", None)
    assert entry.date == "2026-09-14", entry.date


def test_plan_history_entry_falls_back_to_today_with_an_unparsed_marker():
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for bad in ("", "whenever, really", "1970-13-45"):
        msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
                   subject="Renewal", date_iso=bad)
        entry = projections.plan_history_entry(msg, {"summary": "s"}, "gmail:m1", None)
        assert entry.date == today, (bad, entry.date)
        assert "date: unparsed" in entry.summary, (bad, entry.summary)


def test_plan_history_entry_marks_nothing_for_a_good_date():
    msg = _Msg(id="m1", thread_id="t1", from_name="Marcos", from_email="marcos@acme.org",
               subject="Renewal", date_iso="2026-09-14T10:00:00Z")
    entry = projections.plan_history_entry(msg, {"summary": "s"}, "gmail:m1", None)
    assert entry.date == "2026-09-14"
    assert "date: unparsed" not in entry.summary


# --- G2r3-2: the escalation send carries a source-event dedup key -------------
# FR-003/FR-009: a crash between a delivered Telegram and the ledger append must
# not re-page Josh. The ledger record is written AFTER confirmed delivery, so it
# cannot cover that window; the bus's own comms-event-dedup ledger can.

def test_escalation_source_key_is_a_valid_bus_source_key():
    import re

    key = projections.escalation_source_key("gmail:m1", "deadbeefcafe0000")
    # src/utils/event-dedup.ts SOURCE_KEY_PATTERN: the id half may NOT contain
    # a ':', so the source_ref's own colon is folded to '.'.
    assert re.fullmatch(r"[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}", key), key
    assert key == "clientstate:gmail.m1.deadbeef"
    # identity is (source_ref, digest): a new digest is a NEW alert
    assert projections.escalation_source_key("gmail:m1", "0000beefcafedead") != key


def test_plan_escalation_argv_is_a_fail_closed_comms_send():
    argv = projections.plan_escalation_argv("some text", "clientstate:gmail.m1.deadbeef")
    assert argv == [
        "cortextos", "bus", "send-telegram", projections.TELEGRAM_CHAT_ID, "some text",
        "--kind", "comms", "--source-key", "clientstate:gmail.m1.deadbeef",
    ]
