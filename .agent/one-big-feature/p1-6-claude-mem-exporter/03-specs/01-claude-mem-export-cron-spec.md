# Spec 01 — claude-mem-export cron (P1.6, buildable)

Binding scope: MASTER-BUILD-PLAN.md line 102 (D5c DECIDED — exporter, forward-only + FTS
backfill by query). Plan: ../02-master-plan.md. Research (real db schema):
../01-research.md. Branch: `feature/p1-6-claude-mem-exporter` (branch == slug, PR-gate rule).

## Files to create/modify

| Path | Action |
|---|---|
| `orgs/clearworksai/agents/larry/bin/claude-mem-export.sh` | NEW — bash wrapper |
| `orgs/clearworksai/agents/larry/bin/claude-mem-export.py` | NEW — worker (python3 stdlib only) |
| `orgs/clearworksai/agents/larry/config.json` | MODIFY — append one cron object |
| `tests/test_claude_mem_export.py` | NEW — pytest against a fixture sqlite db |

Runtime-created, never committed: `orgs/clearworksai/agents/larry/state/claude-mem-export-state.json`,
`…/state/claude-mem-export-ledger.jsonl`, `~/code/knowledge-sync/raw/areas/clearworks/session-memory/**`.
Do NOT touch: `src/`, `knowledge-base/scripts/mmrag.py`, `bin/kb-reconcile-nightly.sh`, claude-mem itself.

## 1 — `claude-mem-export.sh` (wrapper, mirrors kb-reconcile-nightly.sh shape)

```bash
#!/usr/bin/env bash
# Nightly claude-mem exporter: new observations/session_summaries -> markdown into
# knowledge-sync raw/areas/clearworks/session-memory/ (ingested by kb-reconcile at 03:37).
# Forward-only: cursor state file; history stays in claude-mem FTS (query on demand).
set -u
REPO=/Users/joshweiss/code/cortextos
DB="$HOME/.claude-mem/claude-mem.db"
OUT_ROOT="$HOME/code/knowledge-sync/raw/areas/clearworks/session-memory"
STATE="$REPO/orgs/clearworksai/agents/larry/state/claude-mem-export-state.json"
LEDGER="$REPO/orgs/clearworksai/agents/larry/state/claude-mem-export-ledger.jsonl"

python3 "$REPO/orgs/clearworksai/agents/larry/bin/claude-mem-export.py" \
  --db "$DB" --out-root "$OUT_ROOT" --state "$STATE" --ledger "$LEDGER" \
  --source-task "${1:-cron:claude-mem-export}" 2>>/tmp/claude-mem-export.err
exit $?
```

Notes: no venv (stdlib only). `$1` optionally carries the bus TASK_ID from the cron prompt
so provenance `source-task:` points at the actual bus task.

## 2 — `claude-mem-export.py` (worker)

CLI: `--db --out-root --state --ledger --source-task` (all required except source-task,
default `cron:claude-mem-export`). Optional `--dry-run` (print planned files + counts,
write nothing, no cursor advance) — used by tests and manual verification.

Behavior (exact):

1. **Open db read-only**: `sqlite3.connect(f"file:{db}?mode=ro", uri=True)`;
   `PRAGMA busy_timeout=5000`. Any open/query failure → append red ledger row
   (`"green": false, "error": "<msg>"`), exit 1. Never write to the db.
2. **Load state** from `--state` (JSON:
   `{"observations_last_id": int, "session_summaries_last_id": int, "last_run": iso}`).
   - Missing/unparseable file → **seed mode**: set both cursors to current `MAX(id)`
     (0 if table empty), write state atomically, append ledger row
     `{"ts", "run": "claude-mem-export", "seeded": true, "observations": {"from": N, "to": N, "count": 0}, "summaries": {...}, "files": [], "green": true}`,
     exit 0. NO export of history (forward-only; backfill = FTS query, see §5).
