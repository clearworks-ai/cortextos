# Spec 08 — Per-file error isolation + zero-byte skip in reconcile/ingest

## Problem (proven twice, 2026-07-02)
The reconcile aborts the ENTIRE run on a single file's ingest failure. Run #1 died on a transient Gemini 503; run #2 died on a **0-byte PDF** (`raw/resources/reference/clearworks/all-docs/08009efeb7955532.pdf`) → `google.genai.errors.ClientError: 400 INVALID_ARGUMENT "The document has no pages."`. This is THE reason the nightly "never worked": any one corrupt/empty/unparseable file (or one transient API blip) kills the whole mirror. Reconcile is idempotent, so skip-and-continue is safe.

## Scope (exact — do NOT expand)
File: `knowledge-base/scripts/mmrag.py`

### Fix A — per-file try/except in the reconcile ingest loop
- Location: `_reconcile_collection` (~line 1061), the loop that calls `ingest_file(...)` per disk file.
- Wrap each per-file `ingest_file` call in try/except. On ANY exception:
  - Log `  SKIP (error): <path> — <ExceptionType>: <short msg>` to stdout (match the existing `  SKIP (empty): ...` style at the current empty-file guard).
  - Increment a new `failed` counter.
  - `continue` to the next file. Never re-raise out of the loop.
- Add `Failed (skipped on error): <n>` to the reconcile summary block alongside the existing Purged/New/Ignored/Unchanged/Files-after/Orphans counters. Collect the failed paths in a list and print them at the end of the summary (so bad files are visible, not silent).

### Fix B — zero-byte / empty-file guard BEFORE dispatch to any extractor
- There is already a `SKIP (empty)` path for empty text files. Add an explicit size check that runs for ALL file types (before the PDF/image/gemini branch in `ingest_file`, ~line 1753 and/or `ingest_pdf` ~line 1521): if `os.path.getsize(path) == 0`, log `  SKIP (empty): <path>` and return without calling any extractor / Gemini. This prevents a 0-byte PDF/image from ever reaching Gemini.

## Out of scope (do NOT touch)
- Media (jpg/png/mp4/etc.) ignore-listing — that is a separate product decision (WS2: what belongs in the KB) pending Josh. Do NOT add media extensions to the ignore config in this change.
- No changes to embedding logic, chunking, retrieval, or the pagination helper from spec 07.

## Tests (add to `knowledge-base/scripts/_test_clients/test_mmrag_reconcile.py`)
1. Reconcile continues past a file whose ingest raises (mock `ingest_file` to raise on one path); assert the run completes, the other files are indexed, `failed` count == 1, and the bad path is listed in the summary.
2. A 0-byte file of a "binary" type (e.g. `.pdf`) is skipped as empty and never dispatched to the extractor (assert the Gemini/extractor call is NOT made for it).
3. Existing 36 tests still pass.

## Acceptance
- `env -i` clean pytest: all tests pass (existing 36 + 2 new).
- Non-negotiable: no `any`-equivalent silent bare `except: pass` — must log + count. Catch `Exception` (broad is correct here since the goal is "no single file kills the run"), but log the type+message.
- Diff limited to `mmrag.py` + the test file.
