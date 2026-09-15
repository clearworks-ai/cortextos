#!/usr/bin/env python3
"""Generate G4 item-3/5/6 POSITIVE fixtures from the REAL producers.

G0B2-5/G0B2-14: the checker's positive fixture used to be hand-written text
that invented tokens the producer never emits (`source_ref=gmail:...`), so the
selftest certified a format nothing produces. This runs the actual orchestrator
(client_state_gmail.run, --dry-run) and the actual digest
(client_state_digest.gmail_section) against a scratch vault/CRM with a
FakeRunner standing in for gws/claude/bus, and writes their real stdout,
ledger, receipt and digest into the fixture dir.

Usage: g4-gen-fixture.py <repo-root> <out-dir>
"""
from __future__ import annotations

import json
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

REPO = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(REPO / "scripts" / "brain"))
sys.path.insert(0, str(REPO / "scripts" / "brain" / "tests"))

from helpers_client_state import FakeRunner, make_crm_dir, make_vault  # noqa: E402

import client_state_digest as cs_digest  # noqa: E402
import client_state_gmail as csg  # noqa: E402
import single_flight  # noqa: E402
from observation_ledger import Ledger, read_receipt  # noqa: E402

PAYLOADS = {
    # G0B3-4: the G4 item-3 fixture must contain every OUTCOME SHAPE a real
    # inbox produces, not one specially rich filed message: a filed message with
    # decisions/commitments, a filed message with NO extracted items, an ignored
    # unknown sender, and an ambiguous (escalated) one.
    "filed_rich": None,          # filled from PAYLOAD below
    "filed_empty": None,
    "ignored": None,
    "escalated": None,
}

PAYLOAD = {
    "id": "19a1b2c3d4e5f", "threadId": "thread-1",
    "from": {"name": "Lori Bodenhamer", "email": "lori@acme.org"},
    "to": ["josh@clearworks.ai"], "cc": [],
    "subject": "Re: Q4 budget + SOW", "date": "2026-09-14T11:58:00Z",
    "body": "Confirmed the Q4 budget. Can you send the revised SOW?",
}
MODEL = {
    "schema": "brain.email_extraction/1",
    "summary": "Lori confirmed the Q4 budget and asked for the revised SOW.",
    "decisions": [{"text": "Q4 budget confirmed", "quote": "Confirmed the Q4 budget"}],
    "commitments": [{"text": "send the revised SOW", "owner_name": "Josh", "deadline_iso": None,
                     "quote": "send the revised SOW", "matches_open_item": None}],
    "open_questions": [],
}
WRAPPER = json.dumps({
    "type": "result", "subtype": "success", "result": json.dumps(MODEL),
    "total_cost_usd": 0.0421,
    "modelUsage": {"claude-sonnet-5": {"inputTokens": 2, "outputTokens": 4, "costUSD": 0.0421}},
})


def _payload(mid, from_name, from_email, subject, body):
    return {
        "id": mid, "threadId": f"thread-{mid}",
        "from": {"name": from_name, "email": from_email},
        "to": ["josh@clearworks.ai"], "cc": [],
        "subject": subject, "date": "2026-09-14T11:58:00Z", "body": body,
    }


EMPTY_MODEL = {
    "schema": "brain.email_extraction/1",
    "summary": "Marcos sent the deck for information only.",
    "decisions": [], "commitments": [], "open_questions": [],
}
EMPTY_WRAPPER = json.dumps({
    "type": "result", "subtype": "success", "result": json.dumps(EMPTY_MODEL),
    "total_cost_usd": 0.0104,
    "modelUsage": {"claude-sonnet-5": {"inputTokens": 2, "outputTokens": 2, "costUSD": 0.0104}},
})


