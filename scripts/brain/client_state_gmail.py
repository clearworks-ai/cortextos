#!/usr/bin/env python3
"""Client State v1 -- Gmail poller skeleton (Task 8 / C7). Acquires the FR-002
single-flight lock, sweeps the window (or a manual --query backfill, through the
SAME sweep() so FR-003's exclusion clause and FR-002's 50-cap day-sweep are never
bypassed -- G0A-5), resolves each message, merges the fresh resolution set against
the latest same-digest ledger row so an already-filed resolution is never
re-processed (G0B-3), and files every not-yet-filed resolution as a STUB write
(writes=[], no extraction/CRM/History/task calls yet -- Task 15 replaces
_file_message's body with the real pipeline). Every failure path persists its
cause via observation_ledger.record_failure (G0A-4/G0A-6/G0B-6/G0B-18)."""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import gmail_source
import resolve_email
import single_flight
from gmail_source import GmailSourceError
from observation_ledger import Ledger, ObservationRow, Resolution, content_digest, record_failure, write_receipt
from resolve_meeting import load_closed_sets


@dataclass
class Config:
    repo_root: Path
    vault: Path
    crm_dir: Path
    state_dir: Path
    days: int
    query: str | None
    dry_run: bool
    max_usd: float
    today: date
    now: datetime


@dataclass
class RunResult:
    exit_code: int
    filed: int = 0
    ignored: int = 0
    escalated: int = 0
    skipped_terminal: int = 0
    cost_usd: float = 0.0
    truncation: list[dict] = field(default_factory=list)
    previews: list[str] = field(default_factory=list)


def _resolution_key(r: Resolution) -> tuple[str, str | None, str]:
    return (r.slug, r.contact_id, r.email)


def _resolution_signature(resolutions: list[Resolution]) -> frozenset:
    return frozenset((r.slug, r.contact_id, r.email, r.outcome, r.reason) for r in resolutions)


def _merge_resolutions(prior_same_digest: ObservationRow | None, fresh: list[Resolution]) -> list[Resolution]:
    """G0B-3: carry forward every resolution ALREADY filed on the prior row for
    this exact digest (never re-process it); re-evaluate everything else afresh
    (an escalated/ignored resolution is re-checked every run per FR-001 -- a
    cheap closed-sets re-check, no LLM call)."""
    if prior_same_digest is None:
        return fresh
    prior_by_key = {_resolution_key(r): r for r in prior_same_digest.resolutions}
    merged: list[Resolution] = []
    for r in fresh:
        old = prior_by_key.get(_resolution_key(r))
        if old is not None and old.outcome == "filed":  # G-MERGE-1
            merged.append(old)
        else:
            merged.append(r)
    return merged


def _file_message_stub(cfg: Config, ledger: Ledger, msg, resolver, previews: list[str]) -> tuple[int, int, int]:
    """Task 8's placeholder filing: marks every not-yet-filed resolution 'filed'
    with NO real CRM/History/task writes (writes=[]) -- proves the lock/sweep/
    merge/escalation/ledger/receipt scaffolding before Task 15 wires in the real
    extraction+writes pipeline."""
    source_ref = f"gmail:{msg.id}"
    digest = content_digest(msg.subject, msg.body_text, msg.from_email)
    prior = ledger.latest(source_ref)
    same_digest_prior = prior if (prior is not None and prior.content_digest == digest) else None
    revision_of = prior.content_digest if (prior is not None and prior.content_digest != digest) else None

    fresh = resolver.resolve_message(msg)
    resolutions = _merge_resolutions(same_digest_prior, fresh)

    pending = [r for r in resolutions if r.outcome == "pending"]
    escalated = [r for r in resolutions if r.outcome == "escalated"]
    ignored = [r for r in resolutions if r.outcome == "ignored"]

    if same_digest_prior is not None and not pending:
        if _resolution_signature(resolutions) == _resolution_signature(same_digest_prior.resolutions):  # G-IDEMP-2
            return 0, len(escalated), len(ignored)  # no-change re-check: write nothing

    escalation_text = None
    if escalated and not ledger.escalated_for(source_ref, digest):  # G-ESC-1
        escalation_text = (
            f"Client State: ambiguous Gmail message from {msg.from_name} <{msg.from_email}> "
            f"subject={msg.subject!r} — gmail:{msg.id}"
        )
        if cfg.dry_run:
            previews.append(escalation_text)

    for r in pending:
        r.outcome = "filed"

    row = ObservationRow(
        source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
        observed_at=cfg.now.isoformat(), resolutions=resolutions, revision_of=revision_of,
    )
    ledger.append(row)  # persisted in BOTH dry-run and live -- C7

    if cfg.dry_run:
        if pending or not resolutions:
            previews.append(f"[dry-run] {source_ref}: filed={len(pending)} escalated={len(escalated)} ignored={len(ignored)}")

    return len(pending), len(escalated), len(ignored)


