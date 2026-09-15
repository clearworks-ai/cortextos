"""Task 15 (C7): the full client_state_gmail orchestrator, restated whole (no
append -- G0A-12/G0B-19). Fixtures use gmail_source.parse_message's real payload
shape and the real `claude -p` wrapper JSON (extract_meeting._parse_claude_stdout
shape: {"type":"result","subtype":"success","result": json.dumps(model), ...}),
never a hand-shaped Message or a bare model dict."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from helpers_client_state import FakeRunner, make_crm_dir, make_vault

import client_state_gmail as csg
import client_state_writes
import single_flight


def _lock_ok(runner: FakeRunner, claims_dir: Path) -> None:
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="ok")
    lock_file = single_flight.lock_path(claims_dir, "client-state-gmail")
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file.touch()


def _open_tasks_empty(runner: FakeRunner) -> None:
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=0, stdout="[]")
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "build"), rc=0, stdout="[]")


def _cfg(tmp_path: Path, dry_run: bool, **overrides) -> csg.Config:
    vault = overrides.pop("vault", None) or make_vault(tmp_path)
    crm_dir = overrides.pop("crm_dir", None) or make_crm_dir(tmp_path, overrides.pop("contacts", []))
    defaults = dict(
        repo_root=tmp_path, vault=vault, crm_dir=crm_dir, state_dir=tmp_path / "state",
        days=3, query=None, dry_run=dry_run, max_usd=2.0,
        today=date(2026, 9, 14), now=datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    return csg.Config(**defaults)


def _gmail_payload(mid="m1", from_email="marcos@acme.org", from_name="Marcos", to=None,
                    subject="Renewal", body="Can you send the updated MSA? Let's proceed."):
    """The real gws-dwd +read FLAT shape gmail_source._parse_message_flat_shape reads."""
    return {
        "id": mid, "threadId": "t1",
        "from": {"name": from_name, "email": from_email},
        "to": to or ["josh@clearworks.ai"], "cc": [],
        "subject": subject, "date": "2026-09-14T10:00:00Z", "body": body,
    }


def _claude_wrapper(summary="Marcos asked for the updated MSA.", commitments=None,
                     decisions=None, open_questions=None, cost_usd=0.0123):
    model = {
        "schema": "brain.email_extraction/1",
        "summary": summary,
        "decisions": decisions if decisions is not None else [],
        "commitments": commitments if commitments is not None else [],
        "open_questions": open_questions if open_questions is not None else [],
    }
    wrapper = {
        "type": "result", "subtype": "success",
        "result": json.dumps(model), "total_cost_usd": cost_usd,
        "modelUsage": {"claude-sonnet-5": {"inputTokens": 2, "outputTokens": 4, "costUSD": cost_usd}},
    }
    return json.dumps(wrapper)


def _interaction_stdout(contact_id: str = "c1", source_ref: str = "gmail:m1") -> str:
    """add-interaction.py's real success print: the appended record (:117) --
    always an object carrying contact_id AND source_ref (G0B-11)."""
    return json.dumps({
        "ts": "2026-09-14T12:00:00+00:00", "contact_id": contact_id, "type": "email",
        "summary": "", "decisions": [], "source_ref": source_ref,
    })


def _page_path(cfg: csg.Config, slug: str = "acme") -> Path:
    return cfg.vault / "raw" / "areas" / "clearworks" / "org-brain" / "clients" / f"{slug}.md"


def test_dry_run_files_message_previews_crm_page_and_persists_ledger_receipt(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(
        commitments=[{
            "text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
            "quote": "send the updated MSA", "matches_open_item": None,
        }],
    ))

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    assert result.filed == 1
    assert any(l.startswith("=== source_ref=gmail:m1") for l in result.previews)  # G0B2-5
    block = "\n".join(result.previews)
    assert "resolution: slug='acme'" in block
    assert "CRM: would create contact" in block
    # G0A2-9/G0B-2: a NEW-but-domain-matched sender still previews the CRM
    # interaction row the live run will write, against a prospective id.
    assert "CRM row: contact=<new:marcos@acme.org>" in block
    assert "page diff for" in block
    assert "[source: gmail:m1]" in block
    assert "task: Send the updated MSA (create)" in block
    # G0A2-10 / C6: the dry-run carries its own digest preview lines.
    assert "digest preview: - CRM: crm:<new:marcos@acme.org>" in block
    assert "[simulated]" in block

    # dry-run PERSISTS ledger + receipt (G0A-3/G0B-1)
    assert (cfg.state_dir / "observations.jsonl").exists()
    assert (cfg.state_dir / "run-receipt.json").exists()
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["resolutions"][0]["outcome"] == "filed"
    assert rows[0]["extraction"]["summary"] == "Marcos asked for the updated MSA."
    # G0A2-2/G0B2-4: the dry-run row is SIMULATED -- planned_writes carry what a
    # live run would do, `writes` stays empty, and the row is NOT terminal.
    assert rows[0]["simulated"] is True
    assert rows[0]["writes"] == []
    assert any(w.startswith("crm:") for w in rows[0]["planned_writes"])
    assert any(w.endswith(".md") for w in rows[0]["planned_writes"])
    assert any(w.startswith("task:<new>|") for w in rows[0]["planned_writes"])
    from observation_ledger import Ledger
    assert Ledger(cfg.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[0]["content_digest"]) is False

    # dry-run makes NO irreversible-transport calls
    assert not any(len(c) > 1 and "upsert-contact.py" in c[1] for c in runner.calls)
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner.calls)
    assert not any(c[:3] == ["cortextos", "bus", "create-task"] for c in runner.calls)
    # the page is the pre-existing fixture -- dry-run must not MODIFY it
    assert "[source: gmail:m1]" not in _page_path(cfg).read_text(encoding="utf-8")


def test_second_identical_dry_run_zero_new_claude_calls(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    csg.run(cfg, runner)
    claude_calls_after_first = sum(1 for c in runner.calls if c[0] == "claude")

    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    rows_after_first = (cfg.state_dir / "observations.jsonl").read_text()
    result2 = csg.run(cfg, runner2)

    assert result2.filed == 0
    assert sum(1 for c in runner2.calls if c[0] == "claude") == 0
    assert claude_calls_after_first == 1
    # G0B-3/G-IDEMP-2: the unchanged re-check APPENDS NOTHING -- assert the row
    # COUNT and the file bytes, not just the absence of a Claude call.
    rows_after_second = (cfg.state_dir / "observations.jsonl").read_text()
    assert rows_after_second == rows_after_first
    assert len(rows_after_second.splitlines()) == 1
    assert result2.previews == []


def test_live_run_writes_crm_page_task_and_ledger(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(
        commitments=[{
            "text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
            "quote": "send the updated MSA", "matches_open_item": None,
        }],
    ))
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="new-contact-1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                   stdout=json.dumps({"contact_id": "new-contact-1", "type": "email", "source_ref": "gmail:m1"}))
    runner.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    assert result.filed == 1
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["resolutions"][0]["outcome"] == "filed"
    assert "crm:new-contact-1" in rows[0]["writes"]
    assert any(w.startswith("task:task_1757800000_00000001|") for w in rows[0]["writes"])

    page = _page_path(cfg)
    assert page.exists()
    text = page.read_text(encoding="utf-8")
    assert "[source: gmail:m1]" in text
    assert "Marcos asked for the updated MSA." in text

    assert any(len(c) > 1 and "upsert-contact.py" in c[1] for c in runner.calls)
    assert any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner.calls)
    assert any(c[:3] == ["cortextos", "bus", "create-task"] for c in runner.calls)
    upsert_call = next(c for c in runner.calls if len(c) > 1 and "upsert-contact.py" in c[1])
    assert upsert_call == [
        "python3", str(cfg.crm_dir / "upsert-contact.py"),
        "--name", "Marcos", "--email", "marcos@acme.org", "--match-email", "--source-ref", "gmail:auto",
    ]


def test_revision_new_digest_appends_marked_replacement_entry(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload(body="original text")))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(summary="First pass."))
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                   stdout=_interaction_stdout())
    first = csg.run(cfg, runner)
    assert first.filed == 1

    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload(body="EDITED materially different text")))
    _open_tasks_empty(runner2)
    runner2.record(("claude",), rc=0, stdout=_claude_wrapper(summary="Revised pass."))
    runner2.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner2.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                   stdout=_interaction_stdout())
    second = csg.run(cfg, runner2)
    assert second.filed == 1
    assert second.skipped_terminal == 0

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 2
    assert rows[1]["revision_of"] == rows[0]["content_digest"]
    text = _page_path(cfg).read_text(encoding="utf-8")
    assert "First pass." in text
    assert "Revised pass." in text
    assert "(revision of" in text


def test_two_known_contacts_same_page_one_history_two_crm_rows(tmp_path):
    contacts = [
        {"id": "c-marcos", "name": "Marcos", "emails": ["marcos@acme.org"]},
        {"id": "c-lori", "name": "Lori", "emails": ["lori@acme.org"]},
    ]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    payload = _gmail_payload(to=["josh@clearworks.ai", "lori@acme.org"])
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    # one response PER contact id -- the shared FakeRunner matches on the argv
    # PREFIX, so a longer prefix that includes --contact-id pins each one.
    for cid in ("c-marcos", "c-lori"):
        runner.record(
            ("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", cid),
            rc=0, stdout=_interaction_stdout(contact_id=cid),
        )

    result = csg.run(cfg, runner)
    assert result.exit_code == 0

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    row = rows[0]
    assert len(row["resolutions"]) == 2  # sender + recipient, both known contacts on the SAME page
    assert {r["slug"] for r in row["resolutions"]} == {"acme"}
    crm_writes = [w for w in row["writes"] if w.startswith("crm:")]
    assert sorted(crm_writes) == ["crm:c-lori", "crm:c-marcos"]
    page_writes = [w for w in row["writes"] if w.endswith(".md")]
    assert len(page_writes) == 1  # ONE History write, not two (G0B-9)
    add_interaction_calls = [c for c in runner.calls if len(c) > 1 and "add-interaction.py" in c[1]]
    assert len(add_interaction_calls) == 2  # ONE CRM row per contact_id


def test_recipient_without_contact_never_auto_created(tmp_path):
    """G0B-10: only the SENDER is auto-created; a domain-matched recipient with
    no existing contact row gets NO CRM row this pass (but their page still gets
    History, proven above) -- the create argv must never combine the sender's
    name with a recipient's email."""
    cfg = _cfg(tmp_path, dry_run=False)  # no contacts at all
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    payload = _gmail_payload(to=["josh@clearworks.ai", "lori@acme.org"])
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c-sender\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                   stdout=_interaction_stdout(contact_id="c-sender"))

    result = csg.run(cfg, runner)
    assert result.exit_code == 0

    upsert_calls = [c for c in runner.calls if len(c) > 1 and "upsert-contact.py" in c[1]]
    assert len(upsert_calls) == 1  # only the sender
    assert upsert_calls[0][upsert_calls[0].index("--email") + 1] == "marcos@acme.org"
    add_interaction_calls = [c for c in runner.calls if len(c) > 1 and "add-interaction.py" in c[1]]
    assert len(add_interaction_calls) == 1  # recipient got no CRM row


