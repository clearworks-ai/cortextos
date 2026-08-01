# Spec 01 — Nightly kb-reconcile cron + wrapper + counts ledger

## Objective

Wire ONE daemon cron (owned by larry) that nightly: (a) runs `mmrag.py reconcile` across
`DEFAULT_RECONCILE_ROOTS`, (b) refreshes `kb-extract-edges`, (c) appends a counts row proving
freshness. Also spec (but do NOT execute now) the removal of frank2's `daily-wiki-prep` cron once
the done-condition is met.

## Owned files (this spec owns both, single-spec OBF-lite build)

- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` (new)
- `orgs/clearworksai/agents/larry/config.json` (append ONE object to the `crons` array — no other
  edits to this file)

## Files read but not edited

- `knowledge-base/scripts/mmrag.py` (`DEFAULT_RECONCILE_ROOTS` :135-139, `cmd_reconcile` :2765,
  report keys :1710-1727, subparser :3789) — do not modify
- `src/cli/bus.ts` (`kb-extract-edges` :2661) — do not modify; `src/` is off-limits per
  divergence budget
- `orgs/clearworksai/agents/frank2/config.json` (`daily-wiki-prep` at ~:202) — READ ONLY in this
  build; removal is a later PR (see final section)

## Provided contract — cron entry

Append to `orgs/clearworksai/agents/larry/config.json` `crons` (pattern precedent:
`pipeline-bypass-audit` entry in the same file):

```json
{
  "name": "kb-reconcile-nightly",
  "type": "recurring",
  "cron": "37 3 * * *",
  "prompt": "TASK_ID=$(cortextos bus create-task 'Cron: kb-reconcile-nightly' --desc 'Nightly KB reconcile: mmrag reconcile all roots + kb-extract-edges refresh + counts row' 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; cortextos bus update-cron-fire kb-reconcile-nightly --interval 24h 2>/dev/null; NIGHTLY KB RECONCILE — (1) Check the PREVIOUS run's row: tail -1 $CTX_AGENT_DIR/state/kb-reconcile-ledger.jsonl. If it is missing or has \"green\": false, send Telegram 6690120787 with the row — silent failure on a KB cron is NOT acceptable. (2) Launch tonight's run in the BACKGROUND (it can take hours on backlog nights; do not wait for it): run bash $CTX_AGENT_DIR/bin/kb-reconcile-nightly.sh as a background Bash call. The script writes its own ledger row when it finishes. (3) cortextos bus complete-task $TASK_ID --result 'kb-reconcile launched; previous night checked' 2>/dev/null. SILENT-OK if previous row green and launch succeeded."
}
```

Schedule rationale (all times America/Los_Angeles, larry's config tz): after frank2
`daily-wiki-prep` (`7 2 * * *`) so new wiki articles land before the walk; avoids larry
`pipeline-bypass-audit` (`30 2 * * *`) and the Wednesday `weekly-security-audit` (`7 3 * * 3`).

## Provided contract — wrapper script

Path: `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`. Bash, stdlib/python3 only, no
new dependencies. Behavior contract (codexer writes the final script to this contract):

```bash
#!/usr/bin/env bash
# Nightly KB reconcile: mmrag reconcile (all DEFAULT_RECONCILE_ROOTS) + kb-extract-edges
# refresh + one JSONL counts row. Launched in background by larry's kb-reconcile-nightly cron.
set -u
REPO=/Users/joshweiss/code/cortextos
PY="$REPO/knowledge-base/venv/bin/python3"
MMRAG="$REPO/knowledge-base/scripts/mmrag.py"
LEDGER="$REPO/orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1 — reconcile (defaults cover all 3 DEFAULT_RECONCILE_ROOTS + shared-clearworksai)
RECON_OUT="$("$PY" "$MMRAG" reconcile --json --yes 2>>/tmp/kb-reconcile-nightly.err)"
RECON_STATUS=$?

# Step 2 — edge refresh (deterministic, zero-LLM)
EDGES_OUT="$(cortextos bus kb-extract-edges --org clearworksai --json 2>>/tmp/kb-reconcile-nightly.err)"
EDGES_STATUS=$?