3. **Query new rows** (both tables, `ORDER BY id ASC`):
   - `SELECT id, memory_session_id, project, type, title, subtitle, text, facts,
     narrative, concepts, files_modified, created_at FROM observations WHERE id > ?`
   - `SELECT id, memory_session_id, project, request, investigated, learned, completed,
     next_steps, files_edited, notes, created_at FROM session_summaries WHERE id > ?`
   - Both empty → append green no-op row (`counts 0, files []`), exit 0.
4. **Render batch files** (one per table per run; immutable; never append to an existing
   file). Paths (dirs created with `mkdir -p` semantics):
   - `<out-root>/observations/<YYYY-MM-DD>-obs-<fromid>-<toid>.md`
   - `<out-root>/summaries/<YYYY-MM-DD>-sum-<fromid>-<toid>.md`
   `<YYYY-MM-DD>` = run date UTC. If target name exists (crash-rerun same day, same
   range), suffix `-r2`, `-r3`… — never overwrite.
5. **Atomic write**: render to `<target>.tmp` in the same dir, `os.replace` to final.
6. **Advance state** (atomic tmp+replace) ONLY after all files land, then **append
   ledger row**:
   `{"ts": "<UTC ISO Z>", "run": "claude-mem-export", "observations": {"from": F, "to": T, "count": C}, "summaries": {"from": F, "to": T, "count": C}, "files": ["<abs path>", ...], "green": true}`.
   Exit 0. Any exception mid-run → red row with `"error"`, no cursor advance, exit 1
   (bias: duplicate export possible, lost rows impossible).

### Markdown template — observations batch

````markdown
---
agent: larry
job: claude-mem-export
date: 2026-08-02
source-task: task_1234567890_12345678
source-db: ~/.claude-mem/claude-mem.db
source-table: observations
id-range: 28777-28995
---

# Claude session observations 2026-08-02 (ids 28777-28995)

Auto-exported from claude-mem (forward-only). History before id 28776: query
claude-mem FTS directly, do not re-export.

## [discovery] Fleet Health Status Check Executed at 04:38Z
- id: 28777 · project: sage · session: f3e78815 · 2026-08-01T04:39:14Z
- 12 agents monitored with 2 showing stale heartbeats under 3 hours

Facts:
- Auditmaster agent heartbeat stale at 2h46m since last seen
- 10 agents reporting healthy status …

Concepts: how-it-works, what-changed
Files modified: (none)

<narrative/text paragraph here when non-empty>

## [feature] Automated Fleet Health Monitoring via Cron
…
````

Rendering rules: section header = `## [<type>] <title>` (title fallback: `observation
<id>` if NULL). Meta line: id, project, first 8 chars of memory_session_id, created_at.
Subtitle as the second bullet when non-empty. `facts`/`concepts`/`files_modified` are
JSON arrays in the db — parse with `json.loads` (on parse failure, emit raw string);
facts → bullet list, concepts → comma line, files_modified → comma line or `(none)`.
`narrative` then `text` as plain paragraphs when non-empty. Skip empty fields entirely
(no "Facts:" header with no bullets).

### Markdown template — summaries batch

Same frontmatter (`source-table: session_summaries`, file title
`# Claude session summaries <date> (ids F-T)`). Per row:

````markdown
## <project> — <request truncated to 100 chars, fallback "session <id>">
- id: 41362 · project: cortextos · session: acad732f · 2026-08-01T04:58:38Z

Request: <request>
Investigated: <investigated>
Learned: <learned>
Completed: <completed>
Next steps: <next_steps>
Notes: <notes>
Files edited: <parsed list or (none)>
````

Empty fields skipped. All values written verbatim (content may contain markdown — fine;
frontmatter values are generated scalars only, never row content, so YAML stays valid).

## 3 — Cron entry (append to larry `config.json` `crons` array)