def test_ambiguous_message_escalates_once_then_stays_silent(tmp_path):
    """A contact whose CRM `company` maps (via org_name_to_slug) to the Alloi page
    while their email DOMAIN maps (via domain_to_slug) to the Acme page -- two
    different non-empty slugs -- is the genuine FR-004 ambiguity case."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    payload = _gmail_payload(from_email="marcos@acme.org", from_name="Marcos")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    runner.record(("cortextos", "bus", "send-telegram"), rc=0, stdout="sent")

    result = csg.run(cfg, runner)
    assert result.exit_code == 0
    assert result.escalated == 1
    assert result.filed == 0
    send_calls = [c for c in runner.calls if c[:3] == ["cortextos", "bus", "send-telegram"]]
    assert len(send_calls) == 1
    assert single_flight.lock_path  # sanity import touch

    # second run: same ambiguity, same digest -- escalated_for gates the resend
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    result2 = csg.run(cfg, runner2)
    assert result2.exit_code == 0
    send_calls2 = [c for c in runner2.calls if c[:3] == ["cortextos", "bus", "send-telegram"]]
    assert send_calls2 == []


def test_writer_error_on_add_interaction_aborts_message_never_marks_filed(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=1, stdout="", stderr="boom")

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert "boom" in receipt["error"]
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    # G0B-11/G0B-6: exactly ONE `partial` row -- nothing is marked filed and no
    # write token is claimed, but the extraction this message already PAID for
    # is preserved so the retry does not re-spend on it.
    assert len(rows) == 1
    assert rows[0]["partial"] is True
    assert rows[0]["writes"] == []
    # G0B3-1: every resolution is persisted, stamped "partial" with the effect
    # keys that landed for it (none here) -- NOT dropped, or the retry would
    # lose the landed-effect record.
    assert [r["outcome"] for r in rows[0]["resolutions"]] == ["partial"]
    assert rows[0]["resolutions"][0]["effects"] == []
    assert rows[0]["resolutions"][0]["contact_id"] == "c1"   # the auto-created id assigned back
    assert rows[0]["extraction"]["model_receipt"]
    assert "boom" in rows[0]["reason"]
    from observation_ledger import Ledger
    assert Ledger(cfg.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[0]["content_digest"]) is False

    # the retry reuses the cached extraction: zero new claude calls
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    runner2.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner2.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    result2 = csg.run(cfg, runner2)
    assert result2.exit_code == 0 and result2.filed == 1
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0


def test_task_enumeration_error_exit_3(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=1, stdout="", stderr="down")

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert "down" in receipt["error"]


def test_budget_exceeded_persists_partial_cost_and_exits_12(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False, max_usd=0.01)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.05))

    result = csg.run(cfg, runner)
    assert result.exit_code == 12
    assert result.cost_usd == 0.05  # the paid call's cost is preserved, not discarded (G0B-6)
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert receipt["error"] == "budget"
    assert receipt["cost_usd"] == 0.05


def test_ignored_message_no_known_entity(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    payload = _gmail_payload(from_email="stranger@unknown-domain.example")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))

    result = csg.run(cfg, runner)
    assert result.ignored == 1
    assert result.filed == 0
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["resolutions"][0]["reason"] == "no-known-entity"
    assert not any(len(c) > 1 and "upsert-contact.py" in c[1] for c in runner.calls)


def test_hostile_subject_stays_literal_argv_never_shell_interpolated(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    hostile_subject = "]] --evil `rm -rf /` $(cat /etc/passwd)"
    payload = _gmail_payload(subject=hostile_subject)
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                   stdout=_interaction_stdout())

    result = csg.run(cfg, runner)
    assert result.exit_code == 0
    text = _page_path(cfg).read_text(encoding="utf-8")
    assert "rm -rf" in text  # present, inert literal text
    add_interaction_calls = [c for c in runner.calls if len(c) > 1 and "add-interaction.py" in c[1]]
    assert len(add_interaction_calls) == 1
    assert all(isinstance(part, str) for part in add_interaction_calls[0])


def test_theirs_commitment_produces_no_task_ours_does(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(commitments=[
        {"text": "Send the signed contract", "owner_name": "Marcos", "deadline_iso": None,
         "quote": "Can you send", "matches_open_item": None},
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "send the updated MSA", "matches_open_item": None},
    ]))

    result = csg.run(cfg, runner)
    block = "\n".join(result.previews)
    assert "Send the signed contract" not in block.split("task:")[-1] if "task:" in block else True
    assert "task: Send the updated MSA (create)" in block
    assert "task: Send the signed contract" not in block


def test_list_open_tasks_argv_uses_open_flag_and_both_classes(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())

    csg.run(cfg, runner)
    list_calls = [c for c in runner.calls if c[:3] == ["cortextos", "bus", "list-tasks"]]
    assert len(list_calls) == 2
    assert list_calls[0] == [
        "cortextos", "bus", "list-tasks", "--open", "--class", "human", "--format", "json", "--limit", "200",
    ]
    assert list_calls[1] == [
        "cortextos", "bus", "list-tasks", "--open", "--class", "build", "--format", "json", "--limit", "200",
    ]


# --- absorbed from the retired scripts/brain/tests/test_client_state_gmail_task8.py
# (G0A2-3/G0B2-2: the intermediate file was incompatible with the module Task 15
# ships and was permanently red in the final tree; its unique coverage lives here,
# maintained against the module that actually ships).

def test_lock_held_exit_2_leaves_receipt_byte_identical_and_writes_refusal_file(tmp_path):
    """Binding goal G4 item 5 (amended 2026-09-14 / G0A2-16): a lock-held run
    exits 2 without processing, leaves run-receipt.json BYTE-IDENTICAL, and puts
    the cause in a separate last-lock-refusal.json."""
    cfg = _cfg(tmp_path, dry_run=True)
    # 1) one clean run so a success receipt exists
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([]))
    assert csg.run(cfg, runner).exit_code == 0
    receipt_path = cfg.state_dir / "run-receipt.json"
    before = receipt_path.read_bytes()

    # 2) the lock is held by a live holder -- the claim CLI refuses
    runner2 = FakeRunner()
    runner2.record(("cortextos", "bus", "meeting-brief-claim"), rc=1, stdout="",
                   stderr="Already claimed client-state-gmail (already-claimed)")
    result = csg.run(cfg, runner2)

    assert result.exit_code == 2
    assert receipt_path.read_bytes() == before          # G-LOCKREF-1: byte-identical
    refusal = json.loads((cfg.state_dir / "last-lock-refusal.json").read_text())
    assert refusal["error"] == "lock-held"
    assert refusal["refused_at"]
    assert "error" not in json.loads(before.decode())   # the success receipt stays clean
    # no processing happened at all
    assert not any(c[:3] == ["gws", "gmail", "+triage"] for c in runner2.calls)


def test_gws_failure_exit_3_preserves_last_success_at(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([]))
    csg.run(cfg, runner)
    first_receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert first_receipt.get("error") is None

    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=1, stdout="", stderr="gmail api quota exceeded")
    result = csg.run(cfg, runner2)
    assert result.exit_code == 3
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert "quota exceeded" in receipt["error"]
    assert receipt["last_success_at"] == first_receipt["last_success_at"]
    assert receipt["message_count"] == 0  # G0B-6: partial progress on the failure receipt


def test_backfill_query_composes_exclusion_and_day_sweep(tmp_path):
    """G0A-5/G-QUERY-1: --query goes through sweep(extra_query=...) -- the
    exclusion clause and the day-sweep cap still apply on the manual-backfill
    path."""
    cfg = _cfg(tmp_path, dry_run=True, query="from:marcos@acme.org", days=2)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    fifty = [{"id": f"m{i}", "threadId": "t"} for i in range(50)]
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps(fifty))
    for i in range(50):
        runner.record(("gws", "gmail", "+read", "--id", f"m{i}"), rc=0, stdout=json.dumps(
            _gmail_payload(mid=f"m{i}", from_email="stranger@unknown-domain.example")
        ))
    csg.run(cfg, runner)
    triage_calls = [c for c in runner.calls if c[:3] == ["gws", "gmail", "+triage"]]
    assert len(triage_calls) == 1 + cfg.days  # full window + one per day
    for call in triage_calls:
        query = call[call.index("--query") + 1]
        assert "from:marcos@acme.org" in query
        assert "-category:promotions" in query  # EXCLUSION_QUERY present


# --- new invariants (round-3 findings) ---------------------------------------

def test_dry_run_then_live_run_still_performs_every_write(tmp_path):
    """G0A2-2: the release's own rollout does dry-runs BEFORE live ones. A
    simulated row must never make the following live run a no-op."""
    cfg_dry = _cfg(tmp_path, dry_run=True)
    r1 = FakeRunner()
    _lock_ok(r1, cfg_dry.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=_claude_wrapper())
    assert csg.run(cfg_dry, r1).filed == 1

    cfg_live = _cfg(tmp_path, dry_run=False, vault=cfg_dry.vault, crm_dir=cfg_dry.crm_dir,
                    state_dir=cfg_dry.state_dir)
    r2 = FakeRunner()
    _lock_ok(r2, cfg_live.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(r2)
    r2.record(("python3", str(cfg_live.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r2.record(("python3", str(cfg_live.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    live = csg.run(cfg_live, r2)

    assert live.exit_code == 0
    assert live.skipped_terminal == 0
    assert live.filed == 1
    # the extraction was cached from the dry run, so no SECOND paid call
    assert sum(1 for c in r2.calls if c[0] == "claude") == 0
    assert any(len(c) > 1 and "add-interaction.py" in c[1] for c in r2.calls)
    assert "[source: gmail:m1]" in _page_path(cfg_live).read_text(encoding="utf-8")
    rows = [json.loads(l) for l in (cfg_live.state_dir / "observations.jsonl").read_text().splitlines()]
    assert [r["simulated"] for r in rows] == [True, False]
    assert "crm:c1" in rows[1]["writes"]
    # and NOW it is terminal
    from observation_ledger import Ledger
    assert Ledger(cfg_live.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[1]["content_digest"]) is True


def test_dry_run_escalation_row_does_not_suppress_the_live_telegram(tmp_path):
    """G0A2-2 (FR-003 half): escalated_for must ignore simulated rows, or a
    dry-run silently cancels the real escalation."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg_dry = _cfg(tmp_path, dry_run=True, contacts=contacts)
    r1 = FakeRunner()
    _lock_ok(r1, cfg_dry.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    assert csg.run(cfg_dry, r1).escalated == 1
    assert not any(c[:3] == ["cortextos", "bus", "send-telegram"] for c in r1.calls)

    cfg_live = _cfg(tmp_path, dry_run=False, vault=cfg_dry.vault, crm_dir=cfg_dry.crm_dir,
                    state_dir=cfg_dry.state_dir)
    r2 = FakeRunner()
    _lock_ok(r2, cfg_live.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    r2.record(("cortextos", "bus", "send-telegram"), rc=0, stdout="sent")
    csg.run(cfg_live, r2)
    assert len([c for c in r2.calls if c[:3] == ["cortextos", "bus", "send-telegram"]]) == 1


def test_escalation_send_failure_exits_3_and_never_records_escalated(tmp_path):
    """G0B-4: a failed Telegram send must not leave an escalated row behind --
    escalated_for would then gate the retry forever."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    runner.record(("cortextos", "bus", "send-telegram"), rc=1, stdout="", stderr="telegram down")

    result = csg.run(cfg, runner)
    assert result.exit_code == 3  # G-ESC-2
    ledger_path = cfg.state_dir / "observations.jsonl"
    rows = [json.loads(l) for l in ledger_path.read_text().splitlines()] if ledger_path.exists() else []
    # G-ESC-3: the row IS persisted (so the cost/record of the attempt is not
    # lost) but NOTHING on it is marked escalated -- escalated_for must not read
    # an undelivered alert as proof of delivery.
    assert len(rows) == 1
    assert rows[0]["partial"] is True
    assert not any(r["outcome"] == "escalated" for r in rows[0]["resolutions"])
    assert "telegram down" in json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"]


def test_failed_escalation_send_is_retried_by_the_next_run(tmp_path):
    """G2A-1/G2B-5: the first run's send fails. The next run must SEND AGAIN --
    the failed attempt may not be recorded as an escalation."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    payload = _gmail_payload(from_email="marcos@acme.org", from_name="Marcos")

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    runner.record(("cortextos", "bus", "send-telegram"), rc=1, stdout="", stderr="telegram down")
    assert csg.run(cfg, runner).exit_code == 3

    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    runner2.record(("cortextos", "bus", "send-telegram"), rc=0, stdout="sent")
    result2 = csg.run(cfg, runner2)

    assert result2.exit_code == 0
    assert result2.escalated == 1
    assert [c for c in runner2.calls if c[:3] == ["cortextos", "bus", "send-telegram"]]

    # third run: delivery happened, so no resend
    runner3 = FakeRunner()
    _lock_ok(runner3, cfg.state_dir / "claims")
    runner3.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner3.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    assert csg.run(cfg, runner3).exit_code == 0
    assert not any(c[:3] == ["cortextos", "bus", "send-telegram"] for c in runner3.calls)


def test_lost_lease_mid_run_stops_and_never_releases_the_replacement(tmp_path):
    """G0B2-13: if our own lock file disappears, single-flight is gone. Stop
    before further effects and never release a lease we no longer own."""
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    # a concurrent stale-sweep removes our lock before the first message
    single_flight.lock_path(cfg.state_dir / "claims", "client-state-gmail").unlink()

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    assert "lease disappeared" in json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"]
    # never read the message, never wrote, never released
    assert not any(c[:3] == ["gws", "gmail", "+read"] for c in runner.calls)
    assert not any(c[:3] == ["cortextos", "bus", "meeting-brief-release"] for c in runner.calls)  # G-LOCK-6


def test_partial_message_failure_persists_completed_writes_and_never_replays_them(tmp_path):
    """G0B-11: a mid-message failure after a CRM row landed must persist that
    write on a `partial` row -- not terminal, so the next run finishes the
    remainder, and `_merge_resolutions` stops it re-writing what already landed."""
    contacts = [
        {"id": "c-marcos", "name": "Marcos", "emails": ["marcos@acme.org"]},
        {"id": "c-lori", "name": "Lori", "emails": ["lori@acme.org"]},
    ]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    payload = _gmail_payload(to=["josh@clearworks.ai", "lori@acme.org"])
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", "c-marcos"),
                  rc=0, stdout=_interaction_stdout(contact_id="c-marcos"))
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", "c-lori"),
                  rc=1, stdout="", stderr="crm locked")

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["partial"] is True                       # G-LEDGER-7
    assert rows[0]["writes"] == ["crm:c-marcos"]            # what DID land
    from observation_ledger import Ledger
    led = Ledger(cfg.state_dir / "observations.jsonl")
    assert led.is_terminal("gmail:m1", rows[0]["content_digest"]) is False

    # the retry finishes the remainder without re-writing c-marcos
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner2)
    runner2.record(("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", "c-lori"),
                   rc=0, stdout=_interaction_stdout(contact_id="c-lori"))
    result2 = csg.run(cfg, runner2)
    assert result2.exit_code == 0
    written = [c for c in runner2.calls if len(c) > 1 and "add-interaction.py" in c[1]]
    assert len(written) == 1
    assert written[0][written[0].index("--contact-id") + 1] == "c-lori"  # G-MERGE-1


