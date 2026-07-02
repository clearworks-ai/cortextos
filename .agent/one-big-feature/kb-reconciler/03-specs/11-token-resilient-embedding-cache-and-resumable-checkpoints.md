# Spec 11 — Token-resilient ingest: content-hash embedding cache + resumable checkpoints

## Problem (Josh directive, 2026-07-02)
Josh, verbatim (Telegram):
> "it should build chunk at a time so that it's just keeps adding the new chunks. It sounds like now if it failed, you would waste all the tokens on starting from scratching again. The whole pipeline needs to be resilient."

He is correct. After spec-09 (bounded timeouts) + spec-10 (atomic rebuild) the pipeline is **safe** — a crash can no longer hang forever or corrupt the live store — but it is **not token-resilient on the from-scratch path**:

1. **`reconcile --rebuild` (spec-10)** builds into a temp store and swaps on success. If it is interrupted, the temp store is discarded and the **next rebuild re-embeds every chunk from scratch** — every embedding token spent on the aborted run is wasted.
2. **A rebuild re-embeds content that is already embedded in the live store.** Even a clean rebuild pays the full embedding cost for chunks whose text is byte-identical to what live already holds.

The nightly incremental reconcile already only embeds *new/changed files* (it never re-embeds unchanged files), so that path is already incremental at the **file** level. This spec makes the **rebuild path** (and any interrupted run) cheap and resumable at the **chunk** level: a chunk is never embedded twice, and an interrupted run resumes exactly where it stopped.

## Goal
Every embedding API call is spent at most **once per unique chunk of content**, ever. An interrupted run (nightly OR rebuild) resumes from where it stopped without re-embedding anything already embedded. `--rebuild` reuses cached/live embeddings for unchanged content and only calls the embedding API for genuinely-new chunk text.

## Scope
File: `knowledge-base/scripts/mmrag.py` (+ tests in `knowledge-base/scripts/_test_clients/`). Adds a persistent embedding cache and per-run resumable checkpoints. Does NOT change chunking, retrieval, or the spec-10 atomic-swap mechanics — it slots *underneath* them.

### Fix A — Persistent embedding cache keyed by content hash
- Add a persistent, on-disk cache that maps `content_key -> embedding_vector`, living **outside** the chroma dir so it survives spec-10's rebuild/swap (it must NOT be inside `<chromadb_dir>` or it gets moved/rolled with the swap). Location: `${MMRAG_DIR}/embedding-cache.sqlite` (a single SQLite file; no new runtime dependency — Python stdlib `sqlite3`). Path overridable via `MMRAG_EMBED_CACHE_PATH`; disable with `MMRAG_EMBED_CACHE=0` (defaults on).
- **Inject at the single chokepoint** `embed_content(client, config, content, task_type=...)` at `mmrag.py` L303 (spec-09-hardened). ALL embed call sites funnel through it (text chunks L1253/L1575/L1714, multimodal descriptions L1289/L1399/L1447/L1487, page content), so wrapping this one function makes every path cache-aware with one change. `embed_query` (task_type=RETRIEVAL_QUERY, L334) also flows through it — queries are cacheable too but the ingest win is the document path.
- `content_key = sha256(canonical(content)) || model || output_dimensionality || task_type`, because an embedding is only valid for that exact tuple. Confirmed real params to fold in: `model = config.get("embedding_model", "gemini-embedding-2-preview")` (L307), `output_dimensionality = config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS)` (L310), `task_type` (default `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY` for queries). **`content` is not always a string** — the multimodal path passes a list including raw media bytes; `canonical(content)` must serialize both cases deterministically (str → utf-8 bytes; list/dict → a stable byte serialization that includes the media bytes) so a media change misses the cache.
- Embedding path becomes: compute `content_key`; if present in cache → reuse the stored vector, **skip the API call** (this is the token saving); if absent → call the (spec-09-hardened) embed API, then **write the vector to the cache immediately** (write-through, committed per batch so a crash keeps what was already embedded). A failed embed writes nothing and is tracked as a failure exactly as today. Model/dims/task_type in the key guarantee a config change never serves a stale-shape vector.
- **Backfill (one-time / lazy):** on a rebuild, before embedding, seed the cache from the CURRENT live collection so already-embedded content is free. Preferred: read `(document_text, embedding)` from the live chroma collection via `collection.get(include=["documents","embeddings"])` (paginated per spec-07), compute each `content_key`, and populate the cache. If live embeddings cannot be read back for any reason, fall back to lazy population (embed once, cache thereafter) — never block the run on backfill. Log how many keys were backfilled vs how many embeds were saved.

