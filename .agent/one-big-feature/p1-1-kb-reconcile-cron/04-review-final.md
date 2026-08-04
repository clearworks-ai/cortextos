# Independent Review — PR #188 (kb-reconcile-nightly cron) + PR #240 (retry/quarantine/failed_paths)

Reviewer: independent, no prior context, all findings re-derived from primary sources (live daemon state, git, source code, test execution, task/ledger history). No prior document was trusted.

## VERDICT: PASS (on substance), with 2 non-blocking operational findings worth Larry's attention

Both PRs' code/config claims are verifiably true and live in this codebase. The nightly cron is registered exactly once, correctly wired, and has demonstrably executed and alerted correctly on real (non-green) data. PR #240's retry/quarantine/persistence logic is real, wired into the actual reconcile code path (not dead code), and its own dedicated test suite passes 100% when executed fresh. Two things are NOT proven and are flagged below: (1) the most recent scheduled cron fire (2026-08-03 03:37 PDT) has no corresponding task or ledger evidence despite crons.json's bookkeeping claiming it fired, and (2) PR #240's logic has not yet been proven end-to-end against a real production reconcile run, because it merged (2026-08-03T17:03 PDT) after the last real ledger row (2026-08-02T10:37 UTC).

---

## PR #188 — kb-reconcile-nightly cron + wrapper script

### Claim 1: exactly one `kb-reconcile-nightly` cron registered, no stale duplicate

```
$ python3 -c "... crons.json ..."
total crons: 18
kb-reconcile matches: 1
{
  "name": "kb-reconcile-nightly",
  "schedule": "37 3 * * *",
  "enabled": true,
  "created_at": "2026-08-01T17:47:58.074Z",
  "last_fire_attempted_at": "2026-08-03T10:37:15.383Z",
  "last_fired_at": "2026-08-03T10:37:15.383Z",
  "fire_count": 2
}
```
Confirmed **exactly one** entry, `enabled: true`, no stale duplicate (grepped for `"30 09` schedule — zero hits). Schedule `37 3 * * *` = 3:37 AM local; machine timezone is PDT (`date` → `Mon Aug 3 19:30:00 PDT 2026`), and 3:37 AM PDT = 10:37 UTC — matches the observed task-creation timestamps below. **PASS.**

### Claim 2: daemon is live

```
$ ps -p $(cat ~/.cortextos/cortextos1/daemon.pid)
  PID TTY  TIME CMD
56089 ??   6:49.76 node /Users/joshweiss/code/cortextos/dist/daemon.js
```
Live daemon process confirmed. **PASS.**

### Claim 3: wrapper script calls mmrag.py reconcile → kb-extract-edges → appends ledger row; no Telegram code in the script

Read `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` in full and ran `bash -n` on it (exit 0, valid syntax). Confirmed the pipeline order:
1. `agent-memory-mirror.sh` (P1.5 mirror step)
2. `"$PY" "$MMRAG" reconcile --json --yes` (mmrag.py reconcile)
3. `cortextos bus kb-extract-edges --org clearworksai --json` — verified this is a real registered CLI subcommand (`cortextos bus --help` lists it: "Extract entity mention edges into links.sqlite (deterministic, zero-LLM)")
4. A python3 heredoc composes a JSON row (`memory_mirror` + `reconcile` + `edges` + `green`) and appends it to `$LEDGER` (`orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`)

`grep -n "Telegram\|alert" kb-reconcile-nightly.sh` → **zero matches** (grep exit 1). No alert/Telegram code lives in the script, consistent with the claim that this logic lives in the cron prompt instead. **PASS.**

### Claim 4: alert/red-check logic lives in the cron prompt (config.json ~line 136)

```
$ grep -n "kb-reconcile-nightly" orgs/clearworksai/agents/larry/config.json
133:      "name": "kb-reconcile-nightly",
136:      "prompt": "...NIGHTLY KB RECONCILE — (1) Check the PREVIOUS run's row: tail -1
      $CTX_AGENT_DIR/state/kb-reconcile-ledger.jsonl. If it is missing or has \"green\": false,
      send Telegram 6690120787 with the row — silent failure on a KB cron is NOT acceptable.
      (2) Launch tonight's run in the BACKGROUND ... (3) cortextos bus complete-task ...
      SILENT-OK if previous row green and launch succeeded."
```
Confirmed at line 136 exactly as claimed: red/missing-row check + Telegram alert logic lives in the LLM-interpreted cron prompt, not the shell script. **PASS.**