def test_second_identical_live_run_skips_the_terminal_message(tmp_path):
    """G-IDEMP-1: once a LIVE run has filed every resolution for a digest, the
    next run short-circuits on ledger.is_terminal -- no read-through to
    extraction, no writes, no ledger append."""
    cfg = _cfg(tmp_path, dry_run=False)
    r1 = FakeRunner()
    _lock_ok(r1, cfg.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=_claude_wrapper())
    r1.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r1.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    assert csg.run(cfg, r1).filed == 1
    rows_after_first = (cfg.state_dir / "observations.jsonl").read_text()

    r2 = FakeRunner()
    _lock_ok(r2, cfg.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    result2 = csg.run(cfg, r2)

    assert result2.exit_code == 0
    assert result2.skipped_terminal == 1     # G-IDEMP-1
    assert result2.filed == 0
    assert not any(c[:3] == ["cortextos", "bus", "list-tasks"] for c in r2.calls)
    assert not any(c and c[0] == "claude" for c in r2.calls)
    assert (cfg.state_dir / "observations.jsonl").read_text() == rows_after_first


def test_history_write_happens_under_the_meeting_pipeline_file_lock(tmp_path, monkeypatch):
    """G-HIST-2: the page read + render + atomic write must ALL happen inside
    the SAME advisory client_file_lock the meeting pipeline uses, or a
    concurrent meeting-writeback filing to the same page can interleave with
    this read-modify-write. A recording stand-in proves the lock is entered
    once per bound page and that the page content changed while it was held."""
    import contextlib

    events: list[tuple[str, str]] = []

    @contextlib.contextmanager
    def _recording_lock(page, heartbeat=None, *, clock=None):
        events.append(("enter", str(page)))
        try:
            yield
        finally:
            events.append(("exit", str(page)))

    monkeypatch.setattr(csg, "_page_lock", _recording_lock)

    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    assert csg.run(cfg, runner).exit_code == 0

    page = str(_page_path(cfg))
    assert events == [("enter", page), ("exit", page)]  # exactly once, around the write
    assert "[source: gmail:m1]" in _page_path(cfg).read_text(encoding="utf-8")


# --- ruling A (G0B3-1): completion is per EFFECT, not one `filed` bit ---------

def _two_page_payload():
    """Marcos (acme.org) writes, Dana (alloi.us) is copied: two KNOWN contacts on
    two DISTINCT pages, so there are two History writes to fail between."""
    return _gmail_payload(to=["josh@clearworks.ai", "dana@alloi.us"])


_TWO_PAGE_CONTACTS = [
    {"id": "c-marcos", "name": "Marcos", "emails": ["marcos@acme.org"]},
    {"id": "c-dana", "name": "Dana", "emails": ["dana@alloi.us"]},
]


def _commitment_wrapper():
    return _claude_wrapper(commitments=[
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "send the updated MSA", "matches_open_item": None},
        {"text": "Book the Q4 review", "owner_name": "Josh", "deadline_iso": None,
         "quote": "Can you send", "matches_open_item": None},
    ])


