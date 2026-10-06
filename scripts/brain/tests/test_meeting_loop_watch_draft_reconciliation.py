"""Draft-only terminal contract: read evidence, never register recovery or send Gmail."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

import meeting_loop_watch as watch
from test_meeting_loop_watch_manual_recovery import ERROR, _recovery_fixture, _write_json
from test_meeting_loop_watch_supersession import _seed_incomplete

STATUS = "manually reconciled: CRM debrief complete; recap draft created/surfaced; not sent; proposals open."
SYNTHETIC_ID = "SYNTHETIC_DRAFT_RECONCILIATION"
RJS_ID = "01M3MP6NSTWY20FFAVG67K5H09"


def _pin(path):
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def _row_hash(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _draft_case(tmp_path, monkeypatch, *, exact_rjs=False):
    mid = RJS_ID if exact_rjs else SYNTHETIC_ID
    title = "RJ Smith and Josh Weiss" if exact_rjs else "Synthetic recap meeting"
    account = "josh@clearworks.ai" if exact_rjs else "operator@example.test"
    recipient = "rj@rjsmith.co" if exact_rjs else "customer@example.test"
    draft_id = "r2931824637162790758" if exact_rjs else "r1111111111111111111"
    gmail_id = "1a10e16722df9564" if exact_rjs else "1111111111111111"
    sender = f"Josh Weiss <{account}>" if exact_rjs else f"Operator <{account}>"
    subject = "RJS AI workflow recap and next steps" if exact_rjs else "Synthetic recap"
    crm_id = "task_1791234069478_56501479" if exact_rjs else "task_synthetic_crm"
    draft_task_id = "task_1791237714458_91915692" if exact_rjs else "task_synthetic_draft"
    proposal_ids = (["followup-rj-smith-2026-10-12-fef56f8de5", "followup-rj-smith-2026-10-12-0e3278b12c"]
                    if exact_rjs else ["proposal-synthetic-discovery", "proposal-synthetic-executive"])
    ack, error_path, rows, sent = _recovery_fixture(
        tmp_path, monkeypatch, meeting_id=mid, account=account, recipient=recipient,
        draft_id=draft_id, gmail_message_id=f"gmail:{gmail_id}", label_ids=("DRAFT",),
    )
    source_path = watch.ENVELOPES / mid / "source.json"
    source = json.loads(source_path.read_text())
    source["title"] = title
    _write_json(source_path, source)
    rows[0]["title"] = title
    crm_result = ("RJ Smith transcript ingested; meeting recorded positive; opportunity advanced lead to qualified; "
                  "two proposal tracks and Procore clarification logged") if exact_rjs else "Synthetic CRM debrief complete; two proposals remain open"
    draft_result = (f"Created and independently verified unsent Gmail draft {draft_id} for exact Fireflies meeting "
                    f"{mid}, {title}. To {recipient}; DRAFT label present; meeting-specific recap and next steps; "
                    "surfaced link to Josh. GBK draft remained restored and untouched.")
    docs = {
        "crm": {"id": crm_id, "status": "completed", "result": crm_result, "completed_at": "2026-10-05T21:06:11Z"},
        "draft": {"id": draft_task_id, "status": "completed", "result": draft_result,
                  "created_at": "2026-10-05T22:01:54Z", "completed_at": "2026-10-05T22:02:14Z"},
        "headers": {"timestamp": "2026-10-06T01:50:33.000Z", "text":
                    f"Result rc=0:\n- id: {gmail_id}\n- threadId: {gmail_id}\n- From: {sender}\n"
                    f"- To: {recipient}\n- Subject: {subject}\n- Date: Mon, 5 Oct 2026 17:01:54 -0500\n- labels: [DRAFT]\n"},
    }
    proposals = [{"id": pid, "source_ref": f"fireflies:{mid}", "status": "open"} for pid in proposal_ids]
    live_before = {}
    if exact_rjs:
        root = Path("/Users/joshweiss/.cortextos/cortextos1")
        vault = Path("/Users/joshweiss/code/knowledge-sync/raw/media/transcripts")
        live_paths = {
            "source": vault / "fireflies" / mid / "source.json",
            "error": vault / "_state" / f"fireflies-{mid}" / "processing-error.json",
            "crm": root / "orgs/clearworksai/tasks" / f"{crm_id}.json",
            "draft": root / "orgs/clearworksai/tasks" / f"{draft_task_id}.json",
            "headers": root / "processed/larry-codex/0-1791251433664-from-pa-codex-i4yo2.json",
            "proposals": Path("/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm-codex/crm/followups.jsonl"),
        }
        if all(p.is_file() for p in live_paths.values()):
            live_before = {p: p.read_bytes() for p in live_paths.values()}
            source_path.write_bytes(live_before[live_paths["source"]])
            error_path.write_bytes(live_before[live_paths["error"]])
            docs = {k: json.loads(live_before[live_paths[k]]) for k in docs}
            proposals = [json.loads(line) for line in live_before[live_paths["proposals"]].splitlines()
                         if json.loads(line).get("id") in proposal_ids]
    files = {}
    for name, doc in docs.items():
        files[name] = tmp_path / f"{name}.json"
        _write_json(files[name], doc)
    files["proposals"] = tmp_path / "followups.jsonl"
    files["proposals"].write_text("".join(json.dumps(row) + "\n" for row in proposals))
    rec = ack["verified_manual_recoveries"][mid]
    rec.update({
        "scope": "recap_draft_created_and_surfaced", "meeting_title": title,
        "source_evidence": _pin(source_path), "error_evidence": _pin(error_path),
        "identity_evidence": _pin(files["headers"]),
        "from_header": sender, "to_header": recipient, "subject": subject, "thread_id": gmail_id,
        "draft_created_at": "2026-10-05T22:01:54Z", "surfaced_at": "2026-10-05T22:02:14Z",
        "verified_at": "2026-10-06T01:50:33.000Z",
        "crm_task": {**_pin(files["crm"]), "task_id": docs["crm"]["id"], "result": docs["crm"]["result"]},
        "draft_task": {**_pin(files["draft"]), "task_id": docs["draft"]["id"], "result": docs["draft"]["result"]},
        "crm_task_id": crm_id, "draft_task_id": draft_task_id,
        "excluded_proposals": [{"path": str(files["proposals"]), "id": row["id"], "sha256": _row_hash(row)} for row in proposals],
    })
    return ack, rec, error_path, rows, sent, files, live_before


@pytest.mark.parametrize("exact_rjs", [False, True])
def test_completed_crm_and_surfaced_draft_reconcile_only_exact_failure(exact_rjs, tmp_path, monkeypatch, capsys):
    ack, rec, error_path, rows, sent, _, live_before = _draft_case(tmp_path, monkeypatch, exact_rjs=exact_rjs)
    _seed_incomplete(tmp_path, mid="SYNTHETIC_UNRECOVERED", title="Unrecovered failure",
                     date_string="2026-10-05T23:00:00Z", error_doc={**ERROR, "message": "unrelated active failure"})
    rows.append({"id": "SYNTHETIC_UNRECOVERED", "dateString": "2026-10-05T23:00:00Z"})
    watch._save_ack(ack)  # Operator persistence in the fixture only.
    assert watch._load_ack() == ack
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}

    def forbidden(*args, **kwargs):
        raise AssertionError("watcher must not mutate recovery, Gmail, proposals or errors")

    monkeypatch.setattr(watch, "_save_ack", forbidden)
    monkeypatch.setattr(watch, "atomic_write", forbidden)
    monkeypatch.setattr(watch.subprocess, "run", forbidden)
    for flags in ([], ["--dry-run"], ["--send"]):
        assert watch.main([*flags, "--days", "30"]) == 0
        out = capsys.readouterr().out.rstrip("\n")
        assert rec["meeting_id"] not in out and "Extra data" not in out
        assert "SYNTHETIC_UNRECOVERED" in out and "unrelated active failure" in out
        assert STATUS in out
        assert "canonical processing remains unverified" in out and "all filed" not in out
        assert len(sent) == (1 if flags == ["--send"] else 0)
    assert sent == [out]
    assert before == {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert all(p.read_bytes() == blob for p, blob in live_before.items())
    assert not error_path.with_name("receipt.json").exists()


@pytest.mark.parametrize(("field", "value"), [
    ("surfaced_at", None), ("surfaced_at", "2026-10-05T22:00:00Z"),
    ("draft_created_at", "2026-10-05T20:00:00Z"), ("verified_at", "2026-10-05T22:02:00Z"),
    ("draft_created_at", "2026-10-05T22:01:54"), ("verified_at", "bad"),
    ("meeting_title", "Wrong meeting"), ("meeting_id", "OTHER_MEETING"),
    ("draft_id", "r8888888888888888888"), ("gmail_message_id", "gmail:0000000000000000"),
    ("from_header", "Other <wrong@example.test>"), ("to_header", "wrong@example.test"),
    ("subject", "Wrong subject"), ("thread_id", "0000000000000000"),
    ("crm_task", None), ("draft_task", None), ("identity_evidence", None),
    ("source_evidence", None), ("error_evidence", None), ("excluded_proposals", []),
    ("crm_task_id", "wrong-task"), ("draft_task_id", "wrong-task"),
    ("sent_at", "2026-10-05T22:01:54Z"), ("sent", True),
])
def test_draft_record_missing_or_inconsistent_evidence_alerts(field, value, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, sent, _, _ = _draft_case(tmp_path, monkeypatch)
    rec[field] = value
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--send", "--days", "30"]) == 0
    out = capsys.readouterr().out.rstrip("\n")
    assert sent == [out] and SYNTHETIC_ID in out and "recorded processing failure" in out
    assert STATUS not in out and "Fireflies section error" not in out


@pytest.mark.parametrize("sink", ["crm", "draft"])
@pytest.mark.parametrize("change", ["missing", "noncompleted", "wrong_id", "wrong_result", "changed_hash", "wrong_complete_task", "malformed_result"])
def test_both_task_receipts_are_required_and_exact(sink, change, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    task = json.loads(files[sink].read_text())
    ref = rec[f"{sink}_task"]
    if change == "missing":
        files[sink].unlink()
    else:
        if change == "noncompleted":
            task["status"] = "in_progress"
        elif change == "wrong_id":
            task["id"] = "wrong-task"
        elif change == "wrong_result":
            task["result"] = "Unrelated completed task"
        elif change == "wrong_complete_task":
            task["id"] = ref["task_id"] = "wrong-task"
        elif change == "malformed_result":
            task["result"] = ref["result"] = [SYNTHETIC_ID, rec["meeting_title"], rec["draft_id"], rec["recipient"], "surfaced"]
        else:
            task["extra"] = "modified after verification"
        digest = _write_json(files[sink], task)
        if change != "changed_hash":
            ref["sha256"] = digest
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


@pytest.mark.parametrize("change", ["no_surfacing", "negated_surfacing", "created_at", "completed_at", "missing_timestamp"])
def test_draft_completion_must_prove_surfacing_and_ordering(change, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    task = json.loads(files["draft"].read_text())
    if change == "no_surfacing":
        task["result"] = task["result"].replace("surfaced link to Josh", "retained locally")
        rec["draft_task"]["result"] = task["result"]
    elif change == "negated_surfacing":
        task["result"] = task["result"].replace("surfaced link to Josh", "not surfaced link to Josh")
        rec["draft_task"]["result"] = task["result"]
    elif change == "missing_timestamp":
        del task["completed_at"]
    else:
        task[change] = "2026-10-05T21:00:00Z"
    rec["draft_task"]["sha256"] = _write_json(files["draft"], task)
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


@pytest.mark.parametrize(("old", "new"), [
    ("[DRAFT]", "[SENT]"), ("[DRAFT]", "[DRAFT, SENT]"),
    ("Result rc=0:", "Result rc=1:"), ("- id: 1111111111111111", "- id: 2222222222222222"),
    ("- From: Operator <operator@example.test>", "- From: Wrong <wrong@example.test>"),
    ("- To: customer@example.test", "- To: other@example.test"),
    ("- Subject: Synthetic recap", "- Subject: Wrong recap"),
    ("- labels: [DRAFT]", "- labels: [DRAFT]\n- labels: [SENT]"),
])
def test_header_receipt_must_prove_exact_unsent_draft(old, new, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    evidence = json.loads(files["headers"].read_text())
    evidence["text"] = evidence["text"].replace(old, new)
    rec["identity_evidence"]["sha256"] = _write_json(files["headers"], evidence)
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


@pytest.mark.parametrize("change", ["missing", "duplicate", "closed", "sent", "wrong_source", "changed_hash"])
def test_proposals_remain_separate_open_and_exact(change, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    rows = [json.loads(line) for line in files["proposals"].read_text().splitlines()]
    if change == "missing":
        rows.pop()
    elif change == "duplicate":
        rows.append(rows[0])
    else:
        if change == "closed":
            rows[0]["status"] = "completed"
        elif change == "sent":
            rows[0]["sent"] = True
        elif change == "wrong_source":
            rows[0]["source_ref"] = "fireflies:OTHER_MEETING"
        else:
            rows[0]["reason"] = "changed after verification"
        if change != "changed_hash":
            rec["excluded_proposals"][0]["sha256"] = _row_hash(rows[0])
    files["proposals"].write_text("".join(json.dumps(row) + "\n" for row in rows))
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


def test_unrelated_ledger_append_does_not_invalidate_pinned_proposal_rows(tmp_path, monkeypatch, capsys):
    ack, _, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    with files["proposals"].open("a") as stream:
        stream.write('{"id":"unrelated","status":"open"}\n')
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert STATUS in capsys.readouterr().out


def test_same_meeting_new_error_hash_remains_active(tmp_path, monkeypatch, capsys):
    ack, _, error_path, _, _, _, _ = _draft_case(tmp_path, monkeypatch)
    _write_json(error_path, {**ERROR, "message": "new failed attempt"})
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    out = capsys.readouterr().out
    assert SYNTHETIC_ID in out and "new failed attempt" in out and STATUS not in out


def test_ambiguous_successful_header_blocks_fail_closed(tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    evidence = json.loads(files["headers"].read_text())
    evidence["text"] += "\n" + evidence["text"].replace("[DRAFT]", "[SENT]")
    rec["identity_evidence"]["sha256"] = _write_json(files["headers"], evidence)
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


@pytest.mark.parametrize("ref", ["source_evidence", "error_evidence", "identity_evidence"])
def test_changed_pinned_evidence_fails_closed(ref, tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, _, _ = _draft_case(tmp_path, monkeypatch)
    rec[ref]["sha256"] = "0" * 64
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out


def test_draft_reconciliation_survives_fresh_process(tmp_path, monkeypatch):
    ack, _, _, _, _, _, _ = _draft_case(tmp_path, monkeypatch)
    watch._save_ack(ack)
    script = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import meeting_loop_watch as watch
watch.ENVELOPES, watch.STATE, watch.ACK_PATH = map(Path, sys.argv[2:5])
watch.envparse.parse_env_file = lambda p: {'FIREFLIES_API_KEY': 'synthetic'}
watch.list_transcripts = lambda *a, **k: [{'id': sys.argv[5], 'dateString': '2026-10-05T20:30:00Z'}]
watch._probe = lambda u: 'ok'
sent = []
watch.send_telegram = lambda content: sent.append(content) or True
assert watch.main(['--send', '--days', '36500']) == 0
assert len(sent) == 1 and sys.argv[5] not in sent[0]
assert sys.argv[6] in sent[0]
"""
    result = subprocess.run([sys.executable, "-c", script, str(Path(watch.__file__).parent),
                             str(watch.ENVELOPES), str(watch.STATE), str(watch.ACK_PATH), SYNTHETIC_ID, STATUS],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


def test_malformed_message_id_is_not_blessed_by_matching_header_text(tmp_path, monkeypatch, capsys):
    ack, rec, _, _, _, files, _ = _draft_case(tmp_path, monkeypatch)
    rec["gmail_message_id"] = "not-a-gmail-id"
    evidence = json.loads(files["headers"].read_text())
    evidence["text"] = evidence["text"].replace("- id: 1111111111111111", "- id: not-a-gmail-id")
    rec["identity_evidence"]["sha256"] = _write_json(files["headers"], evidence)
    _write_json(watch.ACK_PATH, ack)
    assert watch.main(["--dry-run", "--days", "30"]) == 0
    assert SYNTHETIC_ID in capsys.readouterr().out
