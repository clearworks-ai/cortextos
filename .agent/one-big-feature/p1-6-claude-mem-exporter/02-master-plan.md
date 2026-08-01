# P1.6 — claude-mem exporter cron (OBF-lite, exempt)

Source of truth: MASTER-BUILD-PLAN.md line 102 (binding, D5c DECIDED: exporter,
forward-only + FTS backfill by query). Research: 01-research.md in this dir.
Precedent mirrored: P1.1 (`.agent/one-big-feature/p1-1-kb-reconcile-cron/`).

## Scope (why OBF-lite exempt, not full M2C1)

Single repo (cortextos), no schema migration, no new subsystem, no `src/` change. The
distillation already exists (claude-mem SQLite, FTS-indexed); the reconcile/ingest side
already exists (P1.1 nightly). This item is a small read-only exporter + cron wiring:

1. One exporter script under `orgs/clearworksai/agents/larry/bin/` (divergence budget:
   custom code in `orgs/`, never `src/` — same rule as P1.0/P1.1).
2. One cron entry appended to larry's `config.json` `crons` (larry = owner: he already
   owns kb-reconcile-nightly; this feeds it).
3. A cursor state file + a JSONL run ledger under `larry/state/` (runtime-created, not
   committed — P1.1 ledger precedent).

Explicitly NOT in scope: jsonl transcript scraping (forbidden by plan line 102), bulk
historical export (forward-only), `user_prompts` export (plan names observations +
summaries only), P1.5 agent-memory *.md files (separate track), any mmrag/`src/` change,
any content filter (see Open flags).

## Deliverable 1 — exporter (wrapper + worker)

