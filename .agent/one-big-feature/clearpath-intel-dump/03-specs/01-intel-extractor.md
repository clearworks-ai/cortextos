# Specs — clearpath-intel-dump

**Repo:** cortextos (single-repo; no other repo touched)
**Files (exactly four, nothing else):**
1. `knowledge-base/scripts/intel_extractor.py`
2. `knowledge-base/scripts/clearpath_export.py`
3. `knowledge-base/scripts/_test_clients/test_intel_extractor.py`
4. `knowledge-base/scripts/_test_clients/test_clearpath_export.py`

**Canonical reference (the oracle):** commit
`edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4` on `feature/clearpath-intel-dump`.
Read each target with:

```bash
git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:knowledge-base/scripts/intel_extractor.py
git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:knowledge-base/scripts/clearpath_export.py
git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:knowledge-base/scripts/_test_clients/test_intel_extractor.py
git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:knowledge-base/scripts/_test_clients/test_clearpath_export.py
```

**Authoring rule:** reproduce the reference **byte-for-byte**. The review stage runs
`git diff --no-index` between your authored file and the `git show` output; an empty
diff passes. A non-empty diff is acceptable ONLY if every hunk is a genuine
improvement (bug fix, tightened safety), each hunk is listed in your implementation
report with a one-line justification, and all 9 test scenarios still pass. Never
paraphrase data (registry entries, prompt texts, model ids, SQL strings, printed
messages) — data hunks are auto-rejected at review. Do NOT edit the reference branch
itself.

The behavioral contracts below exist so review can judge equivalence independently —
they are not a license to redesign.

---

## Spec 01 — `knowledge-base/scripts/intel_extractor.py`

**Goal:** the 27-category Clearpath intelligence registry (single source of truth
consumed by Spec 02) plus the ported standalone extraction CLI. 680 lines in the
reference.

### Structure (in file order)

1. **Shebang + module docstring** — describes the port from Clearpath
   (`shared/intelligence-categories.ts`, `server/services/intelligence.ts` ~L195-215,
   `server/services/default-prompts.ts`), the injectable-factory idiom mirrored from
   mmrag.py, and CLI usage. Imports: `argparse, json, os, re, sys`,
   `from datetime import datetime, timezone` — stdlib only at module import.
2. **`CATEGORY_REGISTRY`** — list of 27 dicts, each with exactly six fields:
   `key, label, display_category, description, primary_field, person_field`.
   Grouped by display_category in this order:
   - `client_insights` (9): objections, desires, problems_pains, voice_of_customer,
     client_wins, question_bank, budget_signals, competitive_mentions,
     relationship_trajectory
   - `product_insights` (4): product_praise, bug_reports, frictions, feature_requests
   - `signature_insights` (4): story_bank, ip_builder, opportunity_finder,
     language_patterns
   - `post_meeting` (6): meeting_outcomes, action_items_extraction, follow_up_needed,
     decisions_made, financial_impact, cos_flags
   - `data_source_insights` (3): calendar_patterns, email_communication,
     cloud_collaboration
   - `assessment_insights` (1): discovery_assessment
   Per-key `primary_field`/`person_field` values are pinned by tests (e.g.
   question_bank → person_field `"askedBy"`; relationship_trajectory, calendar_patterns,
   email_communication, cloud_collaboration, discovery_assessment → person_field
   `None`; the three data-source keys also have primary_field `None`). Copy verbatim.
3. **`REGISTRY_KEYS`** (ordered key list) and **`REGISTRY_BY_KEY`** (key → entry dict).
4. **Model tiers** — defaults `DEFAULT_SONNET_MODEL = "claude-sonnet-4-5"`,
   `DEFAULT_FLASH_MODEL = "gemini-2.5-flash"`,
   `DEFAULT_FLASH_LITE_MODEL = "gemini-2.5-flash-lite"`,
   `DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001"` (legacy-by-policy but
   REQUIRED — tests assert these exact strings; env-overridable, do not modernize).
   Frozensets: `SONNET_PROMPT_KEYS` = {story_bank, ip_builder,
   relationship_trajectory, opportunity_finder, cos_flags};
   `GEMINI_FLASH_KEYS` = {voice_of_customer, desires, problems_pains, objections,
   language_patterns, competitive_mentions, client_wins, product_praise};
   `GEMINI_FLASH_LITE_KEYS` = {question_bank, budget_signals, feature_requests,
   frictions, bug_reports}. Remaining 9 keys fall back to Haiku.
   - `_model_tiers()` — builds the 4-tier {provider, model} map reading
     `INTEL_MODEL_SONNET/FLASH/FLASH_LITE/HAIKU` env overrides **at call time**.
   - `MODEL_TIERS` — static per-key snapshot dict (defaults at import).
   - `route_model(key)` — returns a fresh `{"provider", "model"}` dict per the tier
     sets, Haiku fallback for unlisted keys, env re-read on every call.
