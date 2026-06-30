# Shard 02 — Source-date + doc-type metadata, and recency-weighted reranker

**Target file:** `~/code/cortextos/knowledge-base/scripts/mmrag.py` (git-tracked, live).

Implements Josh's 2026-06-30 ask ("should we privilege newer info?") with the
sourced, production-standard method from
`~/code/knowledge-sync/raw/areas/clearworks/research/rag-recency-weighting-production-patterns-june2026.md`:
a hybrid score, document-type-specific decay, `created_at` (source date) not
`ingested_at`.

---

## Part A — `created_at` + `doc_type` metadata at ingest

Every per-type ingest function writes a metadata dict containing
`"ingested_at": time.strftime(...)`. There are **7** such blocks, at lines
**539, 576, 694, 736, 784, 865, 1000**. To each, add two keys.

1. Two pure helpers (module scope):
   ```python
   def _source_created_at(file_path: Path) -> str:
       """ISO timestamp of the SOURCE file's mtime — the document's own date,
       not the ingest time. Falls back to '' if stat fails."""
       try:
           return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(file_path.stat().st_mtime))
       except OSError:
           return ""

   def _classify_doc_type(file_path: Path) -> str:
       """Coarse document class used to pick a recency half-life.
       Heuristic by path; intentionally simple and documented."""
       p = str(file_path).lower()
       if "/daily/" in p or "/sessions/" in p:        return "note"
       if "/decisions/" in p or "decision" in p:      return "decision"
       if "/wiki/" in p:                              return "reference"
       if any(k in p for k in ("policy", "/sop", "reference/", "definition", "glossary")):
           return "policy"
       if file_path.suffix.lower() in (IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS):
           return "media"
       return "other"
   ```

2. In each of the 7 metadata dicts, alongside `"ingested_at"`, add:
   ```python
   "created_at": _source_created_at(file_path),
   "doc_type": _classify_doc_type(file_path),
   ```
   The local variable holding the source path differs per function (`file_path`
   in most). Codexer: use the correct in-scope path variable for each block — read
   each function, do not blind-paste.

These keys are **purely additive**. Old docs already in Chroma simply lack them;
Part B handles that as neutral recency.

---

## Part B — Hybrid recency reranker in `cmd_query`

`cmd_query` (line 1153). After dedup (line **1225** `filtered = deduplicate_results(filtered)`)
and **before** the top-k trim (line **1229** `filtered = filtered[:final_k]`),
insert the rescore.

1. Module-level config constants near the other DEFAULT_* values:
   ```python
   DEFAULT_RECENCY_WEIGHT = 0.3          # similarity gets (1 - this)
   RECENCY_HALF_LIFE_DAYS = {            # per doc_type
       "decision": 30, "note": 30,
       "reference": 90, "media": 90, "other": 90,
       "policy": 365,                    # policies/definitions decay slowly
   }
   DEFAULT_HALF_LIFE_DAYS = 90
   NEUTRAL_DECAY = 0.5                   # used when created_at is missing/unparseable
   ```

2. Pure scoring helper:
   ```python
   def _recency_decay(created_at: str, doc_type: str, now: float = None) -> float:
       """0.5^(age_days / half_life). Missing/invalid created_at -> NEUTRAL_DECAY,
       so pre-change docs are neither rewarded nor buried."""
       if not created_at:
           return NEUTRAL_DECAY
       try:
           t = time.mktime(time.strptime(created_at, "%Y-%m-%dT%H:%M:%S"))
       except (ValueError, OverflowError):
           return NEUTRAL_DECAY
       now = time.time() if now is None else now
       age_days = max(0.0, (now - t) / 86400.0)
       half_life = RECENCY_HALF_LIFE_DAYS.get(doc_type, DEFAULT_HALF_LIFE_DAYS)
       return 0.5 ** (age_days / half_life)
   ```

3. The rescore + re-sort, inserted between line 1225 and 1229:
   ```python
   if not getattr(args, "no_recency", False):
       w = config.get("recency_weight", DEFAULT_RECENCY_WEIGHT)
       for r in filtered:
           md = r.get("metadata") or {}
           decay = _recency_decay(md.get("created_at", ""), md.get("doc_type", "other"))
           r["recency"] = decay
           r["final_score"] = (1 - w) * r["similarity"] + w * decay
       filtered.sort(key=lambda r: r["final_score"], reverse=True)
   ```
   The existing threshold filter still runs on raw `similarity` (above, ~line
   1215) — recency reorders the *survivors*, it does not resurrect sub-threshold
   hits. Keep it that way.

4. CLI flag: add `--no-recency` (store_true) to the `query` subparser so the old
   pure-similarity ordering is reproducible. Default = recency ON.

---

## Constraints

- Reranker must be **deterministic** and side-effect free given a fixed `now`
  (the helper takes an injectable `now` for tests).
- Missing-metadata path must be exercised — most existing docs have no
  `created_at` until the post-merge re-ingest.
- Do not change the threshold/dedup/token-budget logic; only insert the rescore
  between dedup and trim.

## Unit tests (same location as Shard 01's test module)

- `_recency_decay`: age 0 → 1.0; age == half_life → 0.5; missing created_at →
  NEUTRAL_DECAY; unparseable → NEUTRAL_DECAY; policy decays slower than note at
  equal age.
- `_classify_doc_type`: daily/sessions → note; wiki → reference; policy/sop →
  policy; `.png` → media; plain → other.
- Reranker ordering: two result dicts, equal `similarity`, `created_at` 1 day vs
  120 days, fixed `now` → newer first. With `no_recency=True` → original order
  preserved.

## Acceptance

- `python3 -m py_compile knowledge-base/scripts/mmrag.py` clean.
- All new tests pass; existing mmrag tests still pass.
- `--no-recency` reproduces current ordering exactly (regression guard).