def test_failure_after_the_first_page_write_completes_the_second_page_next_run(tmp_path):
    """G0B3-1: the run dies between two DISTINCT-page History writes. The first
    page landed; the second has not. Nothing may be `filed`, and the retry must
    write ONLY the missing page (never a second entry on the first)."""
    cfg = _cfg(tmp_path, dry_run=False, contacts=list(_TWO_PAGE_CONTACTS))
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_two_page_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    for cid in ("c-marcos", "c-dana"):
        runner.record(("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", cid),
                      rc=0, stdout=_interaction_stdout(contact_id=cid))

    # make the SECOND page write fail, from inside the renderer
    real_apply = csg.writeback_email.apply_history
    seen = {"n": 0}

    def _boom_on_second(page_text, entry):
        seen["n"] += 1
        if seen["n"] == 2:
            raise client_state_writes.WriterError("disk full on the second page")
        return real_apply(page_text, entry)

    csg.writeback_email.apply_history = _boom_on_second
    try:
        result = csg.run(cfg, runner)
    finally:
        csg.writeback_email.apply_history = real_apply

    assert result.exit_code == 3
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["partial"] is True
    assert [r["outcome"] for r in rows[0]["resolutions"]] == ["partial", "partial"]
    pages_written = [w for w in rows[0]["writes"] if w.endswith(".md")]
    assert len(pages_written) == 1                                     # exactly one page landed
    first_page = pages_written[0]
    assert sum(1 for r in rows[0]["resolutions"] if f"page:{first_page}" in r["effects"]) == 1

    # retry: the landed page is NOT rewritten, the missing one IS
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_two_page_payload()))
    _open_tasks_empty(runner2)
    result2 = csg.run(cfg, runner2)

    assert result2.exit_code == 0
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0          # cached
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner2.calls)  # CRM not replayed
    rows2 = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows2[-1]["partial"] is False
    assert all(r["outcome"] == "filed" for r in rows2[-1]["resolutions"])
    for slug in ("acme", "alloi"):
        text = _page_path(cfg, slug).read_text(encoding="utf-8")
        assert text.count("[source: gmail:m1]") == 1        # exactly once, never duplicated


def test_failure_after_the_first_task_completes_the_second_task_next_run(tmp_path):
    """G0B3-1: two commitments, so two tasks. The run dies after the first
    `create-task`. The old code had already set every resolution `filed` in the
    CRM phase, so the retry computed pending=[] and the second task was NEVER
    created. Now the resolutions stay un-filed until every task has landed."""
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_commitment_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    # first create-task wins, second fails
    runner.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    runner.record(("cortextos", "bus", "create-task"), rc=1, stdout="", stderr="bus down")

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    assert result.filed == 0

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["partial"] is True
    assert [r["outcome"] for r in rows[0]["resolutions"]] == ["partial"]
    landed = rows[0]["resolutions"][0]["effects"]
    assert "crm:c1" in landed
    assert "task:Send the updated MSA" in landed
    assert "task:Book the Q4 review" not in landed                     # the one that failed
    assert [w for w in rows[0]["writes"] if w.startswith("task:")] == \
        ["task:task_1757800000_00000001|Send the updated MSA"]

    # retry: only the MISSING task is created
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    runner2.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000002\n")
    result2 = csg.run(cfg, runner2)

    assert result2.exit_code == 0
    assert result2.filed == 1
    created = [c for c in runner2.calls if c[:3] == ["cortextos", "bus", "create-task"]]
    assert len(created) == 1
    assert created[0][3] == "Book the Q4 review"                       # G-EFFECT-1
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner2.calls)
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0
    rows2 = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert all(r["outcome"] == "filed" for r in rows2[-1]["resolutions"])
    assert _page_path(cfg).read_text(encoding="utf-8").count("[source: gmail:m1]") == 1


def test_a_filed_prior_resolution_is_carried_verbatim_not_re_evaluated():
    """G-MERGE-1, isolated. `_merge_resolutions` has two carry-forward branches:
    an ALREADY-FILED resolution is reused VERBATIM (outcome, reason and all),
    while a not-yet-filed one only donates its landed effect keys to the fresh
    resolution (G-MERGE-2). At integration level the two look alike -- the
    effects alone are enough to keep the writes from replaying -- so this pins
    the filed branch directly: the merged resolution must BE the prior object,
    carrying the prior `outcome` and `reason`, never the fresh re-evaluation."""
    from observation_ledger import ObservationRow, Resolution

    old = Resolution(slug="acme", kind="client", method="contact-email",
                     outcome="filed", reason="matched contact c1",
                     contact_id="c1", email="Marcos@Acme.org",
                     effects=["crm:c1", "page:raw/areas/clearworks/org-brain/clients/acme.md"])
    prior = ObservationRow(source_ref="gmail:m1", thread_id="t1", content_digest="d1",
                           observed_at="2026-09-14T12:00:00Z", resolutions=[old])
    fresh = [Resolution(slug="acme", kind="client", method="contact-email",
                        outcome="pending", reason="re-derived this run",
                        contact_id="c1", email="marcos@acme.org")]

    merged = csg._merge_resolutions(prior, fresh)

    assert len(merged) == 1
    assert merged[0] is old
    assert merged[0].outcome == "filed"
    assert merged[0].reason == "matched contact c1"


def test_a_prior_filed_resolution_the_resolver_no_longer_produces_is_carried(tmp_path):
    """G0B3-1 / G-MERGE-3: a counterparty we already filed but that this run's
    resolver no longer yields (its CRM contact was deleted) must stay on the
    row — dropping it would erase the record of a real write."""
    from observation_ledger import Ledger, ObservationRow, Resolution, content_digest

    cfg = _cfg(tmp_path, dry_run=False, contacts=list(_TWO_PAGE_CONTACTS))
    msg_payload = _two_page_payload()
    digest = content_digest("Renewal", "Can you send the updated MSA? Let's proceed.", "marcos@acme.org")
    led = Ledger(cfg.state_dir / "observations.jsonl")
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    led.append(ObservationRow(
        source_ref="gmail:m1", thread_id="t1", content_digest=digest,
        observed_at="2026-09-14T11:00:00+00:00",
        resolutions=[
            Resolution(slug="widget-co", kind="client", method="contact-email",
                       outcome="filed", contact_id="c-gone", email="gone@widget-co.test",
                       effects=["crm:c-gone", "page:raw/areas/clearworks/org-brain/clients/widget-co.md"]),
            # G2B-1: `partial` alone no longer vetoes terminality -- an
            # UNFINISHED resolution is what makes this row non-terminal, and it
            # is what a real mid-message failure would actually have left.
            Resolution(slug="", kind="", method="none", outcome="partial",
                       email="unfinished@widget-co.test"),
        ],
        writes=["crm:c-gone"], partial=True,
    ))

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(msg_payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    for cid in ("c-marcos", "c-dana"):
        runner.record(("python3", str(cfg.crm_dir / "add-interaction.py"), "--contact-id", cid),
                      rc=0, stdout=_interaction_stdout(contact_id=cid))

    assert csg.run(cfg, runner).exit_code == 0
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    slugs = {r["slug"] for r in rows[-1]["resolutions"]}
    assert slugs == {"acme", "alloi", "widget-co"}                     # G-MERGE-3
    carried = next(r for r in rows[-1]["resolutions"] if r["slug"] == "widget-co")
    assert carried["outcome"] == "filed" and carried["effects"] == [
        "crm:c-gone", "page:raw/areas/clearworks/org-brain/clients/widget-co.md"]
    # and it was NOT re-written
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] and "c-gone" in c for c in runner.calls)


