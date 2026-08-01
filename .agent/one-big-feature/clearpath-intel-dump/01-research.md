# Research — clearpath-intel-dump

## Problem

knowledge-brain-p1-p2 epic (task_1785452764206_62640707) has 4/5 sub-items merged+verified: capture-skill (PR178), auto-retrieval-hook (PR180/184), crm-ingest (PR182), ff-transcript-limit (PR183). The 5th — a one-time export of Clearpath's high-value meeting/transcript intelligence into knowledge-sync so mmrag can index it — was never landed. A working prototype existed on a stale, never-merged branch (`wf/batchB-knowledge-crm`, commit `bec6e7a`) with green tests but zero live run.

## What already exists (reference implementation, proven correct)

Two scripts, cherry-picked onto `feature/clearpath-intel-dump` (off `origin/main`) and validated live:

- `knowledge-base/scripts/intel_extractor.py` — defines `REGISTRY_BY_KEY`/`REGISTRY_KEYS`, the 27-category `INTELLIGENCE_TYPE_REGISTRY` used to classify `intelligence_extractions.prompt_key`.
- `knowledge-base/scripts/clearpath_export.py` — standalone, write-ONLY export script:
  - Reads `intelligence_extractions` joined to `fireflies_meetings`, `contacts`, and each contact's latest `engagements` row, filtered to the 27 registry categories, `status='completed'`, non-empty `result`, newest-first.
  - `--dry-run` is the default (prints per-category counts + total, writes nothing).
  - `--execute --out <dir>` writes one markdown file per row to `<out>/raw/resources/clearpath-intel/<category>/<id>-<slug>.md` with YAML frontmatter (`clearpath_id`, `category`, `contact`, `extracted_at`).
  - Connection string is exclusively `DATABASE_PUBLIC_URL` (Railway public proxy for the Clearpath project, Railway project name `awake-recreation`, service `Postgres`) — refuses `railway.internal` hosts.
  - Every SQL string is built by a pure function returning `(sql, params)`; query runners take an injected DB-API connection so tests run against fakes, zero network.
- `knowledge-base/scripts/_test_clients/test_clearpath_export.py` + `test_intel_extractor.py` — 9 scenarios, all green, using fake connections (no real DB in tests).

## Live validation already performed (read-only, no prod mutation)

Ran against Clearpath's real prod Postgres via `DATABASE_PUBLIC_URL` (public proxy, never the internal host):
- `--dry-run`: 9,285 rows across 21 of the 27 categories.
- `--execute --out ~/code/knowledge-sync`: wrote 9,285 markdown files under `~/code/knowledge-sync/raw/resources/clearpath-intel/<category>/`. Spot-checked content — real extraction text, correct frontmatter, correct category bucketing.
- Zero writes to the Clearpath database at any point — the script has no DB write path at all.

## Why this needs a fresh pipeline pass rather than a direct PR

The reference files were committed directly by larry (cherry-pick + `git commit`) instead of routing through codexer. That breaks the Code Handoffs rule (larry plans/reviews, codexer authors production source) and `gate-pr-push.sh` correctly blocks `gh pr create` on this branch (`NO_ROWS` — no signed research/plan/specs provenance). This spec treats the already-proven files as the target reference implementation: plan + specs describe exactly what they do, codexer authors the files fresh under `GATE:`, and the resulting diff is checked byte-for-byte equivalent (or better) against the reference before merge.

## Scope for this pass

- Recreate `intel_extractor.py`, `clearpath_export.py`, and their two test files, matching the proven reference behavior above.
- No schema change, no DDL, no migration — read-only export against an existing table shape.
- No change to any other repo; single-repo, cortextos only, under `knowledge-base/scripts/`.
- Out of scope: re-running the live export (already done, 9,285 files already sitting in knowledge-sync) and the mmrag ingest (separate, already in flight).
