# kb-proactive-maintenance — research

Design source (binding): `knowledge-sync/raw/areas/clearworks/altari-skilltree/DESIGN-D-knowledge-base.md` §3.

## Existing machinery this builds ON TOP OF (read, verified)

- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` (PR #188) — nightly index-freshness:
  mmrag reconcile (re-embed new/changed/removed) + `bus kb-extract-edges` (links.sqlite) + one
  green/red row to `state/kb-reconcile-ledger.jsonl`, Telegram-on-red. Answers *is every file indexed*.
- `knowledge-base/scripts/mmrag.py` — `DEFAULT_RECONCILE_ROOTS = (wiki, raw)`; `_is_ignored()` (:1119)
  drops `.trash/.obsidian/.claude/worktrees/…` + junk exts; `_file_content_hash()` (:1155) sha256;
  `SUPPORTED_EXTS` = the exact set mmrag will ingest (anchor for the junk allowlist).
- `knowledge-sync/wiki/.synthesis-state.json` (614 entries) — per-slug `{raw_path, raw_sha, wiki_path,
  generated_at}`. THIS is the raw→wiki provenance map DESIGN-D §5/Tier-3 needs; no new emitter required.
- `knowledge-sync/wiki/_master-index.md` — `- [title](wiki/<area>/slug.md) \`area\`` lines (orphan/drift source).
- `src/bus/kb-graph/resolve.ts::createSlugResolver` — the exact-match tier the dead-link scan mirrors
  conservatively (basename / area-base / raw basename; no fuzzy, so we never flag a resolvable link).
- Pipeline stages (`src/pipeline/ledger.ts` STAGES): research/synthesize/plan/specs/implement/review/…;
  build legitimately earns research→…→implement; review/true-verify left for the independent reviewer.

## The gap (DESIGN-D §3)

Index freshness ≠ content health. Nothing checks dead links, orphans, junk-in-index, dups, staleness,
or read-side retrieval. Live symptoms: write-only wiki, `.DS_Store`/binaries in top hits, reworded dups,
months-stale wiki over changed raw, cross-store contradiction (Clearpath-Intelligence steering bug).

## Build shape

OBF-lite: single repo, no schema, no `src/` change. One python module + one shell wrapper (sibling to
kb-reconcile so a sweep crash can't redden reconcile) + two cron entries in larry's config.json. Detects
and classifies only — never mutates the corpus (applying fixes is a separate approval-gated step).
