# Spec 02 — Corpus reconciler (CORE) + nightly cron

**File:** `knowledge-base/scripts/mmrag.py` (new `cmd_reconcile`) + `orgs/clearworksai/agents/larry/crons.json` (new nightly cron)
**Repo:** cortextos
**Goal:** Make the index a deterministic mirror of disk. One command walks the canonical roots and brings the RAG into exact agreement with what is actually on disk: new files ingested, changed files re-ingested, deleted/ignored files removed. Then a nightly cron runs it so the index never silently diverges again. This is the fix for Josh's core complaint — "supposed to ingest every night… never worked."

## Depends on
Spec 01 (`_is_ignored` hardening + purge slice). `cmd_reconcile` SUPERSETS `reconcile --purge-ignored`: purge becomes one phase of the full reconcile.

## Key facts codexer must know
- Ingest today is manual + forward-only. There is no content-hash tracking, so an edited file re-ingested produces DUPLICATE chunks (old stale chunks are never removed). Reconcile must replace-by-source, not append.
- Chunk metadata already carries `source_file` (used by spec 01 purge). Reconcile ADDS a per-file `content_hash` (sha256 of file bytes) to every chunk's metadata at ingest time so change-detection is O(1) per file without re-embedding.
- Canonical roots to walk (the real knowledge base, nothing else):
  - `~/code/knowledge-sync/wiki/`
  - `~/code/knowledge-sync/raw/`
  - Do NOT walk `.venv-synth`, `.claude`, `.trash`, `archive`, `deprecated`, `worktrees`, `node_modules`, `site-packages` (all handled by `_is_ignored` after spec 01). Reconcile MUST route every candidate path through `_is_ignored`.
- Target collection for these roots = `shared-clearworksai` (the shared org collection). Agent-private collections are out of scope for the corpus walk (handled by spec 05 orphan reaper).

## Scope (exact)

### 1. Content-hash at ingest (mmrag.py, `cmd_ingest` / chunk-write path)
When writing chunks for a file, compute `content_hash = sha256(file_bytes).hexdigest()` once per file and store it in every chunk's metadata as `content_hash`, alongside existing `source_file`. Also store `source_mtime` (float) for observability. No behavior change to embeddings.

### 2. New subcommand: `reconcile`
`cmd_reconcile(collection, roots, dry_run, json_out)`:
1. **Scan disk:** walk each canonical root, collect every non-ignored file with a supported extension (reuse the existing supported-extension set from `cmd_ingest`). For each, compute `content_hash`. Build `disk = {source_path: content_hash}`.
2. **Scan index:** read all chunk metadata in the collection; build `indexed = {source_path: content_hash}` (take the hash from any chunk of that file; if chunks disagree, treat as changed).
3. **Diff into four sets:**
   - `new` = in disk, not in index → ingest.
   - `changed` = in both, hash differs → delete existing chunks for that source, then ingest.
   - `removed` = in index, not on disk (deleted) → delete chunks.
   - `ignored` = in index but path now `_is_ignored` → delete chunks (this is the spec-01 purge phase, folded in).
   - `unchanged` = in both, hash equal → no-op.
4. **Apply** (unless `--dry-run`): perform deletes then ingests. Deletes by chunk id via `collection.delete(ids=...)`.
5. **Report** a coverage delta:
   `{new_files, new_chunks, changed_files, removed_files, ignored_files, purged_chunks, unchanged_files, total_files_on_disk, total_files_indexed_after}`.

### 3. Flags
`--collection <name>` (default `shared-clearworksai`), `--roots <path>[,<path>]` (default the two canonical roots), `--dry-run`, `--json`. Mirror `cmd_reset`'s destructive-op confirm shape for the non-dry real run (unless `--json`/`--yes`).

### 4. Nightly cron (crons.json — NOT config.json; config crons are inert)
Add to `orgs/clearworksai/agents/larry/crons.json` via `cortextos bus add-cron` (then verify it persisted in crons.json). Schedule: nightly, staggered off other larry crons — propose `07 08 * * *` (08:07 UTC ≈ 01:07 PDT), AFTER `daily-wiki-prep` (09:07Z writes wiki drafts)… **correction:** run reconcile AFTER wiki synthesis so freshly-synthesized wiki files get indexed the same night. Schedule reconcile at `30 09 * * *` (09:30Z, ~23 min after daily-wiki-prep at 09:07Z). Command: run mmrag reconcile against `shared-clearworksai` over the canonical roots, `--json`, log the delta to `orgs/clearworksai/agents/larry/memory/reports/`, SILENT-OK (no Telegram) unless it errors or purges an anomalous count (>500 chunks in one night → surface to larry, not Josh).

## Acceptance
- On the live store, first real `reconcile` run: `removed`+`ignored` clears all remaining trash/junk; `new` picks up every un-indexed wiki/raw file (Logan already in, so count reflects the rest of the gap).
- Idempotent: a second `reconcile` immediately after reports `new=0, changed=0, removed=0, ignored=0` (all `unchanged`).
- Edit a wiki file → reconcile → that file shows as `changed`, old chunks gone, new chunks present, total chunk count for that file does not double.
- Delete a file from disk → reconcile → its chunks removed, query no longer returns it.
- `--dry-run` mutates nothing (chunk count identical before/after).
- Cron present in crons.json and fires (verify with `cortextos bus list-crons` / crons.json inspection, not config.json).

## Tests (`_test_clients/test_mmrag_reconcile.py`)
- Fixture root with 3 files → reconcile ingests 3 (`new=3`); rerun → `unchanged=3`.
- Mutate 1 file's bytes → reconcile → `changed=1`, no duplicate chunks (assert chunk count stable).
- Remove 1 file → reconcile → `removed=1`, chunks gone.
- Add an ignored path with pre-existing chunks → reconcile → `ignored=1`, chunks purged.
- `--dry-run` variants assert zero mutation.
- content_hash + source_mtime present in written chunk metadata.

## Constraints
No `any`-equivalent, no stray debug prints (use the existing logging pattern). Reconcile must be safe to run repeatedly and while agents query (deletes are per-id, not collection-wide). Do not regress the recency rerank from PR #34. Match existing `cmd_*` + arg-parser style; `cmd_reset` (mmrag.py:1594) is the sibling for the destructive confirm path.