def test_budget_exit_persists_the_paid_extraction_so_the_retry_pays_nothing(tmp_path):
    """G0B3-2: exit 12 must not throw away the call it already paid for. The
    partial row carries exc.extraction (with its identity, bound_slugs and
    context mapping), so the retry is a cache HIT and makes ZERO claude calls —
    FR-001's at-most-one-call-per-(source_ref, digest, slugs) is binding."""
    cfg = _cfg(tmp_path, dry_run=False, max_usd=0.01)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.05))

    result = csg.run(cfg, runner)
    assert result.exit_code == 12
    assert result.cost_usd == 0.05
    assert json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"] == "budget"

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["partial"] is True                                   # G-BUDGET-2, non-terminal
    assert rows[0]["writes"] == []
    ex = rows[0]["extraction"]
    assert ex["cost_usd"] == 0.05 and ex["model_receipt"] and ex["identity"]
    assert ex["bound_slugs"] == ["acme"] and "context" in ex
    from observation_ledger import Ledger
    assert Ledger(cfg.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[0]["content_digest"]) is False

    # retry with a bigger cap: ZERO further claude calls
    cfg2 = _cfg(tmp_path, dry_run=False, max_usd=2.0, vault=cfg.vault,
                crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg2.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    runner2.record(("python3", str(cfg2.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner2.record(("python3", str(cfg2.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    result2 = csg.run(cfg2, runner2)

    assert result2.exit_code == 0 and result2.filed == 1
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0   # the whole point
    assert result2.cost_usd == 0.0


def test_release_failure_exits_3_with_its_own_diagnostic_and_keeps_last_success_at(tmp_path):
    """G0B3-11: the run's WORK succeeded, so `last_success_at` is real and must
    stay — but the lock is still held, so the run cannot report 0."""
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=1, stdout="", stderr="claims dir read-only")
    lock = single_flight.lock_path(cfg.state_dir / "claims", "client-state-gmail")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.touch()
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([]))

    result = csg.run(cfg, runner)

    assert result.exit_code == 3
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert receipt["last_success_at"] == cfg.now.isoformat()   # the work really happened
    assert "error" not in receipt                              # the receipt is NOT falsified
    diag = json.loads((cfg.state_dir / "last-lease-release-failure.json").read_text())
    assert diag["error"] == "lease-release-failed"             # G-LOCK-7
    assert "read-only" in diag["detail"] and diag["failed_at"]


def test_dry_run_revision_then_live_revision_keeps_the_supersede_marker(tmp_path):
    """G0B3-3 / D-02: a dry-run of a CHANGED digest records revision_of. The
    later LIVE run sees that simulated row as `latest` with the SAME digest, so
    the plain rule computes revision_of=None — the page entry would ship
    unmarked and the live row would lose the supersede link."""
    # 1) an original live filing
    cfg = _cfg(tmp_path, dry_run=False)
    r1 = FakeRunner()
    _lock_ok(r1, cfg.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload(body="original text")))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=_claude_wrapper(summary="First pass."))
    r1.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r1.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    assert csg.run(cfg, r1).filed == 1
    first_digest = json.loads((cfg.state_dir / "observations.jsonl").read_text().splitlines()[0])["content_digest"]

    # 2) a DRY RUN of the edited message: records revision_of, writes nothing
    cfg_dry = _cfg(tmp_path, dry_run=True, vault=cfg.vault, crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    r2 = FakeRunner()
    _lock_ok(r2, cfg_dry.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload(body="EDITED materially different text")))
    _open_tasks_empty(r2)
    r2.record(("claude",), rc=0, stdout=_claude_wrapper(summary="Revised pass."))
    assert csg.run(cfg_dry, r2).filed == 1
    sim = json.loads((cfg.state_dir / "observations.jsonl").read_text().splitlines()[1])
    assert sim["simulated"] is True and sim["revision_of"] == first_digest

    # 3) the LIVE run of the same edited message
    r3 = FakeRunner()
    _lock_ok(r3, cfg.state_dir / "claims")
    r3.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r3.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload(body="EDITED materially different text")))
    _open_tasks_empty(r3)
    r3.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r3.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    assert csg.run(cfg, r3).filed == 1

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    live = rows[-1]
    assert live["simulated"] is False
    assert live["revision_of"] == first_digest                 # G-REV-1
    text = _page_path(cfg).read_text(encoding="utf-8")
    assert "Revised pass." in text
    assert "(revision of" in text                              # the page marker survives


def test_heartbeat_touches_through_a_long_sweep_and_a_long_extraction(tmp_path):
    """G0B3-6 / A2 (touch at most every 10 min, whole acquired interval).

    The clock is faked so a 14-day backfill sweep and one very slow extraction
    take simulated HOURS. Every runner call boundary is a tick, so the lease is
    touched throughout — the old once-per-message touch left the sweep and the
    extraction entirely uncovered and a live run's 60-minute lease could be
    declared stale under it."""
    ticks = {"t": 0.0}

    def fake_clock():
        return ticks["t"]

    cfg = _cfg(tmp_path, dry_run=True, days=14, clock=fake_clock)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    lock = single_flight.lock_path(cfg.state_dir / "claims", "client-state-gmail")

    # a full-window query at the 50 cap forces a day-sweep: 1 + 14 triage calls
    fifty = [{"id": f"m{i}", "threadId": "t"} for i in range(50)]
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps(fifty))
    for i in range(50):
        runner.record(("gws", "gmail", "+read", "--id", f"m{i}"), rc=0, stdout=json.dumps(
            _gmail_payload(mid=f"m{i}", from_email="stranger@unknown-domain.example")))

    # every runner call advances the simulated clock by 7 minutes
    inner_run = runner.run

    def slow_run(argv, *, input=None, env=None, timeout=120):
        ticks["t"] += 7 * 60
        return inner_run(argv, input=input, env=env, timeout=timeout)

    runner.run = slow_run
    mtimes = []
    real_touch = single_flight.Lease.touch

    def recording_touch(self):
        real_touch(self)
        mtimes.append(ticks["t"])

    single_flight.Lease.touch = recording_touch
    try:
        result = csg.run(cfg, runner)
    finally:
        single_flight.Lease.touch = real_touch

    assert result.exit_code == 0
    triage_calls = [c for c in runner.calls if c[:3] == ["gws", "gmail", "+triage"]]
    assert len(triage_calls) == 1 + 14                      # the long sweep really happened
    assert lock.exists()
    # touched many times, and never a gap wider than the 10-minute A2 bound
    assert len(mtimes) >= 10                                # G-LOCK-8
    gaps = [b - a for a, b in zip(mtimes, mtimes[1:])]
    assert max(gaps) <= 600, gaps
    assert mtimes[-1] - mtimes[0] > 3600                    # simulated hours, fully covered


def test_heartbeat_stops_the_run_the_moment_the_lock_disappears(tmp_path):
    """G0B3-6: loss detected at a tick stops the run before its next effect."""
    ticks = {"t": 0.0}
    cfg = _cfg(tmp_path, dry_run=False, clock=lambda: ticks["t"])
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))

    lock = single_flight.lock_path(cfg.state_dir / "claims", "client-state-gmail")
    inner_run = runner.run

    def sweeping_run(argv, *, input=None, env=None, timeout=120):
        ticks["t"] += 7 * 60
        if argv[:3] == ["gws", "gmail", "+triage"] and lock.exists():
            lock.unlink()          # a concurrent stale-sweep removes our lock
        return inner_run(argv, input=input, env=env, timeout=timeout)

    runner.run = sweeping_run
    result = csg.run(cfg, runner)

    assert result.exit_code == 3
    assert "lease disappeared" in json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"]
    assert not any(c[:3] == ["gws", "gmail", "+read"] for c in runner.calls)
    assert not any(c[:3] == ["cortextos", "bus", "meeting-brief-release"] for c in runner.calls)


def test_write_interaction_rejects_a_record_for_a_different_message(tmp_path):
    """G0B3-8: a parsed record proving a DIFFERENT gmail id is not proof THIS
    message was filed — the ledger would otherwise record a crm write whose
    interaction row never existed."""
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
                  stdout=_interaction_stdout(source_ref="gmail:SOME-OTHER-MESSAGE"))

    result = csg.run(cfg, runner)
    assert result.exit_code == 3
    err = json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"]
    assert "SOME-OTHER-MESSAGE" in err and "gmail:m1" in err


# --- G2a-2: partial progress survives ANY exception on the write path --------
# _persist_partial used to run only for WriterError/EscalationError. An OSError
# from page I/O (or client_file_lock), or a runner timeout, escaping AFTER an
# earlier CRM/page effect had landed skipped partial persistence entirely, so
# the retry re-resolved from nothing and replayed the landed effect -- a second
# CRM interaction row and a duplicate History entry.

