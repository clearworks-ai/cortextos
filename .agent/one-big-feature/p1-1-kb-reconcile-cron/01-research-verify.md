# P1.1 kb-reconcile-cron — VERIFY pass research (not a replan)

Bus task: `task_1785804209278_19110396` — "P1.1 kb-reconcile-cron — earn true-verify receipt".
Directive (WAVE B P1 item): VERIFY the built item, do not replan; find+fix real bugs if any,
don't rubber-stamp.

## What "kb-reconcile-cron" actually is (disambiguated from adjacent items)

Three planning dirs exist on disk for this family; they are NOT the same item:

1. `.agent/one-big-feature/kb-reconcile-504-retry-plus-quarantine/` — PR #240, MERGED
   2026-08-04T00:03:23Z. Scope: retry on Gemini 504s, quarantine corrupt PDFs, persist
   `failed_paths`. **Different item — data/error-handling inside the reconcile call itself.
   Out of scope here, not touched.**
2. `.agent/one-big-feature/p1-1-kb-reconcile-cron/` + `.agent/one-big-feature/system-plan-p1-1-kb-reconcile/`
   — THIS item. Scope per `02-master-plan.md` (both dirs hold the same plan): wire a nightly
   cron that (a) runs `mmrag.py reconcile --json --yes` over `DEFAULT_RECONCILE_ROOTS`, (b) runs
   `kb-extract-edges` refresh, (c) appends a JSONL counts row, (d) alerts Telegram on a
   red/missing previous row. This is CRON WIRING + a wrapper script, not new reconcile logic.
3. `.agent/one-big-feature/kb-reconciler/` — older (Jul 3), pre-dates the above; superseded by
   #2's binding scope from MASTER-BUILD-PLAN.md line 96. Not the current item.

## Ground truth: is item #2 already built and live?

**Yes — merged to main, and live-firing in the running daemon. Verified directly, not taken on
report:**

- PR #188 "P1.1: kb-reconcile-nightly cron + wrapper script" — **MERGED** to
  `clearworks-ai/cortextos` main (`git log main` shows `0884801 P1.1: kb-reconcile-nightly cron +
  wrapper script (#188)`, plus two direct follow-up commits on main:
  `796c63b debug: add mirror_data instrumentation...` and
  `3b78005 Cleanup: remove debug instrumentation...`).
- Wrapper script present and correct on main: `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`.
  Branch history (`feature/p1-1-kb-reconcile-cron`) shows two real bug fixes landed and reviewed
  before merge: `76e5242`/`ff52f6d` — multi-line JSON report parsing (must take the LAST `{...}`
  block on stdout, not the first brace, because `mmrag.py` prints per-file `SKIP (error)` lines
  before the final JSON report) and `errors[]` array-vs-int handling for the edge-extract JSON.
  Both fixes were independently re-verified in `.agent/one-big-feature/system-plan-p1-1-kb-reconcile/05-review-v2.md`
  against the real emitters (`mmrag.py:1936 _emit_report`, `src/cli/bus.ts` `kb-extract-edges`
  `--json` branch) with live adversarial tests, verdict PASS.
- Cron entry: `orgs/clearworksai/agents/larry/config.json` carries exactly one
  `kb-reconcile-nightly` entry, schedule `37 3 * * *` (03:37 America/Los_Angeles = 10:37 UTC).
- **Live daemon state, checked directly** at
  `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json` (the file the running daemon
  actually reads, confirmed live via `daemon.pid`/`daemon.sock` in the same dir): exactly ONE
  `kb-reconcile-nightly` entry (`grep -c` on the name field = 1), `metadata.migrated_from_config:
  true`, schedule `37 3 * * *`, `enabled: true`. **The stale duplicate entry flagged as a HIGH
  finding in `05-review-v2.md` (an old, pre-P1.1, direct-invocation cron at schedule `30 09 * * *`
  under the same name, left behind by the one-shot marker-gated migration) is NO LONGER
  PRESENT** — `grep -n "30 09"` on the live file returns nothing. Whatever fixed this (re-migration
  or manual upsert) happened between the Aug-1 review and now; net effect verified correct today.

## Cron is actually firing and doing real work — evidence, not assumption

`orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` (the wrapper's own append-only
receipt file) has real rows with real reconcile output:

- `2026-08-01T10:37:35Z` — first clean post-fix fire: `new_files: 176, new_chunks: 1151,
  total_files_on_disk: 12556, total_files_indexed_after: 12545`.
