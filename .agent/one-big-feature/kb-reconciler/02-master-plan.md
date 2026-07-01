# One-Big-Feature: kb-reconciler

**Repo:** cortextos (`~/code/cortextos`)
**Owner:** larry (spec + review + PR) → codexer (impl)
**Trigger:** Josh 2026-07-01 — Logan Currie retrieval as "an example of a system that doesn't work."
**Diagnosis of record:** `orgs/clearworksai/agents/larry/memory/analysis/kb-retrieval-system-redesign-2026-07-01.md`

## Framework choice
one-big-feature. Single cohesive feature, one repo (cortextos), one subsystem (`knowledge-base/scripts/mmrag.py` + one new scheduled job). Not a schema migration, not multi-repo, not a new repo.

## The problem in one line
Ingest is manual and forward-only, so search silently diverges from disk: new files are never indexed, edited files serve stale chunks, and deleted/trashed files stay authoritative forever. Measured: 29% of the live index (3,892 / 13,429 chunks) is `.trash/` content; Logan's file was never indexed at all.

## Key facts codexer must know
- `.trash`, `.obsidian`, `node_modules` etc. are ALREADY in `IGNORE_DIR_PARTS` (mmrag.py:47). The filter is forward-only — it stops NEW trash but never removes the 3,892 chunks already indexed. Do not "add .trash" and call it done.
- Manual ingest (`cmd_ingest`) can bypass the ignore filter when passed explicit file paths. Verify `_is_ignored` is enforced on every path, including explicit ones, unless `--force`.
- No `reconcile`/`reindex` command exists. Subcommands today: ingest, query, status, list, collections, delete, reset, usage (mmrag.py:1625+).
- Recency rerank shipped in PR #34 (`DEFAULT_RECENCY_WEIGHT=0.3`, mmrag.py:65; `_apply_recency_rerank`:562). Do not regress it; add a floor (spec 06).
- Collection env: `MMRAG_DIR`/`MMRAG_CHROMADB_DIR`/`MMRAG_CONFIG` under `~/.cortextos/<instance>/orgs/<org>/knowledge-base/`. Shared collection = `shared-<org>`.

## Components (build order — safest/highest-impact first)
1. **spec 01 — exclusion hardening + purge** (SAFE FIRST SLICE). Add `archive`, `deprecated`, `worktrees`, `.claude`, `.trash` (confirm) to ignore. Add `reconcile --purge-ignored` that deletes chunks whose source path is now ignored or gone from disk. Enforce `_is_ignored` on explicit ingest paths. → immediately removes the 3,892 trash chunks.
2. **spec 02 — corpus reconciler** (CORE). `cmd_reconcile`: walk canonical roots, per-file content hash stored in chunk metadata; new→ingest, changed-hash→re-ingest(replace), missing-from-disk→delete. Idempotent, `--dry-run`, prints a coverage delta. Wire a scheduled cron (crons.json, NOT config.json — config crons are inert).
3. **spec 03 — index auto-linker.** Regenerate each `wiki/**/_index.md` auto-section from files present (title from frontmatter), preserving hand-curated prose above a managed marker.
4. **spec 04 — parent-doc retrieval.** Query returns the source doc (or doc-level rollup + link) alongside the top chunk, so "give me X" yields the whole authoritative doc, not one paragraph.
5. **spec 05 — orphan reaper + deliver.** Reap empty `agent-*` collections (extend worker self-terminate + a sweep in reconcile). `deliver <path>` command → pushes a file to Drive/dashboard, returns a link.
6. **spec 06 — recency floor.** Cap recency's ability to demote a high-similarity authoritative doc below a fresher thin note.

## Test requirements (every spec)
Unit tests in `knowledge-base/scripts/_test_clients/` (pattern: `test_mmrag_hygiene.py` already exists). No `any`, no `console.log`-equivalent debug prints in committed code. Reconcile must be idempotent (second run = zero changes) and safe under `--dry-run`.

## Gates
- All merges to cortextos main = Josh approval (PR).
- Purge of existing trash/orphan chunks is destructive on the LOCAL kb store but fully reproducible by re-ingest. Run under bus task #1, `--dry-run` first, report counts before/after.

## Status
- [x] Diagnosis proven against live store
- [x] Immediate fix: Logan ingested (221 chunks), raw extract ranks #1
- [x] Josh: go on the build ("and fix this", 2026-07-01; reconfirmed "best way to have all this properly available… I won't have to think about it")
- [x] Specs 01-06 written
- [ ] codexer impl (order: 01→02 first = exclusion+purge + reconciler+nightly cron; then 03-06) → larry review → PR → Josh merge