def test_oserror_on_the_history_write_persists_the_landed_crm_effect(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    real_apply = csg.writeback_email.apply_history

    def _boom(page_text, entry):
        raise OSError(28, "No space left on device")

    csg.writeback_email.apply_history = _boom
    try:
        result = csg.run(cfg, runner)
    finally:
        csg.writeback_email.apply_history = real_apply

    assert result.exit_code == 3
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1, rows
    assert rows[0]["partial"] is True
    assert rows[0]["resolutions"][0]["outcome"] == "partial"
    assert "crm:c1" in rows[0]["resolutions"][0]["effects"]          # the CRM row DID land
    assert not any(e.startswith("page:") for e in rows[0]["resolutions"][0]["effects"])
    assert rows[0]["writes"] == ["crm:c1"]

    # retry: the CRM write is NOT replayed, the extraction is cached, the page completes
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    result2 = csg.run(cfg, runner2)

    assert result2.exit_code == 0
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner2.calls)
    rows2 = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows2[-1]["partial"] is False
    assert all(r["outcome"] == "filed" for r in rows2[-1]["resolutions"])
    assert _page_path(cfg).read_text(encoding="utf-8").count("[source: gmail:m1]") == 1


def test_runner_timeout_on_create_task_persists_the_landed_page_effect(tmp_path):
    """A subprocess.TimeoutExpired escaping the Runner on `bus create-task`
    after the CRM row and the History page have landed must still persist
    them, or the retry writes a SECOND History entry for the same message."""
    import subprocess as _sp

    cfg = _cfg(tmp_path, dry_run=False)

    class _TimeoutOnCreateTask(FakeRunner):
        def run(self, argv, **kw):
            if argv[:3] == ["cortextos", "bus", "create-task"]:
                self.calls.append(list(argv))
                raise _sp.TimeoutExpired(cmd=argv, timeout=120)
            return super().run(argv, **kw)

    runner = _TimeoutOnCreateTask()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(commitments=[
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "send the updated MSA", "matches_open_item": None},
    ]))
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    result = csg.run(cfg, runner)

    assert result.exit_code == 3
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1, rows
    assert rows[0]["partial"] is True
    effects = rows[0]["resolutions"][0]["effects"]
    assert "crm:c1" in effects
    assert any(e.startswith("page:") for e in effects)
    assert not any(e.startswith("task:") for e in effects)      # the timed-out task never landed

    # retry: only the missing task is created; the page keeps ONE entry
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    runner2.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    result2 = csg.run(cfg, runner2)

    assert result2.exit_code == 0
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner2.calls)
    assert _page_path(cfg).read_text(encoding="utf-8").count("[source: gmail:m1]") == 1
    rows2 = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert all(r["outcome"] == "filed" for r in rows2[-1]["resolutions"])


def test_budget_exit_in_a_dry_run_persists_a_SIMULATED_row(tmp_path):
    """G2A-2: a dry run that blows --max-usd persisted its budget row with
    simulated=false, so the ledger and the digest described a preview as a real
    run — and an ambiguous resolution on it could suppress the later LIVE
    escalation (escalated_for skips simulated rows only)."""
    cfg = _cfg(tmp_path, dry_run=True, max_usd=0.01)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.05))

    result = csg.run(cfg, runner)
    assert result.exit_code == 12
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["simulated"] is True


def test_budget_exit_in_a_live_run_stays_real(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False, max_usd=0.01)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.05))

    assert csg.run(cfg, runner).exit_code == 12
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["simulated"] is False


def _receipt_bytes(cfg) -> bytes:
    return (cfg.state_dir / "run-receipt.json").read_bytes()


def test_claim_operational_failure_exits_3_and_records_failure(tmp_path):
    """G2A-3: an unwritable claims dir is not lock contention. It must produce
    the structured failure receipt (exit 3), NOT a lock-held refusal that leaves
    the success receipt looking fresh."""
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=1, stdout="",
                  stderr="EACCES: permission denied, mkdir '/claims'")

    result = csg.run(cfg, runner)

    assert result.exit_code == 3
    assert not (cfg.state_dir / "last-lock-refusal.json").exists()
    assert "permission denied" in json.loads(_receipt_bytes(cfg))["error"]


def test_missing_claim_executable_exits_3(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)

    class _Missing(FakeRunner):
        def run(self, argv, **kw):
            self.calls.append(list(argv))
            if argv[:3] == ["cortextos", "bus", "meeting-brief-claim"]:
                raise FileNotFoundError(2, "No such file or directory: 'cortextos'")
            return super().run(argv, **kw)

    result = csg.run(cfg, _Missing())

    assert result.exit_code == 3
    assert not (cfg.state_dir / "last-lock-refusal.json").exists()
    assert "cortextos" in json.loads(_receipt_bytes(cfg))["error"]