### Fix B — Resumable checkpoint per run
- Persist per-run progress so an interrupted run resumes without redoing completed work. Checkpoint granularity = **per source file** (aligns with spec-08 file-level modularity; the chunk-level cache already makes intra-file re-embedding free, so file-level checkpointing is sufficient and simple).
- Store a checkpoint record keyed by run identity (collection + roots + a rebuild target dir for spec-10) listing files whose chunks have all been successfully embedded AND written to the target collection. Store in the same SQLite file (separate table) or a sibling `<target>.checkpoint.json`. On (re)start of a run with matching identity, **skip files already marked complete** and continue.
- The checkpoint must be safe to resume into spec-10's temp/rebuild dir: if a rebuild is re-invoked and its prior temp dir + checkpoint still exist and match, resume into that temp dir rather than starting a new one. Provide `--fresh` to ignore an existing checkpoint and start clean. On successful atomic swap (spec-10), clear the run's checkpoint.
- A completed/committed chunk is never re-embedded on resume because (a) the file is checkpointed complete and skipped, and (b) even if re-touched, its `content_key` is in the cache.

### Fix C — Wire cache + checkpoint into both paths
- Incremental `reconcile` (nightly): route its per-file embed calls through the cache (Fix A) so unchanged-but-touched content is free, and honor the checkpoint (Fix B) so an interrupted nightly resumes.
- `reconcile --rebuild` (spec-10): backfill from live (Fix A), embed only genuinely-new chunks, checkpoint per file (Fix B), then spec-10's guarded atomic swap. Interruption at any point leaves the live store untouched (spec-10) AND leaves the cache + checkpoint populated so the re-run resumes cheaply.

## Out of scope
- Changing chunking or the embedding model/provider.
- Cache garbage collection / eviction of stale content hashes (unique-chunk growth is bounded and small vs re-embedding cost; add a `--gc-embed-cache` note as a future follow-up, do NOT build it here).
- The junk-vcard ignore-filter product decision (separate WS item).
- Changing spec-10's swap/guard mechanics (this spec sits underneath them).

## Tests (`knowledge-base/scripts/_test_clients/`)
1. **Cache hit skips the API:** embed a fixture chunk once (fake client via `MMRAG_GEMINI_CLIENT_FACTORY` counts calls); run again over identical content and assert the embed call count is **0** on the second run and vectors are identical.
2. **Content-key correctness:** identical text → same key/vector reused; a one-byte text change → cache MISS → new embed. Changing model id or task_type in the key → MISS (guards against serving a stale-model vector).
3. **Resume after interruption (no wasted tokens):** start a `--rebuild` over a multi-file fixture with a fake client that raises after N files; assert live is untouched (spec-10 gate still holds); re-run and assert the first N files are NOT re-embedded (call count only covers the remaining files + genuinely-new chunks) and the run completes + swaps.
4. **Backfill from live:** pre-populate a live collection with known (text, embedding) pairs; run `--rebuild`; assert those chunks are served from backfill with **0** embed calls and only net-new content is embedded.
5. **Cache disabled fallback:** `MMRAG_EMBED_CACHE=0` → behaves exactly as pre-spec-11 (every chunk embedded), proving the cache is a pure optimization with a clean off switch.
6. **`--fresh` ignores checkpoint:** a stale checkpoint is present; `--fresh` re-does all files (still cache-cheap) and does not resume.
7. Existing reconcile / hygiene / timeout (spec-09) / atomic-rebuild (spec-10) tests all still green.

## Acceptance
- Clean pytest incl. the new tests; full suite green (currently 45/45 with spec-09+10, this adds the spec-11 cases).
- Non-negotiable behaviors, each proven by a test above: (a) no chunk is embedded twice across runs; (b) an interrupted rebuild resumes without re-embedding completed files; (c) the live store is still provably untouched on interruption (spec-10 gate unbroken); (d) `MMRAG_EMBED_CACHE=0` is a clean no-op fallback.
- No bare excepts; cache/checkpoint I/O failures degrade gracefully to "embed anyway" and log, never abort the run or corrupt live.
- Cache and checkpoint files live OUTSIDE `<chromadb_dir>` (verified: a rebuild swap does not move or delete them).
- Diff limited to `mmrag.py` + test file(s).

## Sequencing
Builds ON spec-09 + spec-10 (PR #36). Two viable orders — **Josh decides**:
- **(Recommended) Merge #36 first** as the safety floor (no hang, no corruption — proven, green), then implement spec-11 as a follow-up PR on a fresh branch cut from fork/main. Keeps the proven safety fix shipping now and layers token-resilience cleanly on top.
- **Fold-first:** implement spec-11 on the SAME `feat/kb-timeout-hardening-v2` branch, re-review, re-verify, and merge #36 with all three specs together.

Either way: Larry writes this spec, codexer implements (GATE: build framework=one-big-feature slug=kb-reconciler repo=/Users/joshweiss/code/cortextos), Larry adversarial-reviews against it + runs the full suite, then PR → Josh merges. After merge, the smoke gate is a live `reconcile --rebuild` that reports a high cache-hit rate (most chunks served from backfill, near-zero new embeds) and stays retrievable end-to-end (incl. Logan).
