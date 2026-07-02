# Spec 01 — Exclusion hardening + purge (SAFE FIRST SLICE)

**File:** `knowledge-base/scripts/mmrag.py`
**Repo:** cortextos
**Goal:** Stop deleted/irrelevant content from being authoritative in search, and remove the 3,892 trash chunks already indexed. This is forward-fix + backfill-cleanup in one, low risk, highest immediate impact.

## Scope (exact)

### 1. Extend `IGNORE_DIR_PARTS` (mmrag.py:47)
Current set already has `.trash`, `.obsidian`, `.git`, `.cache`, `.venv`, `__pycache__`, `node_modules`, `.next`, `.turbo`, `dist`, `build`.
ADD: `archive`, `deprecated`, `worktrees`, `.claude`, `.venv-synth`, `.claude-flow`, `site-packages`, `dist-info`.
Rationale: `.claude/worktrees/` holds ≥4 duplicate copies of `mmrag.py` and vault snapshots that pollute results; `archive`/`deprecated` are lifecycle-tombstone conventions.
**LIVE PROOF (2026-07-01T05:39Z):** the deterministic retrieval hook that feeds every agent returned as TOP hits `knowledge-sync/.venv-synth/lib/python3.14/site-packages/httpx/_urls.py`, an `idna` LICENSE.md, and an empty `.claude-flow/data/auto-memory-store.json` (`[]`). Python virtualenv source + license boilerplate + empty json are being served as our "knowledge." `.venv` is in the ignore set but the actual dir is named `.venv-synth`; a plain `.venv` substring check misses it. Codexer: match venv dirs by pattern (`.venv*`) OR add the observed names explicitly, and confirm `site-packages`/`dist-info` anywhere in the path is excluded regardless of venv name.

### 2. Enforce `_is_ignored` on explicit ingest paths
In `cmd_ingest` (mmrag.py:1171), a file path passed explicitly must still be skipped if `_is_ignored(path)` is true, UNLESS `--force` is set. Today directory-walk ingest respects the filter but an explicit path may bypass it — that is how trash got in. Print `SKIP (ignored): <path>` for each.

### 3. New subcommand: `reconcile --purge-ignored`
Add `cmd_reconcile_purge` (full reconcile is spec 02; this is the purge-only slice).
Behavior:
- Iterate every chunk's `source_file` metadata in the target collection(s).
- For each unique source path: if `_is_ignored(Path(source))` OR the path no longer exists on disk → collect its chunk ids.
- Delete those chunk ids (`collection.delete(ids=...)`).
- Flags: `--collection <name>` (default all shared+agent), `--dry-run` (print what WOULD be deleted, delete nothing), `--json`.
- Output: `{purged_files, purged_chunks, kept_files, kept_chunks}` and per-reason counts (`ignored` vs `missing-from-disk`).

## Acceptance
- `reconcile --purge-ignored --dry-run` reports ~3,892 trash chunks / 14 files to purge on the current `shared-clearworksai` store (baseline measured 2026-07-01).
- After a real run, re-querying "Angela Algorithm women's work automation" returns NO `.trash/` source in the top 5.
- Idempotent: a second `--purge-ignored` run purges 0.
- Explicit `ingest <trash-file>` without `--force` prints SKIP and adds 0 chunks.

## Tests (`_test_clients/test_mmrag_hygiene.py` or new)
- ignore set contains the 4 new entries.
- `_is_ignored` true for `.../archive/x.md`, `.../.claude/worktrees/y.md`.
- purge dry-run selects an ignored + a missing-from-disk fixture, deletes nothing; real run deletes exactly those; second run deletes zero.
- explicit ingest of an ignored path adds 0 chunks without `--force`.

## Constraints
No `any`-equivalent, no stray debug prints. Match existing arg-parser + `cmd_*` style (mmrag.py:1594 `cmd_reset` is the closest sibling for a destructive op — mirror its confirm/`--json` shape).