def _runner(cfg):
    r = FakeRunner()
    r.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    r.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="ok")
    lock = single_flight.lock_path(cfg.state_dir / "claims", "client-state-gmail")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.touch()
    # FOUR messages, one per outcome shape (G0B3-4)
    quiet = _payload("19a1b2c3d4e60", "Marcos Ruiz", "marcos@acme.org",
                     "Deck for Thursday", "Attaching the deck. No action needed.")
    rando = _payload("19a1b2c3d4e61", "Rando", "rando@unknown-co.example",
                     "Quick question", "Do you do consulting?")
    ambiguous = _payload("19a1b2c3d4e62", "Dana Iyer", "dana@acme.org",
                         "Re: scope", "Let's align on scope.")
    r.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([
        {"id": "19a1b2c3d4e5f", "threadId": "thread-1"},
        {"id": "19a1b2c3d4e60", "threadId": "thread-19a1b2c3d4e60"},
        {"id": "19a1b2c3d4e61", "threadId": "thread-19a1b2c3d4e61"},
        {"id": "19a1b2c3d4e62", "threadId": "thread-19a1b2c3d4e62"},
    ]))
    r.record(("gws", "gmail", "+read", "--id", "19a1b2c3d4e5f"), rc=0, stdout=json.dumps(PAYLOAD))
    r.record(("gws", "gmail", "+read", "--id", "19a1b2c3d4e60"), rc=0, stdout=json.dumps(quiet))
    r.record(("gws", "gmail", "+read", "--id", "19a1b2c3d4e61"), rc=0, stdout=json.dumps(rando))
    r.record(("gws", "gmail", "+read", "--id", "19a1b2c3d4e62"), rc=0, stdout=json.dumps(ambiguous))
    r.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=0, stdout="[]")
    r.record(("cortextos", "bus", "list-tasks", "--open", "--class", "build"), rc=0, stdout="[]")
    r.record(("claude",), rc=0, stdout=WRAPPER)
    r.record(("claude",), rc=0, stdout=EMPTY_WRAPPER)     # the quiet message's own call
    return r


