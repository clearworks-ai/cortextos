# kb-proactive-maintenance — master plan (OBF-lite)

Follows DESIGN-D-knowledge-base.md §3 exactly. Deterministic core + thin LLM verify (fleet cron doctrine).

## Deliverables

1. `knowledge-base/scripts/kb_maintenance.py` — the 3-tier engine.
   - **Tier 1 (nightly, zero-LLM)** — six scans, all reusing `mmrag._is_ignored` / `_file_content_hash`
     so the maintenance loop sees the SAME file universe the indexer does:
     1. `scan_dead_wikilinks` — every `[[link]]` in wiki+raw resolves (conservative exact-match index).
     2. `scan_orphans` — wiki articles missing from `_master-index.md` + index entries → deleted files.
     3. `scan_junk` — files not mmrag-ignored AND ext ∉ `mmrag.SUPPORTED_EXTS` (genuine index pollution).
     4. `scan_exact_dups` — content-hash clusters of byte-identical files at >1 path.
     5. `scan_freshness` — via `.synthesis-state.json`, flag wiki whose source raw sha changed / was deleted.
     6. `scan_read_canary` — seed kb-queries with expected top-hit substrings (injectable runner; live via
        `cortextos bus kb-query`). "Smart stranger" test operationalized.
   - **Tier 2 (weekly, Haiku, candidates ONLY)** — `run_tier2` seeds near-dup / staleness-triage /
     contradiction / one-fact-one-home from Tier-1 output; `_haiku_verdict_stub` is a documented,
     ready-to-enable LLM call gated on `KB_MAINT_ENABLE_LLM` (deterministic + free by default).
   - **Tier 3 (event-driven)** — `tier3_event_marks(changed_files)` maps reconcile changed raw paths →
     wiki articles → immediate stale-candidate marks (no new cron).
   - **Output routing** — one green/red row → `state/kb-maintenance-ledger.jsonl`; dated findings →
     `knowledge-sync/system/kb-maintenance/YYYY-MM-DD.md`; each finding carries a route:
     `auto-pr` (index regen / unambiguous rename-link repair) | `bus-task` (merges/deletions/rewrites) |
     `digest`. The module DETECTS + CLASSIFIES; never mutates the corpus.

2. `orgs/clearworksai/agents/larry/bin/kb-maintenance-sweep.sh` — sibling wrapper (NOT a reconcile step),
   runs Tier 1, appends the ledger row, writes the findings file, background-launched by cron.

3. Two cron entries in `orgs/clearworksai/agents/larry/config.json`:
   - `kb-maintenance-sweep` `47 4 * * *` (nightly, after reconcile 37 3; feeds Tier-3 from reconcile row;
     Telegram-on-red-or-missing).
   - `kb-maintenance-digest` `23 5 * * 0` (weekly Tier-2 + ONE Telegram digest, not per-item pings).

## Tests

`knowledge-base/scripts/_test_clients/test_kb_maintenance.py` — 9 real-case tests over a temp corpus:
dead-link (live vs dead + alias/heading forms), orphan+index-drift, junk (ingestible vs junk exts,
ignored dirs), exact-dup, freshness (fresh/stale/deleted-source), read-canary (pass/regress/error/none),
Tier-3 mapping, run_tier1+ledger+findings orchestration, Tier-2 stub candidate counting.

## Non-goals (DESIGN-D §4 fluff)

No `/knowledge` scaffold, no interview, no auto-apply of any fix. Approval-gated fixes are a later item.
