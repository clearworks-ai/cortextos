# P1.6 — Research: claude-mem exporter → mmrag ingest

Source of truth (binding): ~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/
MASTER-BUILD-PLAN.md line 102 (P1.6). Scope = D5c — DECIDED (exporter, forward-only + FTS
backfill by query). Do NOT re-litigate; do NOT build a jsonl scraper; the 9.9 GB / 20,098
raw jsonl transcripts are archive only, NEVER raw-ingest.

## claude-mem.db — verified live (sqlite3 -readonly, 2026-08-01)

Path: `~/.claude-mem/claude-mem.db`. Counts as of this read (plan's "28,524" is stale):

| table | rows | id range | notes |
|---|---|---|---|
| `observations` | 28,776 | 1–28776 | created_at 2026-03-23 → now; ~220/day |
| `session_summaries` | 41,361 | 1–41361 | ~315/day |
| `user_prompts` | 71,569 | — | NOT in P1.6 scope (plan names observations + summaries) |
| `sdk_sessions` | — | — | session registry (project, started_at, status) |
| `pending_messages` | — | — | internal work queue, ignore |

### `observations` columns (actual)

`id` (INTEGER PK AUTOINCREMENT), `memory_session_id`, `project` (agent/repo slug: frank2
10,431 · auditmaster 2,683 · sage 2,543 · crm 2,227 · pa 2,110 · auditos-dev · cortextos ·
"521 Doordash" …), `text`, `type` (discovery 11,844 · feature 7,407 · change 5,401 ·
bugfix 2,186 · decision 1,688 · refactor 250), `title`, `subtitle`, `facts` (JSON array of
strings), `narrative`, `concepts` (JSON array, e.g. `["how-it-works","pattern"]`),
`files_read` (JSON array), `files_modified` (JSON array), `prompt_number`,
`discovery_tokens`, `created_at` (ISO-8601 Z), `created_at_epoch`, `content_hash`.

### `session_summaries` columns (actual)

`id` (PK AUTOINCREMENT), `memory_session_id`, `project`, `request`, `investigated`,
`learned`, `completed`, `next_steps`, `files_read`, `files_edited`, `notes` (all free
text; files_* JSON arrays), `prompt_number`, `discovery_tokens`, `created_at`,
`created_at_epoch`.

### FTS (why backfill-by-query works without bulk export)

- `observations_fts` — fts5 over title, subtitle, narrative, text, facts, concepts;
  content-table backed, kept in sync by AFTER INSERT/DELETE/UPDATE triggers.
- `session_summaries_fts` — fts5 over request, investigated, learned, completed,
  next_steps, notes; same trigger maintenance.
- `user_prompts_fts` — fts5 over prompt_text.

Verified: triggers exist for all three, so FTS is always current. Old history stays
queryable at zero export cost:
`sqlite3 -readonly ~/.claude-mem/claude-mem.db "SELECT id,title FROM observations WHERE id IN (SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'railway deploy') LIMIT 20;"`

## How "forward-only + FTS backfill by query" constrains the design

1. **No bulk historical export.** The ~70k existing rows are NOT converted to markdown.
   First run seeds the cursor to current `MAX(id)` per table and exports nothing.
2. **Durable high-water-mark.** `id` is AUTOINCREMENT → strictly increasing → the correct
   cursor (timestamps can collide/skew; ids cannot). One JSON state file holds
   `observations_last_id` + `session_summaries_last_id`. Each run exports
   `WHERE id > cursor ORDER BY id`, then advances the cursor only after files are written.
3. **Exported files are immutable.** Each run writes NEW batch file(s) named by id range
   and never rewrites old ones — so nightly mmrag reconcile (P1.1) sees them once as
   `new_files` and never re-chunks (append-to-one-file would churn the index nightly).
4. **History on demand = FTS query against the db itself** (read-only sqlite3, pattern
   above), optionally hand-filing a result via the P1.0 outputs-router if something old
   deserves permanent KB residence. No automated backfill machinery is built.

## Existing machinery this rides on (verified)

- **P1.1 nightly reconcile is live**: larry cron `kb-reconcile-nightly` at `37 3 * * *`
  (America/Los_Angeles) → `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` →
  `mmrag.py reconcile` over `DEFAULT_RECONCILE_ROOTS` (wiki, **raw**, org Brain) + ledger
  row in `larry/state/kb-reconcile-ledger.jsonl`.
- **Target dir is inside an existing reconcile root**: destination
  `~/code/knowledge-sync/raw/areas/clearworks/session-memory/` sits under `raw/` — mmrag
  picks it up automatically; **zero mmrag/root changes needed**. Dir does not exist yet
  (verified `ls`: No such file) — exporter creates it.
- **Provenance convention** (P1.0 outputs-router SKILL.md): frontmatter keys `agent:`,
  `job:`, `date:`, `source-task:` on `.md` files. Exporter writes these directly (it
  generates the .md; no need to shell out to `file_output.py`, which is built for filing
  an existing artifact by content type — but the frontmatter contract is honored).
- **Cron + wrapper + ledger shape precedent**: P1.1 (`kb-reconcile-nightly.sh` + JSONL
  ledger + config.json cron with create-task / update-cron-fire / previous-row red check /
  complete-task / SILENT-OK). P1.6 mirrors this exactly.

## Concurrency / safety notes

- claude-mem's worker writes to the db while sessions run. Exporter opens read-only
  (`file:...?mode=ro` URI) with a busy timeout — WAL-mode reads never block the writer
  and a partial read is impossible at the row level (cursor advances only on success).
- `observations.content_hash` + dedup index means rows are effectively insert-only;
  forward-only id cursor cannot miss updates that matter.

## Volume / noise observations (facts, not scope changes)

- Steady state ≈ 220 observations + 315 summaries per day → 2 batch files/day,
  roughly 0.5–1 MB/day of markdown. Trivial for reconcile.
- A visible fraction of rows is cron chatter (e.g. crm sync-board "noop: true" summaries,
  sage 5-min fleet-health observations). D5c as decided says export new
  observations/summaries — no filter is in scope. Flagged in 02-master-plan as an open
  flag for Josh at PR review, NOT built by default.

## Divergence budget

All new code lives under `orgs/clearworksai/agents/larry/` (bin script + state files) +
one cron object in larry's `config.json`. No `src/` changes → no fork-delta ledger row.
