# Spec 07 — Paginate all `collection.get()` reads (scale-fix)

## Why (found by live execution 2026-07-02T01:15Z)
Running `reconcile` and `status` against the real production collection
`shared-clearworksai` (45,185 chunks) crashes with:

```
chromadb.errors.InternalError: Error executing plan: Internal error:
error returned from database: (code: 1) too many SQL variables
```

Root cause: four call sites fetch the ENTIRE collection in one call —
`collection.get(include=["metadatas"])` — with no pagination. ChromaDB's
Rust/SQLite binding builds a single statement whose bound-variable count
exceeds SQLite's ceiling once the collection is large. The unit tests
passed only because they run on tiny collections. This means the
reconciler — including the nightly cron — does NOT work at production
scale. This is a correctness/reliability defect, not an enhancement.

## Scope — EXACTLY these 4 unbatched calls (no others)
All four request only `ids` + `metadatas` (verified — none need documents
or embeddings), so one shared helper covers all of them:
- `scripts/mmrag.py:859` in `_collect_index_state()`
- `scripts/mmrag.py:2550` in `cmd_status()`
- `scripts/mmrag.py:2574` in `cmd_list()`
- `scripts/mmrag.py:2616` in `cmd_delete()`

## Change
1. Add module constant near `DELETE_BATCH_SIZE = 500` (line 97):
   `GET_BATCH_SIZE = 5000`  (safely under the SQLite variable ceiling;
   the observed crash was at 45k).
2. Add a helper mirroring the existing `_delete_ids_in_batches` style:
   ```python
   def _get_all_metadatas(collection):
       """Fetch all ids+metadatas in bounded pages so large collections
       cannot exceed SQLite's variable limit. Returns
       {"ids": [...], "metadatas": [...]} preserving order."""
       ids, metadatas = [], []
       offset = 0
       while True:
           page = collection.get(include=["metadatas"],
                                  limit=GET_BATCH_SIZE, offset=offset)
           page_ids = page.get("ids") or []
           if not page_ids:
               break
           ids.extend(page_ids)
           metadatas.extend(page.get("metadatas") or [])
           if len(page_ids) < GET_BATCH_SIZE:
               break
           offset += GET_BATCH_SIZE
       return {"ids": ids, "metadatas": metadatas}
   ```
3. Replace each of the 4 `collection.get(include=["metadatas"])` calls with
   `_get_all_metadatas(collection)`. Keep every downstream use of
   `all_data["ids"]` / `all_data["metadatas"]` identical — the helper's
   return shape matches the two keys those sites read.

## Out of scope
- No behavior change to reconcile/purge/delete logic beyond the read path.
- Do NOT touch the embedding, ingest, or delete-batch code.
- No new dependencies.

## Tests (add to existing suite)
- A test that stubs a collection whose `.get(limit,offset)` returns pages
  and asserts `_get_all_metadatas` reassembles all ids/metadatas in order
  and stops correctly on a short final page and on an exact-multiple page.
- Keep all 32 existing tests green.

## Proof after build (Larry runs, not codexer)
`reconcile --dry-run` then real `reconcile` against the live 45k
collection must complete without the SQL-variables crash, purge the
ignored vcard chunks in batches, add missing real files, and
`query "Logan Currie"` must return the raw source.