- `2026-08-02T10:37:49Z` — second clean fire: `new_files: 71, new_chunks: 462,
  total_files_on_disk: 12616, total_files_indexed_after: 12605`.

Both rows: `reconcile.status: 0`, `edges.status: 0`, `edges.errors: 0` (correctly an int-comparable
0 post-fix). Both `green: false` — NOT because the cron/wiring is broken, but because
`reconcile.failed_files: 3` on every single row (same 3 files, consistently). That is a
**data-quality gap, not a wiring defect** — it is already tracked as a separate, still-open bus
task: `task_1785780818076_75964035` "P1.1 fix: diagnose+resolve kb-reconcile-nightly 3 persistent
failed_files, get 1 green run" (pending). Per this item's scope (cron wiring) and per the parent
instruction ("that one is DONE, do not touch it, it's a different item"), this is correctly out of
scope for `p1-1-kb-reconcile-cron` and is not touched here.

`crons.json`'s own fire bookkeeping corroborates: `fire_count: 2`, both matching the two clean
post-fix ledger rows above (the earlier same-day 2026-08-01 rows in the ledger, timestamped before
17:47:58Z, are pre-fix/manual-test runs under the old entry and are not counted in `fire_count`
because that field only started incrementing after the entry was re-created).

Bus-task-level evidence for the same two fires: `task_1785580646979_34216536` (completed, result
"kb-reconcile launched; previous night non-green (failed_files:3), Telegram sent") and
`task_1785667055466_58458524` (completed, result "kb-reconcile launched; previous night checked
(not green, 3 failed_files, alerted Josh)") — confirming the red-alert-to-Telegram behavior in the
cron prompt is also actually firing, not just the reconcile call.

## One real gap found: a missed fire, root-caused to a fleet-wide incident, not a wiring bug

`crons.json` shows `last_fired_at: 2026-08-03T10:37:15.383Z` — a third scheduled fire — but there
is **no** matching bus task and **no** matching ledger row for that time. Investigated directly:

- `orgs/clearworksai/agents/larry/logs/restarts.log` shows a dense burst of
  `RATE_LIMIT: exit_code=1 ... backoff_s=60` entries starting `2026-08-03T10:04:41Z` and continuing
  every few minutes through `11:59:41Z`, i.e. larry was in a live API-rate-limit crash/backoff loop
  spanning the exact 10:37:15Z fire time.
- This is consistent with a fleet-wide event, not a larry/kb-reconcile-specific defect:
  `restarts.log`/`crashes.log` show the same pattern of `HARD-RESTART`/`RATE_LIMIT`/`CRASH` entries
  for `scout`, `frank2`, `automator`, `knox`, `crm`, `opencode` in the surrounding hours of
  2026-08-03.
- Conclusion: the daemon dispatched the cron prompt on schedule (proven by `last_fired_at`/
  `fire_count` advancing), but larry's process was mid rate-limit backoff and never got to execute
  the prompt body (`create-task` never ran, so no task and no ledger row — every bus call in the
  cron prompt is `2>/dev/null`-guarded, so a dropped dispatch fails silent by design, which is a
  known/accepted tradeoff for this prompt, not new). This is an availability/capacity incident, not
  a defect in the cron's registration, script, or parsing logic — the two prior fires (Aug 1, Aug 2)
  and their correct ledger rows are proof the wiring itself is sound when larry is actually up.

**No fix applied for the missed fire** — it is out of scope for cron *wiring* correctness (which is
what P1.1 binds), and a durable fix belongs to fleet-wide rate-limit/crash-loop resilience, a
different, larger surface already covered by other incident tracking (see MEMORY.md rate-limit /
restart-loop entries for 2026-08-03). Flagging here so it is not silently dropped from the record.

## Verdict

The kb-reconcile-cron wiring item (distinct from the merged #240 retry/quarantine item and from the
still-open #3-failed-files data item) is **already built, merged (PR #188), and verified live**:
single correct cron entry, no stale duplicate, two clean fires with real reconcile+edge-extract
output and correct Telegram-on-red alerting. No `src/`, `config.json`, or wrapper-script changes are
needed. This VERIFY pass produces a receipt (research → plan → review → true-verify pipeline rows)
for the WAVE B tracking ledger — it does not reopen or rebuild the merged work.
