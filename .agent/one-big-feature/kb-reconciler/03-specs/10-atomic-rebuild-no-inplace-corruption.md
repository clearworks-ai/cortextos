# Spec 10 — Atomic rebuild: full reconcile builds into a temp store and swaps only on success

## Problem (proven live, 2026-07-02 incident)
`_reconcile_collection` mutates the **live** chroma collection in place: it deletes changed/removed/ignored chunks and ingests new/changed files directly into the running store. When the ~47-min full reconcile hung (spec 09) and was killed mid-write, the interrupted in-place write **corrupted the live index** (segfault on load, exit 139) AND ballooned the directory to **427 GB** (healthy ≈ 1.1 GB). Recovery required restoring the pre-run backup — i.e. the whole run's cleanup work was lost, and the live KB was down until restore. A KB that can be bricked by interrupting a rebuild is not "properly available."

Root design flaw: **there is no isolation between the rebuild and the serving copy.** Any interruption (kill, crash, OOM, machine sleep, `spawnSync` SIGTERM from the bus wrapper) can corrupt the live store.

## Goal
A full/from-scratch reconcile must NEVER touch the live serving store until it has fully succeeded. Interruption at any point leaves the live store exactly as it was.

## Scope
File: `knowledge-base/scripts/mmrag.py` (+ tests). Introduce a rebuild-into-temp + atomic-swap path. Keep the existing incremental reconcile for small nightly deltas (low risk), but route **full rebuilds** through the safe path.

### Fix A — `reconcile --rebuild` (build-into-temp + atomic swap)
- Add a `--rebuild` flag (and/or a `rebuild` subcommand) that performs a from-scratch mirror:
  1. Resolve the live chroma dir (the `MMRAG_CHROMADB_DIR` / `MMRAG_DIR/chromadb` path already used by `get_chroma_client`).
  2. Create a sibling temp dir `<chromadb_dir>.rebuild-<pid>-<n>` and a fresh `PersistentClient` + collection (same collection name) THERE. Never open the live dir for writing during rebuild.
  3. Ingest ALL disk files for the roots into the temp collection, using the spec-08 per-file try/except isolation and the spec-09 timeouts/retries. Track `failed_paths`, counts, etc. exactly as the incremental path does.
  4. **Sanity guards before swap** (all must pass or ABORT the swap, leaving live untouched):
     - temp collection `count()` > 0 and within a sane ratio of the previous live count (e.g. abort if temp count < 25% of live count unless `--allow-shrink`, to prevent swapping in a near-empty store after a bad run);
     - temp dir on-disk size is not pathological (e.g. abort if > 20× the previous live dir size — this is the **427 GB runaway guard**);
     - fewer than a configurable fraction of files failed (e.g. abort if `failed_paths` > 20% of disk files unless `--force`).
  5. **Atomic swap** (same-volume renames, ordered for crash-recovery):
     - close the temp client;
     - `mv <chromadb_dir>  <chromadb_dir>.old-<ts>` (keep, do not delete);
     - `mv <chromadb_dir>.rebuild-...  <chromadb_dir>`;
     - if the second rename fails, roll back the first (`mv .old-<ts> back`). Log every step.
  6. On success, print a summary (files, chunks, failed, previous vs new count, previous vs new dir size) and leave `<chromadb_dir>.old-<ts>` as the rollback copy. Do NOT auto-delete it (operator/backup policy).
- On ANY exception or signal during steps 1-4, the live dir is untouched; the temp dir may be left for debugging (log its path). Add a SIGTERM/SIGINT handler that exits cleanly without touching live.

### Fix B — investigate + cap the runaway write
- Add the dir-size sanity guard (Fix A.4) as the immediate backstop. Additionally, add a cheap assertion/log after ingest: if temp dir size per indexed chunk exceeds a sane threshold, log a WARNING with the numbers (so we can catch a future runaway before the swap). Root-causing WHY the interrupted in-place write hit 427 GB is secondary to guaranteeing it can never reach the live store.

## Out of scope
- Changing the incremental nightly reconcile's control flow beyond routing full-rebuild through the safe path (the nightly delta is small and low-risk; do not force every nightly through a full temp rebuild).
- Ignore-filter / junk-vcard product decision (separate).

## Tests (`knowledge-base/scripts/_test_clients/`)
1. **Interruption safety:** start a `--rebuild` with an injected client that raises mid-way (via `MMRAG_GEMINI_CLIENT_FACTORY`); assert the live chroma dir is byte-unchanged (same count, loads fine) and NO swap occurred.
2. **Happy path swap:** rebuild with a working fake client over a small fixture tree; assert after success the live dir contains the rebuilt collection, a `.old-<ts>` rollback dir exists, and counts match the fixture.
3. **Sanity guard abort:** force a near-empty temp result (0 or tiny count) and assert the swap is ABORTED and live is untouched (unless `--allow-shrink`).
4. **Size guard:** simulate/stub an oversized temp dir and assert swap aborts with the runaway-guard message.
5. Existing reconcile/hygiene/timeout tests still green.

## Acceptance
- Clean pytest incl. the new tests. Reconcile `--rebuild` is idempotent (second rebuild → same count, swap leaves a fresh `.old`).
- Non-negotiable: the live store is provably untouched on any failure/interruption (test 1 is the gate).
- No `any`-equivalent bare excepts; every guard logs its numbers.
- Diff limited to `mmrag.py` + test file(s).

## Sequencing
Dispatched together with spec 09. Implement **spec 09 first** (it prevents the hang that triggers kills at all), then spec 10 (defense-in-depth so even a crash mid-rebuild can't corrupt live). Larry reviews 09 and can PR it independently of 10 if 10 needs another round.
