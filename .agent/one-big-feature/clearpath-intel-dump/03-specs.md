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

## Spec 02 — `knowledge-base/scripts/clearpath_export.py`

**Goal:** the standalone, read-only-DB / write-only-local export of the Clearpath
high-value intelligence slice into the knowledge-sync `raw/` layout. 331 lines in the
reference.

### Safety model (docstring section headed `SAFETY MODEL (do not weaken):` — verbatim)

- `--dry-run` is the DEFAULT: per-category counts + total, writes NOTHING.
- `--execute` required to write files; even then Postgres is only READ, only local
  markdown is written — no DB write path exists anywhere in the file.
- DSN comes exclusively from the `DATABASE_PUBLIC_URL` env var (Railway public
  proxy); `railway.internal` hosts are refused. Nothing hardcoded.

### Structure (in file order)

1. **Shebang + docstring** (usage, output layout, safety model, testability notes).
   Imports: `argparse, os, re, sys` only at top level.
2. **Registry import** — `HERE = os.path.dirname(os.path.abspath(__file__))`,
   insert into `sys.path`, then
   `from intel_extractor import REGISTRY_BY_KEY, REGISTRY_KEYS  # noqa: E402`.
3. **`DB_ENV_VAR = "DATABASE_PUBLIC_URL"`** and **`EXPORT_COLUMNS`** — 12-tuple, exact
   order: `id, prompt_key, prompt_label, result, created_at, data_source,
   meeting_title, meeting_date, contact_name, contact_org, engagement_name,
   engagement_status` (the writer and the tests both key off this order).
4. **Pure SQL builders** (return `(sql, params)`, no connection):
   - `build_export_query(categories=None, limit=None)` — SELECT the 12 columns FROM
     `intelligence_extractions ie` **INNER** `JOIN fireflies_meetings fm ON
     fm.id = ie.fireflies_meeting_id` (meeting-derived only), `LEFT JOIN contacts c
     ON c.id = ie.contact_id`, `LEFT JOIN LATERAL` selecting each contact's most
     recent engagement (`eng.primary_contact_id = c.id AND eng.org_id = ie.org_id
     ORDER BY eng.updated_at DESC LIMIT 1`) `ON TRUE`; WHERE
     `ie.prompt_key = ANY(%s)` AND `ie.status = 'completed'` AND result non-null AND
     `LENGTH(TRIM(ie.result)) > 0`; `ORDER BY ie.created_at DESC`; params is a tuple
     whose first element is the key **list**; `limit` appends `\nLIMIT %s` + int
     param. `contact_name` is `TRIM(CONCAT(COALESCE(first_name,''), ' ',
     COALESCE(last_name,'')))`; sql is `.strip()`ed.
   - `build_count_query(categories=None)` — same slice filters (registry keys,
     completed, non-empty, INNER JOIN fireflies_meetings), `GROUP BY ie.prompt_key
     ORDER BY n DESC`, returns `(sql, (keys,))`.
5. **`get_connection()`** — RuntimeError (message names `DATABASE_PUBLIC_URL` and the
   Railway guidance) if env unset; RuntimeError (message contains
   `railway.internal`) if the DSN contains that host; lazy `import psycopg2` with a
   RuntimeError advising `pip install psycopg2-binary` on ImportError; returns
   `psycopg2.connect(dsn)`.
6. **Query runners (injected connection):**
   - `fetch_counts(conn, categories=None)` → `([(prompt_key, count), ...], total)`;
     cursor closed in `finally`.
   - `fetch_rows(conn, categories=None, limit=None)` → list of dicts via
     `dict(zip(EXPORT_COLUMNS, row))`.
7. **Markdown writer:**
   - `slugify(text, max_len=60)` — lowercase, non-alnum runs → `-`, strip/truncate,
     fallback `"untitled"`.
   - `_yaml_escape(value)` — escape backslash + double-quote, newlines → space,
     wrap in double quotes.
   - `render_row_markdown(row)` — frontmatter `---` fence with `clearpath_id` (bare),
     `category` (bare), `contact` (yaml-escaped; empty → `"Unknown"`), `extracted_at`
     (yaml-escaped isoformat of created_at); H1 `# <registry label — fallback
     prompt_label/category> — <meeting_title or 'Untitled meeting'>`; optional
     context line joining `Meeting date: ...` / `Contact: name (org)` /
     `Engagement: name [status]` with ` · `; then the stripped `result` body +
     trailing newline.
   - `row_output_path(out_dir, row)` →
     `<out>/raw/resources/clearpath-intel/<category>/<id>-<slug>.md`, slug from
     meeting_title → contact_name → prompt_label → category.
8. **Runners:**
   - `run_dry_run(conn, categories=None, limit=None)` — prints `DRY RUN — ...`
     header, per-category `{key:<28} {count}` table, `TOTAL` line, optional
     `--limit` cap note, re-run hint; returns total; writes nothing.
   - `run_export(conn, out_dir, categories=None, limit=None)` — makedirs per file,
     writes each rendered row, prints `EXPORTED {n} row(s) -> <dir>`; returns count.