# Step 3 — compose + append counts row (python3 heredoc; see row schema below)
# - reconcile stdout is NOT pure JSON even with --json: per-file "SKIP (error)" lines print
#   before the report (mmrag.py ~:1699). Parse the LAST JSON object on stdout.
# - never crash without a row: on any parse/exit failure, write a row with green:false and
#   whatever fields were recoverable.
```

Row composition rules:
- Parse the LAST JSON object from `RECON_OUT` (split on lines, take the final line that parses as
  JSON — the `_emit_report` dump). `EDGES_OUT` with `--json` is a clean JSON object (stderr may
  carry a node:sqlite warning — already routed to the err file).
- `green` = (`RECON_STATUS == 0`) AND (`EDGES_STATUS == 0`) AND reconcile `failed_files == 0` AND
  all three `delete_failures` counters == 0 AND edge-extract `errors` list empty.
- Append exactly one line to `$LEDGER` per run, creating the file if absent (append-only, never
  rewrite). Exit with the reconcile status so the err file + any caller sees failure.

## Provided contract — counts-row format

Location: `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` (agent-owned state dir;
runtime-created, not committed). One JSON object per line:

```json
{
  "ts": "2026-08-01T10:37:00Z",
  "run": "kb-reconcile-nightly",
  "reconcile": {
    "status": 0,
    "new_files": 0, "new_chunks": 0, "changed_files": 0, "removed_files": 0,
    "failed_files": 0, "resumed_files": 0,
    "total_files_on_disk": 0, "total_files_indexed_after": 0,
    "delete_failures": {"files": 0, "chunks": 0, "batches": 0}
  },
  "edges": {
    "status": 0,
    "filesScanned": 0, "filesSkippedUnchanged": 0,
    "edgesUpserted": 0, "typedEdges": 0, "errors": 0
  },
  "green": true
}
```

Field names are lifted verbatim from the live report dicts (`_reconcile_collection` return,
`mmrag.py:1710-1727`; `extractEdges` result, `bus.ts` kb-extract-edges action). FLAG: this schema
is derived by this plan, not dictated by the binding doc — build step keeps it as spec'd unless a
conflicting convention surfaces; do not invent extra fields.

## Consumed contracts

- `mmrag.py reconcile --json --yes` — existing; `--json` alone satisfies the confirm gate
  (`cmd_reconcile` :2766) but keep `--yes` for explicit intent. No `--roots`/`--collection`
  overrides: defaults are exactly the binding scope.
- `cortextos bus kb-extract-edges --org clearworksai --json` — existing.
- Gemini key via mmrag's `load_config()` — if missing, reconcile exits non-zero → red row →
  Telegram next fire. Do not add key-handling logic to the wrapper.

## Adjacent specs

None (single-spec OBF-lite build).

## Implementation steps

1. Write `kb-reconcile-nightly.sh` to the wrapper contract above (`chmod +x`).
2. Append the cron object to larry's `config.json` `crons` array. Valid JSON, no trailing comma,
   no reordering of existing entries.
3. Manual dry run of the wrapper pieces (NOT a full mutating first run — that is hours of ingest
   and belongs to the first scheduled fire):
   - `"$PY" "$MMRAG" reconcile --dry-run --json` → confirm last-line JSON parses and shows the
     expected gap (`new_files` ≈ 206 Brain + raw backlog).
   - `cortextos bus kb-extract-edges --org clearworksai --json` → confirm clean JSON (this one is
     cheap and safe to run for real).
   - Run the row-composer path against those two outputs → confirm one well-formed ledger line,
     then delete the scratch line/file.
4. `python3 -c "import json; json.load(open('orgs/clearworksai/agents/larry/config.json'))"` must
   pass after the config edit.

## Validation requirements

Paste into the handoff:
- The dry-run reconcile last-line JSON (proves parseability + shows the live gap numbers).
- The real `kb-extract-edges --json` output.
- The composed scratch ledger row + confirmation it was cleaned up.
- The config.json JSON-validity check output.

First-fire expectations (post-merge, informational for the reviewer): Brain gap (206 files) should
close night one; raw backlog (~26k files) may take multiple nights — the checkpoint machinery
(`reconcile_checkpoints`, `resumed_files`) makes interrupted/multi-night runs safe and the
`resumed_files` field in each row proves forward progress. No timing precedent exists in the repo;
do not promise a one-night close.

## Done-condition + frank2 daily-wiki-prep removal (spec only — DO NOT execute in this build)

Binding (MASTER-BUILD-PLAN.md line 96 + 265-266, single verdict):
1. Wait for 3 CONSECUTIVE rows with `"green": true` in
   `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` (check:
   `tail -3` — all green, dates consecutive) AND both gaps closed
   (`total_files_indexed_after` ≈ `total_files_on_disk`, `new_files` at steady-state).
2. THEN open a separate PR to `clearworks-ai/cortextos` that deletes exactly one object from
   `orgs/clearworksai/agents/frank2/config.json` `crons`: the entry with
   `"name": "daily-wiki-prep"` (`"cron": "7 2 * * *"`, currently at ~line 202). Nothing else in
   frank2's config changes. PR body cites the 3 green ledger rows verbatim as evidence.
3. Josh approves that merge (main-merge gate). Single verdict — removal, not keep+fold; do not
   re-litigate.

## Handoff requirements

Standard OBF handoff: files changed, dry-run commands + output, risks, branch name, cleanup notes.
Branch off `main`, PR to `clearworks-ai/cortextos` — never push to main directly. Do not touch
frank2's config in this PR.