def test_an_extraction_less_row_does_not_hide_the_paid_extraction(tmp_path):
    """G2A-7/G2B-2: a binding set that cycles (bound -> unknown -> bound again)
    put an extraction-LESS ignored row on top of the paid one. The cache lookup
    only looked at the latest row, so the identical (source_ref, digest, slugs)
    paid for claude a second time."""
    bound = [{"id": "c1", "name": "Marcos", "emails": ["marcos@zorp.example"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=False, max_usd=0.01, contacts=list(bound))
    contacts_json = cfg.crm_dir / "contacts.json"
    payload = _gmail_payload(from_email="marcos@zorp.example", from_name="Marcos")

    def _fresh(**over):
        return _cfg(tmp_path, dry_run=False, vault=cfg.vault, crm_dir=cfg.crm_dir,
                    state_dir=cfg.state_dir, **over)

    # run 1: the extraction is paid for and stamped, then the budget stops the run
    r1 = FakeRunner()
    _lock_ok(r1, cfg.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.05))
    assert csg.run(cfg, r1).exit_code == 12
    assert sum(1 for c in r1.calls if c and c[0] == "claude") == 1

    # run 2: the CRM contact vanishes, so the sender binds to nothing -> an
    # `ignored` row with NO extraction lands on top of the paid one
    contacts_json.write_text(json.dumps({"contacts": [], "source": "test", "version": 1}), encoding="utf-8")
    r2 = FakeRunner()
    cfg2 = _fresh(max_usd=2.0)
    _lock_ok(r2, cfg2.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    assert csg.run(cfg2, r2).exit_code == 0
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[-1]["extraction"] is None
    assert [r["outcome"] for r in rows[-1]["resolutions"]] == ["ignored"]

    # run 3: the contact comes back -> same source_ref/digest/slugs as run 1.
    # FR-001 is binding: ZERO further claude calls.
    contacts_json.write_text(json.dumps({"contacts": bound, "source": "test", "version": 1}), encoding="utf-8")
    r3 = FakeRunner()
    cfg3 = _fresh(max_usd=2.0)
    _lock_ok(r3, cfg3.state_dir / "claims")
    r3.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r3.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r3)
    r3.record(("python3", str(cfg3.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    result3 = csg.run(cfg3, r3)

    assert result3.exit_code == 0, result3.previews
    assert sum(1 for c in r3.calls if c and c[0] == "claude") == 0
    assert result3.filed == 1


def test_recovery_row_after_every_effect_landed_is_terminal(tmp_path):
    """G2B-1: the FIRST ledger append fails after every effect has landed and
    every resolution is filed. The recovery row must derive partial=False, so
    the next run skips the message instead of re-processing it forever."""
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    real_append = csg.Ledger.append
    seen = {"n": 0}

    def _flaky_append(self, row):
        seen["n"] += 1
        if seen["n"] == 1:
            raise OSError(28, "No space left on device")
        return real_append(self, row)

    csg.Ledger.append = _flaky_append
    try:
        result = csg.run(cfg, runner)
    finally:
        csg.Ledger.append = real_append

    assert result.exit_code == 3
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert all(r["outcome"] == "filed" for r in rows[0]["resolutions"])
    assert rows[0]["partial"] is False
    from observation_ledger import Ledger as _L
    assert _L(cfg.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[0]["content_digest"]) is True


# --- G2r2-9 (G2B-3): a landed effect is credited to EVERY resolution that needs it

def test_a_shared_crm_contact_credits_both_resolutions(tmp_path):
    """One CRM contact reachable at two addresses that bind to two DIFFERENT
    pages. The interaction row is written once (global crm:<id> dedup), but the
    second resolution never had the key copied onto it, so it could never be
    `filed` — the message stayed partial and every unchanged re-check appended
    another observation."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org", "marcos@alloi.us"]}]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    payload = _gmail_payload(from_email="marcos@acme.org", to=["marcos@alloi.us"])

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert {r["slug"] for r in rows[0]["resolutions"]} == {"acme", "alloi"}
    assert [r["outcome"] for r in rows[0]["resolutions"]] == ["filed", "filed"]
    assert all("crm:c1" in r["effects"] for r in rows[0]["resolutions"])
    assert rows[0]["partial"] is False
    # exactly ONE interaction row was written for the shared contact
    assert sum(1 for c in runner.calls if len(c) > 1 and "add-interaction.py" in c[1]) == 1

    # and the message is terminal, so an unchanged re-check appends NOTHING
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    assert csg.run(cfg, runner2).exit_code == 0
    rows2 = (cfg.state_dir / "observations.jsonl").read_text().splitlines()
    assert len(rows2) == 1


def test_a_late_resolution_on_an_already_written_page_is_credited(tmp_path):
    """G2B-3's page case: the History entry for a page is written once. A
    counterparty that only resolves on a LATER run and binds to that SAME page
    must inherit the landed page key, instead of waiting forever for a second
    entry that correctly never comes — the message stayed partial and every
    re-check appended another observation."""
    cfg = _cfg(tmp_path, dry_run=False, contacts=[])
    # let a CRM `company` bind to the acme page, the way alloi.md already does
    acme = _page_path(cfg, "acme")
    acme.write_text(acme.read_text(encoding="utf-8").replace(
        "domains: acme.org", "domains: acme.org\n\n- CRM org name: Acme Corp"), encoding="utf-8")
    payload = _gmail_payload(from_email="marcos@acme.org", to=["dana@zorp.example"])
    contacts_json = cfg.crm_dir / "contacts.json"
    wrapper = _claude_wrapper(commitments=[
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "send the updated MSA", "matches_open_item": None},
    ])

    # run 1: the sender's CRM row and the acme page land; the task creation dies,
    # so the row is PARTIAL and dana (unknown) produces no resolution at all.
    r1 = FakeRunner()
    _lock_ok(r1, cfg.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=wrapper)
    r1.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c-marcos\n")
    r1.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0,
              stdout=_interaction_stdout(contact_id="c-marcos"))
    r1.record(("cortextos", "bus", "create-task"), rc=1, stdout="", stderr="bus down")
    assert csg.run(cfg, r1).exit_code == 3
    assert acme.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1

    # run 2: dana turns up in the CRM bound to the SAME page
    contacts_json.write_text(json.dumps({"contacts": [
        {"id": "c-marcos", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Acme Corp"},
        {"id": "c-dana", "name": "Dana", "emails": ["dana@zorp.example"], "company": "Acme Corp"},
    ], "source": "test", "version": 1}), encoding="utf-8")
    cfg2 = _cfg(tmp_path, dry_run=False, vault=cfg.vault, crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    r2 = FakeRunner()
    _lock_ok(r2, cfg2.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r2)
    r2.record(("python3", str(cfg2.crm_dir / "add-interaction.py"), "--contact-id", "c-dana"), rc=0,
              stdout=_interaction_stdout(contact_id="c-dana"))
    r2.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    assert csg.run(cfg2, r2).exit_code == 0

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    dana = next(r for r in rows[-1]["resolutions"] if r["email"] == "dana@zorp.example")
    assert dana["outcome"] == "filed", rows[-1]["resolutions"]
    assert any(e.startswith("page:") for e in dana["effects"])
    assert all(r["outcome"] == "filed" for r in rows[-1]["resolutions"])
    assert rows[-1]["partial"] is False
    # the page still carries exactly ONE entry for this message
    assert acme.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1


# --- G2r2-10 (G2B-4): the page lock waits WITHOUT letting the lease go stale --

def test_a_held_page_lock_heartbeats_while_waiting_then_times_out(tmp_path, monkeypatch):
    """fcntl.flock(LOCK_EX) blocks in the KERNEL, where nothing can heartbeat.
    A page held by another process past the 60-minute claim TTL therefore let
    this run's own lease go stale, and the next cron cleared it and started a
    second concurrent run. The wait is now a timed non-blocking poll that ticks
    the heartbeat, and gives up loudly instead of hanging."""
    import fcntl as _fcntl

    ticks = {"t": 0.0}
    cfg = _cfg(tmp_path, dry_run=False, clock=lambda: ticks["t"])

    monkeypatch.setattr(csg, "PAGE_LOCK_TIMEOUT_S", 1800.0)
    monkeypatch.setattr(csg, "PAGE_LOCK_POLL_S", 5.0)
    monkeypatch.setattr(csg, "_page_lock_sleep", lambda s: ticks.__setitem__("t", ticks["t"] + s))

    touches = {"n": 0}
    real_touch = single_flight.Lease.touch

    def _counting_touch(self):
        touches["n"] += 1
        real_touch(self)

    # another process is holding this page's advisory lock
    page = _page_path(cfg, "acme")
    lock_path = page.with_name(page.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    holder = open(lock_path, "w", encoding="utf-8")
    _fcntl.flock(holder.fileno(), _fcntl.LOCK_EX)

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    single_flight.Lease.touch = _counting_touch
    try:
        result = csg.run(cfg, runner)
    finally:
        single_flight.Lease.touch = real_touch
        _fcntl.flock(holder.fileno(), _fcntl.LOCK_UN)
        holder.close()

    assert result.exit_code == 3
    err = json.loads((cfg.state_dir / "run-receipt.json").read_text())["error"]
    assert "page lock" in err and str(lock_path) in err
    # the lease was heartbeated THROUGH the wait, so it never went stale
    assert touches["n"] >= 5, touches
    # the page was never written
    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 0


def test_the_page_lock_is_taken_and_released_when_free(tmp_path):
    """The happy path still serialises: acquiring, writing and releasing the
    SAME sibling lockfile the meeting pipeline uses."""
    cfg = _cfg(tmp_path, dry_run=False)
    page = _page_path(cfg, "acme")
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    assert csg.run(cfg, runner).exit_code == 0
    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1
    # the lockfile path is byte-identical to meeting_writeback.client_file_lock's
    assert csg._page_lock_path(page) == page.with_name(page.name + ".lock")


# --- G2r2-11 (G2B-6): a dry run mutates NOTHING in the vault ------------------

def _vault_snapshot(vault: Path) -> dict[str, bytes]:
    """Every file under the vault with its bytes — a recursive listing, not just
    `git status --porcelain`, so a .gitignored artifact (which `*.md.lock` is)
    cannot hide."""
    return {
        str(p.relative_to(vault)): p.read_bytes()
        for p in sorted(vault.rglob("*")) if p.is_file()
    }


def test_dry_run_leaves_the_vault_byte_identical(tmp_path):
    """G2B-6: the dry-run branch sat INSIDE the advisory page lock, whose
    context manager mkdir's and opens <page>.md.lock with mode 'w' — creating or
    truncating a file inside the vault on a run that promises to write nothing.
    `*.md.lock` is gitignored, so porcelain alone would never have caught it."""
    import subprocess as _sp

    cfg = _cfg(tmp_path, dry_run=True)
    vault = cfg.vault
    _sp.run(["git", "init", "-q"], cwd=vault, check=True)
    _sp.run(["git", "add", "-A"], cwd=vault, check=True)
    _sp.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"],
            cwd=vault, check=True)

    before = _vault_snapshot(vault)

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    assert any("page diff for" in p for p in result.previews)   # it DID preview the write
    assert _vault_snapshot(vault) == before                      # ... and changed nothing
    assert not list(vault.rglob("*.md.lock"))
    porcelain = _sp.run(["git", "status", "--porcelain"], cwd=vault,
                        capture_output=True, text=True, check=True).stdout
    assert porcelain == "", porcelain


# --- G2r2-13: a PAID dry-run extraction survives a downstream failure --------

def test_dry_run_failure_after_extraction_persists_the_paid_extraction(tmp_path):
    """FR-001 is binding for dry runs too: the claude call was really made and
    really billed. _persist_partial returned early on cfg.dry_run, so a dry run
    that paid for the extraction and then blew up downstream kept NO row and no
    cache — and the next run paid again for identical input."""
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper(cost_usd=0.07))

    real_apply = csg.writeback_email.apply_history

    def _boom(page_text, entry):
        raise OSError(5, "Input/output error")

    csg.writeback_email.apply_history = _boom
    try:
        result = csg.run(cfg, runner)
    finally:
        csg.writeback_email.apply_history = real_apply

    assert result.exit_code == 3
    assert sum(1 for c in runner.calls if c and c[0] == "claude") == 1

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["simulated"] is True          # a PREVIEW, never a real run
    assert rows[0]["partial"] is True            # and never terminal
    assert rows[0]["writes"] == []
    assert rows[0]["planned_writes"] == []       # nothing was previewed to completion
    assert rows[0]["extraction"]["identity"]
    assert rows[0]["extraction"]["cost_usd"] == 0.07
    from observation_ledger import Ledger as _L
    assert _L(cfg.state_dir / "observations.jsonl").is_terminal("gmail:m1", rows[0]["content_digest"]) is False

    # the retry — dry OR live — is a cache hit and makes ZERO claude calls
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    assert csg.run(cfg, runner2).exit_code == 0
    assert sum(1 for c in runner2.calls if c and c[0] == "claude") == 0

    cfg_live = _cfg(tmp_path, dry_run=False, vault=cfg.vault, crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    runner3 = FakeRunner()
    _lock_ok(runner3, cfg_live.state_dir / "claims")
    runner3.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner3.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner3)
    runner3.record(("python3", str(cfg_live.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner3.record(("python3", str(cfg_live.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    assert csg.run(cfg_live, runner3).exit_code == 0
    assert sum(1 for c in runner3.calls if c and c[0] == "claude") == 0
    assert _page_path(cfg_live).read_text(encoding="utf-8").count("[source: gmail:m1]") == 1


def test_escalation_send_is_gated_on_a_source_event_key(tmp_path):
    """G2r3-2: the send goes through the bus's source-event dedup ledger, so a
    crash between a DELIVERED Telegram and this run's ledger append cannot
    re-page Josh on the next sweep."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=False, contacts=contacts)
    payload = _gmail_payload(from_email="marcos@acme.org", from_name="Marcos")
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    runner.record(("cortextos", "bus", "send-telegram"), rc=0, stdout="sent")

    assert csg.run(cfg, runner).exit_code == 0

    from observation_ledger import content_digest

    send = next(c for c in runner.calls if c[:3] == ["cortextos", "bus", "send-telegram"])
    digest = content_digest("Renewal", "Can you send the updated MSA? Let's proceed.", "marcos@acme.org")
    assert send[-4:] == ["--kind", "comms", "--source-key", f"clientstate:gmail.m1.{digest[:8]}"]


def test_dry_run_never_touches_the_shared_dedup_ledger(tmp_path):
    """The source-event ledger is a shared WRITE. A dry run previews the
    escalation and must not record it, or the later live run would be
    suppressed and Josh would never be paged."""
    contacts = [{"id": "c1", "name": "Marcos", "emails": ["marcos@acme.org"], "company": "Alloy"}]
    cfg = _cfg(tmp_path, dry_run=True, contacts=contacts)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0,
                  stdout=json.dumps(_gmail_payload(from_email="marcos@acme.org", from_name="Marcos")))

    assert csg.run(cfg, runner).exit_code == 0
    assert not any(c[:3] == ["cortextos", "bus", "send-telegram"] for c in runner.calls)
    assert not any("event-dedup" in c for c in runner.calls)


def test_a_dry_run_between_two_live_runs_does_not_hide_landed_effects(tmp_path):
    """G2r3-3: a SIMULATED row must not carry `filed` into a live run — nothing
    was written. But nulling the merge source outright ERASED the real partial
    work underneath it, so the live retry replayed the CRM write and appended a
    SECOND History entry for the same message."""
    cfg = _cfg(tmp_path, dry_run=False)
    page = _page_path(cfg, "acme")
    payload = _gmail_payload()
    wrapper = _claude_wrapper(commitments=[
        {"text": "Send the updated MSA", "owner_name": "Josh", "deadline_iso": None,
         "quote": "send the updated MSA", "matches_open_item": None},
    ])

    # run 1 (LIVE): CRM + History land, the task creation dies -> real partial row
    r1 = FakeRunner()
    _lock_ok(r1, cfg.state_dir / "claims")
    r1.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r1.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r1)
    r1.record(("claude",), rc=0, stdout=wrapper)
    r1.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r1.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    r1.record(("cortextos", "bus", "create-task"), rc=1, stdout="", stderr="bus down")
    assert csg.run(cfg, r1).exit_code == 3
    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1

    # run 2 (DRY): appends a simulated row on top of the real partial one
    cfg_dry = _cfg(tmp_path, dry_run=True, vault=cfg.vault, crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    r2 = FakeRunner()
    _lock_ok(r2, cfg_dry.state_dir / "claims")
    r2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r2)
    assert csg.run(cfg_dry, r2).exit_code == 0
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[-1]["simulated"] is True

    # run 3 (LIVE): only the missing task is created; nothing landed is replayed
    cfg3 = _cfg(tmp_path, dry_run=False, vault=cfg.vault, crm_dir=cfg.crm_dir, state_dir=cfg.state_dir)
    r3 = FakeRunner()
    _lock_ok(r3, cfg3.state_dir / "claims")
    r3.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r3.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(payload))
    _open_tasks_empty(r3)
    r3.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    assert csg.run(cfg3, r3).exit_code == 0

    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in r3.calls)   # CRM not replayed
    assert not any(len(c) > 1 and "upsert-contact.py" in c[1] for c in r3.calls)
    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1       # ONE entry, still
    rows3 = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert all(r["outcome"] == "filed" for r in rows3[-1]["resolutions"])
    assert rows3[-1]["partial"] is False


