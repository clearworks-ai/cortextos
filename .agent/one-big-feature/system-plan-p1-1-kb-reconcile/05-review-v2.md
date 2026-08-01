# P1.1 kb-reconcile-nightly — code review v2

Repo: `/Users/joshweiss/code/cortextos`, branch `feature/p1-1-kb-reconcile-cron`
Commit under review: `ff52f6d18e817771b3096957e1056d94663e438b` — "Fix P1.1: Handle errors[] array + parse LAST JSON object (skip adversarial SKIP lines)"
File: `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`
Supersedes: `05-review.md` (FAIL verdict on `574fbef..a7a2b2c`, finding 1 — RECON_JSON parsing silently discarded the reconcile report via `tail -1`). That defect is the direct ancestor of the two fixes in this commit.

## Verdict: PASS

Both bug fixes in `ff52f6d` are correct, independently verified against the real upstream source (not assumed, not taken on the prior self-report alone) and against a live functional test I ran myself. The wrapper script now correctly parses `mmrag.py`'s real multi-line JSON report and `kb-extract-edges`'s real `errors[]` array shape, and `green` will correctly reflect true failures. `bash -n` on the script is clean.

One finding below (Finding 3) is a genuine gap in the fleet's cron wiring — not a defect in this commit's diff — that must be closed before the "nightly" behavior Josh was promised is actually live. It does not change the PASS verdict on this commit's code changes, but it must not be silently dropped from the provenance record.

## Bug fix verification

### Fix 1 — `errors[] ` array handling (kb-reconcile-nightly.sh:96)

Diff: `edges_data.get("errors", 0)` → `len(edges_data.get("errors", []) or [])`