def _cfg(root: Path, now: datetime) -> csg.Config:
    root.mkdir(parents=True, exist_ok=True)
    return csg.Config(
        repo_root=root, vault=make_vault(root),
        crm_dir=make_crm_dir(root, [
            {"id": "lori-bodenhamer", "name": "Lori", "emails": ["lori@acme.org"]},
            {"id": "marcos-ruiz", "name": "Marcos", "emails": ["marcos@acme.org"]},
            # `company` maps to the Alloi page while the DOMAIN maps to Acme:
            # the genuine FR-004 ambiguity, so this sender escalates.
            {"id": "dana-iyer", "name": "Dana", "emails": ["dana@acme.org"], "company": "Alloy"},
        ]),
        state_dir=root / "state", days=3, query=None, dry_run=True, max_usd=2.0,
        today=now.date(), now=now,
    )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    scratch = OUT / "_scratch"
    if scratch.exists():
        shutil.rmtree(scratch)
    now = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)

    # --- item 3: the REAL dry-run stdout + its ledger + receipt -------------
    cfg = _cfg(scratch / "run1", now)
    result = csg.run(cfg, _runner(cfg))
    assert result.exit_code == 0 and result.filed >= 1, (result.exit_code, result.filed)
    assert result.ignored >= 1 and result.escalated >= 1, (result.ignored, result.escalated)
    stdout = "\n".join(result.previews) + "\n" + (
        f"filed={result.filed} escalated={result.escalated} ignored={result.ignored} "
        f"skipped_terminal={result.skipped_terminal} cost_usd={result.cost_usd:.4f}\n"
    )
    label = cfg.today.isoformat()
    (OUT / f"dry-run-{label}.txt").write_text(stdout, encoding="utf-8")
    shutil.copyfile(cfg.state_dir / "observations.jsonl", OUT / f"dry-run-{label}.ledger.jsonl")
    shutil.copyfile(cfg.state_dir / "run-receipt.json", OUT / "run-receipt.json")

    # --- item 5: real repeat run + real lock-held run + real stale reclaim --
    receipt_before = (cfg.state_dir / "run-receipt.json").read_bytes()
    rows_before = len((cfg.state_dir / "observations.jsonl").read_text().splitlines())
    r2 = _runner(cfg)
    result2 = csg.run(cfg, r2)
    rows_after = len((cfg.state_dir / "observations.jsonl").read_text().splitlines())
    second = {
        "second_run_rows_added": rows_after - rows_before,
        "second_run_claude_calls": sum(1 for c in r2.calls if c and c[0] == "claude"),
        "second_run_previews_count": len(result2.previews),
        "second_run_cost_delta_usd": round(result2.cost_usd, 4),
        "second_run_exit_code": result2.exit_code,
    }

    # third run: the claim CLI refuses (a live holder) -- receipt must be
    # BYTE-IDENTICAL and the cause must land in last-lock-refusal.json.
    receipt_before_third = (cfg.state_dir / "run-receipt.json").read_bytes()
    r3 = FakeRunner()
    # G2A-3: only a REAL already-claimed verdict is contention; any other
    # non-zero rc is now an operational failure (exit 3), so the fixture has to
    # speak the CLI's actual refusal language.
    r3.record(("cortextos", "bus", "meeting-brief-claim"), rc=1, stdout="",
              stderr="Already claimed client-state-gmail (already-claimed)")
    result3 = csg.run(cfg, r3)
    receipt_after_third = (cfg.state_dir / "run-receipt.json").read_bytes()
    refusal = json.loads((cfg.state_dir / "last-lock-refusal.json").read_text())

    # stale lock: the claim CLI reports stale-cleared, single_flight retries once and wins
    cfg4 = _cfg(scratch / "run4", now)
    r4 = FakeRunner()
    r4.record(("cortextos", "bus", "meeting-brief-claim"), rc=1, stdout="",
              stderr="Already claimed client-state-gmail (stale-cleared)")
    r4.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    r4.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="ok")
    lock4 = single_flight.lock_path(cfg4.state_dir / "claims", "client-state-gmail")
    lock4.parent.mkdir(parents=True, exist_ok=True)
    lock4.touch()
    r4.record(("gws", "gmail", "+triage"), rc=0, stdout=json.dumps([]))
    result4 = csg.run(cfg4, r4)
    claim_calls = [c for c in r4.calls if c[:3] == ["cortextos", "bus", "meeting-brief-claim"]]

    idem = dict(second)
    # NOTE (G0B2-7 / amended goal G4 item 5): there is deliberately NO
    # `second_run_receipt_unchanged` field. An ordinary repeated SUCCESSFUL run
    # legitimately rewrites the success receipt (last_success_at, cost_usd);
    # what the goal requires unchanged is the receipt across the LOCK-HELD
    # third run, asserted below as third_run_receipt_byte_identical.
    idem.update({
        "third_run_lock_held_processed": result3.filed != 0 or result3.skipped_terminal != 0,
        "third_run_exit_code": result3.exit_code,
        "third_run_receipt_byte_identical": receipt_after_third == receipt_before_third,
        "third_run_lock_refusal": refusal,
        "stale_lock_reclaimed_and_ran": result4.exit_code == 0,
        "stale_then_next_acquire_wins": len(claim_calls) == 2,
    })
    (OUT / "idempotency.json").write_text(json.dumps(idem, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # --- item 6: the REAL digest section over the dry-run ledger, with a
    # freshly written invariants baseline (the goal requires the invariants
    # section to read one and report zero NEW violations). -----------------
    cs_digest.main([
        "write-baseline", "--state-dir", str(cfg.state_dir), "--vault", str(cfg.vault),
    ])
    ledger = Ledger(cfg.state_dir / "observations.jsonl")
    lines = cs_digest.gmail_section(
        cfg.state_dir, cfg.vault, ledger, now + timedelta(minutes=30),
        window_days=3, runner=FakeRunner(),
    )
    digest = "\n".join(lines) + "\nFireflies error: FIREFLIES_API_KEY unset - section skipped\n"
    (OUT / "digest-dry-run.txt").write_text(digest, encoding="utf-8")

    shutil.rmtree(scratch, ignore_errors=True)
    print(f"g4-gen-fixture: wrote real producer output into {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
