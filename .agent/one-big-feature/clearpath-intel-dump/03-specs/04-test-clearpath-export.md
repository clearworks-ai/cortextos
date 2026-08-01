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
