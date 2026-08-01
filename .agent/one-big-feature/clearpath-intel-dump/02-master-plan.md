# Plan — clearpath-intel-dump (re-author reference implementation under signed provenance)

## Problem (verified against live git state, not assumed)

The 5th and final sub-item of the knowledge-brain-p1-p2 epic — the one-time export of
Clearpath's high-value meeting/transcript intelligence into knowledge-sync for mmrag —
already has a **proven-correct reference implementation** sitting on branch
`feature/clearpath-intel-dump` (commit `edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4`):

- `knowledge-base/scripts/intel_extractor.py` (680 lines) — the 27-category
  `CATEGORY_REGISTRY` / `REGISTRY_BY_KEY` / `REGISTRY_KEYS` single source of truth,
  plus the ported extraction pipeline (tiered model routing, injectable client
  factories, prompt composition, response parsing, JSONL/markdown rendering, CLI).
- `knowledge-base/scripts/clearpath_export.py` (331 lines) — standalone, read-only-DB /
  write-only-local export: pure SQL builders, injected-connection query runners,
  dry-run-by-default CLI, `DATABASE_PUBLIC_URL`-only connection with a hard
  `railway.internal` refusal, knowledge-sync `raw/` markdown writer.
- `knowledge-base/scripts/_test_clients/test_clearpath_export.py` (4 scenarios) and
  `_test_clients/test_intel_extractor.py` (5 scenarios) — 9 scenarios total, all green,
  zero network / zero Postgres / zero real LLM clients (fakes injected).

Live validation is already done (2026-07-31, read-only): dry-run counted 9,285 rows
across 21 of 27 categories; `--execute` wrote 9,285 markdown files into
`~/code/knowledge-sync/raw/resources/clearpath-intel/<category>/`; spot-checks clean;
zero DB writes (the script has no write path).

**Why this pass exists:** those files were committed directly by larry (cherry-pick +
`git commit`) instead of being authored by codexer under a `GATE:` directive, so
`gate-pr-push.sh` correctly blocks the PR (`NO_ROWS` — no signed research/plan/specs
provenance). Nothing is wrong with the code; the provenance chain is missing.

## Approach

Treat the reference branch as the **canonical target**, not a starting point to edit:

1. This plan + `03-specs.md` describe exactly what the four reference files do
   (grounded in a full read of all four, this session).
2. Codexer authors the four files **fresh** on a new pipeline branch under a `GATE:`
   directive, using the frozen reference bytes as ground truth:
   `git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:<path>` (pin the SHA, not the
   branch name — the branch can move).
3. Review checks the authored files **byte-for-byte** against the reference
   (`git diff --no-index`). The bar is *equivalent or better*: an empty diff passes
   outright; any deviation must be an explicit, listed improvement that keeps every
   pinned test green and none of the safety properties weakened.
4. True-verify = the two test modules run green (9/9 scenarios) with no network and
   without psycopg2 / google-genai / anthropic installed.

This is deliberately NOT a clean-room reinvention. The value of the pass is the signed
provenance chain, and the cheapest correct path is exact reproduction with the
reference as the oracle.

## Scope

- **IN:** author exactly four files, all under `knowledge-base/scripts/`:
  `intel_extractor.py`, `clearpath_export.py`,
  `_test_clients/test_intel_extractor.py`, `_test_clients/test_clearpath_export.py`.
- **OUT (hard):**
  - No schema change, no DDL, no migration — the export reads an existing table shape.
  - No re-run of the live export (9,285 files already in knowledge-sync) and no mmrag
    ingest (separate, already in flight).
  - No other repo, no other file in this repo (no `railway.json`/`railway.toml`, no
    package manifests — both scripts are stdlib-only at import time by design).
  - No edits on the reference branch itself; it stays untouched as the comparison
    oracle until this pass merges, then gets deleted.

## Key invariants codexer must not "improve" away (tests pin all of these)

- **Safety model of clearpath_export.py:** `--dry-run` is the default and writes
  nothing; `--execute` requires `--out`; the DB is only ever read; the DSN comes
  exclusively from `DATABASE_PUBLIC_URL`; any DSN containing `railway.internal` is
  refused with a clear error; nothing DB-related is hardcoded.
- **Testability seams:** every SQL string comes from a pure `(sql, params)` builder;
  query runners take an injected DB-API connection; LLM clients come from injectable
  factories (`INTEL_GEMINI_CLIENT_FACTORY` / `INTEL_ANTHROPIC_CLIENT_FACTORY` dotted
  paths); psycopg2 / google-genai / anthropic are lazily imported inside the default
  paths only, so both modules import cleanly without any of them installed.
- **Model ids:** the four defaults (`claude-sonnet-4-5`, `gemini-2.5-flash`,
  `gemini-2.5-flash-lite`, `claude-haiku-4-5-20251001`) mirror Clearpath prod and are
  asserted verbatim by test 2/5. They are legacy-by-policy but intentionally kept —
  env-overridable via `INTEL_MODEL_*`. Do NOT modernize them in this pass.
- **Registry contents:** exactly 27 keys with the exact key strings, labels,
  `display_category`, `primary_field`, `person_field` values, and the exact 27 prompt
  texts (long, ported as data from Clearpath). These are data, not style — reproduce
  verbatim.

## Execution steps

1. Codexer (GATE build, scope-sha bound to `03-specs.md`): create branch off
   `origin/main`, author the four files per the specs, run both test modules +
   `py_compile`, produce the diff.
2. Larry adversarial review: `git diff --no-index` each authored file vs
   `git show edeeebc...:<path>`; empty diff or justified-improvement-only; run the
   9-scenario suite independently.
3. True-verify evidence, then PR through the normal gate (provenance rows now exist).
4. After merge: delete `feature/clearpath-intel-dump` (superseded), mark the epic's
   5th sub-item done. (Export + ingest already live; no operational step follows.)

## Acceptance (whole pass)

1. `python3 -m py_compile knowledge-base/scripts/intel_extractor.py knowledge-base/scripts/clearpath_export.py` clean.
2. From `knowledge-base/scripts/`: `python3 -m _test_clients.test_intel_extractor`
   exits 0 with `ALL PASS (5 scenarios)`; `python3 -m _test_clients.test_clearpath_export`
   exits 0 with `ALL PASS (4 scenarios)` — with no network and without psycopg2,
   google-genai, or anthropic importable.
3. Byte-for-byte: `git diff --no-index <authored> <reference>` is empty for all four
   files, OR every hunk is an explicitly listed improvement approved at review.
4. `gate-pr-push.sh` passes (signed research/plan/specs rows exist for this slug).
5. Diff touches exactly the four files — nothing else.

## Risk + mitigation

- *Codexer paraphrases the long prompt texts →* registry/prompt content is declared
  data-not-style in the specs; test 1/5 asserts key coverage and review diffs bytes.
- *"Helpful" modernization of model ids or argparse shape →* invariants section above;
  tests pin ids and CLI behavior; byte-diff catches the rest.
- *Reference branch moves/deleted mid-pass →* all comparisons pin commit SHA
  `edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4`, not the branch name.

## References

- Research: `.agent/one-big-feature/clearpath-intel-dump/01-research.md`
- Specs: `.agent/one-big-feature/clearpath-intel-dump/03-specs.md`
- Reference oracle: commit `edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4`
  (`feature/clearpath-intel-dump`), four paths under `knowledge-base/scripts/`.
- Epic: knowledge-brain-p1-p2 (task_1785452764206_62640707), sub-items 1–4 merged
  (PR178, PR180/184, PR182, PR183).
