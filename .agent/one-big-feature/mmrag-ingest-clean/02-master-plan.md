# Master Plan — MMRAG ingest hygiene + recency-weighted retrieval

## Problem (verified against live code + live queries, not assumed)

Two defects in the live MMRAG pipeline, both traced to real source this session:

1. **Polluted ingest.** `cortextos bus kb-query`/`kb-ingest` execute
   `~/code/cortextos/knowledge-base/scripts/mmrag.py` (resolved at
   `src/bus/knowledge-base.ts:156,278` → `frameworkRoot/knowledge-base/scripts/mmrag.py`;
   git-tracked, 1580 lines). The directory walk at **line 1091**:
   ```python
   files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
   ```
   only filters files whose **own name** starts with `.`. `rglob("*")` still
   descends into dot-**directories** (`.trash/`, `.obsidian/`, `.git/`) and
   `node_modules/`, so every non-dotfile inside them is embedded. Junk (deleted
   notes in `.trash`, Obsidian workspace JSON, `.drawio` XML) pollutes the
   collection and dilutes retrieval.

2. **No recency signal.** Retrieval is pure cosine similarity. A stale Clearpath
   snapshot or a note from two days ago that is semantically close outranks the
   current truth. Every metadata block (lines 539/576/694/736/784/865/1000)
   records `ingested_at` but no **source** date and no document type, so there is
   nothing to decay on. Josh hit this twice today (stale Clearpath; frank2 missing
   the last two days). External research (knox, sourced — see References) confirms
   the production-standard fix is a hybrid score privileging newer information.

## Approach

Three changes, all confined to the one live file
`~/code/cortextos/knowledge-base/scripts/mmrag.py`:

1. **Ingest ignore-filter** (Shard 01) — exclude dot-directories, dependency
   dirs, and `.drawio` at the walk. **Keep** images/PDF/audio/video/DOCX — the
   multimodal value Josh explicitly wants retained. Scope the change to the walk
   only; do not touch the per-type ingest functions.

2. **Source-date + doc-type metadata** (Shard 02, part A) — tag every ingested
   chunk with `created_at` (source file mtime, NOT ingest time) and `doc_type`
   (heuristic class) so retrieval has something to decay on.

3. **Recency-weighted reranker** (Shard 02, part B) — in `cmd_query`, after dedup
   and before the top-k trim, rescore:
   `final = 0.7·similarity + 0.3·0.5^(age_days / half_life)`, with a
   document-TYPE-specific half-life (short for decisions/notes, long for
   policies/definitions). Re-sort by `final`, then trim. Backend-agnostic: this is
   a Python rerank over Chroma results now; the same formula ports to a pgvector
   `ORDER BY` later (Josh's possible Supabase swap) with zero waste.

## Scope

- **IN:** the ignore-filter at the walk; `created_at` + `doc_type` on all 7
  metadata blocks; the hybrid reranker in `cmd_query`; config/flag knobs
  (`--no-recency`, recency weight + half-lives via config) for back-compat; unit
  tests for all three.
- **OUT:** no ChromaDB store format change beyond adding two metadata keys (purely
  additive; old docs without them are handled as neutral-recency). No change to
  `knowledge-base.ts` (it just shells the script). No wipe/re-ingest in this
  change — that is a separate, Josh-gated operational step after merge. Multimodal
  feeding cadence unchanged (fast-follow, Josh-gated).

## Backward compatibility (hard requirement)

Docs already in Chroma have no `created_at`/`doc_type`. The reranker MUST treat
missing `created_at` as **neutral** recency (decay = 0.5), never as "infinitely
old," so pre-change docs are not unfairly buried before the re-ingest runs.
`--no-recency` reproduces today's pure-similarity behavior byte-for-byte.

## Shards

- `03-specs/01-ingest-filter.md` — the walk ignore-filter + its unit test.
- `03-specs/02-recency-rerank.md` — `created_at`/`doc_type` metadata + the hybrid
  reranker + their unit tests.

## Acceptance

1. `python3 -m py_compile knowledge-base/scripts/mmrag.py` clean.
2. New unit tests pass (placed alongside the existing mmrag tests — see Shard
   notes; codexer locates the current test location, does not invent one).
3. Filter proof: ingest a temp tree containing `.trash/x.md`, `.obsidian/y.json`,
   `a.drawio`, `note.md`, `pic.png` → only `note.md` and `pic.png` are embedded;
   skipped count reported.
4. Recency proof: two docs, equal similarity, different `created_at` → the newer
   ranks first; a doc with no `created_at` ranks deterministically (neutral).
5. `--no-recency` reproduces current ordering exactly.

## Risk + mitigation

- Over-aggressive filter dropping wanted files → ignore-list is an explicit,
  documented constant; media/PDF kept; unit test pins the keep/drop set.
- Recency burying a still-correct old policy → document-type half-life makes
  policies/definitions decay ~12× slower than notes; weight capped at 0.3 so
  similarity still dominates; `--no-recency` escape hatch.
- Existing docs lacking metadata → neutral-recency handling (above); full
  correctness after the post-merge re-ingest.

## Post-merge operational steps (NOT in this build — Larry + Josh)

- A) Wipe the collection + re-ingest knowledge-sync clean so existing docs gain
  `created_at`/`doc_type` and junk is purged. Index is **regenerable**
  (non-destructive), but re-ingest spends Gemini embedding calls — **confirm with
  Josh before running** (cost + runtime).
- B) Empty `.trash` + dedupe at the knowledge-sync source (Larry direct).
- C) Fix the frank2 `knowledge-base` SKILL.md contradiction (it points agents at
  the stale Clearpath Intelligence MCP instead of the live `kb-query`).

## References

- Recency research (sourced): `~/code/knowledge-sync/raw/areas/clearworks/research/rag-recency-weighting-production-patterns-june2026.md`
- Live target: `~/code/cortextos/knowledge-base/scripts/mmrag.py` (git-tracked).
- Diagnosis memory: `orgs/clearworksai/agents/larry/memory/feedback_wiki_is_write_only_no_agent_reads_it.md`
