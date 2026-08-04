# Spec 01 — Tier-1 deterministic scans

Module: `knowledge-base/scripts/kb_maintenance.py`. All scans return `ScanResult(findings, errored, error)`.
`errored=True` means the scan itself crashed (reddens the run); findings themselves are the corpus health
signal, NOT a red run — mirrors reconcile's "did the run succeed" semantics.

| Scan | Function | Detects | Route |
|---|---|---|---|
| dead wikilink | `scan_dead_wikilinks` | `[[link]]` with no exact home (basename/area-base/raw-base) | auto-pr |
| orphan / drift | `scan_orphans` | wiki not in `_master-index.md`; index → deleted file | auto-pr |
| junk | `scan_junk` | not mmrag-ignored AND ext ∉ `mmrag.SUPPORTED_EXTS` | bus-task |
| exact dup | `scan_exact_dups` | byte-identical files (sha256) at >1 path | bus-task |
| freshness | `scan_freshness` | `.synthesis-state.json` raw_sha drift / source deleted | bus-task |
| read canary | `scan_read_canary` | seed query loses its expected top-hit substring | bus-task |

Ledger row (`compose_ledger_row`): `{ts, run, counts{scan:n}, total_findings, errored_scans, green}`.
`green = no scan crashed`. Written by `append_ledger` (fsync). Findings file by `write_findings_file`
(per-scan cap 200 lines). `run_tier1(...)` orchestrates all six; every corpus path is parameterized so
tests re-root at a temp corpus.

## Tier 2 (spec, same module)

`run_tier2(tier1)` builds candidate prompts from Tier-1 output ONLY (never the whole corpus) for the four
DESIGN-D checks; `_haiku_verdict_stub` gated on `KB_MAINT_ENABLE_LLM` (latest Haiku, no pinned legacy id).
`_one_fact_one_home_candidates` greps mutable-fact tokens (model ids / `$`prices / URLs) appearing in >1 file.

## Tier 3 (spec, same module)

`tier3_event_marks(changed_files)` — reconcile changed raw paths → wiki via `.synthesis-state.json` →
`wiki_stale_candidate_event` findings (route bus-task). Tolerates leading `./`.
