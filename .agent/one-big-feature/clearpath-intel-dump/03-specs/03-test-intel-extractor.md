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
