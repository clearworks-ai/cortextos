"""Task 8 (C7): poller skeleton -- lock, sweep(extra_query), merge, escalation
gating, receipt persisted (including in dry-run), record_failure on every
failure path, no `del cfg` bug."""
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
import single_flight


def _lock_ok(runner: FakeRunner, claims_dir: Path) -> None:
    """The real `cortextos bus meeting-brief-claim` CLI creates the lock file on
    the filesystem; FakeRunner only fakes the rc/stdout, so the test must create
    it too -- Lease.touch() calls os.utime() on that exact path."""
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="ok")
    lock_file = single_flight.lock_path(claims_dir, "client-state-gmail")
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file.touch()


def _cfg(tmp_path: Path, dry_run: bool, **overrides) -> csg.Config:
    vault = make_vault(tmp_path)
    crm_dir = make_crm_dir(tmp_path, overrides.pop("contacts", []))
    defaults = dict(
        repo_root=tmp_path, vault=vault, crm_dir=crm_dir, state_dir=tmp_path / "state",
        days=3, query=None, dry_run=dry_run, max_usd=2.0,
        today=date(2026, 9, 14), now=datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    return csg.Config(**defaults)


def _gmail_msg(mid="m1", from_email="marcos@acme.org", subject="Renewal", body="Let's renew."):
    return {
        "id": mid, "threadId": "t1", "from": {"name": "Marcos", "email": from_email},
        "to": ["josh@clearworks.ai"], "cc": [], "subject": subject,
        "date": "2026-09-14T10:00:00Z", "body": body,
    }


def test_lock_held_exit_2_and_receipt_persisted(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=1, stdout="", stderr="held")
    result = csg.run(cfg, runner)
    assert result.exit_code == 2
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert receipt["error"] == "lock-held"


def test_gws_failure_exit_3_preserves_last_success_at(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    # first: a clean successful run establishes last_success_at
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([]))
    csg.run(cfg, runner)
    first_receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert first_receipt.get("error") is None

    # second: gws now fails -- exit 3, error persisted, last_success_at carried forward
    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=1, stdout="", stderr="gmail api quota exceeded")
    result = csg.run(cfg, runner2)
    assert result.exit_code == 3
    receipt = json.loads((cfg.state_dir / "run-receipt.json").read_text())
    assert "quota exceeded" in receipt["error"]
    assert receipt["last_success_at"] == first_receipt["last_success_at"]


def test_dry_run_persists_ledger_and_receipt(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_msg()))

    result = csg.run(cfg, runner)
    assert result.exit_code == 0
    assert result.filed == 1
    assert (cfg.state_dir / "observations.jsonl").exists()
    assert (cfg.state_dir / "run-receipt.json").exists()
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["resolutions"][0]["outcome"] == "filed"


def test_second_identical_dry_run_appends_nothing(tmp_path):
    cfg = _cfg(tmp_path, dry_run=True)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_msg()))
    csg.run(cfg, runner)
    rows_after_first = (cfg.state_dir / "observations.jsonl").read_text().splitlines()

    runner2 = FakeRunner()
    _lock_ok(runner2, cfg.state_dir / "claims")
    runner2.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner2.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_gmail_msg()))
    result2 = csg.run(cfg, runner2)
    rows_after_second = (cfg.state_dir / "observations.jsonl").read_text().splitlines()

    assert result2.skipped_terminal == 1
    assert rows_after_second == rows_after_first


def test_ignored_message_reason_set(tmp_path):
    cfg = _cfg(tmp_path, dry_run=False)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([{"id": "m1", "threadId": "t1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(
        _gmail_msg(from_email="stranger@unknown-domain.example")
    ))
    result = csg.run(cfg, runner)
    assert result.ignored == 1
    rows = [json.loads(l) for l in (cfg.state_dir / "observations.jsonl").read_text().splitlines()]
    assert rows[0]["resolutions"][0]["reason"] == "no-known-entity"


def test_backfill_query_composes_exclusion_and_day_sweep(tmp_path):
    """G0A-5: --query goes through sweep(extra_query=...) -- the exclusion clause
    and day-sweep cap still apply on the manual-backfill path."""
    cfg = _cfg(tmp_path, dry_run=True, query="from:marcos@acme.org", days=2)
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    fifty = [{"id": f"m{i}", "threadId": "t"} for i in range(50)]
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps(fifty))
    for i in range(50):
        runner.record(("gws", "gmail", "+read", "--id", f"m{i}"), rc=0, stdout=json.dumps(
            _gmail_msg(mid=f"m{i}", from_email="stranger@unknown-domain.example")
        ))
    csg.run(cfg, runner)
    triage_calls = [c for c in runner.calls if c[:3] == ["gws", "gmail", "+triage"]]
    assert len(triage_calls) == 1 + cfg.days  # full window + one per day
    for call in triage_calls:
        query = call[call.index("--query") + 1]
        assert "from:marcos@acme.org" in query
        assert "-category:promotions" in query  # EXCLUSION_QUERY present
