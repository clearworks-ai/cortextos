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