def test_a_page_entry_written_before_a_ledger_crash_is_not_appended_twice(tmp_path):
    """G2r3-4: the page write is atomic and lands BEFORE the ledger row. A crash
    in between left the entry on the page and NOTHING on the ledger, so the next
    run re-filed the message and appended a second identical History entry. The
    page itself is the record of what landed."""
    cfg = _cfg(tmp_path, dry_run=False)
    page = _page_path(cfg, "acme")

    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    real_append = csg.Ledger.append

    def _never_appends(self, row):
        raise OSError(28, "No space left on device")

    csg.Ledger.append = _never_appends
    try:
        assert csg.run(cfg, runner).exit_code == 3
    finally:
        csg.Ledger.append = real_append

    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1
    ledger_path = cfg.state_dir / "observations.jsonl"
    assert not ledger_path.exists() or ledger_path.read_text().strip() == ""

    # next run: the ledger remembers nothing, the PAGE does
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner2)
    runner2.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner2.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner2.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    assert csg.run(cfg, runner2).exit_code == 0

    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert all(r["outcome"] == "filed" for r in rows[-1]["resolutions"])


# --- G2r3-7: at-most-once vs an output the validator REJECTED ----------------
# FR-001's guarantee is no duplicate spend on a USABLE result. A rejected or
# indeterminate output produced nothing, so exactly ONE automatic retry is
# allowed — and then the identity freezes, so a poisoned message cannot bill
# forever in silence.

def _invalid_wrapper():
    """A claude result the schema validator rejects (no `summary`)."""
    return json.dumps({
        "type": "result", "subtype": "success",
        "result": json.dumps({"schema": "brain.email_extraction/1"}),
        "total_cost_usd": 0.01,
    })


def _extraction_runner(cfg, claude_stdout):
    r = FakeRunner()
    _lock_ok(r, cfg.state_dir / "claims")
    r.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    r.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(r)
    if claude_stdout is not None:
        r.record(("claude",), rc=0, stdout=claude_stdout)
    r.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    r.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    return r


def test_an_invalid_extraction_is_retried_exactly_once_then_frozen(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)

    # attempt 1: rejected
    r1 = _extraction_runner(cfg, _invalid_wrapper())
    assert csg.run(cfg, r1).exit_code == 3
    assert sum(1 for c in r1.calls if c and c[0] == "claude") == 1

    # attempt 2 (the ONE automatic retry): rejected again
    r2 = _extraction_runner(cfg, _invalid_wrapper())
    assert csg.run(cfg, r2).exit_code == 3
    assert sum(1 for c in r2.calls if c and c[0] == "claude") == 1

    # attempt 3: FROZEN — no further automatic calls, and the digest says so
    r3 = _extraction_runner(cfg, None)
    result3 = csg.run(cfg, r3)
    assert result3.exit_code == 0
    assert sum(1 for c in r3.calls if c and c[0] == "claude") == 0

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    frozen = rows[-1]
    assert frozen["extraction_attempt"]["frozen"] is True
    assert frozen["extraction_attempt"]["attempt"] == 2
    assert frozen["extraction_attempt"]["last_error"]
    assert frozen["partial"] is True

    import client_state_projections as _proj
    from observation_ledger import _row_from_dict

    lines = _proj.plan_digest_line(_row_from_dict(frozen))
    assert any("extraction failed twice — manual re-run" in ln for ln in lines), lines


def test_a_successful_extraction_clears_the_attempt_budget(tmp_path):
    """One rejected output must not spend the budget of the NEXT message state:
    a success clears the counter, and the cached success is never re-invoked."""
    cfg = _cfg(tmp_path, dry_run=False)

    r1 = _extraction_runner(cfg, _invalid_wrapper())
    assert csg.run(cfg, r1).exit_code == 3

    r2 = _extraction_runner(cfg, _claude_wrapper())
    assert csg.run(cfg, r2).exit_code == 0
    assert sum(1 for c in r2.calls if c and c[0] == "claude") == 1

    from observation_ledger import read_extraction_attempts
    assert read_extraction_attempts(cfg.state_dir) == {}

    # and the cached success is never re-invoked
    r3 = _extraction_runner(cfg, None)
    assert csg.run(cfg, r3).exit_code == 0
    assert sum(1 for c in r3.calls if c and c[0] == "claude") == 0


# --- G2r3-8: never synthesise a contact name from the address ----------------

def _nameless_payload():
    return _gmail_payload(from_email="marcos@acme.org", from_name="")


def test_a_sender_with_no_display_name_is_not_auto_created(tmp_path):
    """A contact row whose name is just the email address is CRM noise that a
    human then has to clean up. With no From display name there is no
    header-only fact worth creating a contact from — the page History entry is
    written either way."""
    cfg = _cfg(tmp_path, dry_run=False, contacts=[])
    page = _page_path(cfg, "acme")
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_nameless_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    assert result.filed == 1
    assert not any(len(c) > 1 and "upsert-contact.py" in c[1] for c in runner.calls)
    assert not any(len(c) > 1 and "add-interaction.py" in c[1] for c in runner.calls)
    assert page.read_text(encoding="utf-8").count("[source: gmail:m1]") == 1

    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    res = rows[-1]["resolutions"][0]
    assert res["outcome"] == "filed"
    assert res["contact_id"] is None
    assert res["reason"] == "crm: skipped (no display name)"


def test_the_dry_run_preview_says_the_contact_was_skipped(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True, contacts=[])
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_nameless_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())

    result = csg.run(cfg, runner)

    assert result.exit_code == 0
    block = "\n".join(result.previews)
    assert "CRM: skipped (no display name)" in block
    assert "would create contact" not in block
    assert "page diff for" in block          # the page write is still previewed


def test_a_named_sender_is_still_auto_created(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False, contacts=[])
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_payload()))
    _open_tasks_empty(runner)
    runner.record(("claude",), rc=0, stdout=_claude_wrapper())
    runner.record(("python3", str(cfg.crm_dir / "upsert-contact.py")), rc=0, stdout="c1\n")
    runner.record(("python3", str(cfg.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())

    assert csg.run(cfg, runner).exit_code == 0
    assert any(len(c) > 1 and "upsert-contact.py" in c[1] for c in runner.calls)