- Verified the real emitter: `src/cli/bus.ts` `kb-extract-edges` command (`--json` branch, line ~2698) does `console.log(JSON.stringify(result, null, 2))` where `result.errors` is consumed elsewhere in the same file via `.length` (`result.errors.length`, lines 2702 and 2708, and `process.exit(1)` when `result.errors.length > 0`). This confirms `errors` is always an array in the real JSON payload, never an int.
- The old code (`edges_data.get("errors", 0) == 0` in the `green` computation) compared a `list` to the `int` `0` in Python, which is `False` for *any* list including `[]` — meaning `green` would be `False` on every single clean run, permanently red regardless of actual outcome. This is the inverse failure mode of the original `05-review.md` finding 1 (that one silently hid real failures as green; this one would have falsely reported every clean run as red).
- Live test (`/tmp/test_errors_array.py`, run by me, not reused from codexer's self-report): confirmed `len(edges_data.get("errors", []) or [])` returns `0` for a clean `errors: []` payload and `1` for a payload with one error object, and confirmed the old check (`errors == 0` against a live `[]`) evaluates `False` — reproducing the bug the fix addresses. Output:
  ```
  clean errors_count= 0 green_component= True
  witherrors errors_count= 1 green_component= False
  OLD BUGGY CHECK on clean run (list == int): False <- would be False, permanently red
  ```
  PASS — fix is correct and matches the real emitter's contract.

### Fix 2 — parse LAST JSON object instead of first `{` (kb-reconcile-nightly.sh:42-64)

Diff: scans `RECON_OUT` line-by-line from the end, finds the last line whose stripped content starts with `{`, and `raw_decode`s from that byte offset — instead of the old `recon_raw.find('{')` (first brace anywhere in stdout).

- Verified against real `mmrag.py`: `_emit_report()` (line 1936) does `print(json.dumps(report, indent=2))` — the final report is always the last thing printed, pretty-printed and multi-line, starting with a top-level `{` on its own line. Confirmed real `SKIP` lines exist throughout `mmrag.py` (16 call sites, e.g. lines 1700, 1748, 2129, 2170, 2220, 2571, 2648, 2654, 2681, 2727) with format `f"  SKIP (...): {file_path} — ..."` — these are indented (leading two spaces) and can legitimately contain literal `{`/`}` characters if a filename or interpolated error message contains braces (e.g. a JSON parse error message embedded in the exception text). The old "first brace" logic was vulnerable to exactly this; the new "last line starting with `{`" logic is not, because it anchors on the final pretty-printed report rather than the first brace anywhere in the stream.
- Live test (`/tmp/test_recon_parse.py`, run by me): constructed a realistic adversarial `RECON_OUT` — two `SKIP` lines including one containing a literal brace-delimited JSON-looking fragment in the error text (`SKIP (error): /path/to/weird{file}.md — ValueError: {"nested": "json-looking text"}`), followed by a real `json.dumps(report, indent=2)` block with `new_files=2, failed_files=1`. Ran the exact parsing logic copied verbatim from the script's heredoc. Result: correctly isolated and parsed the real report (`new_files=2`, `failed_files=1`) and did not lock onto the brace embedded in the SKIP line. Output:
  ```
  PARSED: {"new_files": 2, "new_chunks": 14, "changed_files": 1, ..., "failed_files": 1, ...}
  TEST PASS: real report correctly isolated despite adversarial brace-in-text SKIP line
  ```
  PASS — fix is correct and handles the adversarial case it was written for.

### Syntax / sanity

- `bash -n orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` — clean, no syntax errors.
- Read the full current script end-to-end (133 lines) to confirm no other regressions were introduced alongside the two targeted fixes; the rest of the file is unchanged from the version reviewed in `05-review.md` (findings 2–7 there, all LOW/PASS, still apply unchanged and are not re-litigated here).

## Other findings

1. **HIGH — the new nightly cron is not actually live-wired in the running daemon (deployment gap, not a defect in this commit).** `config.json`'s `crons` array carries a `kb-reconcile-nightly` entry with schedule `"37 3 * * *"` pointing at this wrapper script. But `config.json → crons.json` migration (`src/daemon/cron-migration.ts`) is a **one-shot, marker-gated** process: `orgs/clearworksai/agents/larry`'s `.crons-migrated` marker at `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/.crons-migrated` already exists (created `May 1 19:05`), so `runMigrationCore` returns `skipped-already-migrated` on every subsequent daemon boot and never re-reads `config.json`'s crons array — new/changed entries added after that first migration are silently ignored unless someone runs the migration with `--force`.
   I read the live `crons.json` directly (`~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json`) and confirmed it still holds a **different, pre-existing** `kb-reconcile-nightly` entry: `created_at: 2026-07-01T21:45:25Z`, `schedule: "30 09 * * *"`, `fire_count: 28`, `last_fired_at: 2026-07-31T16:30:24Z` — a direct `mmrag.py reconcile --collection shared-clearworksai ... --json > memory/reports/kb-reconcile-$(date).json` invocation with **no wrapper script, no ledger row, no `green` check, and no Telegram-on-red logic**. This is not the P1.1 deliverable; it just happens to share the cron name.
   Net effect: the actual daemon cron scheduler is still firing the old direct-invocation cron every morning at 09:30, and the new wrapper script (`kb-reconcile-nightly.sh`, this review's subject) is **not registered to fire at all** under its intended `37 3 * * *` schedule. The single ledger row currently in `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` (`ts: 2026-07-31T22:11:49Z, reconcile.status: 2, green: false`) is consistent with a manual/test invocation of the script (its `/tmp/kb-reconcile-nightly.err` companion file contains only the literal text `Traceback...\ncrash`, which is synthetic test fixture content, not a real Python traceback) — not a genuine autonomous cron fire.
   This does not implicate the code fixes reviewed above, which are correct. But it means the "nightly cron that checks the previous run and Telegram-alerts on red" — the actual point of P1.1 — will not run in production until either (a) `cortextos bus <cron CLI>` is used to explicitly upsert this entry into `crons.json` directly, or (b) migration is re-run with `--force` for the `larry` agent (which would also require reconciling the name collision with the old `30 09 * * *` entry so the daemon doesn't end up with two same-named crons or silently keep the stale one). **Recommend opening this as a follow-up task before this is considered "shipped and firing" — do not let this get lost in the provenance record.**

2. LOW (pre-existing, not a regression, not touched by this commit): findings 2–4 and 6–7 from `05-review.md` (exit-code masking of `EDGES_STATUS`, `allexport` short-circuit on `source` failure, unbounded `/tmp/kb-reconcile-nightly.err` growth on a world-readable path) remain open and unaddressed by `ff52f6d`. None are blocking for this PASS since they were already scoped out of the prior review's blocking finding.

## Summary

- Fix 1 (`errors[]` handling): CORRECT — verified against real `bus.ts` emitter contract + live test.
- Fix 2 (last-JSON-object parsing): CORRECT — verified against real `mmrag.py` SKIP-line behavior + live adversarial test.
- Script syntax: clean (`bash -n`).
- **Verdict on commit `ff52f6d18e817771b3096957e1056d94663e438b`: PASS.**
- **Outstanding, non-blocking-for-this-commit but must-track finding: the nightly cron is not yet live in `crons.json` — the daemon is still firing a different, older, pre-P1.1 cron under the same name. This needs a follow-up fix (explicit `crons.json` upsert or forced re-migration) before Josh can trust that "nightly" reconcile+alert behavior is actually happening.**
