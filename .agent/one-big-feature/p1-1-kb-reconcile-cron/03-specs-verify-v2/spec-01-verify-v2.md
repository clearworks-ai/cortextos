# Spec 01 (v2) — Independent re-derivation checklist, P1.1 kb-reconcile-cron receipt

## Purpose

For the reviewer subagent running this checklist: re-derive `02-plan-verify-v2.md`'s conclusion
directly from primary sources. Do not read the plan and agree with it — read the files/commands
listed below yourself and compare what you find against the claims. This v2 spec uses the
corrected file paths identified by the prior adversarial review (`04-review-verify.md`) and adds
one new check (item 8) covering PR #240, since that's a second merged item this receipt should
reconfirm still holds on the current branch.

## Out of scope — do not act on these even if you notice them

- `reconcile.failed_files: 3` on both ledger rows — tracked at `task_1785780818076_75964035`,
  still open, not this item's job.
- The 2026-08-03 missed fire beyond confirming its root cause is the fleet-wide rate-limit
  incident — do not attempt a fix.
- PR #240's retry/quarantine internals — confirm presence only, do not modify.
- If every check below reproduces and no genuine wiring defect turns up, the correct outcome is a
  **no-diff** true-verify receipt. Do not invent a change just to produce a PR.

## Checklist

1. **Cron registration, live daemon state.** Read
   `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json`. First confirm this is the
   file the running daemon actually uses by checking `~/.cortextos/cortextos1/daemon.pid` and
   `~/.cortextos/cortextos1/daemon.sock` exist (note: these two files sit one directory above
   `.cortextOS/`, not alongside `crons.json` — verify at the corrected path). Then confirm exactly
   one `kb-reconcile-nightly` entry, `schedule: "37 3 * * *"`, `enabled: true`,
   `metadata.migrated_from_config: true`, and that the string `30 09` does not appear anywhere in
   the file (the previously-fixed stale duplicate).

2. **PR #188 merge state.** `gh pr view 188 --repo clearworks-ai/cortextos --json
   title,state,mergedAt,mergeCommit` — confirm `state: MERGED` and the merge commit matches
   `0884801` on `main`. Separately confirm via `git log main --oneline` that follow-up commits
   `796c63b` (added debug instrumentation) and `3b78005` (removed it) are both present, and that
   the wrapper script on `main` today shows no leftover debug code from `796c63b`.

3. **Wrapper script content and syntax.** Read
   `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` in full; run `bash -n` on it.
   Confirm it calls `mmrag.py reconcile --json --yes`, calls `kb-extract-edges`, and appends a
   JSONL row to the ledger. Confirm the JSON-parsing fix takes the **last** `{...}` block on
   stdout, not the first brace, and that `edges.errors` is handled safely regardless of
   array-vs-int shape. Do **not** expect Telegram/alert logic in this script — grep it for
   `telegram|alert|red` and confirm zero real matches; that logic lives in the cron **prompt**,
   `orgs/clearworksai/agents/larry/config.json:136`, not in this script. (The original v1 spec
   pointed reviewers at the wrapper script for this logic — that was wrong; verify the corrected
   location instead.)

4. **Ledger rows, exact values.** Read
   `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`. Confirm the row timestamped
   `2026-08-01T10:37:35Z` (`new_files: 176`, `new_chunks: 1151`, `total_files_on_disk: 12556`,
   `total_files_indexed_after: 12545`, `reconcile.status: 0`, `edges.status: 0`,
   `edges.errors: 0`, `reconcile.failed_files: 3`, `green: false`) and the row timestamped
   `2026-08-02T10:37:49Z` (`new_files: 71`, `new_chunks: 462`, `total_files_on_disk: 12616`,
   `total_files_indexed_after: 12605`, same status/error/failed_files/green pattern) both exist
   exactly as stated. Confirm no row exists timestamped `2026-08-03T1*`.

5. **`fire_count` mapping — verify the corrected reading, not the original one.** In the same
   `crons.json` entry from item 1, read `fire_count`, `created_at`, and `last_fired_at`. Confirm
   `created_at` (2026-08-01T17:47:58Z) postdates the 08-01T10:37:35Z ledger fire, which means that
   fire cannot belong to this cron-entry object's count. Confirm the more consistent mapping is
   that `fire_count: 2` corresponds to the 08-02 fire (ledger row present) and the 08-03 fire
   (`last_fired_at`, no ledger row — the missed fire), not 08-01 + 08-02.

6. **Bus task corroboration.** Look up `task_1785580646979_34216536` and
   `task_1785667055466_58458524` in the bus task store. Confirm both are `completed`, with result
   text indicating a non-green previous night (`failed_files: 3`) and a Telegram alert sent. If
   accessible, also check `~/.cortextos/cortextos1/logs/larry/outbound-messages.jsonl` for the
   actual sent messages around `2026-08-01T10:37:32Z` and `2026-08-02T10:37:44Z` as
   wire-level corroboration beyond the task text.

7. **Missed-fire root cause.** Read `~/.cortextos/cortextos1/logs/larry/restarts.log` (this is the
   correct path — `orgs/clearworksai/agents/larry/logs/restarts.log` does not exist as a
   directory, do not use it). Confirm `RATE_LIMIT` backoff entries spanning roughly
   `2026-08-03T10:04:41Z` through past `10:37:15Z` (the fire time). Spot-check at least one other
   agent's restart log (`scout`, `frank2`, `automator`, or `crm`) in the same window for matching
   `RATE_LIMIT` hits, confirming a fleet-wide incident rather than a defect local to this cron.

8. **NEW — PR #240 still present on current branch.** PR #240
   (`kb-reconcile-504-retry-plus-quarantine`) is a second merged item this receipt should
   reconfirm. Run `gh pr view 240 --repo clearworks-ai/cortextos --json state,mergedAt,title` and
   confirm `state: MERGED`. Then read `knowledge-base/scripts/mmrag.py` on the current branch and
   confirm the 504-retry logic, the corrupt-PDF quarantine path, and `failed_paths` persistence
   are present in the reconcile flow. Do not modify this code — confirm presence only, and confirm
   nothing in this receipt's plan/spec/diff depends on or touches it.

9. **Scope-boundary check.** Confirm `task_1785780818076_75964035` exists in the bus task store,
   is not `completed`, and its description covers the 3 persistent `failed_files` — i.e. that gap
   is genuinely tracked elsewhere, not silently closed by this receipt.

10. **No drift since merge.** Run `git status --short` and `git diff main -- \
    orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh \
    orgs/clearworksai/agents/larry/config.json`. Confirm no uncommitted or pending diff against
    either file — the live state matches what PR #188 actually merged.

## Pass/fail

- **PASS (no-diff true-verify):** all 10 items reproduce as described, including the corrected
  paths and the corrected `fire_count` mapping, and PR #240's retry/quarantine code is confirmed
  present. Emit the receipt with a no-diff outcome.
- **FAIL:** any item fails to reproduce (e.g., a second cron entry reappears, a ledger value is
  off, PR #188 or #240 is not actually merged/present, the wrapper is missing a documented fix).
  Document the exact discrepancy and route back for a narrowly-scoped fix — do not touch the
  explicitly out-of-scope items above even if something looks fixable there.