### Claim 4b (bonus — proven, not just claimed): the alert path has actually fired in production

Cross-referenced the org task bus (`~/.cortextos/cortextos1/orgs/clearworksai/tasks/*.json`) for `"Cron: kb-reconcile-nightly"` system tasks:

| task id | created_at | status | result |
|---|---|---|---|
| task_1785580646979_34216536 | 2026-08-01T10:37:26Z | completed | "kb-reconcile launched; previous night non-green (failed_files:3), Telegram sent" |
| task_1785667055466_58458524 | 2026-08-02T10:37:35Z | completed | "kb-reconcile launched; previous night checked (not green, 3 failed_files, alerted Josh)" |

This is real end-to-end proof the alert-on-red logic actually executed twice in production, not just that the prompt text exists. **PASS, and stronger than the claim required.**

---

## PR #240 — retry 504 / quarantine / failed_paths+quarantined_paths (commit 561beba)

### Claim: commit is merged and present in HEAD

```
$ git log --oneline main | grep 561beba
561beba fix(kb-reconcile): retry 504, quarantine corrupt PDFs, persist failed_paths (#240)
$ git merge-base --is-ancestor 561beba HEAD; echo $?
0   (IS ANCESTOR)
$ git log -1 --format="%H %ai %s" 561beba
561bebaf36265dff83208cef79cc552bab76081c 2026-08-03 17:03:23 -0700 fix(kb-reconcile): retry 504, quarantine corrupt PDFs, persist failed_paths (#240)
```
**PASS.**

### Claim: retry-with-backoff for transient HTTP errors (429/500/503/504)

`knowledge-base/scripts/mmrag.py:151` — `TRANSIENT_HTTP_CODES = {429, 500, 503, 504}` (429/500/503/504, matches claim exactly; also `TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED"}` for gRPC-style errors).

`_retry_api_call` (line 325) implements bounded backoff (`backoffs=(5, 15, 45)` default), retries on `APIError` with transient code/status or on timeout/transport exceptions, re-raises immediately on non-transient errors, re-raises last error after exhausting attempts. `_retry_generate_content` (line 363) and `embed_content`'s call site (line 415) both route through `_retry_api_call` — this is the actual call path used by ingestion, not a parallel/unused helper. **PASS.**

### Claim: quarantine mechanism for unrecoverable/corrupt-parse files, separate from generic failures

`_is_quarantine_worthy(exc)` (line 379): returns `True` for Gemini `APIError` with `INVALID_ARGUMENT` + "no pages" message, or for exception type names containing `pdf`/`stream`/`eof`/`read`/`corrupt`. Explicitly documented as shared between `_reconcile_collection` and `_build_collection_from_disk` "to avoid DRY violations."

Wired into both ingestion paths (read lines 1628-1806 directly):
- `_reconcile_collection` (~line 1705-1738): on `ingest_file` exception, calls `_is_quarantine_worthy(exc)` — if true, appends to `quarantined_paths` and prints `QUARANTINED (unrecoverable): ...`; else appends to `failed_paths` and prints `SKIP (error): ...`. Both lists are separate, populated independently.
- `_build_collection_from_disk` (~line 1767-1793): identical pattern.

This is real production wiring, not dead code — the exception handler around the actual `ingest_file()` call is what classifies and routes each failure. **PASS.**

### Claim: both `failed_paths` and `quarantined_paths` persisted in the reconcile report/ledger output

`_reconcile_collection`'s return dict (line 1746-1764) includes both `"failed_paths": failed_paths` and `"quarantined_paths": quarantined_paths` alongside `"failed_files": len(failed_paths)`. Same in `_build_collection_from_disk`'s return (line 1796-1805). The checkpoint-clear guard at line 1743 was also updated to require `not failed_paths and not quarantined_paths` (previously presumably just failed_paths) before clearing checkpoint state — a correct extension of existing logic, not a bolt-on.

The shell wrapper (`kb-reconcile-nightly.sh`) ledger composer explicitly reads `recon_data.get("failed_paths", [])` and `recon_data.get("quarantined_paths", [])` into the persisted ledger row — confirmed by reading the full heredoc in the script. **PASS.**

### Independent test execution (not just static read)

Ran the PR's own dedicated test file fresh, against the actual `mmrag.py` in this worktree (not trusting any prior "tests passed" claim):

