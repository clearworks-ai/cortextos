# Spec 06 — Recency floor

**File:** `knowledge-base/scripts/mmrag.py` (`_apply_recency_rerank`:562, `DEFAULT_RECENCY_WEIGHT`:65)
**Repo:** cortextos
**Goal:** Keep the recency boost from PR #34 (fresh notes should surface) WITHOUT letting a thin, fresh scratch note demote a high-similarity authoritative document below it. Edge case from the redesign analysis: recency is a tie-breaker, not an override.

## The problem
PR #34 added `_apply_recency_rerank` with `DEFAULT_RECENCY_WEIGHT=0.3`. Unbounded, a brand-new low-similarity note can be reranked above a slightly-older but far-more-relevant authoritative doc. That reintroduces "wrong thing surfaced" — the exact failure class we're fixing. We need a floor so recency can reorder near-ties but cannot leapfrog a strong semantic match with a weak one.

## Scope (exact)

### 1. Similarity-gated recency
In `_apply_recency_rerank`, gate the recency contribution so it cannot flip order across a large similarity gap:
- Let `sim` = base similarity score, `recency_boost` = current recency term.
- Rule: recency may only reorder documents whose base similarity is within a band `RECENCY_TIE_BAND` (default `0.05`) of each other. If doc A's base similarity exceeds doc B's by more than `RECENCY_TIE_BAND`, A stays above B regardless of recency.
- Equivalent implementation: cap the effective recency adjustment so `final = sim + min(recency_boost, RECENCY_MAX_LIFT)` where `RECENCY_MAX_LIFT` (default `0.05`) bounds how far recency can lift a doc. Choose whichever is cleaner given the existing code; both enforce "recency breaks ties, never overrides strong relevance."

### 2. Floor for authoritative docs
Add a small guard: a document whose base similarity is above a high-confidence threshold (`AUTHORITATIVE_SIM=0.7`) is never demoted below a document with base similarity below that threshold purely by recency.

### 3. Config surface
Expose `RECENCY_TIE_BAND` / `RECENCY_MAX_LIFT` / `AUTHORITATIVE_SIM` as module constants near `DEFAULT_RECENCY_WEIGHT` (mmrag.py:65) and honor env overrides matching the existing config pattern. Do not change `DEFAULT_RECENCY_WEIGHT` itself.

## Acceptance
- A fresh note with base sim 0.55 does NOT outrank an older doc with base sim 0.72 (gap > band, authoritative floor holds).
- Two docs at sim 0.71 vs 0.70 (within band) → the fresher one may rank first (recency still works as a tie-breaker).
- Recency behavior for near-ties is unchanged from PR #34 intent; only cross-gap leapfrogging is prevented.
- Existing recency tests still pass.

## Tests (`_test_clients/test_mmrag_recency_floor.py` — or extend existing recency test)
- Two docs, sim gap > band, older is more similar → older ranks first despite younger's recency.
- Two docs within band → younger ranks first.
- Authoritative doc (sim>0.7) vs fresh weak doc (sim<0.7) → authoritative first.
- Constants overridable via env.

## Constraints
Do NOT regress PR #34 recency behavior for the tie case — this is a bounded floor, not a revert. No `any`-equivalent, no debug prints. Keep the rerank deterministic. Match existing constant/env-config style at mmrag.py:65.
