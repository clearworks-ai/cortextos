# Spec 01 — Independent REVIEW checklist for the P1.1 kb-reconcile-cron VERIFY pass

## Objective

This is a checklist for the REVIEW stage subagent (independent of, and running after, the plan
author). The goal is to **independently re-derive** the conclusion in `02-plan-verify.md` from
the same primary sources — not to re-read the plan/research docs and agree with them. Every item
below names the exact file/command to inspect directly. If any item fails to reproduce, stop and
flag it as a real finding rather than adjusting the narrative to fit.

## Non-goals reminder (do not act on these, even if found)

- Do not attempt to fix `reconcile.failed_files: 3` — tracked separately in
  `task_1785780818076_75964035`.
- Do not attempt to fix the 2026-08-03T10:37:15Z missed fire — fleet-wide rate-limit incident,
  tracked elsewhere.
- Do not touch anything under `kb-reconcile-504-retry-plus-quarantine` scope (PR #240, merged,
  separate item).
- If none of the checks below turn up a genuine wiring defect, the correct outcome is a
  **no-diff** true-verify receipt — do not manufacture a change to justify a PR.

## Checklist — re-derive from primary sources

1. **Live cron entry count and schedule.** Read
   `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json` directly (confirm this is
   the live daemon's state file by checking `daemon.pid`/`daemon.sock` exist in the same
   directory first). Confirm:
   - Exactly one entry with `name` (or equivalent identifying field) `kb-reconcile-nightly`.
   - Its schedule is exactly `37 3 * * *`.
   - `enabled: true`.
   - `metadata.migrated_from_config: true` (or equivalent marker) is present.
   - No second `kb-reconcile-nightly`-named entry exists anywhere in the file (grep the full
     file, not just a snippet), and specifically confirm the string `30 09` (the previously
     flagged stale-duplicate schedule) does not appear anywhere in the file.

2. **PR #188 merge state.** Run `git log main --oneline | grep -i "0884801\|P1.1"` (or equivalent)
   against the actual `clearworks-ai/cortextos` main branch in this checkout and confirm commit
   `0884801` ("P1.1: kb-reconcile-nightly cron + wrapper script (#188)") is present on `main`,
   not just on a feature branch. Also confirm the two cited follow-up commits (`796c63b`,
   `3b78005`) exist on `main` and that `3b78005` is the one that removed the debug
   instrumentation `796c63b` added (i.e. net state on `main` today has no leftover debug code).

3. **Wrapper script on disk matches what was merged.** Read
   `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` on `main` directly. Confirm it
   contains: (a) a call to `mmrag.py reconcile --json --yes` (or equivalent) over
   `DEFAULT_RECONCILE_ROOTS`, (b) a `kb-extract-edges` refresh call, (c) a JSONL ledger-append
   step, (d) logic that checks the previous ledger row for red/missing and sends a Telegram
   alert. Confirm the two documented bug fixes are present in the current file: JSON parsing
   takes the LAST `{...}` block on stdout (not the first brace), and `edges.errors` is handled
   correctly whether the emitter returns an array or an int.

4. **Ledger rows — exact values.** Read
   `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` directly and confirm, byte-
   for-byte against the cited values (not approximately):
   - Row timestamped `2026-08-01T10:37:35Z`: `new_files: 176`, `new_chunks: 1151`,
     `total_files_on_disk: 12556`, `total_files_indexed_after: 12545`, `reconcile.status: 0`,
     `edges.status: 0`, `edges.errors: 0`, `reconcile.failed_files: 3`, `green: false`.
   - Row timestamped `2026-08-02T10:37:49Z`: `new_files: 71`, `new_chunks: 462`,
     `total_files_on_disk: 12616`, `total_files_indexed_after: 12605`, `reconcile.status: 0`,
     `edges.status: 0`, `edges.errors: 0`, `reconcile.failed_files: 3`, `green: false`.
   - Confirm there is NO row timestamped `2026-08-03T1*` (the missed fire).

5. **`fire_count` reconciliation.** In the same `crons.json` entry checked in item 1, confirm
   `fire_count` and `last_fired_at` are consistent with 3 total scheduled fires (2 with ledger
   rows, 1 without — the 08-03 miss), and that `last_fired_at` reads `2026-08-03T10:37:15` (some
   sub-second suffix expected).

6. **Bus task corroboration.** Look up `task_1785580646979_34216536` and
   `task_1785667055466_58458524` via the bus task store/CLI and confirm both are `completed` with
   result text indicating a non-green run (`failed_files:3`) and a Telegram alert sent — i.e. the
   red-alert path in the wrapper is independently corroborated at the task-log level, not just
   inferred from the ledger.

7. **Missed-fire root cause.** Read `orgs/clearworksai/agents/larry/logs/restarts.log` directly
   and confirm `RATE_LIMIT: exit_code=1 ... backoff_s=60` (or materially equivalent) entries exist
   with timestamps spanning `2026-08-03T10:04:41Z` through at least `2026-08-03T10:37:15Z` (the
   fire time). Spot-check at least one other agent's restart/crash log (`scout`, `frank2`,
   `automator`, `knox`, `crm`, or `opencode`) in the same window to confirm the fleet-wide-incident
   framing, not a larry-only or kb-reconcile-only failure.

8. **Open-item scope boundary.** Confirm `task_1785780818076_75964035` exists in the bus task
   store, is not `completed`, and its description matches "diagnose+resolve kb-reconcile-nightly
   3 persistent failed_files" — i.e. the failed_files gap is genuinely tracked elsewhere and isn't
   silently dropped by treating this VERIFY pass as the closing action for it.

9. **No src/config/wrapper diff needed.** Run `git status` / `git diff` against `main` in this
   checkout scoped to `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`,
   `orgs/clearworksai/agents/larry/config.json`, and any `src/` path touched by PR #188, and
   confirm there is no uncommitted or pending diff — i.e. the live file state matches what was
   merged, with nothing silently drifted since.

10. **PR #240 boundary respected.** Confirm `.agent/one-big-feature/kb-reconcile-504-retry-plus-quarantine/`
    shows a merged PR (separately, e.g. via `gh pr list --repo clearworks-ai/cortextos --state merged --search "504"`)
    and that nothing in this VERIFY pass's plan, spec, or any resulting diff references or
    depends on that item's retry/quarantine logic.

## Pass/fail criteria

- **PASS (true-verify, no-diff outcome):** All 10 items reproduce as stated above from primary
  sources, and no genuine cron-wiring defect (registration, script logic, ledger/JSON parsing) is
  found. Emit the true-verify pipeline receipt with a no-diff outcome.
- **FAIL / escalate:** Any item does not reproduce as stated (e.g. a second `kb-reconcile-nightly`
  entry reappears, a ledger value doesn't match, PR #188 is not actually on `main`, the wrapper
  script is missing one of the two documented bug fixes). In that case, do not mark true-verify —
  document the discrepancy and route back for a scoped fix, staying within cron-wiring scope only
  (not the two explicitly out-of-scope items).