def run(cfg: Config, runner) -> RunResult:
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    claims_dir = cfg.state_dir / "claims"
    lease = single_flight.acquire(runner, claims_dir, "client-state-gmail", ttl_min=60)
    if lease is None:
        # C11: single_flight.acquire retries once internally on a stale-cleared
        # claim (Task 2) -- a None here means the lock is genuinely held by a
        # live holder, not a stale one.
        record_failure(cfg.state_dir, "lock-held")
        return RunResult(exit_code=2, previews=["lock held — another run is in progress"])

    result = RunResult(exit_code=0)
    ledger = Ledger(cfg.state_dir / "observations.jsonl")

    try:
        messages_raw, truncation = gmail_source.sweep(runner, cfg.days, cfg.today, extra_query=cfg.query)  # G-QUERY-1
        result.truncation = truncation

        contacts = resolve_email.load_contacts(cfg.crm_dir)
        closed = load_closed_sets(cfg.vault)
        resolver = resolve_email.EmailResolver(closed, contacts)

        for raw in messages_raw:
            lease.touch()
            message_id = raw.get("id") or raw.get("messageId")
            if not message_id:
                continue
            msg = gmail_source.read_message(runner, message_id)
            digest = content_digest(msg.subject, msg.body_text, msg.from_email)
            source_ref = f"gmail:{msg.id}"

            if ledger.is_terminal(source_ref, digest):  # G-IDEMP-1
                result.skipped_terminal += 1
                continue

            filed, escalated, ignored = _file_message_stub(cfg, ledger, msg, resolver, result.previews)
            result.filed += filed
            result.escalated += escalated
            result.ignored += ignored

        receipt = {
            "last_success_at": cfg.now.isoformat(), "window_days": cfg.days,
            "message_count": len(messages_raw), "truncation": truncation, "cost_usd": result.cost_usd,
        }
        write_receipt(cfg.state_dir, receipt)  # persisted in BOTH dry-run and live -- C7
        return result
    except GmailSourceError as exc:
        record_failure(cfg.state_dir, str(exc))  # G-FAIL-1
        result.exit_code = 3
        return result
    except Exception as exc:  # noqa: BLE001 -- catch-all per C7: record_failure + exit 3
        record_failure(cfg.state_dir, str(exc))
        result.exit_code = 3
        return result
    finally:
        lease.release()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--crm-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--query", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-usd", type=float, default=2.0)
    parser.add_argument("--today", default=None)
    args = parser.parse_args(argv)

    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()
    cfg = Config(
        repo_root=Path(args.repo_root), vault=Path(args.vault), crm_dir=Path(args.crm_dir),
        state_dir=Path(args.state_dir), days=args.days, query=args.query, dry_run=args.dry_run,
        max_usd=args.max_usd, today=today, now=datetime.now(timezone.utc),
    )
    from runner import LoggingRunner, SubprocessRunner
    runner = LoggingRunner(SubprocessRunner(), cfg.state_dir)
    result = run(cfg, runner)
    for line in result.previews:
        print(line)
    print(
        f"filed={result.filed} escalated={result.escalated} ignored={result.ignored} "
        f"skipped_terminal={result.skipped_terminal} cost_usd={result.cost_usd:.4f}"
    )
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