```
$ MMRAG_DIR=~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base \
  /Users/joshweiss/code/cortextos/knowledge-base/venv/bin/python3 \
  -m _test_clients.test_kb_reconcile_504_quarantine

[test 1/4] transient_504_and_deadline           — 4/4 PASS
[test 2/4] quarantine_parse_errors               — 4/4 PASS
[test 3/4] transient_network_still_fails         — 2/2 PASS
[test 4/4] ledger_includes_paths                 — 6/6 PASS
ALL PASS (4 scenarios)
```
All 16 assertions across 4 scenarios pass on a clean, independent run. **PASS.**

---

## Findings

### Non-blocking Finding 1 — most recent cron "fire" (2026-08-03T10:37Z) has no corresponding task or ledger row

`crons.json` reports `last_fire_attempted_at` = `last_fired_at` = `2026-08-03T10:37:15.383Z`, but `fire_count` is still `2` (matching only the 08-01 and 08-02 fires, both of which have confirmed completed task records and ledger rows — see PR #188 §4b). I searched the full org task store (`~/.cortextos/cortextos1/orgs/clearworksai/tasks/*.json` and archives) for any `"Cron: kb-reconcile-nightly"` task created on 08-03 — none exists. `/tmp/kb-reconcile-nightly.err` was last modified 2026-08-02 03:43, not touched since. No `mmrag.py`/reconcile process is currently running (`ps aux` checked). This means either the 08-03 scheduled fire silently failed before creating its tracking task (the prompt's `$(cortextos bus create-task ...)` capture with `2>/dev/null` would swallow that failure), or daemon bookkeeping stamped the timestamp without a completed dispatch. Either way, the cron's most recent scheduled real-world occurrence is unaccounted for — worth a live check next time it fires (should be ~2026-08-04T10:37Z / 03:37 PDT).

### Non-blocking Finding 2 — PR #240 logic not yet proven against a real production run

The last real ledger row is `2026-08-02T10:37:49Z`; PR #240 merged `2026-08-03T17:03:23-07:00`, i.e. *after* the last logged run. All 12 historical ledger rows predate the merge and correctly lack `failed_paths`/`quarantined_paths` keys (not a bug — expected, since the code that adds them didn't exist yet). All 12 rows also show `green: false` with a persistent `failed_files: 3` every single night since 08-01, unresolved — there is an open (status `pending`) task `task_1785780818076_75964035` ("P1.1 fix: diagnose+resolve kb-reconcile-nightly 3 persistent failed_files, get 1 green run") tracking this directly. PR #240's retry/quarantine logic is designed to address exactly this class of problem, and its unit tests pass cleanly (see above), but there is no live production ledger row yet showing the 3 persistent failures actually get retried/quarantined/resolved by the new code. Recommend treating "PR #240 fixes the persistent 3-file failure" as unproven until the next real nightly run (or a manual `mmrag.py reconcile` run) produces a ledger row with `failed_paths`/`quarantined_paths` populated.

## Summary table

| Claim | Verdict | Evidence |
|---|---|---|
| PR188: exactly 1 cron, no stale dup | PASS | crons.json direct read |
| PR188: daemon live | PASS | `ps -p $(cat daemon.pid)` |
| PR188: script order (reconcile→edges→ledger), no Telegram in script | PASS | full script read + `bash -n` + grep |
| PR188: alert logic in cron prompt (config.json:136) | PASS | direct read, line-matched |
| PR188: alert actually fired in prod | PASS (bonus) | 2 completed task records w/ "Telegram sent" results |
| PR240: commit merged/ancestor of HEAD | PASS | `git merge-base --is-ancestor` exit 0 |
| PR240: 429/500/503/504 retry w/ backoff | PASS | `TRANSIENT_HTTP_CODES`, `_retry_api_call` read + wired |
| PR240: quarantine detection, separate from generic failure | PASS | `_is_quarantine_worthy` read + wired into both ingest paths |
| PR240: failed_paths + quarantined_paths persisted | PASS | report dict + ledger composer read |
| PR240: own test suite passes | PASS | ran fresh, 16/16 assertions pass |
| Operational: latest cron fire (08-03) accounted for | **FINDING** | no task/ledger row despite crons.json timestamp |
| Operational: PR240 proven against live prod data | **FINDING (unproven, not disproven)** | merged after last ledger row; open task tracks the underlying persistent failure |