5. **`PROMPTS`** — dict of 27 entries: `{display_name, description, prompt_text}`.
   The prompt_texts are long, ported Clearpath prompts (data — copy verbatim,
   including the `\n` escapes and embedded JSON examples). Three keys
   (calendar_patterns, email_communication, discovery_assessment) carry synthesized
   prompts explicitly marked `[Synthesized in-house from the Clearpath registry
   description — ...]`; cloud_collaboration has a real ported prompt.
6. **Client factories** —
   - `_load_factory(dotted_path, env_name)` — resolves `'module.attr'` or
     `'module:attr'` (colon form preferred for ambiguity), raises `ValueError` on
     malformed paths and `TypeError` on non-callables.
   - `get_gemini_client()` — honors `INTEL_GEMINI_CLIENT_FACTORY`; default lazily
     imports `google.genai`, requires `GEMINI_API_KEY` (RuntimeError otherwise),
     returns `genai.Client(api_key=...)`.
   - `get_anthropic_client()` — honors `INTEL_ANTHROPIC_CLIENT_FACTORY`; default
     lazily imports `anthropic`, returns `anthropic.Anthropic()`.
   - `_CLIENT_FACTORIES` = {"gemini": ..., "anthropic": ...}.
   - `_ClientPool` — lazily constructs one client per provider, honoring a dict of
     pre-injected clients.
7. **Model calls + parsing** —
   - `INTEL_MAX_TOKENS` — int env, default 4096.
   - `_call_model(client, provider, model, prompt)` — gemini:
     `client.models.generate_content(model=, contents=)` → `.text`; anthropic:
     `client.messages.create(model=, max_tokens=, messages=[{role:user,...}])` →
     join `.text` over `.content` parts; unknown provider → ValueError.
   - `build_prompt(key, source_name, text)` — prompt_text + `SOURCE:` line +
     BEGIN/END source-content fence + an OUTPUT FORMAT sentence naming the entry's
     primary_field (fallback `"content"`) as required and person_field as optional.
   - `_FENCE_RE` + `parse_extraction_response(key, raw_text)` — strips code fences;
     tolerates prose-wrapped JSON via a `\[.*\]` DOTALL fallback; unparseable →
     whole text as single `(text, None)`; dict → wrapped in list; per item pulls
     primary_field (fallback `"content"`, else `json.dumps` the item) and
     person_field; returns list of `(content, person)` tuples.
8. **Pipeline** —
   - `resolve_categories(spec)` — `'all'`/empty → all keys; else comma-split,
     ValueError listing unknown keys (message includes the valid keys).
   - `extract_file(path, categories, clients=None, now=None)` — reads the file
     (`errors="replace"`), iterates categories, routes + calls the model, appends
     records `{category, content, person, source_file, extracted_at, model}`;
     per-category exceptions are isolated with `print(f"  SKIP (error): {key}: {exc}")`
     and `continue` — one bad category never sinks the rest.
   - `extract_paths(paths, categories, clients=None)` — shared `_ClientPool`,
     per-path `OSError` isolation (SKIP + empty list), returns ordered
     `{source_path: [records]}`.
9. **Rendering** — `_stem`, `write_jsonl` (one `ensure_ascii=False` JSON per line),
   `render_markdown(source_path, records)` — `# Intelligence — <basename>` heading,
   sections `## <label> (<key>)` in registry order, `- content — person` bullets.
10. **CLI** — `build_arg_parser()` with required `extract` subcommand
    (`paths+`, `--categories` default `all`, `--out` required, `--json` flag);
    `cmd_extract(args)` — validates categories (exit 2) and file existence (exit 2),
    writes `<stem>.intel.jsonl` (+ `<stem>.intel.md` unless `--json`) per source,
    prints per-source and `DONE:` totals; `main(argv=None)`;
    `if __name__ == "__main__": sys.exit(main())`.

---

## Acceptance (build stage)

1. Exactly four files in the diff; branch off `origin/main`.
2. `python3 -m py_compile` clean on both source files.
3. From `knowledge-base/scripts/`: both test modules exit 0 —
   `ALL PASS (5 scenarios)` and `ALL PASS (4 scenarios)` — with no network and
   without psycopg2 / google-genai / anthropic importable.
4. `git diff --no-index` vs `git show edeeebc49af1dfc5b2eda242420b0b4f5b5ff9c4:<path>`
   empty for all four files, or improvement-only hunks each justified in the
   implementation report.
5. No live DB touched, no export re-run, no mmrag ingest, no schema/DDL, no
   `railway.json`/`railway.toml`, no new dependencies or manifests.

## Constraints

- Python 3 stdlib only at import time in all four files (lazy third-party imports
  only inside the default factory/connection paths, exactly as the reference does).
- No `print` additions beyond the reference's user-facing output; no debug prints.
- Do not touch `feature/clearpath-intel-dump` — it is the comparison oracle and gets
  deleted after this pass merges.
