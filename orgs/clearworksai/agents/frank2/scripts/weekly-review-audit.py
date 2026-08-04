#!/usr/bin/env python3
"""weekly-review-audit.py — P6 deterministic core for frank2's weekly-review cron.

Per MASTER-BUILD-PLAN.md P6 ("Weekly-review cadence wiring"), the Friday weekly-review
must, on top of its existing wins/metrics/lessons synthesis:
  1. Audit the approval queue for anything stuck.
  2. Audit Multica lanes (the bus<->Multica sync) for sync errors.
  3. Check that larry's Monday `upstream-sync` cron produced its row this week.
  4. Feed any misses back as fix tasks against the responsible pillar
     (`cortextos bus create-task`).
  5. Persist a durable report at the content-type-routed knowledge-sync path
     (P1.0 router convention: raw/weekly-reviews/, matching the existing
     2026-03-21 precedent file).

Deterministic core / thin LLM verify layer split (fleet pattern,
feedback_deterministic_cron_core_llm_verify_layer, Josh 2026-07-31): this script
does the mechanical bulk-checking. The weekly-review cron's LLM layer is
responsible for the narrative synthesis (wins/metrics/lessons) and for
dispatching the `pipeline-operations-manager` skill to fill in the
"## PIPELINE MOVEMENT" section this script leaves as a placeholder.

Exit 0 always (cron-safe) — any subprocess/audit failure becomes a finding or a
log line, never a crash, mirroring trending-fetch.py's degrade-clean contract.

Usage:
  python3 weekly-review-audit.py [--json]

Stdout: one line of JSON —
  {
    "date": "YYYY-MM-DD",
    "findings": [{"kind": ..., "detail": ..., "pillar": ..., "fix_task_id": ... | null}],
    "clean": bool,
    "report_path": "/Users/.../raw/weekly-reviews/YYYY-MM-DD-weekly-review.md",
    "fix_task_ids": [...]
  }
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

INSTANCE_ID = os.environ.get("CTX_INSTANCE_ID", "cortextos1")
CTX_ROOT = Path(os.environ.get("CTX_ROOT", os.path.expanduser(f"~/.cortextos/{INSTANCE_ID}")))
KNOWLEDGE_SYNC_ROOT = Path(
    os.environ.get("KNOWLEDGE_SYNC_ROOT", os.path.expanduser("~/code/knowledge-sync")),
)
REPORT_DIR = KNOWLEDGE_SYNC_ROOT / "raw" / "weekly-reviews"
LARRY_CRON_STATE_PATH = CTX_ROOT / "state" / "larry" / "cron-state.json"
CORTEXTOS_BIN = os.environ.get("CORTEXTOS_BIN", "cortextos")

APPROVAL_STALE_THRESHOLD_HOURS = 48
UPSTREAM_SYNC_MAX_AGE_DAYS = 8  # 7d interval + 1d slack


@dataclass
class Finding:
    kind: str
    detail: str
    pillar: str
    fix_task_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "detail": self.detail,
            "pillar": self.pillar,
            "fix_task_id": self.fix_task_id,
        }


# ---------------------------------------------------------------------------
# Pure detectors — no I/O, independently unit-testable.
# ---------------------------------------------------------------------------

def _parse_iso(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        # Normalize a trailing "Z" to an explicit UTC offset for fromisoformat.
        normalized = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def detect_stale_approvals(
    approvals: list[dict[str, Any]],
    now: datetime,
    threshold_hours: int = APPROVAL_STALE_THRESHOLD_HOURS,
) -> list[Finding]:
    """Any pending approval older than threshold_hours is a finding, assigned
    to its own requesting_agent — the literal "responsible pillar" for a
    stuck approval."""
    findings: list[Finding] = []
    for approval in approvals:
        if approval.get("status") != "pending":
            continue
        created_at = _parse_iso(str(approval.get("created_at", "")))
        if created_at is None:
            continue
        age_hours = (now - created_at).total_seconds() / 3600
        if age_hours >= threshold_hours:
            pillar = str(approval.get("requesting_agent") or "larry")
            findings.append(Finding(
                kind="stale_approval",
                detail=(
                    f"Approval '{approval.get('title', approval.get('id', 'unknown'))}' "
                    f"(id: {approval.get('id', 'unknown')}) has been pending "
                    f"{age_hours:.0f}h (>{threshold_hours}h threshold)"
                ),
                pillar=pillar,
            ))
    return findings


def detect_multica_issues(sync_summary: Optional[dict[str, Any]]) -> list[Finding]:
    """A non-zero `errors` count from `cortextos bus multica-sync --dry-run` is
    a finding. Not-configured and configured-idle both report errors: 0 (see
    src/bus/multica/index.ts:resolveMulticaConfig) so no special-casing is
    needed for "Multica isn't set up yet"."""
    if not sync_summary:
        return []
    errors = sync_summary.get("errors", 0)
    if not isinstance(errors, int) or errors <= 0:
        return []
    return [Finding(
        kind="multica_sync_errors",
        detail=f"multica-sync --dry-run reported {errors} error(s) this run: {json.dumps(sync_summary)}",
        pillar="larry",
    )]


def detect_stale_upstream_sync(
    cron_state: Optional[dict[str, Any]],
    now: datetime,
    max_age_days: int = UPSTREAM_SYNC_MAX_AGE_DAYS,
) -> list[Finding]:
    """larry's Monday `upstream-sync` cron must have fired within the last
    max_age_days. Missing entirely or stale -> one finding, pillar=larry."""
    if not cron_state:
        return [Finding(
            kind="upstream_sync_missing",
            detail="larry's cron-state.json is unreadable or missing — cannot confirm upstream-sync ran this week",
            pillar="larry",
        )]

    crons = cron_state.get("crons", [])
    record = next((c for c in crons if c.get("name") == "upstream-sync"), None)
    if record is None:
        return [Finding(
            kind="upstream_sync_missing",
            detail="larry's cron-state.json has no upstream-sync record — it may never have fired",
            pillar="larry",
        )]

    last_fire = _parse_iso(str(record.get("last_fire", "")))
    if last_fire is None:
        return [Finding(
            kind="upstream_sync_missing",
            detail=f"larry's upstream-sync record has an unparseable last_fire: {record.get('last_fire')!r}",
            pillar="larry",
        )]

    age_days = (now - last_fire).total_seconds() / 86400
    if age_days > max_age_days:
        return [Finding(
            kind="upstream_sync_stale",
            detail=(
                f"larry's upstream-sync last fired {age_days:.1f}d ago "
                f"(>{max_age_days}d threshold) — may have missed this week's row"
            ),
            pillar="larry",
        )]
    return []


REPORT_HEADINGS = ["## SYSTEM AUDIT", "## FIX TASKS", "## PIPELINE MOVEMENT"]


def render_report(date_str: str, findings: list[Finding]) -> str:
    """Fixed section headings across every run — required by the P6
    done-condition ("4 consecutive weekly reports ... identical section
    headings verified by grep")."""
    lines = [
        "---",
        "type: session",
        "area: clearworks",
        "status: complete",
        "tags: [weekly-review, ops, p6-audit]",
        f"date: {date_str}",
        "---",
        "",
        f"# Weekly Review — {date_str}",
        "",
        REPORT_HEADINGS[0],
        "",
    ]
    if findings:
        for f in findings:
            lines.append(f"- **[{f.kind}]** ({f.pillar}) {f.detail}")
    else:
        lines.append("- Clean run — approval queue, Multica lanes, and larry's upstream-sync all healthy.")
    lines += ["", REPORT_HEADINGS[1], ""]
    fix_ids = [f.fix_task_id for f in findings if f.fix_task_id]
    if fix_ids:
        for f in findings:
            if f.fix_task_id:
                lines.append(f"- `{f.fix_task_id}` — {f.kind} ({f.pillar})")
    else:
        lines.append("- none — clean run")
    lines += [
        "",
        REPORT_HEADINGS[2],
        "",
        "<!-- FILLED BY: pipeline-operations-manager skill dispatch (weekly-review cron's LLM layer) -->",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# I/O shell — subprocess calls, filesystem, best-effort everywhere.
# ---------------------------------------------------------------------------

def _run_bus_json(*args: str) -> Optional[Any]:
    try:
        result = subprocess.run(
            [CORTEXTOS_BIN, "bus", *args],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            print(f"[weekly-review-audit] '{' '.join(args)}' exited {result.returncode}: {result.stderr.strip()}", file=sys.stderr)
            return None
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, FileNotFoundError, OSError) as err:
        print(f"[weekly-review-audit] '{' '.join(args)}' failed: {err}", file=sys.stderr)
        return None


def _create_fix_task(finding: Finding) -> Optional[str]:
    title = f"Weekly-review fix: {finding.kind} ({finding.pillar})"
    try:
        result = subprocess.run(
            [
                CORTEXTOS_BIN, "bus", "create-task", title,
                "--project", "system-fix",
                "--assignee", finding.pillar,
                "--priority", "normal",
                "--desc", finding.detail,
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"[weekly-review-audit] create-task failed for {finding.kind}: {result.stderr.strip()}", file=sys.stderr)
            return None
        task_id = result.stdout.strip().splitlines()[-1].strip() if result.stdout.strip() else None
        return task_id or None
    except (subprocess.SubprocessError, FileNotFoundError, OSError) as err:
        print(f"[weekly-review-audit] create-task raised for {finding.kind}: {err}", file=sys.stderr)
        return None


def _read_larry_cron_state() -> Optional[dict[str, Any]]:
    try:
        return json.loads(LARRY_CRON_STATE_PATH.read_text())
    except (OSError, json.JSONDecodeError) as err:
        print(f"[weekly-review-audit] could not read {LARRY_CRON_STATE_PATH}: {err}", file=sys.stderr)
        return None


def main() -> int:
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")

    approvals = _run_bus_json("list-approvals", "--format", "json") or []
    if isinstance(approvals, dict):
        # Some list endpoints wrap results as {"approvals": [...]}
        approvals = approvals.get("approvals", [])

    multica_summary = _run_bus_json("multica-sync", "--dry-run", "--direction", "both")
    larry_cron_state = _read_larry_cron_state()

    findings: list[Finding] = []
    findings += detect_stale_approvals(approvals, now)
    findings += detect_multica_issues(multica_summary)
    findings += detect_stale_upstream_sync(larry_cron_state, now)

    for finding in findings:
        finding.fix_task_id = _create_fix_task(finding)

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"{date_str}-weekly-review.md"
    try:
        report_path.write_text(render_report(date_str, findings))
    except OSError as err:
        print(f"[weekly-review-audit] failed to write report to {report_path}: {err}", file=sys.stderr)

    output = {
        "date": date_str,
        "findings": [f.to_dict() for f in findings],
        "clean": len(findings) == 0,
        "report_path": str(report_path),
        "fix_task_ids": [f.fix_task_id for f in findings if f.fix_task_id],
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