```json
{
  "name": "claude-mem-export",
  "type": "recurring",
  "cron": "12 3 * * *",
  "prompt": "TASK_ID=$(cortextos bus create-task 'Cron: claude-mem-export' --desc 'Nightly claude-mem exporter: new observations/summaries -> session-memory markdown for 03:37 kb-reconcile ingest' 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; cortextos bus update-cron-fire claude-mem-export --interval 24h 2>/dev/null; CLAUDE-MEM EXPORT — (1) Check the PREVIOUS run's row: tail -1 $CTX_AGENT_DIR/state/claude-mem-export-ledger.jsonl. If it is missing or has \"green\": false, send Telegram 6690120787 with the row — silent failure on a KB feed cron is NOT acceptable. (2) Run bash $CTX_AGENT_DIR/bin/claude-mem-export.sh $TASK_ID (foreground — it finishes in seconds; it writes its own ledger row). (3) If it exited 0: cortextos bus complete-task $TASK_ID --result 'claude-mem export ok' 2>/dev/null. SILENT-OK if previous row green and tonight's run exited 0."
}
```

Schedule rationale (verified against larry's live crons): 03:12 PT daily — before
`kb-reconcile-nightly` `37 3 * * *` so files ingest same night; clear of `30 2 * * *`
pipeline-bypass-audit, `7 3 * * 3` weekly-security-audit, `7 6` plan-adherence, `7 23`
usage-audit.

## 4 — Tests (`tests/test_claude_mem_export.py`)

Build a tmp fixture db with the real schema subset (observations + session_summaries,
AUTOINCREMENT ids). Assert:
1. Seed run: no state file → cursors == MAX(id), zero files written, ledger row has
   `seeded: true, green: true`.
2. Forward run: insert 3 obs + 2 summaries above cursor → exactly 2 files written, id
   ranges in names/frontmatter correct, cursor advanced to new MAX.
3. No-op run: rerun with no new rows → no files, green no-op ledger row.
4. Rendering: JSON-array facts become bullets; NULL title falls back; empty fields
   omitted; frontmatter parses as YAML (keys agent/job/date/source-task/source-db/
   source-table/id-range present).
5. Failure path: unreadable db path → exit 1, red ledger row, state file untouched.
6. Never-overwrite: pre-create the target filename → run writes `-r2` variant.

## 5 — Backfill-by-query (documented pattern, NOT automated)

History (ids ≤ seed cursor) is reached via claude-mem's own FTS, read-only:

```bash
sqlite3 -readonly ~/.claude-mem/claude-mem.db \
  "SELECT id, project, title, created_at FROM observations
   WHERE id IN (SELECT rowid FROM observations_fts WHERE observations_fts MATCH '<terms>')
   ORDER BY created_at_epoch DESC LIMIT 20;"
```

If a historical row deserves permanent KB residence, file it manually via the P1.0
outputs-router. No bulk backfill code in this build (D5c decided).

## Acceptance criteria (build-complete gate)

1. `npm run build` + `npm test` green (repo rules); `python3 -m pytest
   tests/test_claude_mem_export.py -v` green.
2. Manual proof on the REAL db, read-only, into a THROWAWAY out-root + state + ledger
   (e.g. `/tmp/p16-proof/`): seed run then forward run after new real rows exist —
   ledger shows seeded row + green row; batch file frontmatter valid; real db untouched
   (`sqlite3 -readonly` PRAGMA quick_check unchanged, no wal growth caused by us).
   Do NOT write the production state file pre-merge.
3. `config.json` parses (`python3 -c "import json; json.load(open(...))"`), new cron
   object matches the shape above.
4. PR to `clearworks-ai/cortextos` from `feature/p1-6-claude-mem-exporter`; Josh merges.
   Post-merge nights: night 1 seeds, night 2 exports + 03:37 reconcile ingests, done-
   condition per 02-master-plan §Done-condition (3 green ledger rows + chroma chunk
   count > 0 for `%/session-memory/%`).
