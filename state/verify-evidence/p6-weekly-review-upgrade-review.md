# Independent Review — p6-weekly-review-upgrade (PR #274)

Reviewer: independent (did NOT build this). Verdict: **PASS**.

## Scope reviewed
PR #274, branch `p6-weekly-review-upgrade`. Three added files, all under `orgs/`:
- `orgs/clearworksai/agents/frank2/scripts/weekly-review-audit.py` (319 lines)
- `orgs/clearworksai/agents/frank2/scripts/tests/test_weekly_review_audit.py` (183 lines, 15 tests)
- `orgs/clearworksai/agents/frank2/scripts/p6-done-check.sh` (105 lines)

## Checks performed
1. Read the full `gh pr diff 274` end to end.
2. Spec conformance vs `02-master-plan.md` + `03-specs/spec01-weekly-review.md`:
   - All changes under `orgs/`; zero `src/`, `dist/`, `bus/`, `templates/`, `community/`, daemon.
   - No DDL / schema / storage-layer changes. File + subprocess/CLI only. Matches hard constraints.
   - Branch name == slug exactly (`p6-weekly-review-upgrade`, no prefix).
3. Detector logic (pure, unit-testable):
   - `detect_stale_approvals`: pending >48h → finding, pillar = requesting_agent, fallback `larry`.
   - `detect_multica_issues`: non-zero integer `errors` → finding, pillar `larry`; None/0 → clean.
   - `detect_stale_upstream_sync`: missing/unparseable/stale (>8d) larry cron-state → finding.
   - `_parse_iso`: empty/garbage → None (skipped, never crash).
4. Contract: `main()` degrade-clean — every subprocess failure prints to stderr and returns None,
   never crashes; exit 0 always (cron-safe). JSON has all 5 keys
   (`date`/`findings`/`clean`/`report_path`/`fix_task_ids`).
5. Heading-drift safety: `render_report` and `p6-done-check.sh` both key off the SAME three exact
   strings (`## SYSTEM AUDIT` / `## FIX TASKS` / `## PIPELINE MOVEMENT`). No drift risk.
6. `p6-done-check.sh`: correct Friday computation with BSD/GNU `date` fallback; heading grep exact;
   full `task_` ID extraction scoped to the FIX TASKS section only; clean-week = PASS (surfaces the
   flagged HUMAN-GATE ambiguity rather than failing); overall PASS only on 4/4.

## Independent reproduction
- `python3 -m pytest tests/test_weekly_review_audit.py -q` → **15 passed** (reproduced independently
  from PR-branch files in a clean temp dir).
- Live run of `weekly-review-audit.py` → exit 0, JSON:
  `{"date":"2026-08-04","findings":[],"clean":true,"report_path":".../2026-08-04-weekly-review.md","fix_task_ids":[]}`.
  Report file written; `grep '^## '` shows the three fixed headings. Subprocess errors from the
  isolated env degraded to empty findings (no crash) — confirms the cron-safe contract.
- `bash -n p6-done-check.sh` clean; live run → `P6 DONE-CONDITION: FAIL (0/4)` with per-week
  missing-file reasons, exit 1 — the correct current answer (fewer than 4 Friday reports exist yet).

## Defects
None. The 15 tests are real (edge cases, not trivial). No scope drift. Spec-conformant.

## Emitted ledger rows
`implement` (build landed, PR #274) → this `review` row. `true-verify` to follow on PASS.