9. **CLI:** `build_arg_parser()` (`--dry-run` store_true default True, `--execute`,
   `--out`, `--limit` int, `--categories` default `"all"`);
   `resolve_categories(spec)` (same contract as Spec 01's, ValueError on unknown);
   `main(argv=None)` — category errors → print `ERROR:` + return 2;
   `--execute` without `--out` → `ERROR:` + return 2; opens the connection, runs
   export or dry-run, `conn.close()` in `finally`, returns 0; `sys.exit(main())`
   guard.

---

## Spec 03 — `_test_clients/test_intel_extractor.py`

**Goal:** 5 behavioral scenarios, zero external deps, zero network. 295 lines in the
reference. Runnable as `python -m _test_clients.test_intel_extractor` from
`knowledge-base/scripts/`; exits 0 all-pass / 1 otherwise; final line
`ALL PASS (5 scenarios)`.

Mechanics: sys.path parent-insert; `import intel_extractor as ie`; module-level
`ALL_27_KEYS` / `SONNET_KEYS` / `FLASH_KEYS` / `FLASH_LITE_KEYS` /
`HAIKU_KEYS = ALL - ...` sets; `_check(label, cond, detail="")` PASS/FAIL printer
appending to `FAILURES`; fake clients shape-compatible with google.genai
(`.models.generate_content` → object with `.text`) and anthropic
(`.messages.create` → object with `.content` list of `.text` blocks); module-level
`fake_gemini_factory()` for the env-hook test.

1. **registry_complete** — keys == the 27; `PROMPTS` and `MODEL_TIERS` cover all 27;
   every prompt_text non-empty; every registry entry has the six fields; spot-checks
   (question_bank person_field `askedBy`; relationship_trajectory person_field None).
2. **routing_exact** — every key routes to the exact expected (provider, model)
   pair including the Haiku fallback; Haiku set is exactly 9 (27−5−8−5);
   `route_model("meeting_outcomes")` equals the Haiku dict.
3. **env_override** — the four `INTEL_MODEL_*` overrides change routed ids (provider
   unchanged); env restored in `finally`; defaults restored after clearing.
4. **extraction_with_fakes** — tempdir transcript; gemini fake raises on the
   frictions prompt (simulated outage) and returns 2 objections (one without
   speaker); anthropic fake returns 1 story_bank; asserts: 2/1/0 records per
   category (frictions isolated, no raise), exact record key-set, content from
   primary_field, person from person_field / None when omitted, model matches the
   routed tier per record, `now` passthrough for extracted_at, source_file recorded;
   then `write_jsonl` round-trip (line count) and `render_markdown` grouping
   (`## Objections (objections)` etc.).
5. **factory_env_hook** — sets `INTEL_GEMINI_CLIENT_FACTORY` to
   `_test_clients.test_intel_extractor:fake_gemini_factory`, asserts
   `ie.get_gemini_client()` builds the fake (response `.text == "[]"`); env restored.

---

## Spec 04 — `_test_clients/test_clearpath_export.py`

**Goal:** 3 numbered scenarios + a guardrails extra (the "4 scenarios" of
`ALL PASS (4 scenarios)`), zero psycopg2 / Postgres / network. 232 lines in the
reference. Runnable as `python -m _test_clients.test_clearpath_export`; exit 0/1.

Mechanics: sys.path parent-insert; `import clearpath_export as ce`; `_check` +
`FAILURES` as in Spec 03; `FakeCursor` (records `(sql, params)` in `.executed`,
returns canned rows) + `FakeConnection` wrapping it.

1. **sql_builders** — export params = 1-tuple wrapping the 27-key list; sql contains
   `ie.prompt_key = ANY(%s)`, `ie.status = 'completed'`, the INNER
   fireflies_meetings join (and NOT `LEFT JOIN fireflies_meetings`), the contacts
   LEFT JOIN, the lateral engagements join (`FROM engagements eng` + `LIMIT 1`),
   `ORDER BY ie.created_at DESC`; no `LIMIT %s` without limit;
   `len(EXPORT_COLUMNS) == 12`; with categories+limit the sql ends `LIMIT %s` and
   params == `(["objections"], 100)`; count query groups by prompt_key, filters the
   same slice, carries the category list; no `railway`/`postgres://` substring in
   the sql.
2. **dry_run_counts** — fake rows `[("objections", 120), ("story_bank", 45)]`;
   captures stdout; asserts total 165 returned, per-category counts + `TOTAL` +
   `DRY RUN` printed, exactly one executed query containing `COUNT(*)`, and a
   tempdir stays empty (ZERO files).
3. **execute_writes_markdown** — two fake 12-tuples in EXPORT_COLUMNS order (one
   full row id 101 objections w/ contact "David Sailer"/org/engagement; one sparse
   row id 102 story_bank with empty contact); asserts: 2 files written, category
   filter passed through to SQL params, path
   `raw/resources/clearpath-intel/objections/101-seiu-scope-call.md`, frontmatter
   fields (`clearpath_id: 101`, `category: objections`,
   `contact: "David Sailer"`, `extracted_at: "2026-06-15T10:30:00"`, `---` fencing),
   body carries the result text + engagement context, second category lands in its
   own dir with a `102-` file, empty contact renders `contact: "Unknown"`.
4. **guardrails (extra)** — with `DATABASE_PUBLIC_URL` unset, `get_connection()`
   raises RuntimeError naming the var; with a `railway.internal` DSN it raises
   RuntimeError naming `railway.internal`; env saved/restored in `finally`.

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