- `orgs/clearworksai/agents/larry/bin/claude-mem-export.sh` — thin bash wrapper, same
  shape as `kb-reconcile-nightly.sh` (set -u, REPO/paths at top, UTC ts, appends the
  ledger row via the worker's exit path). Kept thin because the whole job is
  sqlite + templating.
- `orgs/clearworksai/agents/larry/bin/claude-mem-export.py` — stdlib-only Python 3 (sqlite3, json,
  pathlib; system `python3`, no venv needed — read-only db + text writes). Testable like
  P1.2's `mirror_deliverables.py` (small pytest in `tests/`).

Worker algorithm (per run):
1. Open `~/.claude-mem/claude-mem.db` read-only (`file:` URI `mode=ro`, busy_timeout).
2. Load cursor state `larry/state/claude-mem-export-state.json`. If absent →
   **seed** `observations_last_id = MAX(observations.id)`,
   `session_summaries_last_id = MAX(session_summaries.id)`, write state, append ledger
   row `{"seeded": true, …}`, export nothing, exit 0. (This IS forward-only semantics:
   history stays in claude-mem FTS, backfilled by query on demand.)
3. `SELECT … FROM observations WHERE id > ? ORDER BY id` (and same for
   session_summaries). Zero new rows in both → append green no-op ledger row, exit 0.
4. Render one markdown batch file per table per run (immutable, id-range-named) into
   `~/code/knowledge-sync/raw/areas/clearworks/session-memory/observations/` and
   `…/session-memory/summaries/` (dirs created on demand). Exact template in spec-01.
   Frontmatter carries P1.0 provenance keys (agent/job/date/source-task) + source db,
   table, id range.
5. Write files atomically (tmp + rename), THEN advance the cursor state, THEN append the
   ledger row `{"ts", "run": "claude-mem-export", "observations": {from,to,count},
   "summaries": {from,to,count}, "files": [...], "green": bool}`. Crash between write and
   cursor advance → next run re-exports the same range to a new file; mmrag dedups
   nothing but the duplicate is bounded to one run and green:false rows expose it —
   acceptable; never the reverse (cursor advanced past unexported rows).

## Deliverable 2 — cron entry (larry `config.json`)

Mirror the `kb-reconcile-nightly` object verbatim in shape (create-task →
update-cron-fire → check previous ledger row, Telegram 6690120787 only if red/missing →
run script → complete-task → SILENT-OK). Exact JSON in spec-01.

**Schedule: `12 3 * * *`** (larry tz America/Los_Angeles), i.e. 25 minutes BEFORE
`kb-reconcile-nightly` at `37 3 * * *`. Rationale:
- The export is seconds of work (~500 rows/day, pure sqlite read + file writes) — runs
  foreground in the cron turn, no background launch needed (unlike P1.1's hours-long
  reconcile).
- Collision-checked against larry's existing crons: `30 2 * * *` pipeline-bypass-audit,
  `7 3 * * 3` weekly-security-audit (Wed), `37 3 * * *` kb-reconcile, `7 6`, `7 23` —
  03:12 is clear every day.

## Hook into P1.1 nightly reconcile — ordering/dependency

Loose coupling by schedule, no code coupling: exporter lands new .md files under
`knowledge-sync/raw/…/session-memory/` at 03:12; reconcile fires 03:37 over
`DEFAULT_RECONCILE_ROOTS` which already includes `raw/` — **no mmrag root change, no
edit to kb-reconcile-nightly.sh**. If a night's export fails or runs long, its files
simply ingest the following night (reconcile is diff-based); the red-row Telegram check
in the exporter's own cron surfaces the failure. Batch files are immutable + id-range
named, so reconcile sees each exactly once as `new_files` — no nightly re-chunk churn.

## Done-condition (machine-checkable)

1. State file exists and matches the db:
   `python3 -c` compare `claude-mem-export-state.json` cursors == `MAX(id)` per table at
   check time (allowing rows newer than last 03:12 run).
2. Ledger `larry/state/claude-mem-export-ledger.jsonl` — **3 consecutive green rows**
   (green = exit 0, files written == files listed, cursors advanced; no-op nights count
   as green). Mechanical: `tail -3`, all `"green": true`, dates consecutive.
3. Files on disk: ≥1 `.md` under `session-memory/` with valid provenance frontmatter
   (`agent:`, `job:`, `date:`, `source-task:`, `source-table:`, `id-range:`).
4. Index proof (P1 phase done-condition alignment):
   `sqlite3 …chroma.sqlite3` chunk count for `source_file LIKE '%/session-memory/%'` > 0
   after the first post-export reconcile — i.e. the next `kb-reconcile-ledger.jsonl` row
   shows `new_files` ≥ the count of files the exporter wrote that night, and a
   `kb-query` for a distinctive exported title returns a session-memory citation.

## File ownership

Codexer owns (committed):
- `orgs/clearworksai/agents/larry/bin/claude-mem-export.sh` (new)
- `orgs/clearworksai/agents/larry/bin/claude-mem-export.py` (new)
- `orgs/clearworksai/agents/larry/config.json` (one cron object appended)
- `tests/test_claude_mem_export.py` (new, P1.2 test precedent)

Runtime-created (not committed):
- `orgs/clearworksai/agents/larry/state/claude-mem-export-state.json`
- `orgs/clearworksai/agents/larry/state/claude-mem-export-ledger.jsonl`
- `~/code/knowledge-sync/raw/areas/clearworks/session-memory/**` (lands in the
  knowledge-sync repo; its own commit cadence handles it, reconcile reads disk)

NOT touched: `knowledge-base/scripts/mmrag.py`, `bin/kb-reconcile-nightly.sh`, anything
under `src/`, claude-mem itself (db opened read-only only).

## Open flags (surface at PR review, do not guess at build time)

1. **Noise filter** — a visible share of rows is cron chatter (crm sync-board noops,
   sage 5-min health checks). D5c as decided = export new observations/summaries, no
   filter; shipping unfiltered. If Josh wants one later it's a one-line WHERE clause —
   flag it in the PR body, don't build it.
2. **Cron owner = larry** — inherited from P1.1's flagged default (larry owns the
   reconcile cron this feeds). Same paper-trail-via-PR treatment.
3. **Duplicate-on-crash window** (write-then-advance ordering) is deliberately biased to
   never lose rows; a re-exported batch shows as a second file for the same id range —
   note in PR, no dedup machinery.

## Rollout

Feature branch `feature/p1-6-claude-mem-exporter` off cortextos main, PR to
`clearworks-ai/cortextos`, Josh approves merge (never direct to main). After merge +
daemon config reload, first fire 03:12 PT seeds the cursor (no-op export); night two
produces the first batch files; night two's 03:37 reconcile ingests them; done-condition
checks run from night four (3 green rows).
