# Spec 04 — Parent-doc retrieval

**File:** `knowledge-base/scripts/mmrag.py` (`cmd_query` + result assembly)
**Repo:** cortextos
**Goal:** When an agent asks "give me X," return the WHOLE authoritative document (or a doc-level rollup + a link to it), not one out-of-context paragraph. Josh's failure: asking for "the file" and getting a fragment or the wrong thing. Chunk-level retrieval finds the right needle but hands back only the needle.

## The problem
`query` returns top-K chunks ranked by similarity. For "send me the Logan file" that yields one 800-char slice, not the file. Agents then can't deliver the actual document. We need retrieval to be able to answer at the DOCUMENT grain.

## Scope (exact)

### 1. Parent-doc grouping in query results
After the existing chunk ranking (keep it — it drives relevance), add a grouping pass:
- Group the top-N retrieved chunks by `source_file`.
- Compute a per-document score = max(child chunk score) (optionally + small bonus for #-of-matching-chunks, capped).
- Return, alongside the raw chunk hits, a `documents` array: `[{source_file, doc_score, matched_chunks, title, abs_path}]` sorted by doc_score.

### 2. `--parent` / `--docs` mode
Add a flag so a caller can ask for document-grained answers explicitly: `query "<q>" --docs [--top-docs N]`. In `--docs` mode the primary output is the ranked `documents` list with `abs_path` (so an agent can Read/deliver the file) plus a short highlight (the single best matching chunk) per doc. Default (no flag) preserves today's chunk output for backward compat.

### 3. `--full` doc fetch
Add `query "<q>" --docs --full` (or a `get-doc <source_file>` helper): return the FULL text of the top document (read from `abs_path` on disk, not reconstructed from chunks — chunks may have gaps). Guard size (cap at e.g. 200KB; if larger, return path + first N KB + note). This is what lets an agent hand Josh the real file.

### 4. JSON shape
`--json` includes both `chunks` (existing) and `documents` (new) so nothing downstream breaks. Additive only.

## Acceptance
- `query "Logan Currie" --docs` returns Logan's raw source doc as the #1 document with its `abs_path`, not a mid-file fragment.
- Default `query "Logan Currie"` output is unchanged from today (backward compatible).
- `--docs --full` returns the complete Logan file text (or path + head if oversized).
- A query matching chunks across 3 files returns 3 grouped documents ranked by best-chunk score.

## Tests (`_test_clients/test_mmrag_parentdoc.py`)
- Ingest 2 docs, query a term in doc A → `documents[0].source_file == docA`.
- Term present in both docs (stronger in A) → A ranks above B in `documents`.
- `--json` contains both `chunks` and `documents` keys.
- `--full` returns on-disk file bytes for the top doc; oversized fixture returns truncated + note.
- Default mode output shape identical to pre-change (regression guard).

## Constraints
Additive — do not change the default chunk-output contract other agents already parse. `--full` reads from disk `abs_path` (verify it exists / not ignored). No `any`-equivalent, no debug prints. Preserve recency rerank ordering within the chunk pass before grouping.
